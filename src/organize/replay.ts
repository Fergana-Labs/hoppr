import { z } from 'zod'
import type { Config } from '../config/schema.ts'
import type { Db } from '../db/driver.ts'
import { type LlmProvider, recordCall } from '../llm/index.ts'
import type { Layout } from '../store/layout.ts'
import { type CaseRow, listCases } from './cases.ts'
import { checkMove, type ProjectFacts, projectFacts, renderViolations } from './grounded.ts'
import { recordOutcome } from './reliability.ts'
import { listSkills } from './skills.ts'

/**
 * Replay a recorded failure with and without a candidate skill.
 *
 * The bench asks the only question hoppr could never answer before: does this
 * skill change what an agent does? Not whether it reads well, not whether its
 * commands were real, not whether a model asked to grade its own evidence says
 * it holds up — whether the agent, in a situation that actually went wrong,
 * goes wrong again.
 *
 * **Both arms, always.** A skill that avoids the failure tells you nothing on
 * its own, because the case may simply be easy: the baseline avoids plenty of
 * them too. The verdict is the difference between the arms, which is why the
 * baseline is computed for every case whether or not any skill exists yet.
 *
 * **The skill is never shown the correction.** Arms see the lead-in and stop.
 * Only the judge sees what the person said, and it sees it as a rubric rather
 * than as context. Leak that in either direction and every candidate passes.
 */
const ArmOut = z.object({ move: z.string().min(1), why: z.string().default('') })
const JudgeOut = z.object({
  baseline_recurred: z.boolean(),
  skill_recurred: z.boolean(),
  reason: z.string().default(''),
})

/**
 * `unstable` is the absence of a verdict, not a kind of one.
 *
 * With three draws a 1/1/1 split means every draw disagreed, and reporting the
 * arbitrary winner as `inert` states a finding the bench did not make. It
 * counts toward nothing and blocks nothing — it says the instrument could not
 * resolve this case, which is a thing a person should be able to see.
 */
export type Verdict = 'prevents' | 'regression' | 'inert' | 'both-fail' | 'unstable'

export interface ReplayResult {
  caseId: string
  mode: string
  verdict: Verdict
  reason: string
  /** Set when the skill arm proposed something this project cannot do. */
  ungrounded?: string
  /** Samples that agreed with the recorded verdict. */
  agreement: number
  samples: number
}

/**
 * Draws per case.
 *
 * Three rather than one because one is not stable. Measured on this store's
 * own corrections, the same skill scored against the same case moved from
 * `regression` to `prevents` between two runs — so a single draw reports which
 * way the coin landed, and this bench retires skills.
 */
const DEFAULT_SAMPLES = 3

export interface SkillVerdict {
  slug: string
  /** Cases where the baseline failed and the skill did not. */
  prevents: number
  /** Holdout cases of the skill's own mode — how testable its claim was. */
  ownTested: number
  /** Cases the skill broke that the baseline handled. The disqualifying one. */
  regressions: number
  inert: number
  bothFail: number
  /** Cases where no two draws agreed — the instrument could not resolve them. */
  unstable: number
  /**
   * Cases where the skill arm proposed something this project cannot do.
   *
   * Checked against the real manifests and filesystem, not judged — the two
   * failure classes replay is structurally blind to are Environment Mismatch
   * and Artifact Misplacement, and neither is visible in a transcript.
   */
  ungrounded: Array<{ mode: string; detail: string }>
  cases: number
  /**
   * Enough resolved cases for `pass` to mean anything.
   *
   * Three draws stabilise a CASE verdict; they do not stabilise a SKILL
   * verdict, because that is a threshold over a handful of cases and one flip
   * crosses it. Measured here: the same skill against the same cases scored
   * `pass` in one run, `fail` in the next, and `pass` again — not because any
   * case was noisy, but because `prevents === 0` is one case away from
   * `prevents === 1`. A gate that retires skills has to say when its own
   * answer is not reproducible.
   */
  conclusive: boolean
  pass: boolean
  why: string
  results: ReplayResult[]
}

/**
 * What makes a skill-level verdict worth acting on.
 *
 * Two bars, because the instability has two sources. Overall resolution
 * covers the regression check, which fires on any single case. Own-mode
 * resolution covers `prevents === 0`, which is a cliff by construction — a
 * guardrail preventing one of six passes and none of six fails — and a cliff
 * over two cases is a coin toss.
 *
 * A single bar on the total does not work: a store with one failure mode has
 * no off-mode cases to reach it with, so the threshold would be unreachable
 * exactly where the skill is most testable.
 */
export const MIN_RESOLVED = 4
export const MIN_OWN_RESOLVED = 3

/** Holdout cases of the skill's own failure mode, at most. */
const OWN_MODE = 6
/** Unrelated holdout cases, to catch a skill that breaks situations it never claimed. */
const OFF_MODE = 4

