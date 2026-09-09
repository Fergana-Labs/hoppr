import { z } from 'zod'
import type { Config } from '../config/schema.ts'
import { sha256 } from '../core/hash.ts'
import type { Db } from '../db/driver.ts'
import type { Embedder } from '../embed/provider.ts'
import { type LlmProvider, recordCall } from '../llm/index.ts'
import type { Layout } from '../store/layout.ts'
import { clip, loadPrompt, render } from '../store/prompts.ts'
import { contentTokens, jaccard, quotedByUser, userSpeech } from './lessons.ts'

/**
 * A correction is a moment the agent got it wrong and the person said so.
 *
 * The rest of the pipeline reads transcripts for what a session ESTABLISHED —
 * standing claims, superseded when a newer one contradicts them, one per
 * subject. That shape is right for a preference and wrong for a mistake. A
 * mistake is an event: it happened at a time, it cost turns, and the second
 * occurrence is more evidence rather than a replacement. Recurrence is the
 * entire point here, which is the exact opposite of the ledger's rule, so
 * corrections get their own table rather than a fifth lesson bin.
 *
 * Why bother, when `lesson-extract` already reads corrections to infer
 * preferences? Because inferring the preference throws away the part a person
 * actually wants: what keeps going wrong, how often, and what it costs. A
 * store's first output today is a review queue — a list of chores. With this
 * it can be a finding, in the person's own words, about their own work.
 */
const CorrectionOut = z.object({
  session: z.string().default(''),
  mode: z.string().min(2).max(80),
  headline: z.string().min(4),
  quote: z.string().default(''),
  turns: z.number().int().min(1).max(200).default(1),
  severity: z.enum(['annoyance', 'rework', 'damage']).default('annoyance'),
  confidence: z.number().min(0).max(1).default(0.5),
})
const ExtractOut = z.object({ corrections: z.array(CorrectionOut).default([]) })

export interface CorrectionRow {
  id: string
  raw_id: string
  mode: string
  /** The coherent sub-group within the mode. See `clusterKeys`. */
  cluster: string
  headline: string
  quote: string
  turns: number
  severity: 'annoyance' | 'rework' | 'damage'
  observed: number
}

export interface CorrectionStats {
  sessionsRead: number
  corrections: number
  /** Claims whose quote was not found in anything the human typed. */
  unattributed: number
  failed: number
  logLine: string
}

/**
 * Sessions per call, and it is deliberately smaller than lesson extraction's.
 *
 * A lesson is a standing claim, and standing claims cluster at the start and
 * end of a session — the setup and the conclusion — which is exactly what
 * head-and-tail clipping preserves. A correction is a mid-transcript event, so
 * the same clipping throws away the part being looked for. Fewer sessions per
 * call buys each one a much larger share of the budget.
 */
const BATCH = 2

/**
 * A transcript reduced to the turns a correction could be in.
 *
 * Measured before this existed: 48 real sessions produced five corrections,
 * every one of them a singleton, because a 200KB transcript clipped to 6,000
 * characters keeps its opening and its ending and discards the middle, where
 * the arguing happens.
 *
 * Every correction is something the person typed, and `userSpeech` already
 * knows how to find those spans — the same routine the attribution check runs
 * on the other side. So instead of clipping the transcript, the transcript is
 * REPLACED by its user turns, each carrying enough of what came just before to
 * see what was being reacted to. On a long session that is a few percent of
 * the bytes and close to all of the signal.
 *
 * Falls back to plain clipping when a transcript has no recognizable user
 * turns — a connector whose rendering this does not know is better read badly
 * than not at all.
 */
