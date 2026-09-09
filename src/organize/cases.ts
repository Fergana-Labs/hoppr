import type { Config } from '../config/schema.ts'
import { sha256 } from '../core/hash.ts'
import type { Db } from '../db/driver.ts'

/**
 * Turn recorded corrections into replayable cases.
 *
 * A correction already carries everything a test case needs: the situation,
 * what the agent did, and what the person said instead. What it does not carry
 * is a boundary — the extractor stored the quote, not the point in the
 * transcript before which the agent had not yet been told. Drawing that
 * boundary is all this module does, and it is the only part of the bench that
 * has to be exactly right.
 *
 * **The lead-in must stop before the correction.** Everything else here is
 * bookkeeping; this one property is what makes a replay mean anything. A
 * lead-in that includes the person's objection hands both arms the answer,
 * every candidate scores perfectly, and the bench becomes an expensive way to
 * agree with itself.
 *
 * No model calls. A case is cut out of a transcript by string arithmetic, so
 * rebuilding the whole store's cases is free and the cut is inspectable.
 */
export interface CaseRow {
  id: string
  correction_id: string
  raw_id: string
  mode: string
  /** The coherent sub-group a guardrail is actually written from. */
  cluster: string
  lead_in: string
  wrong_move: string
  correction: string
  severity: 'annoyance' | 'rework' | 'damage'
  split: 'train' | 'holdout'
}

export interface CaseStats {
  built: number
  /** Corrections whose mode turned out to hold more than one failure. */
  split: number
  /** Corrections whose quote could not be located in the transcript body. */
  unplaceable: number
  train: number
  holdout: number
  logLine: string
}

/** How much of the run-up to show an arm. Enough to see the task and the drift. */
const LEAD_CHARS = 6000
/** How far back to look for what the agent had just done. */
const MOVE_CHARS = 1500

export async function buildCases(
  db: Db,
  opts: { limit?: number; config?: Config } = {},
): Promise<CaseStats> {
  const st: CaseStats = { built: 0, unplaceable: 0, train: 0, holdout: 0, split: 0, logLine: '' }

  // Cluster first, so a case is born with the key its guardrail will claim.
  // Both are pure code over text already in the table, so doing it on every
  // build keeps them in step at no cost.
  const { assignClusters } = await import('./corrections.ts')
  st.split = (await assignClusters(db, opts.config)).split

  const pending = db
    .prepare<{
      id: string
      raw_id: string
      mode: string
      cluster: string
      headline: string
      quote: string
      severity: string
      text: string
    }>(
      `SELECT c.id, c.raw_id, c.mode, c.cluster, c.headline, c.quote, c.severity, r.text
         FROM corrections c
         JOIN raw r ON r.id = c.raw_id
        WHERE r.text IS NOT NULL
          AND c.id NOT IN (SELECT correction_id FROM cases)
        ORDER BY c.observed DESC LIMIT :n`,
    )
    .all({ n: opts.limit ?? 200 })

  for (const c of pending) {
    const cut = cutLeadIn(c.text, c.quote)
    if (!cut) {
      // The quote lives only in the `## Prompts` block, which is a flat list
      // with no surrounding turns — there is no "before" to replay from. A
      // case without a lead-in is not a weaker case, it is not a case.
      st.unplaceable++
      continue
    }
    const id = sha256(`case ${c.id}`).slice(0, 24)
    const split = splitFor(id)
    db.prepare(
      `INSERT INTO cases(id, correction_id, raw_id, mode, cluster, lead_in, wrong_move,
                         correction, severity, split, created)
       VALUES (:id,:cid,:raw,:mode,:cluster,:lead,:move,:corr,:sev,:split,:now)
       ON CONFLICT(id) DO NOTHING`,
    ).run({
      id,
      cid: c.id,
      raw: c.raw_id,
      mode: c.mode,
      cluster: c.cluster || c.mode,
      lead: cut.leadIn,
      move: cut.wrongMove || c.headline,
      corr: c.quote,
      sev: c.severity,
      split,
      now: Date.now(),
    })
    st.built++
    if (split === 'train') st.train++
    else st.holdout++
  }

  st.logLine = st.built
    ? `${st.built} cases (${st.train} train, ${st.holdout} holdout)` +
      (st.split ? `, ${st.split} in a split mode` : '')
    : ''
  return st
}

