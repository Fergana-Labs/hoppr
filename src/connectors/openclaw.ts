import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { glob } from 'tinyglobby'
import { expandHome } from '../config/load.ts'
import { contentHash } from '../core/hash.ts'
import { projectOf } from './claude-code.ts'
import { blockText, renderTranscript, summarizeToolInput, type Turn } from './render.ts'
import { parseLine, tailLines } from './tail.ts'
import type { Connector, ConnectorSource, PullResult, TailCursor } from './types.ts'
import { isLive } from './types.ts'

interface OcLine {
  type?: string
  id?: string
  timestamp?: string
  cwd?: string
  version?: number
  provider?: string
  modelId?: string
  role?: string
  content?: unknown
  text?: string
  name?: string
}

const DEFAULT_ROOT = '~/.openclaw/agents'

/** openclaw: one JSONL per session under agents/<agent>/sessions/. */
export const openclaw: Connector = {
  id: 'openclaw',
  label: 'openclaw',
  defaultIntervalMs: 60_000,

  async detect(cfg) {
    return existsSync(expandHome(String(cfg.path ?? DEFAULT_ROOT)))
  },

  async discover(cfg) {
    const root = expandHome(String(cfg.path ?? DEFAULT_ROOT))
    if (!existsSync(root)) return []
    const files = await glob(['*/sessions/*.jsonl'], { cwd: root, absolute: true })
    const out: ConnectorSource[] = []
    for (const f of files) {
      const s = await stat(f).catch(() => undefined)
      if (!s) continue
      out.push({ key: f, label: basename(f), mtimeMs: s.mtimeMs, size: s.size })
    }
    return out
  },

  async pull(source, ctx): Promise<PullResult> {
    const cursor = (ctx.cursor ?? undefined) as TailCursor | undefined
    const read = await tailLines(source.key, cursor)
    if (read.lines.length === 0) return { items: [], cursor: read.cursor, done: read.done }

    const maxChars = Number(ctx.config.max_chars ?? 60_000)
    const minTurns = Number(ctx.config.min_turns ?? 2)

    const turns: Turn[] = []
    let id: string | undefined
    let cwd: string | undefined
    let model: string | undefined
    let firstTs: number | undefined
    let lastTs = 0
    let userTurns = 0

    for (const line of read.lines) {
      const o = parseLine<OcLine>(line)
      if (!o) continue
      if (o.timestamp) {
        const t = Date.parse(o.timestamp)
        if (!Number.isNaN(t)) {
          firstTs ??= t
          lastTs = Math.max(lastTs, t)
        }
      }
      switch (o.type) {
        case 'session':
          id ??= o.id
          cwd ??= o.cwd
          break
        case 'model_change':
          model = o.modelId ? `${o.provider ?? ''}/${o.modelId}` : model
          break
        case 'message': {
          const { text, tools } = blockText(o.content ?? o.text)
          if (o.role === 'user' && text.trim()) {
            turns.push({ role: 'user', text })
            userTurns++
          } else if (text.trim()) {
            turns.push({ role: 'assistant', text })
          }
          for (const t of tools) turns.push({ role: 'tool', tool: t, text: '' })
          break
        }
        case 'tool_call':
        case 'tool_result':
          turns.push({
            role: 'tool',
            tool: o.name ?? 'tool',
            text: summarizeToolInput(o.content, 400),
          })
          break
        default:
          break // unknown line types are ignored, never fatal
      }
    }

    if (!id || userTurns < minTurns) return { items: [], cursor: read.cursor, done: read.done }

    const body = renderTranscript({ id, cwd, model, turns: turns.length }, turns, { maxChars })
    const hash = contentHash(body)
    if (cursor?.emittedHash === hash) {
      return { items: [], cursor: { ...read.cursor, emittedHash: hash }, done: read.done }
    }

    return {
      items: [
        {
          externalId: `openclaw:${id}`,
          kind: 'session',
          title: `openclaw session in ${projectOf(cwd) ?? 'workspace'}`,
          body,
          createdAt: new Date(firstTs ?? Date.now()),
          updatedAt: new Date(lastTs || Date.now()),
          project: projectOf(cwd),
          origin: { harness: 'openclaw', sessionId: id, cwd, model, path: source.key },
          partial: isLive(lastTs || Date.now()),
        },
      ],
      cursor: { ...read.cursor, emittedHash: hash },
      done: read.done,
    }
  },
}