export function correctionWindow(text: string, maxChars: number): string {
  const clean = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
  const prompts = promptBlock(clean)
  // Pairs come from the transcript body alone. Taking them from the whole
  // document meant the lead-in for the first user turn was the `## Prompts`
  // block sitting just above it — every quote shown twice, and the budget for
  // the surrounding turns spent on a copy of the quotes.
  const at = clean.indexOf('\n## Transcript')
  const body = at >= 0 ? clean.slice(at) : clean
  const turns = [...body.matchAll(/^\*\*user:\*\*[ \t]?(.*)$/gm)]
  if (turns.length === 0 && !prompts.length) return clip(text, maxChars)

  const paired: string[] = []
  for (const m of turns) {
    const at = m.index ?? 0
    // What the agent had just done. A user turn on its own says "no, not like
    // that" and nothing about what `that` was, which is the half that names
    // the failure mode.
    paired.push(`${clipTail(body.slice(Math.max(0, at - LEAD), at), LEAD)}\n${m[0]}`)
  }

  // Whatever the person said that the body no longer contains.
  //
  // `renderTranscript` truncates the transcript body through the MIDDLE when a
  // session is long, and keeps the `## Prompts` block whole precisely because
  // it is "the only part a human actually wrote". Reading only the body would
  // therefore lose the user turns from the middle of exactly the long, messy
  // sessions where the corrections are — so the block is the safety net, and
  // it is filtered against the pairs so nothing is shown twice.
  const seen = paired.join('\n').toLowerCase()
  const orphaned = prompts.filter(
    (p) => p.length > 12 && !seen.includes(p.slice(0, 60).toLowerCase()),
  )

  const out: string[] = []
  // Pairs first: they cost more per quote and are worth more, because only
  // they say what the person was reacting to.
  let budget = maxChars
  // Keep the LAST pairs when they overflow. A long session went wrong late
  // more often than early, and its opening turns are what the lesson pass
  // already reads.
  const joined = paired.join('\n\n···\n\n')
  const kept = joined.length <= budget ? joined : `…\n\n${joined.slice(-Math.floor(budget * 0.75))}`
  if (kept) out.push(kept)
  budget -= kept.length

  if (orphaned.length && budget > 400) {
    const extra = [
      '',
      '···',
      '',
      '_Also said in this session, with the surrounding turns no longer retained:_',
      '',
      ...orphaned.map((p) => `**user:** ${p}`),
    ].join('\n')
    out.push(extra.length <= budget ? extra : extra.slice(0, budget))
  }
  return out.join('\n')
}

/** Preceding agent output shown with each user turn. */
const LEAD = 700

