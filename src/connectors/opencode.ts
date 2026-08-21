import { existsSync } from 'node:fs'
import { expandHome } from '../config/load.ts'
import { contentHash } from '../core/hash.ts'
import { openDriver } from '../db/driver.ts'
import { projectOf } from './claude-code.ts'
import { renderTranscript, summarizeToolInput, type Turn } from './render.ts'
import type { Connector, ConnectorSource, IngestCandidate, PullResult } from './types.ts'
import { isLive } from './types.ts'

const DEFAULT_DB = '~/.local/share/opencode/opencode.db'

interface DbCursor {
  lastUpdated: number
}

/**
 * opencode stores sessions in its own SQLite database rather than files.
 *
 * We open it READ-ONLY and never write, never checkpoint, never VACUUM: it is
 * another application's live database and we are a guest in it. We also probe
 * the schema before querying, because a third-party schema is not a contract —
 * if theirs moves, this connector disables itself with a clear message instead
 * of throwing on every poll forever.
 */
export const opencode: Connector = {
  id: 'opencode',
  label: 'opencode',
  defaultIntervalMs: 120_000,

  async detect(cfg) {
    return existsSync(expandHome(String(cfg.db ?? DEFAULT_DB)))
  },

  async discover(cfg) {
    const path = expandHome(String(cfg.db ?? DEFAULT_DB))
    if (!existsSync(path)) return []
    // One synthetic source: the database itself. Sessions are rows, not files.
    return [{ key: path, label: 'opencode.db' }] satisfies ConnectorSource[]
  },

  async pull(source, ctx): Promise<PullResult> {
    const cursor = (ctx.cursor ?? { lastUpdated: 0 }) as DbCursor
    const maxChars = Number(ctx.config.transcript_max_chars ?? 400_000)
    const toolCap = Number(ctx.config.tool_result_max_chars ?? 8_000)
    const minTurns = Number(ctx.config.min_turns ?? 2)

    const db = await openDriver(source.key, 'auto', { readonly: true })
    try {
      const cols = new Set(
        db
          .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((r) => r.name),
      )
      if (!cols.has('session') || !cols.has('message')) {
        ctx.log('opencode schema not recognized — connector disabled for this run')
        return { items: [], cursor, done: true }
      }

      const sessions = db
        .prepare<{
          id: string
          title: string
          directory: string
          time_created: number
          time_updated: number
          cost: number
        }>(
          `SELECT id, title, directory, time_created, time_updated, cost
             FROM session WHERE time_updated > :since
            ORDER BY time_updated ASC LIMIT 200`,
        )
        .all({ since: cursor.lastUpdated })

      const items: IngestCandidate[] = []
      let maxSeen = cursor.lastUpdated

      for (const s of sessions) {
        maxSeen = Math.max(maxSeen, s.time_updated)
        const parts = db
          .prepare<{ role: string; data: string; part: string | null }>(
            `SELECT m.role AS role, m.data AS data, p.data AS part
               FROM message m LEFT JOIN part p ON p.message_id = m.id
              WHERE m.session_id = :sid
              ORDER BY m.time_created ASC`,
          )
          .all({ sid: s.id })

        const turns: Turn[] = []
        let userTurns = 0
        for (const row of parts) {
          const text = extractText(row.part ?? row.data)
          if (!text.trim()) continue
          if (row.role === 'user') {
            turns.push({ role: 'user', text })
            userTurns++
          } else if (row.role === 'assistant') {
            turns.push({ role: 'assistant', text })
          } else {
            turns.push({ role: 'tool', tool: row.role, text: summarizeToolInput(text, toolCap) })
          }
        }
        if (userTurns < minTurns) continue

        const created = normalizeTime(s.time_created)
        const updated = normalizeTime(s.time_updated)
        const body = renderTranscript(
          { id: s.id, cwd: s.directory, cost_usd: s.cost, turns: turns.length },
          turns,
          { maxChars, maxToolResultChars: toolCap },
        )
        items.push({
          externalId: `opencode:${s.id}`,
          kind: 'session',
          title: s.title || `opencode session in ${projectOf(s.directory)}`,
          body,
          createdAt: new Date(created),
          updatedAt: new Date(updated),
          project: projectOf(s.directory),
          origin: {
            harness: 'opencode',
            sessionId: s.id,
            cwd: s.directory,
            hash: contentHash(body),
          },
          partial: isLive(updated),
        })
      }

      return {
        items,
        cursor: { lastUpdated: maxSeen } satisfies DbCursor,
        done: sessions.length < 200,
      }
    } catch (e) {
      // SQLITE_BUSY and friends: their database, their lock. Try again later.
      ctx.log(`opencode read failed (will retry): ${(e as Error).message}`)
      return { items: [], cursor, done: true }
    } finally {
      db.close()
    }
  },
}

/** opencode timestamps are seconds in some versions, ms in others. */
function normalizeTime(t: number): number {
  return t > 1e12 ? t : t * 1000
}

function extractText(raw: string | null): string {
  if (!raw) return ''
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (typeof o.text === 'string') return o.text
    if (typeof o.content === 'string') return o.content
    if (Array.isArray(o.content)) {
      return o.content
        .map((b) =>
          typeof (b as { text?: string })?.text === 'string' ? (b as { text: string }).text : '',
        )
        .filter(Boolean)
        .join('\n')
    }
    return ''
  } catch {
    return raw
  }
}