/**
 * Score one skill against the bench.
 *
 * Held out, always. The cases a skill was mined from are the ones it is
 * guaranteed to handle — scoring on those measures memorisation, which is
 * exactly the distinction `promotionGate` currently asks a model to assert
 * about itself. `cases.split` is assigned by hashing the case id, so the two
 * halves stay fixed across runs and a candidate cannot be re-rolled into
 * passing.
 */
export async function verifySkill(
  db: Db,
  l: Layout,
  _cfg: Config,
  llm: LlmProvider,
  slug: string,
  body: string,
  opts: {
    onProgress?: (m: string) => void
    ownMode?: number
    offMode?: number
    samples?: number
    /** Check proposed moves against this project's manifests and filesystem. */
    projectDir?: string
  } = {},
): Promise<SkillVerdict> {
  const samples = opts.samples ?? DEFAULT_SAMPLES
  const row = db
    .prepare<{ prevents: string; kind: string }>(
      'SELECT prevents, kind FROM skills WHERE slug = :s',
    )
    .get({ s: slug })
  const mode = row?.prevents ?? ''

  // A guardrail names the failure it exists to stop, so its own mode is where
  // the claim can be tested. Anything else — a mined procedure, a starter
  // skill — makes no such claim, and gets the regression half only.
  const own = mode ? listCases(db, { mode, split: 'holdout', limit: opts.ownMode ?? OWN_MODE }) : []
  const off = listCases(db, {
    notMode: mode || undefined,
    split: 'holdout',
    limit: opts.offMode ?? OFF_MODE,
  })

  const seen = new Set<string>()
  const cases = [...own, ...off].filter((c) => !seen.has(c.id) && seen.add(c.id))

  const v: SkillVerdict = {
    slug,
    ownTested: own.length,
    prevents: 0,
    regressions: 0,
    inert: 0,
    bothFail: 0,
    unstable: 0,
    ungrounded: [],
    conclusive: false,
    cases: cases.length,
    pass: false,
    why: '',
    results: [],
  }
  if (cases.length === 0) {
    v.why = 'no holdout cases to replay against'
    return v
  }

  // Read once. The project does not change between cases, and every case's
  // move is checked against the same facts.
  const facts = opts.projectDir ? await projectFacts(opts.projectDir) : undefined

  for (const kase of cases) {
    opts.onProgress?.(`replaying ${slug} against ${kase.mode}`)
    const r = await replayCase(db, l, llm, kase, slug, body, { samples, facts })
    if (!r) continue
    if (r.ungrounded) v.ungrounded.push({ mode: r.mode, detail: r.ungrounded })
    v.results.push(r)
    if (r.verdict === 'prevents') v.prevents++
    else if (r.verdict === 'regression') v.regressions++
    else if (r.verdict === 'inert') v.inert++
    else if (r.verdict === 'both-fail') v.bothFail++
    else v.unstable++
  }

  // Success-prioritized, in SkillRevise's sense: a regression disqualifies
  // regardless of how much else the skill prevented. Breaking a situation that
  // was working is the failure mode with no upside — the person had that
  // behaviour already and the skill took it away.
  const resolved = v.results.filter((r) => r.verdict !== 'unstable').length
  const ownResolved = v.results.filter(
    (r) => r.verdict !== 'unstable' && own.some((c) => c.id === r.caseId),
  ).length
  v.conclusive = resolved >= MIN_RESOLVED && (mode === '' || ownResolved >= MIN_OWN_RESOLVED)

  // Whether the skill's OWN claim was testable at all. A guardrail names the
  // failure it exists to stop; if none of that mode's cases landed on the
  // holdout side there is nothing to test the claim against, which is not the
  // same as testing it and finding nothing. Reporting the second when the
  // first is true would fail skills for the split's arithmetic.
  const ownTested = own.length
  if (v.ungrounded.length > 0) {
    // Not a judgement and not a sample — the manifest either has the script or
    // it does not, so one instance is the whole finding.
    v.pass = false
    v.why = `proposes what this project cannot do — ${v.ungrounded[0]?.detail ?? ''}`
  } else if (v.regressions > 0) {
    v.pass = false
    v.why = `${v.regressions} regression(s) — broke a case the baseline handled`
  } else if (v.results.length === 0) {
    v.why = 'no case could be replayed'
  } else if (v.unstable === v.results.length) {
    v.pass = false
    v.why = `no case resolved — ${v.unstable} of ${v.results.length} draws disagreed with themselves`
  } else if (mode && ownTested === 0) {
    v.pass = false
    v.why = `broke nothing, but no holdout case of \`${mode}\` exists to test its claim`
  } else if (mode && v.prevents === 0) {
    v.pass = false
    v.why = `prevented none of ${ownTested} holdout case(s) of its own mode`
  } else {
    v.pass = true
    v.why = mode
      ? `prevented ${v.prevents} of ${ownTested}, broke nothing`
      : `broke nothing across ${v.results.length} cases`
  }
  if (!v.conclusive && v.results.length > 0) {
    v.why =
      `${v.why} — but only ${resolved} case(s) resolved` +
      (mode ? `, ${ownResolved} of its own mode` : '') +
      ', so this does not reproduce'
  }

  db.prepare(
    'UPDATE skills SET verified_at = :at, prevents_n = :p, regress_n = :r WHERE slug = :s',
  ).run({ at: Date.now(), p: v.prevents, r: v.regressions, s: slug })

  // The bench is an outcome like any other, and a stronger one than the
  // signals reliability was built from: those record a human intervening,
  // this records the skill being tried.
  // An inconclusive run is not evidence. Recording it would move reliability —
  // and eventually the lifecycle — on a number that does not reproduce.
  if (v.results.length > 0 && v.conclusive) {
    recordOutcome(db, slug, v.pass ? 'pass' : 'fail', 'used', `bench: ${v.why}`)
  }
  return v
}