/** Every user turn, verbatim and uncapped — see `connectors/render.ts`. */
function promptBlock(text: string): string[] {
  const m = /\n## Prompts\n([\s\S]*?)(?=\n## |$)/.exec(text)
  if (!m?.[1]) return []
  return m[1]
    .split(/\n(?=> )/)
    .map((p) => p.replace(/^> ?/gm, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function clipTail(s: string, n: number): string {
  return s.length <= n ? s : `…${s.slice(-n)}`
}

/**
 * Read sessions never read for corrections.
 *
 * Once-ever per session, like lessons and usage. A transcript is immutable, so
 * a second read can only spend tokens arriving at the same answer.
 */
export async function extractCorrections(
  db: Db,
  l: Layout,
  cfg: Config,
  llm: LlmProvider,
  opts: { limit?: number; onProgress?: (m: string) => void } = {},
): Promise<CorrectionStats> {
  const st: CorrectionStats = {
    sessionsRead: 0,
    corrections: 0,
    unattributed: 0,
    failed: 0,
    logLine: '',
  }
  if (!cfg.skills.enabled) return st

  const pending = db
    .prepare<{ id: string; title: string; text: string; observed: number }>(
      `SELECT id, COALESCE(title,'') AS title, text,
              COALESCE(created, captured) AS observed
         FROM raw
        WHERE kind = 'session' AND partial = 0 AND text IS NOT NULL
          AND corrections_at IS NULL
        ORDER BY captured DESC LIMIT :n`,
    )
    .all({ n: opts.limit ?? 40 })
  if (pending.length === 0) return st

  const prompt = await loadPrompt(l, 'correction-extract')
  const per = Math.max(4000, Math.floor(prompt.maxInputChars / BATCH))
  // Modes converge only if each batch can see what the last ones chose.
  //
  // Measured on 48 real sessions: 25 corrections, 25 distinct modes, not one
  // of which recurred — while six of them were plainly the same mistake
  // (`answered-wrong-question`, `answered-wrong-topic`,
  // `analyzed-adoption-not-need`, …). Token clustering cannot rescue that,
  // because those strings share almost no words. hoppr already solved the
  // identical problem for tags by feeding the existing vocabulary back in and
  // preferring it, and a failure mode is a tag on a mistake.
  let vocabulary = knownModes(db)

  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH)
    opts.onProgress?.(`reading ${batch.length} sessions for corrections`)
    let out: z.infer<typeof ExtractOut>
    try {
      const res = await llm.completeJson({
        prompt: render(prompt.template, {
          vocabulary: renderVocabulary(vocabulary),
          sessions: batch
            .map((s) => `### session ${s.id}\n${s.title}\n\n${correctionWindow(s.text, per)}`)
            .join('\n\n---\n\n'),
        }),
        tier: prompt.tier,
        purpose: 'corrections.extract',
        schema: ExtractOut,
        maxTokens: 4096,
      })
      recordCall(db, llm.id, 'corrections.extract', prompt.tier, res.usage, true)
      out = res.value
    } catch (e) {
      st.failed += batch.length
      opts.onProgress?.(`correction extraction failed: ${(e as Error).message.slice(0, 80)}`)
      // Watermark stays NULL so the next pass retries. A provider hiccup must
      // not permanently blind the report to these sessions.
      continue
    }

    const byId = new Map(batch.map((s) => [s.id, s]))
    const speech = new Map(batch.map((s) => [s.id, userSpeech(s.text)]))
    for (const cx of out.corrections) {
      // Never trust a model's echo of a session id — transcripts contain their
      // own UUIDs and models return those. Same rule as lessons and mining.
      const src = byId.get(cx.session) ?? (batch.length === 1 ? batch[0] : undefined)
      if (!src) continue

      // The person's words or nothing. An agent apologizing for itself is the
      // agent grading its own homework, and left unchecked the top failure
      // mode on any report becomes whatever the assistant most likes to
      // apologize for rather than what actually cost anyone anything.
      if (!cx.quote.trim()) continue
      if (!quotedByUser(cx.quote, speech.get(src.id) ?? '')) {
        st.unattributed++
        continue
      }

      const mode = normalizeMode(cx.mode)
      if (!mode) continue
      // One row per (session, mode): a session where the same mistake happened
      // three times is one occurrence of the mode with a larger turn count,
      // not three, and `turns` takes the largest estimate seen for it.
      const id = sha256(`${src.id} ${mode}`).slice(0, 24)
      db.prepare(
        `INSERT INTO corrections(id, raw_id, mode, headline, quote, turns, severity, observed, created)
         VALUES (:id,:raw,:mode,:head,:quote,:turns,:sev,:obs,:now)
         ON CONFLICT(id) DO UPDATE SET
           headline = :head, quote = :quote, severity = :sev,
           turns = MAX(turns, :turns)`,
      ).run({
        id,
        raw: src.id,
        mode,
        head: cx.headline.trim(),
        quote: cx.quote.trim().slice(0, 400),
        turns: cx.turns,
        sev: cx.severity,
        obs: src.observed || Date.now(),
        now: Date.now(),
      })
      st.corrections++
    }

    for (const s of batch) {
      db.prepare('UPDATE raw SET corrections_at = :at WHERE id = :id').run({
        at: Date.now(),
        id: s.id,
      })
      st.sessionsRead++
    }
    // Refreshed per batch rather than once, so a mode coined early in a
    // backfill is offered to every batch after it.
    vocabulary = knownModes(db)
  }

  st.logLine = st.corrections
    ? `${st.corrections} corrections from ${st.sessionsRead} sessions`
    : ''
  return st
}

/**
 * Lowercase, hyphenate, trim to a verb phrase.
 *
 * The prompt asks for `claimed-done-without-running` and models return
 * "Claimed done without running", "claimed_done_without_running", and
 * occasionally a whole sentence. Normalizing here rather than insisting in the
 * prompt is the difference between a mode that groups and five that do not.
 */
export function normalizeMode(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 6)
    .join('-')
    .slice(0, 60)
}

/**
 * Split a mode's corrections into groups that are actually one failure.
 *
 * Grouped on the HEADLINE — what the agent did — rather than on the mode,
 * because the mode is the label being distrusted. Two corrections filed under
 * `built-before-clarifying` describing "created four types where two were
 * specified" and "rebuilt the artwork without the reference" share the label
 * and nothing else, and a guardrail written from both has to abandon one.
 *
 * Assigned by code, so a split is free to recompute and inspectable in the
 * table. The key is the mode itself when a mode holds together, and
 * `mode~2`, `mode~3` for the groups after the largest — so the common case
 * leaves every existing key untouched and only a genuinely mixed mode gains
 * suffixes.
 */