/**
 * Which half a case belongs to, decided by its id and nothing else.
 *
 * Deterministic on purpose. A split re-rolled each pass would let a skill
 * drift into passing by being scored repeatedly until the easy cases happened
 * to land on the holdout side — which is the failure mode a held-out split
 * exists to prevent, reintroduced by the mechanism meant to implement it.
 */
export function splitFor(id: string): 'train' | 'holdout' {
  // `sha256()` returns a `sha256:`-prefixed digest, so parsing from character
  // zero yields NaN, and `NaN % 2 === 0` is false — which silently assigned
  // every case in the store to the holdout side and left the train half empty.
  // The whole held-out design was inert and nothing about it looked wrong.
  const hex = sha256(`split ${id}`).split(':').pop() ?? ''
  return Number.parseInt(hex.slice(0, 8), 16) % 2 === 0 ? 'train' : 'holdout'
}

export interface Cut {
  leadIn: string
  wrongMove: string
}

/**
 * Everything before the person objected, and what the agent had just done.
 *
 * Searched from `## Transcript` onward. A rendered session repeats every user
 * turn in a `## Prompts` block above the body, and matching there would cut
 * the lead-in out of a list of prompts rather than out of the conversation.
 */
export function cutLeadIn(text: string, quote: string): Cut | null {
  const from = text.indexOf('\n## Transcript')
  if (from < 0) return null
  const body = text.slice(from)

  const needle = quote.slice(0, 40).toLowerCase()
  if (needle.length < 12) return null
  const at = body.toLowerCase().indexOf(needle)
  if (at < 0) return null

  // Back up to the start of the line the correction is on, so no part of the
  // person's objection — not even the `**user:**` marker — survives into the
  // lead-in. An arm that can see a user turn is about to begin knows one is
  // coming, and that is a hint the real agent did not have.
  const lineStart = body.lastIndexOf('\n', at)
  const end = lineStart < 0 ? at : lineStart

  const leadIn = body.slice(Math.max(0, end - LEAD_CHARS), end).trimEnd()
  if (leadIn.length < 80) return null

  return { leadIn, wrongMove: lastAssistantTurn(body.slice(Math.max(0, end - MOVE_CHARS), end)) }
}

/** The agent's last action before the objection — the thing being corrected. */
function lastAssistantTurn(window: string): string {
  const turns = [...window.matchAll(/^(?:\*\*assistant:\*\*|→)\s?(.*)$/gm)]
  const last = turns.at(-1)
  return last ? (last[0] ?? '').trim().slice(0, 600) : ''
}

export interface CaseQuery {
  /**
   * A cluster key, which is a mode name for a mode that held together and
   * `mode~2` for the groups after the largest. Matched against `cluster` so a
   * guardrail selects the cases it actually claims rather than everything
   * filed under a mode it only partly covers.
   */
  mode?: string
  split?: 'train' | 'holdout'
  /** Exclude this cluster — used to sample unrelated cases for regression checks. */
  notMode?: string
  limit?: number
}

export function listCases(db: Db, q: CaseQuery = {}): CaseRow[] {
  const where: string[] = []
  const params: Record<string, string | number> = { n: q.limit ?? 50 }
  if (q.mode) {
    where.push("COALESCE(NULLIF(cluster, ''), mode) = :mode")
    params.mode = q.mode
  }
  if (q.notMode) {
    where.push("COALESCE(NULLIF(cluster, ''), mode) <> :notMode")
    params.notMode = q.notMode
  }
  if (q.split) {
    where.push('split = :split')
    params.split = q.split
  }
  return db
    .prepare<CaseRow>(
      `SELECT * FROM cases
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY id LIMIT :n`,
    )
    .all(params)
}

export function caseCounts(db: Db): { total: number; train: number; holdout: number } {
  const r = db
    .prepare<{ total: number; train: number; holdout: number }>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(split = 'train'), 0) AS train,
              COALESCE(SUM(split = 'holdout'), 0) AS holdout
         FROM cases`,
    )
    .get()
  return { total: r?.total ?? 0, train: r?.train ?? 0, holdout: r?.holdout ?? 0 }
}
