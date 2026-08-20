import type { Candidate } from './fts.ts'

export interface Arm {
  name: string
  weight: number
  candidates: Candidate[]
  /**
   * bm25 scores are unbounded NEGATIVE and better when lower; cosine distance
   * is 0..2 and also better when lower. Rank-based fusion never has to know
   * this, which is most of why it is the default — but any method that touches
   * the raw numbers does, or it ranks the corpus backwards.
   */
  lowerIsBetter?: boolean
}

export interface FusedHit {
  docId: string
  score: number
  /** Per-arm rank, 1-based. Absent means that arm did not return this doc. */
  ranks: Record<string, number>
}

export interface FuseOptions {
  k?: number
}

export type RerankMethod = 'rrf' | 'weighted' | 'none'

/**
 * Pick a fusion method.
 *
 * `rrf` is the default and should stay so; the alternatives exist because
 * "which reranker" is a legitimate thing to want to change, not because they
 * are usually better:
 *
 *   weighted — normalises each arm to 0..1 and blends. Tunable, and worse in a
 *              specific way: the normalisation is computed per query from that
 *              query's own score range, so a doc's contribution depends on
 *              what else happened to match. Fine when one arm is known to be
 *              stronger and you want to say so numerically.
 *   none     — take the first arm as-is. Useful for debugging a ranking
 *              complaint, and for a hoppr with no vector index where fusing
 *              one arm with nothing is just overhead.
 */
export function fuse(arms: Arm[], method: RerankMethod, opts: FuseOptions = {}): FusedHit[] {
  if (method === 'none') {
    const first = arms.find((a) => a.candidates.length) ?? arms[0]
    return (first?.candidates ?? []).map((c, i) => ({
      docId: c.docId,
      // Descending, and spaced so downstream boosts still discriminate.
      score: 1 / (i + 1),
      ranks: { [first?.name ?? 'keyword']: i + 1 },
    }))
  }
  return method === 'weighted' ? weighted(arms) : rrf(arms, opts)
}

/**
 * Min-max normalise each arm, then blend by weight.
 *
 * Arms are normalised INDEPENDENTLY because their scales are unrelated — bm25
 * is unbounded negative, cosine distance is 0..2. An arm whose scores are all
 * equal contributes a flat 1, not a division by zero.
 */
export function weighted(arms: Arm[]): FusedHit[] {
  const acc = new Map<string, FusedHit>()
  for (const arm of arms) {
    const scores = arm.candidates.map((c) => c.score)
    const lo = Math.min(...scores)
    const hi = Math.max(...scores)
    const span = hi - lo
    arm.candidates.forEach((cand, i) => {
      const raw = span === 0 ? 1 : (cand.score - lo) / span
      const norm = arm.lowerIsBetter === false ? raw : 1 - raw
      let hit = acc.get(cand.docId)
      if (!hit) {
        hit = { docId: cand.docId, score: 0, ranks: {} }
        acc.set(cand.docId, hit)
      }
      hit.score += arm.weight * norm
      hit.ranks[arm.name] = i + 1
    })
  }
  return [...acc.values()].sort((a, b) => b.score - a.score)
}

/**
 * Reciprocal rank fusion.
 *
 * RRF is chosen precisely because it needs no score normalization between
 * arms: bm25 returns unbounded negatives, cosine distance returns 0..2, and
 * any attempt to blend those numerically requires calibration that drifts the
 * moment you change a model. Rank position is comparable across arms by
 * construction, so RRF stays correct with no tuning.
 */
export function rrf(arms: Arm[], opts: FuseOptions = {}): FusedHit[] {
  const k = opts.k ?? 60
  const acc = new Map<string, FusedHit>()

  for (const arm of arms) {
    arm.candidates.forEach((c, i) => {
      const rank = i + 1
      let hit = acc.get(c.docId)
      if (!hit) {
        hit = { docId: c.docId, score: 0, ranks: {} }
        acc.set(c.docId, hit)
      }
      hit.score += arm.weight / (k + rank)
      hit.ranks[arm.name] = rank
    })
  }

  return [...acc.values()].sort((a, b) => b.score - a.score)
}

export interface BoostInput {
  tier: string
  kind: string
  confidence: string
  created: number
  pinned?: boolean
}

export interface BoostConfig {
  tier: Record<string, number>
  kind: Record<string, number>
  confidence: Record<string, number>
  recencyHalfLifeDays: number
  now?: number
}

/**
 * Post-fusion boosts, applied multiplicatively so they scale the fused score
 * rather than distorting the rank scale it was computed on.
 *
 * The tier boost is the important one: a curated page should outrank the
 * transcript it was distilled from, because the distillation is what the
 * reader actually wants — but the transcript stays reachable one hop away.
 */
export function applyBoosts(base: number, doc: BoostInput, cfg: BoostConfig): number {
  let s = base
  s *= cfg.tier[doc.tier] ?? 1
  s *= cfg.kind[doc.kind] ?? 1
  s *= cfg.confidence[doc.confidence] ?? 1
  if (doc.pinned) s *= 1.15

  const ageDays = ((cfg.now ?? Date.now()) - doc.created) / 86_400_000
  if (ageDays > 0 && cfg.recencyHalfLifeDays > 0) {
    // Gentle decay, never elimination: a five-year-old note that is the only
    // answer must still be findable.
    s *= 0.6 + 0.4 * 2 ** (-ageDays / cfg.recencyHalfLifeDays)
  }
  return s
}