export async function clusterKeys(
  rows: CorrectionRow[],
  opts: { embedder?: Embedder } = {},
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const byMode = new Map<string, CorrectionRow[]>()
  for (const r of rows) {
    const list = byMode.get(r.mode)
    if (list) list.push(r)
    else byMode.set(r.mode, [r])
  }

  // Similarity over the headlines. Embedded where an embedder resolves,
  // lexical otherwise — the same choice, for the same reason, as the routing
  // bench: two sentences describing one failure in different vocabulary score
  // near zero on token overlap, so a lexical threshold that keeps unrelated
  // failures apart also splits related ones, and no value of it is right.
  const vectors = opts.embedder
    ? await embedHeadlines(rows, opts.embedder).catch(() => undefined)
    : undefined

  for (const [mode, members] of byMode) {
    const groups: Array<{ tokens: Set<string>; vec?: Float32Array; rows: CorrectionRow[] }> = []
    for (const r of [...members].sort((a, b) => a.id.localeCompare(b.id))) {
      const tokens = contentTokens(r.headline)
      const vec = vectors?.get(r.id)
      const hit = groups.find((g) =>
        vec && g.vec
          ? dot(vec, g.vec) >= COHERENT_COSINE
          : tokens.size > 0
            ? jaccard(g.tokens, tokens) >= COHERENT_LEXICAL
            : // A headline with no content words — every term a stopword or
              // under three characters — has an empty token set, and an empty
              // set matches nothing. Left alone, identical degenerate headlines
              // each became their own cluster, which is the opposite of what
              // identical means.
              g.tokens.size === 0,
      )
      if (hit) {
        hit.rows.push(r)
        for (const t of tokens) hit.tokens.add(t)
      } else {
        groups.push({ tokens, vec, rows: [r] })
      }
    }
    // Largest first, so the biggest group keeps the plain mode name and the
    // suffixes land on the outliers. Ties break on the first id, which keeps
    // the assignment stable across runs.
    groups.sort(
      (a, b) =>
        b.rows.length - a.rows.length || (a.rows[0]?.id ?? '').localeCompare(b.rows[0]?.id ?? ''),
    )
    groups.forEach((g, i) => {
      const key = i === 0 ? mode : `${mode}~${i + 1}`
      for (const r of g.rows) out.set(r.id, key)
    })
  }
  return out
}

/**
 * Similarity above which two corrections describe the same failure.
 *
 * Both are policies rather than measurements, and the lexical one is the
 * weaker instrument: on two real headlines about the same config-schema
 * mistake it scored 0.333, which no threshold separates from unrelated pairs
 * without also splitting related ones. It is a fallback for stores with no
 * embedder, and it errs toward splitting — an over-split mode costs a
 * guardrail that could have been broader, while an over-merged one produces a
 * guardrail that cannot address most of what it claims.
 */
const COHERENT_COSINE = 0.62
const COHERENT_LEXICAL = 0.3

async function embedHeadlines(
  rows: CorrectionRow[],
  embedder: Embedder,
): Promise<Map<string, Float32Array>> {
  const vecs = await embedder.embed(rows.map((r) => r.headline))
  return new Map(
    rows.map((r, i) => [r.id, vecs[i]!]).filter(([, v]) => v) as Array<[string, Float32Array]>,
  )
}

/** Providers normalize before storage, so the dot product IS the cosine. */
function dot(a: Float32Array, b: Float32Array): number {
  let n = 0
  for (let i = 0; i < a.length && i < b.length; i++) n += (a[i] ?? 0) * (b[i] ?? 0)
  return n
}

/** Recompute and store every correction's cluster. No model call. */
export async function assignClusters(
  db: Db,
  cfg?: Config,
): Promise<{ split: number; modes: number }> {
  const rows = db.prepare<CorrectionRow>('SELECT * FROM corrections').all()
  let embedder: Embedder | undefined
  if (cfg) {
    const { resolveEmbedder } = await import('../embed/provider.ts')
    embedder = await resolveEmbedder(cfg).catch(() => undefined)
    await embedder?.warmup?.().catch(() => {})
  }
  const keys = await clusterKeys(rows, { embedder })
  let split = 0
  for (const [id, key] of keys) {
    db.prepare('UPDATE corrections SET cluster = :k WHERE id = :i').run({ k: key, i: id })
    if (key.includes('~')) split++
  }
  // Cases copy the correction's cluster, so the bench and the routing fixtures
  // both select the cases a guardrail actually claims.
  db.exec(
    'UPDATE cases SET cluster = COALESCE((SELECT c.cluster FROM corrections c WHERE c.id = cases.correction_id), cluster)',
  )
  return { split, modes: new Set(keys.values()).size }
}

