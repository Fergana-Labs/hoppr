import type { Db } from '../db/driver.ts'
import type { QueryFilters } from './query.ts'
import { toMatchExpression } from './query.ts'

export interface Candidate {
  docId: string
  rowid: number
  /** Lower is better for bm25; callers only use the rank order. */
  score: number
}

export interface FilterSql {
  where: string
  params: Record<string, unknown>
}

/**
 * Build the filter predicate once and push it into every retrieval arm.
 *
 * Filters run INSIDE each arm, before ranking — never as a post-filter on the
 * fused result set. Post-filtering silently empties your results when the
 * top-K happens to miss the filtered subset, which reads to the user as "there
 * is nothing about X" rather than "the filter was too narrow".
 */
export function buildFilters(f: QueryFilters, alias = 'd'): FilterSql {
  const clauses: string[] = []
  const params: Record<string, unknown> = {}

  if (f.scope && f.scope !== 'all') {
    clauses.push(`${alias}.tier = :tier`)
    params.tier = f.scope
  }
  if (f.kinds.length) {
    clauses.push(`${alias}.kind IN (${f.kinds.map((_, i) => `:kind${i}`).join(',')})`)
    f.kinds.forEach((k, i) => {
      params[`kind${i}`] = k
    })
  }
  if (f.project) {
    clauses.push(`${alias}.project = :project`)
    params.project = f.project
  }
  if (f.confidence) {
    clauses.push(`${alias}.confidence = :confidence`)
    params.confidence = f.confidence
  }
  if (f.since !== undefined) {
    clauses.push(`${alias}.created >= :since`)
    params.since = f.since
  }
  if (f.until !== undefined) {
    clauses.push(`${alias}.created <= :until`)
    params.until = f.until
  }
  // Tags live on the wiki page, not the projection row, so match them through
  // the doc's tags_text as well as the relation — a raw capture carries tags
  // from its origin and has no wiki row yet.
  f.tags.forEach((t, i) => {
    clauses.push(
      `(:tag${i} IN (SELECT tag FROM wiki_tags WHERE page_id = ${alias}.ref_id)
        OR ' ' || ${alias}.tags_text || ' ' LIKE '% ' || :tag${i} || ' %')`,
    )
    params[`tag${i}`] = t
  })
  f.notTags.forEach((t, i) => {
    clauses.push(
      `NOT (:ntag${i} IN (SELECT tag FROM wiki_tags WHERE page_id = ${alias}.ref_id)
        OR ' ' || ${alias}.tags_text || ' ' LIKE '% ' || :ntag${i} || ' %')`,
    )
    params[`ntag${i}`] = t
  })

  return { where: clauses.length ? `AND ${clauses.join(' AND ')}` : '', params }
}

/**
 * Lexical arm.
 *
 * Selects ONLY rowid and score — no body, no snippet(). Materializing text for
 * every candidate would mean reading 40KB transcripts for results that never
 * get returned; snippets are built after fusion, for the ~10 rows that survive.
 */
export function ftsSearch(db: Db, text: string, f: QueryFilters, k: number): Candidate[] {
  const match = toMatchExpression(text)
  if (!match) return []
  const { where, params } = buildFilters(f)

  return db
    .prepare<{ id: string; rowid: number; score: number }>(
      `SELECT d.id AS id, d.rowid AS rowid, bm25(docs_fts, 4.0, 2.0, 2.0, 1.0) AS score
         FROM docs_fts
         JOIN docs d ON d.rowid = docs_fts.rowid
        WHERE docs_fts MATCH :match ${where}
        ORDER BY score
        LIMIT :k`,
    )
    .all({ ...params, match, k })
    .map((r) => ({ docId: r.id, rowid: r.rowid, score: r.score }))
}

/** Pure filter listing: no query text, so no ranking to do. */
export function filterOnly(db: Db, f: QueryFilters, k: number): Candidate[] {
  const { where, params } = buildFilters(f)
  return db
    .prepare<{ id: string; rowid: number }>(
      `SELECT d.id AS id, d.rowid AS rowid
         FROM docs d
        WHERE 1=1 ${where}
        ORDER BY d.created DESC
        LIMIT :k`,
    )
    .all({ ...params, k })
    .map((r, i) => ({ docId: r.id, rowid: r.rowid, score: i }))
}
