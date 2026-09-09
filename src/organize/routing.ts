import type { Config } from '../config/schema.ts'
import type { Db } from '../db/driver.ts'
import type { Embedder } from '../embed/provider.ts'
import { listCases } from './cases.ts'
import { listSkills, type SkillRow } from './skills.ts'

/**
 * Can an agent find the right skill when it needs it?
 *
 * Every other check here asks whether a skill is any good. This asks whether
 * it is reachable, which is a separate failure and the one that scales
 * against you. Measured with pool composition held fixed and only size varied,
 * the precision with which an agent actually uses the right skill collapses
 * from 29.6% at five skills to 3.3% at a hundred — and splitting by
 * composition shows *confusability* is the stressor rather than count: top-1
 * on pools of similar skills falls 70.5% → 53.4%, against 97.7% → 84.1% on
 * random ones.
 *
 * hoppr sits in the worst corner of that measurement twice over. It mines
 * automatically, so it reaches large pools without anyone deciding to, and
 * every skill is distilled from one person's work, so the pool is similar by
 * construction. A store that mines well and routes badly has spent real money
 * to make its own skills unreachable.
 *
 * **This measures offline identification, not task success.** The same study
 * is explicit that the two come apart — exact ground-truth invocation is
 * neither sufficient nor strictly necessary for the task to come out right.
 * A falling number here is a reason to merge or narrow skills, not a
 * prediction that work will fail.
 */
export interface Fixture {
  /** The situation, as it looked just before the agent went wrong. */
  situation: string
  /** The skill that should have been reached for. */
  expect: string
  mode: string
}

/**
 * Routing fixtures, free as a by-product of the bench.
 *
 * gbrain's skillify demands "trigger phrases users ACTUALLY type", which an
 * author normally has to invent — and inventing them tests the author's
 * imagination rather than the router. hoppr does not have to: a case already
 * holds the real situation, and the guardrail mined from that case's mode is
 * the skill that should fire in it.
 *
 * The situation is `wrong_move` — what the agent was about to do — with a
 * little of the run-up behind it.
 *
 * The first version used the tail of the lead-in, which measured the wrong
 * thing. A transcript tail is whatever prose the session happened to end on,
 * and on real cases here that was an assistant sign-off: "Say the word and
 * I'll do the same sweep there. Session: https://…". Scoring that against a
 * skill description compares two unrelated kinds of text and reports the
 * mismatch as though the skills were confusable.
 *
 * `wrong_move` is the symmetric comparison. A description says "use when about
 * to <do a thing>"; `wrong_move` says what thing was about to be done. That is
 * the same question from both sides, which is what a routing measurement needs
 * to be measuring.
 */
export function fixturesFrom(db: Db, opts: { tail?: number } = {}): Fixture[] {
  const byMode = new Map<string, string>()
  for (const s of liveSkills(db)) {
    if (s.prevents && !byMode.has(s.prevents)) byMode.set(s.prevents, s.slug)
  }
  if (byMode.size === 0) return []

  const out: Fixture[] = []
  for (const kase of listCases(db, { limit: 200 })) {
    // The cluster, not the mode. A guardrail mined from one coherent group of
    // a mixed mode should not be scored against the group it never addressed —
    // that measures the mode's breadth and calls it a routing failure.
    const expect = byMode.get(kase.cluster || kase.mode)
    if (!expect) continue
    const runUp = kase.lead_in.slice(-(opts.tail ?? 400))
    out.push({
      situation: `${kase.wrong_move}\n\n${runUp}`.trim(),
      expect,
      mode: kase.cluster || kase.mode,
    })
  }
  return out
}

export function liveSkills(db: Db): SkillRow[] {
  return listSkills(db)
    .filter((s) => s.state === 'accepted' || s.state === 'installed')
    .filter((s) => s.lifecycle !== 'archived' && s.kind !== 'frontdoor')
}