export interface FailureMode {
  /** The normalized mode key of the largest member, used as the cluster name. */
  mode: string
  /** What the agent did wrong, phrased once — the most recent headline. */
  headline: string
  /** Distinct sessions this happened in. */
  rawIds: string[]
  /** Estimated turns burned across all of them. */
  turns: number
  /** turns × severity weight — what the report ranks on. See `SEVERITY_WEIGHT`. */
  cost: number
  /** Worst severity observed. */
  severity: 'annoyance' | 'rework' | 'damage'
  /** What the person actually said, newest first. The part that lands. */
  quotes: string[]
  /** Every row in the cluster, for the miner. */
  rows: CorrectionRow[]
}

const SEVERITY_RANK = { annoyance: 0, rework: 1, damage: 2 } as const

/**
 * What a turn is worth at each severity. A policy, not a measurement.
 *
 * Ranking on raw turns alone made severity decorative, and it is not: on real
 * transcripts the most expensive correction in the corpus — an agent indexing
 * 1Password credentials off the filesystem — cost exactly one turn to say
 * "1password shouldn't be part of this", and sorted below a run of cosmetic
 * notes about spacing. Turns measure how long you spent arguing, which is not
 * the same as what the mistake cost you.
 *
 * The numbers are a judgement and are named as one wherever the ranking is
 * shown. What they encode is only the ordering: rework outranks annoyance, and
 * anything committed, shipped or deleted outranks both by enough that a single
 * instance leads the report.
 */
const SEVERITY_WEIGHT = { annoyance: 1, rework: 3, damage: 12 } as const

/**
 * Group corrections into failure modes, ranked by what they cost.
 *
 * Ranked by turns rather than by count, and that is the whole argument for the
 * feature. A count answers "what happens most", which a person can usually
 * guess. Turns answer "what is this costing me", which they cannot, and the
 * two orderings disagree: a small mistake caught immediately fifteen times is
 * cheaper than a wrong direction pursued twice for twenty turns each.
 *
 * Clustering is exact-key first, then token overlap, exactly as procedures are
 * clustered — `claimed-done-without-running` and `claimed-done-never-ran-it`
 * are one mode, and noticing that does not require an embedding model.
 */
export function failureModes(
  db: Db,
  opts: { minSessions?: number; byCluster?: boolean } = {},
): FailureMode[] {
  const rows = db
    .prepare<CorrectionRow>('SELECT * FROM corrections ORDER BY observed DESC LIMIT 600')
    .all()

  const groups: Array<{ mode: string; tokens: Set<string>; rows: CorrectionRow[] }> = []
  for (const r of rows) {
    // Group on the cluster where one has been assigned. A mode that held
    // together keeps its own name as its cluster, so this is the same
    // behaviour as before for everything except a genuinely mixed mode.
    const key = opts.byCluster === false ? r.mode : r.cluster || r.mode
    const tokens = contentTokens(key)
    const hit = groups.find(
      (g) => g.mode === key || (tokens.size > 0 && jaccard(g.tokens, tokens) >= 0.5),
    )
    if (hit) {
      hit.rows.push(r)
      for (const t of tokens) hit.tokens.add(t)
    } else {
      groups.push({ mode: key, tokens, rows: [r] })
    }
  }

  const min = opts.minSessions ?? 1
  return groups
    .map((g) => {
      // `rows` arrive newest-first, so the first of each is the current one.
      const sorted = [...g.rows].sort((a, b) => b.observed - a.observed)
      const worst = sorted.reduce(
        (acc, r) => (SEVERITY_RANK[r.severity] > SEVERITY_RANK[acc] ? r.severity : acc),
        'annoyance' as FailureMode['severity'],
      )
      return {
        mode: g.mode,
        headline: sorted[0]?.headline ?? g.mode,
        rawIds: [...new Set(sorted.map((r) => r.raw_id))],
        turns: sorted.reduce((n, r) => n + r.turns, 0),
        // Weighted per row, not per cluster: a mode with one damaging instance
        // and nine annoying ones should not have all ten priced as damage.
        cost: sorted.reduce((n, r) => n + r.turns * SEVERITY_WEIGHT[r.severity], 0),
        severity: worst,
        quotes: [...new Set(sorted.map((r) => r.quote).filter(Boolean))],
        rows: sorted,
      }
    })
    .filter((m) => m.rawIds.length >= min)
    .sort((a, b) => b.cost - a.cost || b.rawIds.length - a.rawIds.length)
}

