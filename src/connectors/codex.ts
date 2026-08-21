import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { glob } from 'tinyglobby'
import { expandHome } from '../config/load.ts'
import { contentHash } from '../core/hash.ts'
import { projectOf } from './claude-code.ts'
import { renderTranscript, summarizeToolInput, type Turn } from './render.ts'
import { parseLine, tailLines } from './tail.ts'
import type {
  Connector,
  ConnectorSource,
  IngestCandidate,
  PullResult,
  TailCursor,
} from './types.ts'
import { isLive } from './types.ts'

interface CxLine {
  timestamp?: string
  type?: string
  payload?: Record<string, unknown>
}

const DEFAULT_ROOT = '~/.codex'

/**
 * Codex keeps a `session_index.jsonl` manifest alongside dated rollout files.
 *
 * The manifest is the win: one cheap read tells us exactly which sessions
 * changed, so a poll over thousands of historical rollouts costs a single file
 * read instead of thousands of stats.
 */
export const codex: Connector = {
  id: 'codex',
  label: 'Codex CLI',
  defaultIntervalMs: 60_000,

  async detect(cfg) {
    return existsSync(expandHome(String(cfg.path ?? DEFAULT_ROOT)))
  },

  async discover(cfg) {
    const root = expandHome(String(cfg.path ?? DEFAULT_ROOT))
    if (!existsSync(root)) return []

    const files = await glob(['sessions/**/rollout-*.jsonl'], { cwd: root, absolute: true })
    const byId = new Map<string, string>()
    for (const f of files) {
      const id = /rollout-.*?-([0-9a-f-]{36})\.jsonl$/.exec(basename(f))?.[1]
      if (id) byId.set(id, f)
    }

    // Prefer the manifest when present: it carries updated_at per session, so
    // we can skip untouched rollouts without stat-ing each one.
    const manifest = `${root}/session_index.jsonl`
    const out: ConnectorSource[] = []
    if (existsSync(manifest)) {
      for (const line of (await readFile(manifest, 'utf8')).split('\n')) {
        const o = parseLine<{ id?: string; thread_name?: string; updated_at?: string }>(line)
        if (!o?.id) continue
        const path = byId.get(o.id)
        if (!path) continue
        byId.delete(o.id)
        out.push({
          key: path,
          label: o.thread_name ?? o.id,
          mtimeMs: o.updated_at ? Date.parse(o.updated_at) : undefined,
        })
      }
    }
    for (const [, path] of byId) {
      const s = await stat(path).catch(() => undefined)
      out.push({ key: path, label: basename(path), mtimeMs: s?.mtimeMs, size: s?.size })
    }
    return out
  },

  async pull(source, ctx): Promise<PullResult> {
    const cursor = (ctx.cursor ?? undefined) as TailCursor | undefined
    const read = await tailLines(source.key, cursor)
    if (read.lines.length === 0) return { items: [], cursor: read.cursor, done: read.done }

    const maxChars = Number(ctx.config.transcript_max_chars ?? 400_000)
    const toolCap = Number(ctx.config.tool_result_max_chars ?? 8_000)
    const minTurns = Number(ctx.config.min_turns ?? 2)

    const turns: Turn[] = []
    let id: string | undefined
    let cwd: string | undefined
    let cli: string | undefined
    let provider: string | undefined
    let firstTs: number | undefined
    let lastTs = 0
    let userTurns = 0
    // Codex writes a user turn as BOTH an event_msg and a response_item.
    // Without this the prompt block would be doubled.
    const seenUser = new Set<string>()

    for (const line of read.lines) {
      const o = parseLine<CxLine>(line)
      if (!o) continue
      if (o.timestamp) {
        const t = Date.parse(o.timestamp)
        if (!Number.isNaN(t)) {
          firstTs ??= t
          lastTs = Math.max(lastTs, t)
        }
      }
      const p = o.payload ?? {}

      if (o.type === 'session_meta') {
        id = String(p.id ?? id ?? '')
        cwd = typeof p.cwd === 'string' ? p.cwd : cwd
        cli = typeof p.cli_version === 'string' ? p.cli_version : cli
        provider = typeof p.model_provider === 'string' ? p.model_provider : provider
        continue
      }

      const ptype = String(p.type ?? '')
      if (ptype === 'reasoning') continue // internal, and enormous

      if (ptype === 'user_message' || (ptype === 'message' && p.role === 'user')) {
        const text = textOf(p)
        const key = text.slice(0, 200)
        if (text.trim() && !seenUser.has(key)) {
          seenUser.add(key)
          turns.push({ role: 'user', text })
          userTurns++
        }
      } else if (ptype === 'agent_message' || (ptype === 'message' && p.role === 'assistant')) {
        const text = textOf(p)
        if (text.trim()) turns.push({ role: 'assistant', text })
      } else if (ptype === 'function_call') {
        turns.push({
          role: 'tool',
          tool: String(p.name ?? 'tool'),
          text: summarizeToolInput(p.arguments),
        })
      } else if (ptype === 'function_call_output') {
        turns.push({ role: 'tool', tool: 'result', text: summarizeToolInput(p.output, toolCap) })
      }
    }

    if (!id || userTurns < minTurns) return { items: [], cursor: read.cursor, done: read.done }

    const body = renderTranscript({ id, cwd, codex: cli, provider, turns: turns.length }, turns, {
      maxChars,
      maxToolResultChars: toolCap,
    })
    const hash = contentHash(body)
    if (cursor?.emittedHash === hash) {
      return { items: [], cursor: { ...read.cursor, emittedHash: hash }, done: read.done }
    }

    const item: IngestCandidate = {
      externalId: `codex:${id}`,
      kind: 'session',
      title:
        source.label !== basename(source.key) ? source.label : `Codex session in ${projectOf(cwd)}`,
      body,
      createdAt: new Date(firstTs ?? Date.now()),
      updatedAt: new Date(lastTs || Date.now()),
      project: projectOf(cwd),
      origin: { harness: 'codex', sessionId: id, cwd, cli, provider, path: source.key },
      partial: isLive(lastTs || Date.now()),
    }
    return { items: [item], cursor: { ...read.cursor, emittedHash: hash }, done: read.done }
  },
}

function textOf(p: Record<string, unknown>): string {
  if (typeof p.message === 'string') return p.message
  if (typeof p.text === 'string') return p.text
  const content = p.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const blk = b as Record<string, unknown>
        return typeof blk?.text === 'string' ? blk.text : ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}