/**
 * Rank a pool of skills against a situation.
 *
 * IDF-weighted overlap of the description's terms — `description` is the field
 * every harness matches on, and the body is not loaded until after the choice
 * is made.
 *
 * The FALLBACK ranker. `rankEmbedded` is closer to what a real router does and
 * is used whenever an embedder resolves; this exists because embeddings are an
 * optional dependency here, and a routing floor that only works on machines
 * with a model installed is not a floor. A lexical run is a lower bound, and
 * the report says which ranker produced its numbers.
 *
 * The weighting is what makes it a measurement rather than a word count. Terms
 * shared by every description carry no information about which skill to pick;
 * scoring them would have every well-formed description tie with every other,
 * since the gate requires them all to say "use when".
 */
export function rank(situation: string, pool: SkillRow[]): string[] {
  const idf = new Map<string, number>()
  const docs = pool.map((s) => ({ slug: s.slug, terms: terms(s.description) }))
  for (const d of docs) {
    for (const t of new Set(d.terms)) idf.set(t, (idf.get(t) ?? 0) + 1)
  }
  const n = Math.max(1, docs.length)
  const q = new Set(terms(situation))

  return docs
    .map((d) => {
      let score = 0
      for (const t of new Set(d.terms)) {
        if (!q.has(t)) continue
        // Classic IDF, floored at zero so a term in every document adds
        // nothing rather than subtracting.
        score += Math.max(0, Math.log(n / (idf.get(t) ?? 1)))
      }
      // Longer descriptions match more terms by accident; normalise so a
      // rambling one cannot win on surface area alone.
      return { slug: d.slug, score: score / Math.sqrt(Math.max(1, new Set(d.terms).size)) }
    })
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
    .map((d) => d.slug)
}

const STOP = new Set([
  'use',
  'when',
  'this',
  'that',
  'you',
  'your',
  'are',
  'about',
  'the',
  'and',
  'for',
  'not',
  'with',
  'before',
  'after',
  'into',
  'from',
  'have',
  'has',
  'its',
  'any',
  'all',
  'them',
  'they',
  'their',
  'what',
  'which',
  'where',
  'how',
  'been',
  'was',
  'were',
  'will',
  'would',
  'should',
  'can',
  'could',
  'than',
  'then',
  'but',
  'out',
  'off',
  'per',
  'via',
  'while',
  'also',
  'just',
  'need',
  'get',
  'make',
  'run',
  'it',
  'a',
  'an',
  'of',
  'to',
  'in',
  'on',
  'is',
  'be',
  'as',
  'at',
  'or',
  'if',
  'by',
  'do',
  'did',
])

function terms(text: string): string[] {
  const out: string[] = []
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP.has(w)) continue
    out.push(w.replace(/(ing|ed|es|s)$/, ''))
  }
  return out
}

/**
 * Rank by embedding similarity, which is what a real router approximates.
 *
 * The lexical ranker above is a fallback, and a weak one: descriptions are two
 * sentences, the gate forces them to share their opening words, and a
 * situation that means the same thing in different vocabulary scores zero.
 * That weakness would surface in the report as skills being confusable — a
 * different claim about a different thing. The number has to measure the pool
 * rather than the instrument, so the report names which ranker produced it.
 */
export async function rankEmbedded(
  situation: string,
  pool: SkillRow[],
  embedder: Embedder,
): Promise<string[]> {
  const vecs = await embedder.embed([situation, ...pool.map((s) => s.description)])
  const q = vecs[0]
  if (!q) return pool.map((s) => s.slug)
  return pool
    .map((s, i) => ({ slug: s.slug, score: cosine(q, vecs[i + 1]) }))
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
    .map((d) => d.slug)
}

/** Providers normalize before storage, so the dot product IS the cosine. */
function cosine(a: Float32Array, b: Float32Array | undefined): number {
  if (!b) return -1
  let dot = 0
  for (let i = 0; i < a.length && i < b.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0)
  return dot
}

export interface PoolResult {
  poolSize: number
  fixtures: number
  /** Share where the right skill ranked first. */
  top1: number
  /** Mean reciprocal rank — how far down it was when it was not first. */
  mrr: number
}