/**
 * One case, both arms, one verdict.
 *
 * The baseline arm is cached: it does not depend on the candidate, so it is
 * the same answer for every skill ever scored against this case. Recomputing
 * it per candidate would add a third of the bench's cost to arrive at a result
 * already on disk.
 */
export async function replayCase(
  db: Db,
  l: Layout,
  llm: LlmProvider,
  kase: CaseRow,
  slug: string,
  body: string,
  opts: { samples?: number; facts?: ProjectFacts } = {},
): Promise<ReplayResult | null> {
  const k = Math.max(1, opts.samples ?? DEFAULT_SAMPLES)
  const drawn: Array<{ verdict: Verdict; reason: string }> = []
  const violations: string[] = []

  for (let i = 0; i < k; i++) {
    // The baseline for sample `i` is cached and shared across every skill, so
    // two skills are compared against identical controls rather than against
    // two different draws of one.
    const baseline = await baselineMove(db, l, llm, kase, i)
    if (!baseline) continue
    const skillMove = await runArm(db, l, llm, kase, body)
    if (!skillMove) continue
    // Checked, not run. A move naming a script this project does not define is
    // wrong here whatever a judge reading it thinks, and no transcript
    // contains the manifest that settles it.
    if (opts.facts) {
      const bad = checkMove(skillMove, opts.facts)
      if (bad.length > 0) violations.push(renderViolations(bad))
    }
    const out = await judge(db, l, llm, kase, baseline, skillMove)
    if (!out) continue
    drawn.push({ verdict: verdictOf(out), reason: out.reason })
  }
  if (drawn.length === 0) return null

  // Majority, with the disqualifying verdict needing a real majority rather
  // than a plurality. `regression` retires a skill outright, so it is the one
  // label that must not be reachable by a single unlucky draw among three.
  const tally = new Map<Verdict, number>()
  for (const d of drawn) tally.set(d.verdict, (tally.get(d.verdict) ?? 0) + 1)
  const regressions = tally.get('regression') ?? 0
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]!
  const verdict: Verdict =
    top[0] === 'regression' && regressions * 2 <= drawn.length
      ? ([...tally.entries()]
          .filter((e) => e[0] !== 'regression')
          .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'inert')
      : top[0]
  let agreement = tally.get(verdict) ?? 0
  let settled = verdict
  // No majority at all — every draw said something different. Naming a winner
  // out of that would turn a coin flip into a finding.
  if (drawn.length > 1 && agreement * 2 <= drawn.length && agreement < 2) {
    settled = 'unstable'
  }
  const reason =
    settled === 'unstable'
      ? `no two draws agreed (${drawn.map((d) => d.verdict).join(', ')})`
      : (drawn.find((d) => d.verdict === settled)?.reason ?? '')
  if (settled === 'unstable') agreement = 0

  db.prepare(
    `INSERT INTO replays(slug, case_id, at, verdict, baseline_recurred, skill_recurred,
                         agreement, samples, reason)
     VALUES (:s,:c,:at,:v,:b,:k,:ag,:n,:r)
     ON CONFLICT(slug, case_id) DO UPDATE SET
       at = :at, verdict = :v, baseline_recurred = :b, skill_recurred = :k,
       agreement = :ag, samples = :n, reason = :r`,
  ).run({
    s: slug,
    c: kase.id,
    at: Date.now(),
    v: settled,
    b: settled === 'prevents' || settled === 'both-fail' ? 1 : 0,
    k: settled === 'regression' || settled === 'both-fail' ? 1 : 0,
    ag: agreement,
    n: drawn.length,
    r: reason.slice(0, 400),
  })

  return {
    caseId: kase.id,
    mode: kase.mode,
    verdict: settled,
    reason,
    agreement,
    samples: drawn.length,
    ungrounded: violations[0],
  }
}

