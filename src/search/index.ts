import type { Config } from '../config/schema.ts'
import type { Db } from '../db/driver.ts'
import { buildFilters, type Candidate, filterOnly, ftsSearch } from './fts.ts'
import { type Arm, applyBoosts, rrf } from './fuse.ts'
import { type ParsedQuery, parseQuery } from './query.ts'
import { snippetFor } from './snippet.ts'
import { vectorSearch } from './vector.ts'

export interface SearchHit {
  id: string
  tier: string
  kind: string
  refId: string
  title: string
  summary: string
  project?: string
  confidence: string
  tags: string[]
  created: number
  updated: number
  score: number
  snippet: string
  /** Why this hit ranked where it did — surfaced by `--explain`. */
  why: { ranks: Record<string, number>; base: number; boosted: number }
  /** Set when a raw capture matched but a curated page superseded it. */
  matchedInSource?: string
}

export interface SearchOptions {
  limit?: number
  mode?: 'hybrid' | 'fts' | 'vec'
  scope?: 'curated' | 'raw' | 'all'
  explain?: boolean
  /** Pin "now" for the recency boost. Ranking is stable regardless; this makes
   *  the absolute scores reproducible for tests and for explain output. */
  now?: number
  /** Pre-computed query embedding. Search stays synchronous and testable; the
   *  caller decides whether paying for an embedding is worth it. */
  queryVector?: Float32Array
}

export interface SearchResult {
  hits: SearchHit[]
  query: ParsedQuery
  meta: { candidates: number; arms: string[]; tookMs: number; mode: string }
}

interface DocRow {
  id: string
  tier: string
  kind: string
  ref_id: string
  title: string
  summary: string
  body: string
  tags_text: string
  project: string | null
  confidence: string
  created: number
  updated: number
}

export function search(db: Db, cfg: Config, input: string, opts: SearchOptions = {}): SearchResult {
  const started = Date.now()
  const limit = opts.limit ?? cfg.search.limit
  const mode = opts.mode ?? 'hybrid'
  const parsed = parseQuery(input, {
    scope: opts.scope ?? (cfg.search.default_scope as 'curated' | 'raw' | 'all'),
  })
  const k = Math.max(50, limit * 5)

  const arms: Arm[] = []
  if (parsed.text) {
    if (mode !== 'vec') {
      arms.push({
        name: 'fts',
        weight: 1,
        candidates: ftsSearch(db, parsed.text, parsed.filters, k),
      })
    }
    if (mode !== 'fts' && opts.queryVector) {
      arms.push({
        name: 'vec',
        weight: 1,
        candidates: vectorSearch(db, opts.queryVector, parsed.filters, k),
      })
    }
  }

  const fused = parsed.text
    ? rrf(arms, { k: cfg.search.rrf_k })
    : filterOnly(db, parsed.filters, k).map((c: Candidate) => ({
        docId: c.docId,
        score: 1 / (1 + c.score),
        ranks: { filter: c.score + 1 },
      }))

  if (fused.length === 0) {
    return {
      hits: [],
      query: parsed,
      meta: { candidates: 0, arms: arms.map((a) => a.name), tookMs: Date.now() - started, mode },
    }
  }

  const candidateCount = fused.length
  const docs = loadDocs(
    db,
    fused.map((f) => f.docId),
  )

  const boostCfg = {
    tier: cfg.search.tier_boost,
    kind: cfg.search.kind_boost,
    confidence: cfg.search.confidence_boost,
    recencyHalfLifeDays: cfg.search.recency_half_life_days,
    now: opts.now,
  }

  const scored = fused
    .map((f) => {
      const d = docs.get(f.docId)
      if (!d) return undefined
      const boosted = applyBoosts(f.score, d, boostCfg)
      return { fused: f, doc: d, boosted }
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x))
    .sort((a, b) => b.boosted - a.boosted)

  const collapsed = collapseRawIntoCurated(db, scored)

  // Snippets are materialized ONLY for the rows that survive to the response.
  // Building them earlier would mean reading full bodies for candidates that
  // never get returned.
  const hits: SearchHit[] = collapsed.slice(0, limit).map((s) => ({
    id: s.doc.id,
    tier: s.doc.tier,
    kind: s.doc.kind,
    refId: s.doc.ref_id,
    title: s.doc.title,
    summary: s.doc.summary,
    project: s.doc.project ?? undefined,
    confidence: s.doc.confidence,
    tags: s.doc.tags_text ? s.doc.tags_text.split(' ').filter(Boolean) : [],
    created: s.doc.created,
    updated: s.doc.updated,
    score: s.boosted,
    snippet: snippetFor(s.doc.body || s.doc.summary, parsed.text, cfg.search.max_snippet_chars),
    why: { ranks: s.fused.ranks, base: s.fused.score, boosted: s.boosted },
    matchedInSource: s.matchedInSource,
  }))

  return {
    hits,
    query: parsed,
    meta: {
      candidates: candidateCount,
      arms: arms.map((a) => a.name),
      tookMs: Date.now() - started,
      mode,
    },
  }
}

