import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { Hoppr } from '../core/hoppr.ts'
import * as lock from '../daemon/lock.ts'
import { getRun } from '../daemon/scheduler.ts'
import { Layout } from '../store/layout.ts'

export interface PassSummary {
  passId: string
  started: number
  ended: number
  ops: number
  created: number
  updated: number
  kinds: string
}

export interface HopprHealth {
  hopper: string
  root: string
  captures: number
  pending: number
  /** Rows that failed 3 times and left the queue permanently. */
  stuck: number
  lastError?: string
  pages: number
  deep: { lastFiredAt: number; lastSuccessAt: number; curatedThrough: number; failures: number }
  passes: PassSummary[]
  spend: { calls: number; failed: number; usd: number; tokensIn: number; tokensOut: number }
}

/**
 * Everything you would want to know before trusting what the curator did.
 *
 * Deliberately reads state that already exists rather than adding a run table:
 * the journal is the record of what changed, `llm_calls` of what it cost, and
 * the watermark of how far it got. A separate status table would be a fourth
 * source of truth that could disagree with the other three.
 */
export async function hopprHealth(h: Hoppr): Promise<HopprHealth> {
  const db = await h.db()
  const one = <T>(sql: string, params: Record<string, unknown> = {}): T | undefined =>
    db.prepare<T>(sql).get(params)

  const passes = db
    .prepare<PassSummary>(
      `SELECT pass_id AS passId, min(ts) AS started, max(ts) AS ended, count(*) AS ops,
              sum(op = 'create') AS created, sum(op = 'update') AS updated,
              group_concat(DISTINCT target_kind) AS kinds
         FROM journal GROUP BY pass_id ORDER BY started DESC LIMIT 20`,
    )
    .all({})

  const counts = one<{ captures: number; pending: number; stuck: number }>(
    `SELECT count(*) AS captures,
            sum(curate_stale = 1 AND curate_fails < 3 AND partial = 0) AS pending,
            sum(curate_fails >= 3) AS stuck
       FROM raw`,
  )
  const lastError = one<{ curate_error: string }>(
    `SELECT curate_error FROM raw
      WHERE curate_error IS NOT NULL ORDER BY captured DESC LIMIT 1`,
  )?.curate_error
  const spend = one<{
    calls: number
    failed: number
    usd: number
    tokensIn: number
    tokensOut: number
  }>(
    `SELECT count(*) AS calls, sum(ok = 0) AS failed, coalesce(sum(cost_usd), 0) AS usd,
            coalesce(sum(input_tokens), 0) AS tokensIn, coalesce(sum(output_tokens), 0) AS tokensOut
       FROM llm_calls`,
  )

  return {
    hopper: h.name,
    root: h.layout.root,
    captures: counts?.captures ?? 0,
    pending: counts?.pending ?? 0,
    stuck: counts?.stuck ?? 0,
    lastError: lastError ?? undefined,
    pages: one<{ n: number }>('SELECT count(*) AS n FROM wiki')?.n ?? 0,
    deep: getRun(db, 'deep'),
    passes,
    spend: spend ?? { calls: 0, failed: 0, usd: 0, tokensIn: 0, tokensOut: 0 },
  }
}

export interface DaemonHealth {
  running: boolean
  pid?: number
  port?: number
  startedAt?: number
  managed: string[]
  log: string[]
}

/** Global daemon state — the same lock the CLI reads, plus the log tail. */
export async function daemonHealth(managed: string[], tail = 40): Promise<DaemonHealth> {
  const info = await lock.status(Layout.daemonFileGlobal())
  const logPath = Layout.daemonLogGlobal()
  let log: string[] = []
  if (existsSync(logPath)) {
    try {
      // Small enough to read whole; the daemon writes one line per event.
      const text = await readFile(logPath, 'utf8')
      log = text.split('\n').filter(Boolean).slice(-tail).reverse()
    } catch {
      /* a log we cannot read is not a reason to fail the health check */
    }
  }
  return {
    running: Boolean(info),
    pid: info?.pid,
    port: info?.port,
    startedAt: info?.startedAt,
    managed,
    log,
  }
}