/** Totals for the report header. */
export function correctionTotals(db: Db): {
  corrections: number
  sessions: number
  turns: number
} {
  const r = db
    .prepare<{ corrections: number; sessions: number; turns: number }>(
      `SELECT COUNT(*) AS corrections,
              COUNT(DISTINCT raw_id) AS sessions,
              COALESCE(SUM(turns), 0) AS turns
         FROM corrections`,
    )
    .get()
  return { corrections: r?.corrections ?? 0, sessions: r?.sessions ?? 0, turns: r?.turns ?? 0 }
}

/**
 * A starting vocabulary of failure modes.
 *
 * Not findings, and not written into any store — they exist only as preferred
 * wording in the extraction prompt, the way `converging = true` reuses a
 * table's existing values. Without a seed the first batch of a backfill coins
 * whatever it likes and every later batch converges on THAT, so the vocabulary
 * a corpus ends up with is decided by whichever four sessions happened to be
 * read first.
 *
 * Deliberately short and shaped like the ones the extractor produced on real
 * transcripts: verb-first, general enough to recur, specific enough to act on.
 *
 * The seed is also the thing to watch. Measured on 16 real sessions, adding it
 * took 25 singleton modes down to 7 with 5 recurring — and every one of the 7
 * was a seed, including two that did not fit: a session where the agent ran
 * everything and got a bad result was filed under
 * `claimed-done-without-running`. A wrong label is worse than a new mode,
 * because it corrupts the count for the mode that was accurate. The prompt
 * carries the fit test that guards against it; if this list grows, that test
 * matters more, not less.
 */
export const SEED_MODES = [
  'answered-a-different-question',
  'claimed-done-without-running',
  'expanded-scope-unasked',
  'built-before-clarifying',
  'rewrote-instead-of-editing',
  'stopped-short-of-doing-it',
  'fixed-the-test-not-the-bug',
  'ignored-a-stated-preference',
  'asked-what-was-readable',
  'reinvented-something-existing',
] as const

/** Modes this corpus already uses, most-used first, plus the seeds. */
export function knownModes(db: Db, limit = 24): Array<{ mode: string; n: number }> {
  const rows = db
    .prepare<{ mode: string; n: number }>(
      `SELECT mode, COUNT(DISTINCT raw_id) AS n FROM corrections
        GROUP BY mode ORDER BY n DESC, mode ASC LIMIT :n`,
    )
    .all({ n: limit })
  const seen = new Set(rows.map((r) => r.mode))
  for (const m of SEED_MODES) {
    if (rows.length >= limit) break
    if (!seen.has(m)) rows.push({ mode: m, n: 0 })
  }
  return rows
}

function renderVocabulary(modes: Array<{ mode: string; n: number }>): string {
  return modes
    .map((m) => (m.n > 0 ? `- \`${m.mode}\` (seen ${m.n}×)` : `- \`${m.mode}\``))
    .join('\n')
}

export interface Regret {
  mode: string
  /** Estimated turns this failure has already cost. */
  turns: number
  /** turns × severity weight — what the queue sorts on. */
  cost: number
  sessions: number
  severity: FailureMode['severity']
}

/**
 * Order proposals by what the thing they address has already cost.
 *
 * The review queue sorted by `confidence`, which is a number about the model
 * rather than about the person reading it. Every proposal in a queue has
 * cleared the same gate, so their confidences sit in a narrow band and the
 * ordering carries almost no information — which is how a queue becomes a list
 * of chores rather than a list of wins.
 *
 * Regret is available only for a guardrail, because only a guardrail was mined
 * FROM a failure mode. A procedure has no honest cost attached to it and gets
 * none rather than a fabricated one; it sorts below on confidence, as before.
 */
export function rankByRegret<T extends { slug: string; confidence: number }>(
  db: Db,
  rows: T[],
  prevents: (row: T) => string,
): Array<T & { regret: Regret | null }> {
  const modes = failureModes(db)
  const find = (mode: string): Regret | null => {
    if (!mode) return null
    const m = modes.find((x) => x.mode === mode || x.rows.some((r) => r.mode === mode))
    return m
      ? {
          mode: m.mode,
          turns: m.turns,
          cost: m.cost,
          sessions: m.rawIds.length,
          severity: m.severity,
        }
      : null
  }
  return rows
    .map((r) => ({ ...r, regret: find(prevents(r)) }))
    .sort((a, b) => (b.regret?.cost ?? 0) - (a.regret?.cost ?? 0) || b.confidence - a.confidence)
}
