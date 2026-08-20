import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { HopprError } from '../core/errors.ts'
import { parseJsonWithRepair } from './json.ts'
import type { CompleteOptions, JsonOptions, LlmProvider, ModelMap, Usage } from './provider.ts'
import { modelFor } from './provider.ts'

const exec = promisify(execFile)

/**
 * Drive the user's existing `claude` CLI as a one-shot generator.
 *
 * The point of this provider is that it needs NO API key: it reuses the login
 * the user already has. We deliberately shell out to the installed binary
 * instead of depending on `@anthropic-ai/claude-agent-sdk`, which ships a
 * ~300MB platform binary — a second copy of something already on the machine,
 * and far too much weight for `npx hoppr`.
 *
 * Every flag below exists to strip the CLI back to a plain completion: no
 * settings files, no MCP servers, no tools, no project context. This is a
 * text-in/text-out call, and anything else is cost and unpredictability.
 * Per-call overhead is still ~2-4s and ~11k cached prompt tokens, which is
 * exactly why curation batches items rather than calling per row.
 */
export class ClaudeCliProvider implements LlmProvider {
  readonly id = 'claude-cli'
  /**
   * The CLI takes a prompt string, with no way to attach image bytes to a
   * one-shot `-p` call. Declaring this honestly is what stops the image
   * extractor from asking it and storing the answer.
   */
  readonly supportsVision = false
  readonly #models: ModelMap
  readonly #timeoutMs: number

  constructor(models: ModelMap, timeoutMs = 120_000) {
    this.#models = models
    this.#timeoutMs = timeoutMs
  }

  async available(): Promise<boolean> {
    try {
      await exec('claude', ['--version'], { timeout: 10_000 })
      return true
    } catch {
      return false
    }
  }

  async completeText(o: CompleteOptions): Promise<{ text: string; usage: Usage }> {
    const model = modelFor(o.tier, this.#models)
    const started = Date.now()
    const args = [
      '-p',
      o.prompt,
      '--output-format',
      'json',
      '--model',
      model,
      // Strip the CLI back to a bare generator.
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--exclude-dynamic-system-prompt-sections',
      '--disallowed-tools',
      'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite,NotebookEdit',
    ]
    if (o.system) args.push('--system-prompt', o.system)

    const stdout = await this.#run(args)

    let payload: {
      result?: string
      is_error?: boolean
      usage?: { input_tokens?: number; output_tokens?: number }
      total_cost_usd?: number
    }
    try {
      payload = JSON.parse(stdout)
    } catch {
      throw HopprError.terminal(`claude CLI returned non-JSON: ${stdout.slice(0, 200)}`)
    }
    if (payload.is_error) {
      throw HopprError.terminal(
        `claude CLI reported an error: ${String(payload.result).slice(0, 300)}`,
      )
    }

    return {
      text: payload.result ?? '',
      usage: {
        inputTokens: payload.usage?.input_tokens,
        outputTokens: payload.usage?.output_tokens,
        costUsd: payload.total_cost_usd,
        model,
        ms: Date.now() - started,
      },
    }
  }

  /**
   * Spawn with stdin explicitly closed.
   *
   * `execFile` leaves the child's stdin open, and the CLI waits on it before
   * proceeding — under load that wait is long enough to look like a hang, and
   * the warning it prints lands in stderr where it reads as a failure. It cost
   * 15 of 19 rows in a benchmark pass before it was spotted, because the
   * per-row failure cap masked it as "some transcripts are just hard".
   */
  async #run(args: string[]): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      let size = 0
      const MAX = 32 * 1024 * 1024
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(HopprError.transient(`claude CLI timed out after ${this.#timeoutMs}ms`))
      }, this.#timeoutMs)

      child.stdout.on('data', (b: Buffer) => {
        size += b.length
        if (size > MAX) {
          child.kill('SIGKILL')
          return reject(HopprError.terminal('claude CLI output exceeded 32MB'))
        }
        out += b
      })
      child.stderr.on('data', (b: Buffer) => {
        err += b
      })
      child.on('error', (e) => {
        clearTimeout(timer)
        reject(HopprError.terminal(`claude CLI could not start: ${e.message}`))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) return resolve(out)
        // stderr also carries warnings on success paths, so it only decides the
        // KIND of failure — never whether one happened.
        const transient = /rate limit|overloaded|503|429/i.test(err)
        reject(
          new HopprError(
            transient ? 'transient' : 'terminal',
            `claude CLI exited ${code}: ${(err || 'no stderr').slice(0, 300)}`,
          ),
        )
      })
    })
  }

  async completeJson<T>(o: JsonOptions<T>): Promise<{ value: T; usage: Usage }> {
    const system = [o.system, 'Respond with JSON only. No prose, no explanation.']
      .filter(Boolean)
      .join('\n\n')
    const first = await this.completeText({ ...o, system })
    const value = await parseJsonWithRepair(first.text, o.schema, {
      retry: async (repairPrompt) =>
        (await this.completeText({ ...o, system, prompt: repairPrompt })).text,
    })
    return { value, usage: first.usage }
  }
}
