import { HopprError } from '../core/errors.ts'
import { parseJsonWithRepair } from './json.ts'
import type { CompleteOptions, JsonOptions, LlmProvider, ModelMap, Usage } from './provider.ts'
import { modelFor } from './provider.ts'

interface Spec {
  id: string
  envKey?: string
  baseUrl: string
  /** Anthropic's Messages API differs enough from the OpenAI shape to branch. */
  dialect: 'anthropic' | 'openai'
  extraHeaders?: Record<string, string>
  pricePerMTok?: { input: number; output: number }
}

const SPECS: Record<string, Spec> = {
  anthropic: {
    id: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    baseUrl: 'https://api.anthropic.com/v1/messages',
    dialect: 'anthropic',
    extraHeaders: { 'anthropic-version': '2023-06-01' },
  },
  openai: {
    id: 'openai',
    envKey: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    dialect: 'openai',
  },
  openrouter: {
    id: 'openrouter',
    envKey: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    dialect: 'openai',
    extraHeaders: {
      'HTTP-Referer': 'https://github.com/samzliu/hoppr',
      'X-Title': 'hoppr',
    },
  },
  ollama: {
    id: 'ollama',
    baseUrl: `${process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'}/v1/chat/completions`,
    dialect: 'openai',
  },
}

/**
 * One HTTP provider covering Anthropic, OpenRouter, and Ollama.
 *
 * Written with `fetch` rather than three vendor SDKs: the surface we need is a
 * single chat completion, and three SDKs would be ~40MB of install weight plus
 * three independent release cadences to track for no behavioural gain.
 *
 * Ollama matters beyond convenience — it is the path where nothing leaves the
 * machine, which is the honest answer for anyone pointing hoppr at transcripts
 * they would not send to a vendor.
 */
export class HttpLlmProvider implements LlmProvider {
  readonly id: string
  /** Every dialect here carries images; whether the MODEL does is its problem. */
  readonly supportsVision = true
  readonly #spec: Spec
  readonly #models: ModelMap
  readonly #timeoutMs: number
  readonly #secrets: Record<string, string>

  constructor(
    provider: string,
    models: ModelMap,
    timeoutMs = 120_000,
    secrets: Record<string, string> = {},
  ) {
    const spec = SPECS[provider]
    if (!spec) throw HopprError.user(`unknown LLM provider '${provider}'`)
    this.id = spec.id
    this.#spec = spec
    this.#models = models
    this.#timeoutMs = timeoutMs
    this.#secrets = secrets
  }

  /**
   * The live environment wins, then this store's own .env values. Reading the
   * store's values directly rather than through process.env is what lets two
   * hoppers in one daemon use different keys for the same provider.
   */
  #key(): string | undefined {
    const name = this.#spec.envKey
    if (!name) return undefined
    return process.env[name] || this.#secrets[name] || undefined
  }

  async available(): Promise<boolean> {
    if (this.#spec.envKey) return Boolean(this.#key())
    // Ollama has no key; probe the socket instead of assuming it is up.
    try {
      const base = new URL(this.#spec.baseUrl)
      const res = await fetch(`${base.origin}/api/tags`, {
        signal: AbortSignal.timeout(1500),
      })
      return res.ok
    } catch {
      return false
    }
  }

  async completeText(o: CompleteOptions): Promise<{ text: string; usage: Usage }> {
    const model = modelFor(o.tier, this.#models)
    const started = Date.now()
    const key = this.#key()
    if (this.#spec.envKey && !key) {
      throw HopprError.user(`${this.id} needs ${this.#spec.envKey}`)
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.#spec.extraHeaders,
    }
    if (key) {
      if (this.#spec.dialect === 'anthropic') headers['x-api-key'] = key
      else headers.authorization = `Bearer ${key}`
    }

    const imgs = o.images ?? []
    const body =
      this.#spec.dialect === 'anthropic'
        ? {
            model,
            max_tokens: o.maxTokens ?? 4096,
            system: o.system,
            messages: [
              {
                role: 'user',
                content: imgs.length
                  ? [
                      ...imgs.map((i) => ({
                        type: 'image',
                        source: { type: 'base64', media_type: i.mediaType, data: i.base64 },
                      })),
                      { type: 'text', text: o.prompt },
                    ]
                  : o.prompt,
              },
            ],
          }
        : {
            model,
            max_tokens: o.maxTokens ?? 4096,
            messages: [
              ...(o.system ? [{ role: 'system', content: o.system }] : []),
              {
                role: 'user',
                content: imgs.length
                  ? [
                      ...imgs.map((i) => ({
                        type: 'image_url',
                        image_url: { url: `data:${i.mediaType};base64,${i.base64}` },
                      })),
                      { type: 'text', text: o.prompt },
                    ]
                  : o.prompt,
              },
            ],
            // OpenRouter omits cost unless asked, which left `hoppr cost`
            // reporting nothing at all for the provider most likely to be
            // billing you. Other OpenAI-dialect servers ignore the field.
            ...(this.#spec.id === 'openrouter' ? { usage: { include: true } } : {}),
          }

    let res: Response
    try {
      res = await fetch(this.#spec.baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch (e) {
      throw HopprError.transient(`${this.id} request failed: ${(e as Error).message}`)
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      // 429 and 5xx will pass; a 400 means this input will never work.
      const kind = res.status === 429 || res.status >= 500 ? 'transient' : 'terminal'
      throw new HopprError(kind, `${this.id} returned ${res.status}: ${detail}`)
    }

    const json = (await res.json()) as Record<string, unknown>
    return {
      text: this.#pickText(json),
      usage: { ...this.#pickUsage(json), model, ms: Date.now() - started },
    }
  }

  #pickText(json: Record<string, unknown>): string {
    if (this.#spec.dialect === 'anthropic') {
      const content = json.content as Array<{ type: string; text?: string }> | undefined
      return (content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
    }
    const choices = json.choices as Array<{ message?: { content?: string } }> | undefined
    return choices?.[0]?.message?.content ?? ''
  }

  #pickUsage(json: Record<string, unknown>): Usage {
    const u = json.usage as Record<string, number> | undefined
    if (!u) return {}
    return this.#spec.dialect === 'anthropic'
      ? { inputTokens: u.input_tokens, outputTokens: u.output_tokens }
      : { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, costUsd: u.cost }
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