/**
 * Fixtures below which the floor stays quiet.
 *
 * A precision computed over two cases moves by fifty points when one of them
 * flips, so enforcing a floor against it would fail a store for having a small
 * corpus rather than a routing problem. The number is still reported — it is
 * the enforcement that waits.
 */
export const MIN_FIXTURES = 8

export interface RoutingReport {
  fixtures: number
  pool: number
  /** Enough fixtures for the floor to mean anything. */
  enforceable: boolean
  /** Which ranker produced these numbers. A lexical run is a lower bound. */
  method: 'embedding' | 'lexical'
  results: PoolResult[]
  /** Fixtures whose expected skill never ranked first at full pool size. */
  misses: Array<{ mode: string; expect: string; got: string; rank: number }>
  logLine: string
}

/** Pool sizes to measure at, trimmed to what the store actually has. */
const SIZES = [3, 5, 10, 20, 50, 100]

/**
 * Measure routing precision as the pool grows.
 *
 * Subsampled from the REAL skill set rather than padded with invented
 * distractors. A synthetic pool would measure how confusable made-up skills
 * are, which is not a fact about this store — and the whole reason the curve
 * matters here is that hoppr's own skills are unusually similar to each other.
 *
 * Deterministic: distractors are chosen by sorted slug order, so two runs over
 * an unchanged store report the same number and a drop means something moved.
 */
export async function routingBench(
  db: Db,
  cfg?: Config,
  opts: { tail?: number; embedder?: Embedder } = {},
): Promise<RoutingReport> {
  const pool = liveSkills(db)
  const fixtures = fixturesFrom(db, opts)

  let embedder = opts.embedder
  if (!embedder && cfg) {
    const { resolveEmbedder } = await import('../embed/provider.ts')
    embedder = await resolveEmbedder(cfg).catch(() => undefined)
    await embedder?.warmup?.().catch(() => {})
  }

  const report: RoutingReport = {
    fixtures: fixtures.length,
    pool: pool.length,
    method: embedder ? 'embedding' : 'lexical',
    enforceable: fixtures.length >= MIN_FIXTURES,
    results: [],
    misses: [],
    logLine: '',
  }
  if (fixtures.length === 0 || pool.length < 2) {
    report.logLine =
      fixtures.length === 0 ? 'no routing fixtures yet' : 'only one skill to route to'
    return report
  }

  const sizes = [...new Set([...SIZES.filter((k) => k < pool.length), pool.length])].sort(
    (a, b) => a - b,
  )
  for (const k of sizes) {
    let hits = 0
    let rr = 0
    let counted = 0
    for (const f of fixtures) {
      const subset = poolFor(pool, f.expect, k)
      if (subset.length < 2) continue
      const ranked = embedder
        ? await rankEmbedded(f.situation, subset, embedder)
        : rank(f.situation, subset)
      const at = ranked.indexOf(f.expect)
      if (at < 0) continue
      counted++
      if (at === 0) hits++
      rr += 1 / (at + 1)
      if (k === pool.length && at !== 0) {
        report.misses.push({ mode: f.mode, expect: f.expect, got: ranked[0] ?? '', rank: at + 1 })
      }
    }
    if (counted === 0) continue
    report.results.push({
      poolSize: subsetSize(pool, k),
      fixtures: counted,
      top1: hits / counted,
      mrr: rr / counted,
    })
  }

  const full = report.results.at(-1)
  report.logLine = full
    ? `routing — top-1 ${(full.top1 * 100).toFixed(0)}% over ${full.poolSize} skills (${report.method})`
    : 'routing — nothing measurable'
  return report
}

/** The expected skill plus `k - 1` deterministic distractors. */
function poolFor(pool: SkillRow[], expect: string, k: number): SkillRow[] {
  const target = pool.find((s) => s.slug === expect)
  if (!target) return []
  const others = pool.filter((s) => s.slug !== expect).sort((a, b) => a.slug.localeCompare(b.slug))
  return [target, ...others.slice(0, Math.max(0, k - 1))]
}

function subsetSize(pool: SkillRow[], k: number): number {
  return Math.min(k, pool.length)
}
