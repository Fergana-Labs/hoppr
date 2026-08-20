import type { Db } from '../db/driver.ts'

export interface RunState {
  lastFiredAt: number
  lastSuccessAt: number
  curatedThrough: number
  failures: number
}

export function getRun(db: Db, name: string): RunState {
  const row = db
    .prepare<{ value: string }>('SELECT value FROM watermarks WHERE key = :k')
    .get({ k: `run.${name}` })
  if (!row) return { lastFiredAt: 0, lastSuccessAt: 0, curatedThrough: 0, failures: 0 }
  try {
    return JSON.parse(row.value) as RunState
  } catch {
    return { lastFiredAt: 0, lastSuccessAt: 0, curatedThrough: 0, failures: 0 }
  }
}

function putRun(db: Db, name: string, s: RunState): void {
  db.prepare(
    `INSERT INTO watermarks(key, value, updated_at) VALUES (:k,:v,:t)
     ON CONFLICT(key) DO UPDATE SET value = :v, updated_at = :t`,
  ).run({ k: `run.${name}`, v: JSON.stringify(s), t: Date.now() })
}

/**
 * Consume the tick BEFORE doing the work.
 *
 * A pass that takes forty minutes must not be re-fired by the next tick, and a
 * pass that crashes must not be retried instantly in a loop. Claiming the tick
 * up front makes both impossible, at the cost of occasionally skipping one
 * window — which the watermark below makes harmless.
 */
export function claimTick(db: Db, name: string, minIntervalMs: number, now = Date.now()): boolean {
  const s = getRun(db, name)
  if (now - s.lastFiredAt < minIntervalMs) return false
  putRun(db, name, { ...s, lastFiredAt: now })
  return true
}

/**
 * Advance the watermark ONLY on success.
 *
 * This is what makes a skipped or failed run harmless: the next run still sees
 * everything since the last *successful* one, so a week of missed nightly
 * passes is one bigger pass, not seven lost ones.
 */
export function markSuccess(db: Db, name: string, highWater: number, now = Date.now()): void {
  const s = getRun(db, name)
  putRun(db, name, {
    ...s,
    lastSuccessAt: now,
    curatedThrough: Math.max(s.curatedThrough, highWater),
    failures: 0,
  })
}

export function markFailure(db: Db, name: string): void {
  const s = getRun(db, name)
  putRun(db, name, { ...s, failures: s.failures + 1 })
}

/**
 * Laptops are asleep at 3am. If a window was missed by more than half an
 * interval, fire on wake rather than silently waiting a full day.
 */
export function isOverdue(db: Db, name: string, intervalMs: number, now = Date.now()): boolean {
  const s = getRun(db, name)
  if (s.lastFiredAt === 0) return false
  return now - s.lastFiredAt > intervalMs * 1.5
}

/** Cheap gate: one boolean query, so an idle day costs almost nothing. */
export function hasWorkSince(db: Db, since: number): boolean {
  return Boolean(
    db
      .prepare<{ n: number }>('SELECT 1 AS n FROM raw WHERE captured > :s LIMIT 1')
      .get({ s: since }),
  )
}

export function highWaterMark(db: Db): number {
  return db.prepare<{ m: number }>('SELECT COALESCE(MAX(captured),0) m FROM raw').get()?.m ?? 0
}
