import type { Db } from '../db/driver.ts'
import { toBlob, vecInt } from '../embed/provider.ts'
import type { Candidate } from './fts.ts'
import { buildFilters } from './fts.ts'
import type { QueryFilters } from './query.ts'

export interface VectorOptions {
  /** Above this many filtered docs, fall back to ANN + post-filter. */
  bruteForceCeiling?: number
}

export function vecTableExists(db: Db): boolean {
  return Boolean(
    db
      .prepare<{ n: number }>("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'vec_chunks'")
      .get()?.n,
  )
}

/**
 * Semantic arm.
 *
 * Two retrieval paths, because tag and project filters are multi-valued and so
 * cannot be vec0 metadata columns:
 *
 *  - **Narrow filter** (the common case): resolve the filtered doc set first,
 *    then brute-force cosine over just those chunks. Exact, with none of the
 *    recall loss an ANN index has when most of the corpus is filtered away —
 *    which is precisely when ANN is worst and users are most confused.
 *  - **Wide or no filter**: real KNN with `tier`/`kind`/`created_day` pushed
 *    down as vec0 metadata columns, over-fetching so post-filtering still
 *    leaves enough candidates.
 *
 * Returns at most one candidate per document — the best-matching chunk — so
 * one long transcript cannot occupy the whole result page.
 */
export function vectorSearch(
  db: Db,
  queryVec: Float32Array,
  f: QueryFilters,
  k: number,
  opts: VectorOptions = {},
): Candidate[] {
  if (!vecTableExists(db)) return []
  const ceiling = opts.bruteForceCeiling ?? 5000
  const { where, params } = buildFilters(f)
  const needsRowFilter = f.tags.length > 0 || f.notTags.length > 0 || Boolean(f.project)

  if (needsRowFilter) {
    const ids = db
      .prepare<{ id: string }>(`SELECT d.id AS id FROM docs d WHERE 1=1 ${where} LIMIT :cap`)
      .all({ ...params, cap: ceiling + 1 })
      .map((r) => r.id)

    if (ids.length === 0) return []
    if (ids.length <= ceiling) return bruteForce(db, queryVec, ids, k)
    // Too many to scan exactly; fall through to ANN with a wider net.
  }

  return knn(db, queryVec, f, k, where, params)
}

function knn(
  db: Db,
  queryVec: Float32Array,
  f: QueryFilters,
  k: number,
  where: string,
  params: Record<string, unknown>,
): Candidate[] {
  const meta: string[] = []
  const mp: Record<string, unknown> = {}
  if (f.scope && f.scope !== 'all') {
    meta.push('AND v.tier = :vtier')
    mp.vtier = f.scope
  }
  if (f.kinds.length === 1) {
    meta.push('AND v.kind = :vkind')
    mp.vkind = f.kinds[0]
  }
  if (f.since !== undefined) {
    meta.push('AND v.created_day >= :vday')
    mp.vday = vecInt(f.since / 86_400_000)
  }

  // Over-fetch: post-filtering on anything vec0 cannot push down would
  // otherwise return a short page that reads as "no results".
  const overfetch = Math.min(k * 8, 2000)

  const rows = db
    .prepare<{ doc_id: string; rowid: number; distance: number }>(
      `SELECT v.doc_id AS doc_id, v.chunk_id AS rowid, v.distance AS distance
         FROM vec_chunks v
        WHERE v.embedding MATCH :q AND k = :k ${meta.join(' ')}`,
    )
    .all({ ...mp, q: toBlob(queryVec), k: vecInt(overfetch) })

  return dedupeByDoc(db, rows, f, where, params, k)
}

function bruteForce(db: Db, queryVec: Float32Array, ids: string[], k: number): Candidate[] {
  const out: Array<{ doc_id: string; rowid: number; distance: number }> = []
  const CHUNK = 400
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK)
    const ph = slice.map((_, j) => `:d${j}`).join(',')
    const p: Record<string, unknown> = { q: toBlob(queryVec) }
    slice.forEach((id, j) => {
      p[`d${j}`] = id
    })
    out.push(
      ...db
        .prepare<{ doc_id: string; rowid: number; distance: number }>(
          `SELECT doc_id, chunk_id AS rowid, vec_distance_cosine(embedding, :q) AS distance
             FROM vec_chunks
            WHERE doc_id IN (${ph})`,
        )
        .all(p),
    )
  }
  out.sort((a, b) => a.distance - b.distance)
  return collapse(out, k)
}

function dedupeByDoc(
  db: Db,
  rows: Array<{ doc_id: string; rowid: number; distance: number }>,
  f: QueryFilters,
  where: string,
  params: Record<string, unknown>,
  k: number,
): Candidate[] {
  if (rows.length === 0) return []
  const needsPostFilter =
    f.tags.length > 0 || f.notTags.length > 0 || Boolean(f.project) || f.kinds.length > 1

  let allowed: Set<string> | undefined
  if (needsPostFilter) {
    allowed = new Set(
      db
        .prepare<{ id: string }>(`SELECT d.id AS id FROM docs d WHERE 1=1 ${where}`)
        .all(params)
        .map((r) => r.id),
    )
  }
  const kept = allowed ? rows.filter((r) => allowed.has(r.doc_id)) : rows
  kept.sort((a, b) => a.distance - b.distance)
  return collapse(kept, k)
}

/** Best chunk per document, so one long transcript cannot flood the page. */
function collapse(
  rows: Array<{ doc_id: string; rowid: number; distance: number }>,
  k: number,
): Candidate[] {
  const best = new Map<string, Candidate>()
  for (const r of rows) {
    if (best.has(r.doc_id)) continue
    best.set(r.doc_id, { docId: r.doc_id, rowid: r.rowid, score: r.distance })
    if (best.size >= k) break
  }
  return [...best.values()]
}