function verdictOf(o: z.infer<typeof JudgeOut>): Verdict {
  return o.baseline_recurred && !o.skill_recurred
    ? 'prevents'
    : !o.baseline_recurred && o.skill_recurred
      ? 'regression'
      : o.baseline_recurred
        ? 'both-fail'
        : 'inert'
}

async function judge(
  db: Db,
  l: Layout,
  llm: LlmProvider,
  kase: CaseRow,
  baseline: string,
  skillMove: string,
): Promise<z.infer<typeof JudgeOut> | null> {
  const { loadPrompt, render, clip } = await import('../store/prompts.ts')
  const prompt = await loadPrompt(l, 'replay-judge')
  try {
    const res = await llm.completeJson({
      prompt: render(prompt.template, {
        wrong_move: kase.wrong_move || '_not recorded — judge from the correction alone_',
        correction: kase.correction,
        baseline_move: clip(baseline, 1500),
        skill_move: clip(skillMove, 1500),
      }),
      tier: prompt.tier,
      purpose: 'replay.judge',
      schema: JudgeOut,
      maxTokens: 1024,
    })
    recordCall(db, llm.id, 'replay.judge', prompt.tier, res.usage, true)
    return res.value
  } catch {
    // A judge that cannot run produces no evidence, not a verdict. Unlike the
    // refuter, silence here must not count against the skill — the bench is
    // the thing being trusted, so it does not get to fail closed.
    return null
  }
}

/** The no-skill arm, computed once per case and reused for every candidate. */
export async function baselineMove(
  db: Db,
  l: Layout,
  llm: LlmProvider,
  kase: CaseRow,
  idx = 0,
): Promise<string> {
  const cached = db
    .prepare<{ move: string }>('SELECT move FROM case_baselines WHERE case_id = :c AND idx = :i')
    .get({ c: kase.id, i: idx })
  if (cached?.move) return cached.move

  const move = await runArm(db, l, llm, kase)
  if (!move) return ''
  db.prepare(
    'INSERT OR REPLACE INTO case_baselines(case_id, idx, move, at) VALUES (:c,:i,:m,:at)',
  ).run({ c: kase.id, i: idx, m: move, at: Date.now() })
  return move
}

/** Ask what an agent would do next, with the skill in context or without it. */
async function runArm(
  db: Db,
  l: Layout,
  llm: LlmProvider,
  kase: CaseRow,
  body?: string,
): Promise<string> {
  const { loadPrompt, render, clip } = await import('../store/prompts.ts')
  const prompt = await loadPrompt(l, 'replay-arm')
  try {
    const res = await llm.completeJson({
      prompt: render(prompt.template, {
        skill_block: body
          ? `## A skill is loaded in your context\n\n${clip(body, 4000)}`
          : '_No skill is loaded._',
        lead_in: clip(kase.lead_in, prompt.maxInputChars - (body ? 4500 : 500)),
      }),
      tier: prompt.tier,
      purpose: body ? 'replay.arm.skill' : 'replay.arm.baseline',
      schema: ArmOut,
      maxTokens: 700,
    })
    recordCall(
      db,
      llm.id,
      body ? 'replay.arm.skill' : 'replay.arm.baseline',
      prompt.tier,
      res.usage,
      true,
    )
    return `${res.value.move}\n\n(${res.value.why})`
  } catch {
    return ''
  }
}

export interface BenchStats {
  scored: number
  passed: number
  failed: number
  logLine: string
}

/** Run the bench over every skill that has not been through it. */
export async function runBench(
  db: Db,
  l: Layout,
  cfg: Config,
  llm: LlmProvider,
  opts: {
    onProgress?: (m: string) => void
    limit?: number
    all?: boolean
    cases?: number
    samples?: number
  } = {},
): Promise<BenchStats> {
  const { readFile } = await import('node:fs/promises')
  const st: BenchStats = { scored: 0, passed: 0, failed: 0, logLine: '' }

  const candidates = listSkills(db)
    .filter((s) => s.state !== 'rejected' && s.kind !== 'frontdoor')
    .filter((s) => opts.all || s.verified_at === null)
    .slice(0, opts.limit ?? 5)

  for (const s of candidates) {
    const body = await readFile(l.skillFile(s.slug), 'utf8').catch(() => '')
    if (!body) continue
    const v = await verifySkill(db, l, cfg, llm, s.slug, body, {
      onProgress: opts.onProgress,
      ownMode: opts.cases,
      offMode: opts.cases,
      samples: opts.samples,
    })
    if (v.results.length === 0) continue
    st.scored++
    if (v.pass) st.passed++
    else st.failed++
  }

  st.logLine = st.scored ? `bench — ${st.passed} passed, ${st.failed} failed of ${st.scored}` : ''
  return st
}
