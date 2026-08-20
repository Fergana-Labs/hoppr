import { existsSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { newId } from '../core/ids.ts'
import type { Db } from '../db/driver.ts'
import { writeAtomic } from '../store/atomic.ts'
import type { Layout } from '../store/layout.ts'

export type JournalOp = 'create' | 'update' | 'delete'

export interface JournalEntry {
  passId: string
  targetKind: string
  targetId: string
  op: JournalOp
  /** File contents before and after — enough to reverse the write exactly. */
  before?: string
  after?: string
}

/**
 * The undo log.
 *
 * By construction it can only ever contain `curated/` mutations, because the
 * curator has no write path to tier 1 — so `hoppr undo` is safe in a way that
 * does not depend on getting the implementation right. It complements git
 * rather than duplicating it: git gives you commit-level revert, the journal
 * gives you pass-level revert even when the store is not a repo or the pass
 * has not been committed yet.
 */
export function record(db: Db, e: JournalEntry): void {
  db.prepare(
    `INSERT INTO journal(pass_id, ts, target_kind, target_id, op, before, after)
     VALUES (:p, :ts, :k, :id, :op, :before, :after)`,
  ).run({
    p: e.passId,
    ts: Date.now(),
    k: e.targetKind,
    id: e.targetId,
    op: e.op,
    before: e.before ?? null,
    after: e.after ?? null,
  })
}

export function newPassId(): string {
  return newId()
}

export interface PassSummary {
  passId: string
  ts: number
  entries: number
  kinds: Record<string, number>
}

export function listPasses(db: Db, limit = 20): PassSummary[] {
  const rows = db
    .prepare<{ pass_id: string; ts: number; n: number }>(
      `SELECT pass_id, MAX(ts) ts, COUNT(*) n FROM journal
       GROUP BY pass_id ORDER BY ts DESC LIMIT :n`,
    )
    .all({ n: limit })
  return rows.map((r) => ({
    passId: r.pass_id,
    ts: r.ts,
    entries: r.n,
    kinds: Object.fromEntries(
      db
        .prepare<{ target_kind: string; n: number }>(
          'SELECT target_kind, COUNT(*) n FROM journal WHERE pass_id = :p GROUP BY target_kind',
        )
        .all({ p: r.pass_id })
        .map((k) => [k.target_kind, k.n]),
    ),
  }))
}

export interface UndoResult {
  restored: number
  deleted: number
  missing: number
}

/**
 * Replay a pass backwards. Newest entry first, so a page created and then
 * updated within the same pass unwinds in the right order.
 */
export async function undoPass(db: Db, l: Layout, passId: string): Promise<UndoResult> {
  const entries = db
    .prepare<{
      id: number
      target_kind: string
      target_id: string
      op: string
      before: string | null
    }>(
      `SELECT id, target_kind, target_id, op, before FROM journal
        WHERE pass_id = :p ORDER BY id DESC`,
    )
    .all({ p: passId })

  const out: UndoResult = { restored: 0, deleted: 0, missing: 0 }
  for (const e of entries) {
    const abs = join(l.root, e.target_id)
    if (e.op === 'create') {
      if (existsSync(abs)) {
        await unlink(abs)
        out.deleted++
      } else out.missing++
    } else if (e.before != null) {
      await writeAtomic(abs, e.before)
      out.restored++
    } else {
      out.missing++
    }
  }
  db.prepare('DELETE FROM journal WHERE pass_id = :p').run({ p: passId })
  return out
}

/** Read a file's current bytes for the `before` side of an entry. */
export async function snapshot(l: Layout, relPath: string): Promise<string | undefined> {
  const abs = join(l.root, relPath)
  return existsSync(abs) ? readFile(abs, 'utf8') : undefined
}
