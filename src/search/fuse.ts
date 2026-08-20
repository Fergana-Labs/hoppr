import type { Candidate } from './fts.ts'

export interface Arm {
  name: string
  weight: number
  candidates: Candidate[]
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