function loadDocs(db: Db, ids: string[]): Map<string, DocRow> {
  const out = new Map<string, DocRow>()
  const CHUNK = 400 // stay well under SQLite's variable limit
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK)
    const placeholders = slice.map((_, j) => `:id${j}`).join(',')
    const params: Record<string, unknown> = {}
    slice.forEach((id, j) => {
      params[`id${j}`] = id
    })
    for (const r of db
      .prepare<DocRow>(`SELECT * FROM docs WHERE id IN (${placeholders})`)
      .all(params)) {
      out.set(r.id, r)
    }
  }
  return out
}

interface Scored {
  fused: { docId: string; score: number; ranks: Record<string, number> }
  doc: DocRow
  boosted: number
  matchedInSource?: string
}

/**
 * A raw capture that already has a curated page collapses into that page.
 *
 * Without this you get the summary and the transcript it came from as two
 * competing results, which wastes the reader's attention and an agent's
 * context window on the same information twice. The raw id is kept as
 * `matchedInSource` so drilling down is still one hop away.
 */
function collapseRawIntoCurated(db: Db, scored: Scored[]): Scored[] {
  const rawIds = scored.filter((s) => s.doc.tier === 'raw').map((s) => s.doc.ref_id)
  if (rawIds.length === 0) return scored

  const owner = new Map<string, string>()
  const CHUNK = 400
  for (let i = 0; i < rawIds.length; i += CHUNK) {
    const slice = rawIds.slice(i, i + CHUNK)
    const ph = slice.map((_, j) => `:r${j}`).join(',')
    const params: Record<string, unknown> = {}
    slice.forEach((r, j) => {
      params[`r${j}`] = r
    })
    for (const row of db
      .prepare<{ raw_id: string; page_type: string; slug: string }>(
        `SELECT ws.raw_id AS raw_id, w.page_type AS page_type, w.slug AS slug
           FROM wiki_sources ws JOIN wiki w ON w.id = ws.page_id
          WHERE ws.raw_id IN (${ph})`,
      )
      .all(params)) {
      owner.set(row.raw_id, `wiki:${row.page_type}/${row.slug}`)
    }
  }
  if (owner.size === 0) return scored

  const byId = new Map(scored.map((s) => [s.doc.id, s]))
  const out: Scored[] = []
  const seen = new Set<string>()

  for (const s of scored) {
    if (s.doc.tier === 'raw') {
      const pageDocId = owner.get(s.doc.ref_id)
      const page = pageDocId ? byId.get(pageDocId) : undefined
      if (page) {
        // The page is already in the list and outranks its own source; just
        // record that the match came from the transcript.
        page.matchedInSource = s.doc.ref_id
        continue
      }
    }
    if (seen.has(s.doc.id)) continue
    seen.add(s.doc.id)
    out.push(s)
  }
  return out
}

export { parseQuery } from './query.ts'
export { buildFilters }
