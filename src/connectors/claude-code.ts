import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { glob } from 'tinyglobby'
import { expandHome } from '../config/load.ts'
import { contentHash } from '../core/hash.ts'
import { blockText, renderTranscript, summarizeToolInput, type Turn } from './render.ts'
import { parseLine, tailLines } from './tail.ts'
import type {
  Connector,
  ConnectorSource,
  IngestCandidate,
  PullResult,
  TailCursor,
} from './types.ts'
import { isLive } from './types.ts'

interface CCLine {
  type?: string
  sessionId?: string
  cwd?: string
  gitBranch?: string
  version?: string
  timestamp?: string
  isSidechain?: boolean
  isMeta?: boolean
  title?: string
  message?: { role?: string; content?: unknown }
  toolUseResult?: unknown
}

const DEFAULT_ROOT = '~/.claude/projects'

/**
 * Claude Code writes one append-only JSONL per session under a
 * path-slug directory. Verified against 99 project directories on this machine.
 */
export const claudeCode: Connector = {
  id: 'claude-code',
  label: 'Claude Code',
  defaultIntervalMs: 60_000,

  async detect(cfg) {
    return existsSync(expandHome(String(cfg.path ?? DEFAULT_ROOT)))
  },

  async discover(cfg) {
    const root = expandHome(String(cfg.path ?? DEFAULT_ROOT))
    if (!existsSync(root)) return []
    const files = await glob(['*/*.jsonl'], { cwd: root, absolute: true })
    const out: ConnectorSource[] = []
    for (const f of files) {
      const s = await stat(f).catch(() => undefined)
      if (!s) continue
      out.push({
        key: f,
        label: `${basename(join(f, '..'))}/${basename(f)}`,
        mtimeMs: s.mtimeMs,
        size: s.size,
      })
    }
    return out
  },

  async pull(source, ctx): Promise<PullResult> {
    const cursor = (ctx.cursor ?? undefined) as TailCursor | undefined
    const read = await tailLines(source.key, cursor)
    if (read.lines.length === 0) return { items: [], cursor: read.cursor, done: read.done }

    const includeSidechains = ctx.config.include_sidechains === true
    const maxChars = Number(ctx.config.max_chars ?? 60_000)
    const minTurns = Number(ctx.config.min_turns ?? 2)

    const turns: Turn[] = []
    let sessionId: string | undefined
    let cwd: string | undefined
    let branch: string | undefined
    let version: string | undefined
    let title: string | undefined
    let firstTs: number | undefined
    let lastTs = 0
    let sidechains = 0
    let userTurns = 0

    for (const line of read.lines) {
      const o = parseLine<CCLine>(line)
      if (!o) continue
      sessionId ??= o.sessionId
      cwd ??= o.cwd
      branch ??= o.gitBranch
      version ??= o.version

      if (o.timestamp) {
        const t = Date.parse(o.timestamp)
        if (!Number.isNaN(t)) {
          firstTs ??= t
          lastTs = Math.max(lastTs, t)
        }
      }

      // The CLI writes a generated title for the session. Free, and better
      // than anything we would derive from the first prompt.
      if (o.type === 'ai-title' && typeof o.title === 'string') {
        title = o.title
        continue
      }
      if (o.isSidechain && !includeSidechains) {
        sidechains++
        continue
      }
      if (o.isMeta) continue

      if (o.type === 'user' && o.message) {
        const { text } = blockText(o.message.content)
        if (text.trim()) {
          turns.push({ role: 'user', text })
          userTurns++
        }
        if (o.toolUseResult !== undefined) {
          turns.push({
            role: 'tool',
            tool: 'result',
            text: summarizeToolInput(o.toolUseResult, 400),
          })
        }
      } else if (o.type === 'assistant' && o.message) {
        const { text, tools } = blockText(o.message.content)
        if (text.trim()) turns.push({ role: 'assistant', text })
        for (const t of tools) turns.push({ role: 'tool', tool: t, text: '' })
      }
    }

    if (!sessionId || userTurns < minTurns) {
      // Trivial sessions are skipped entirely rather than curated: an LLM call
      // for a two-line session is pure cost.
      return { items: [], cursor: read.cursor, done: read.done }
    }

    const body = renderTranscript(
      {
        id: sessionId,
        cwd,
        branch,
        'claude-code': version,
        turns: turns.length,
        subagent_turns_skipped: sidechains || undefined,
      },
      turns,
      { maxChars },
    )

    const hash = contentHash(body)
    if (cursor?.emittedHash === hash) {
      return { items: [], cursor: { ...read.cursor, emittedHash: hash }, done: read.done }
    }

    const item: IngestCandidate = {
      externalId: `claude-code:${sessionId}`,
      kind: 'session',
      title: title ?? `Claude Code session in ${projectOf(cwd)}`,
      body,
      createdAt: new Date(firstTs ?? Date.now()),
      updatedAt: new Date(lastTs || Date.now()),
      project: projectOf(cwd),
      origin: { harness: 'claude-code', sessionId, cwd, branch, version, path: source.key },
      partial: isLive(lastTs || Date.now()),
    }
    return { items: [item], cursor: { ...read.cursor, emittedHash: hash }, done: read.done }
  },
}

/**
 * Project name comes from the `cwd` recorded on each line, NOT from the
 * directory slug. The slug flattens every separator to a dash, so
 * `-Users-sam-code-my-app` cannot be reversed: `my-app` and `my/app` collide.
 */
export function projectOf(cwd?: string): string | undefined {
  if (!cwd) return undefined
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1]
}
