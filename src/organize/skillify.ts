import type { Db } from '../db/driver.ts'
import { writeIfChanged } from '../store/atomic.ts'
import type { Layout } from '../store/layout.ts'
import type { SkillRow } from './skills.ts'

/**
 * The promotion gate, adapted from gbrain's `skillify`.
 *
 * Mining finds *candidates*. This decides which of them deserve to become a
 * skill at all — because an installed skill is loaded into every future agent
 * session, so the cost of a bad one is paid forever while the cost of missing
 * one is paid once.
 *
 * gbrain's Phase 0 asks three questions before skillifying anything: will this
 * be invoked more than once, is there real procedure here, and is there a
 * trigger phrase a user would actually say. The third is the one mining gets
 * wrong most often: a model will happily summarize a session into prose that
 * reads like a skill but that nothing will ever match against.
 *
 * The first is asked as a judgement rather than a count. Requiring N
 * recurrences discards a procedure that is obviously reusable the first time
 * anyone does it, and SkillOpt measured the cost of that bar: on their
 * training-size ablation a SINGLE example already carried most of the gain
 * (SpreadsheetBench 47.5 from one, against 41.8 with no skill and 78.0 from
 * the full set). An agent reading the transcript can tell a repeatable job
 * from a one-off; the count is corroboration, not the test.
 */
export interface GateResult {
  pass: boolean
  score: number
  reasons: string[]
  failures: string[]
}

export interface GateInput {
  slug: string
  description: string
  body: string
  evidenceCount: number
  /** The miner's judgement that this applies beyond the sessions it came from. */
  reusable: boolean
  confidence: number
  minEvidence: number
  minConfidence: number
  /**
   * Sessions in the cluster where the approach actually WORKED.
   *
   * `undefined` means the caller cannot know — an audit of a skill on disk has
   * no cluster behind it, and a guardrail is mined from corrections by
   * definition. Those skip the check rather than failing it.
   */
  successCount?: number
}

export function promotionGate(i: GateInput): GateResult {
  const reasons: string[] = []
  const failures: string[] = []

  // 1. Reusability, judged rather than counted.
  //
  //    This was "did it happen at least three times". Recurrence is a crude
  //    proxy for generalizability and wrong in both directions: it threw away
  //    a plainly reusable procedure seen once, and admitted a one-off that
  //    merely happened twice. A model that has read the transcript can answer
  //    the real question — would this apply to a different instance of the
  //    same job — so it is asked, and recurrence becomes corroboration.
  if (i.reusable) reasons.push('applies beyond the sessions it came from')
  else failures.push('reads as specific to these sessions, not a repeatable job')

  if (i.evidenceCount >= i.minEvidence) {
    if (i.evidenceCount > 1) reasons.push(`seen in ${i.evidenceCount} sessions`)
  } else {
    failures.push(`only ${i.evidenceCount} sessions (need ${i.minEvidence})`)
  }

  // 2. Confidence from the miner itself.
  if (i.confidence >= i.minConfidence) reasons.push(`confidence ${i.confidence.toFixed(2)}`)
  else failures.push(`confidence ${i.confidence.toFixed(2)} below ${i.minConfidence}`)

  // 3. A real trigger. The description is what a future agent matches against;
  //    if it does not name the situation, the skill is unreachable in practice.
  const trig = triggerQuality(i.description)
  if (trig.ok) reasons.push('description names when to use it')
  else failures.push(trig.why)

  // 4. Actual procedure, not a retelling. Steps are the thing that makes a
  //    skill reusable rather than a story about one afternoon.
  const steps = countSteps(i.body)
  if (steps >= 2) reasons.push(`${steps} concrete steps`)
  else failures.push(`only ${steps} step(s) — reads as narrative, not procedure`)

  // 5. Pitfalls: credited, no longer required.
  //
  //    hoppr required this on the premise that "the failures are the payload".
  //    Demystifying Agent Skills measures the opposite. Holding the source
  //    trajectories fixed and varying only their success/failure mix, skills
  //    distilled from success-only pools dominate, while failure-only pools
  //    fall BELOW the no-skill baseline (Codex 0s5f: 0.5161 skill against
  //    0.5935 raw). Failures are worth recording — hence the credit — but a
  //    draft written from nothing else is worse than no skill at all, so the
  //    requirement moved to where the evidence puts it, in check 6.
  const hasPitfalls =
    /(?:^|\n)#{1,4}\s*(pitfall|gotcha|failure|common mistake|what goes wrong)/i.test(i.body)
  if (hasPitfalls) reasons.push('records pitfalls seen in practice')

  // 6. At least one session where the approach WORKED.
  //
  //    The success-mix finding above, applied at the only point hoppr can act
  //    on it. A procedure reconstructed entirely from transcripts where the
  //    work went wrong is a description of a wrong turn, and shipping one is
  //    measurably worse than shipping nothing.
  if (i.successCount !== undefined) {
    if (i.successCount > 0) reasons.push(`${i.successCount} session(s) where it worked`)
    else failures.push('no session where this approach actually worked')
  }

  // 7. An applicability boundary.
  //
  //    Skills introduce a failure surface that raw execution does not have:
  //    `skill_guidance_misapplied_or_ignored` appears in 10.0% of skill-arm
  //    cases against 0.8% of raw ones, and Agent Skills Can Be Harmful finds
  //    only 2 of 125 functional failures come from an obviously irrelevant
  //    skill — the rest come from a RELEVANT one applied where it does not
  //    fit. Saying where it stops is the cheapest guard against that, and it
  //    is the field MSCE has that hoppr's SKILL.md never did.
  if (BOUNDARY.test(i.body)) reasons.push('says where it does not apply')
  else failures.push('no boundary section — nothing says when NOT to use it')

  // 8. Size. Always-loaded body text is the dominant cost of a bad skill:
  //    Skill-Body Context Bloat accounts for 43 of 46 context-overhead
  //    regressions, against 3 for supplementary material that is only read on
  //    demand. Detail is not forbidden — it belongs behind a reference the
  //    agent opens when it needs it, not in the file loaded every time.
  if (i.body.length > MAX_BODY) {
    failures.push(`body is ${i.body.length} chars — over ${MAX_BODY}, move detail behind a link`)
  }

  const score = reasons.length / (reasons.length + failures.length)
  return { pass: failures.length === 0, score, reasons, failures }
}

/** `## Do not use when`, `## When this does not apply`, `## Limits`, … */
const BOUNDARY =
  /(?:^|\n)#{1,4}\s*(do not use|don't use|when not to|not for|does not apply|out of scope|limits|boundary|boundaries)/i

/**
 * Characters of always-loaded body a skill may carry.
 *
 * Not a style rule. Every character here is re-read on each model call that
 * has the skill loaded, which is what makes Skill-Body Context Bloat the
 * single largest source of skill-induced efficiency regressions.
 */
const MAX_BODY = 5000

const VAGUE = /^(a |an |the )?(skill|guide|helper|utility|process|workflow|approach)\b/i

/** Matches the truncation width in `writeResolver` and the front door. */
const MAX_TRIGGER = 240

export function triggerQuality(description: string): { ok: boolean; why: string } {
  const d = description.trim()
  if (d.length < 40) return { ok: false, why: 'description too short to match against' }
  // And an upper bound, because the description's job is to be scanned.
  //
  // The dispatcher and the front door both render it as one table cell and
  // truncate at 200 characters, so anything past that is invisible where it
  // matters — while still costing every session the tokens to load it. Mined
  // guardrails came back at 330 characters on real evidence: three clauses,
  // a parenthetical, and the trigger buried in the middle.
  if (d.length > MAX_TRIGGER) {
    return { ok: false, why: `description is ${d.length} chars — too long to scan` }
  }
  if (VAGUE.test(d)) return { ok: false, why: 'description is generic, not a trigger' }
  // "Use when…", "…when you see…", or explicit symptoms. This is what a model
  // actually pattern-matches on when deciding whether to load a skill.
  //
  // `use at|before|after|while` is here because it was rejecting descriptions
  // that name the moment perfectly well: "Use at the start of any task that
  // changes files" says WHEN as clearly as "use when you change files", and
  // failing it taught the writer to bend a good sentence around the regex.
  if (
    !/\b(use (this )?(when|at|before|after|during|while|whenever)|when (you|the|a|someone)|if (you|the)|symptom)/i.test(
      d,
    )
  ) {
    return { ok: false, why: 'description does not say WHEN to use it' }
  }
  return { ok: true, why: '' }
}

export function countSteps(body: string): number {
  const numbered = (body.match(/^\s*\d+[.)]\s+\S/gm) ?? []).length
  const bulleted = (body.match(/^\s*[-*]\s+\S/gm) ?? []).length
  const fenced = (body.match(/```/g) ?? []).length / 2
  return Math.max(numbered, Math.min(bulleted, 12)) + (fenced >= 1 ? 1 : 0)
}

/**
 * The resolver — a dispatch table over installed skills.
 *
 * At three skills you do not need one. At three hundred, loading every
 * SKILL.md into every turn is the dominant token cost, and gbrain solved that
 * with a single routed index: read the table, then read only the one skill
 * that matched. hoppr mines skills automatically, so it reaches that scale
 * faster than a human-authored set would — the resolver has to exist before
 * the problem does.
 */
export async function writeResolver(l: Layout, skills: SkillRow[]): Promise<string> {
  const live = skills
    .filter((s) => s.state === 'accepted' || s.state === 'installed')
    // Archived skills stay on disk and in the index but leave the dispatcher.
    // Nothing is deleted: a skill that fell out of favour is exactly what
    // someone will want to read later to understand why it did.
    .filter((s) => s.lifecycle !== 'archived')
    .sort((a, b) => a.slug.localeCompare(b.slug))

  const lines = [
    '# Skill Resolver',
    '',
    'This is the dispatcher, not the implementation. Read the standing context,',
    'then match the situation and read that ONE procedure file. Do not load them all.',
    '',
  ]

  // Ledgers are standing context, not situational procedures, and the
  // difference matters at dispatch time. "What writing style does this person
  // want" has to be known BEFORE writing; a table that says to look it up when
  // the situation arises is a table nobody consults, because by then the
  // agent has already picked a style and does not know it picked wrong.
  const front = live.filter((s) => s.kind === 'frontdoor')
  const guardrails = live.filter((s) => s.kind === 'guardrail')
  const procedures = live.filter((s) => s.kind === 'procedure')
  const ledgers = live.filter(
    (s) => s.kind !== 'procedure' && s.kind !== 'guardrail' && s.kind !== 'frontdoor',
  )

  if (live.length === 0) {
    lines.push('_No accepted skills yet._ Run `hoppr deep`, then `hoppr skills review`.', '')
  } else {
    // The front door inlines the standing halves, so an agent that reads it
    // needs nothing else before starting. It is listed first and alone,
    // because a "read these first" list of four entries is a list of four
    // things to skip.
    if (front.length > 0) {
      lines.push(
        '## Read this first',
        '',
        ...front.map(
          (s) => `- \`skills/${s.slug}/SKILL.md\` — ${s.description.replace(/\s+/g, ' ').trim()}`,
        ),
        '',
      )
    }
    if (ledgers.length > 0) {
      lines.push(
        '## Read these first',
        '',
        'Standing context, not situational. Each is a short list assembled from',
        'things this person actually said, with a citation per line.',
        '',
      )
      for (const s of ledgers) {
        // Full description, not the table clip: there are at most three of
        // these, and the clip was cutting the sentence that says WHEN to read
        // it — the only part that changes an agent's behaviour.
        lines.push(`- \`skills/${s.slug}/SKILL.md\` — ${s.description.replace(/\s+/g, ' ').trim()}`)
      }
      lines.push('')
    }
    // Guardrails sit above procedures and in their own table. A procedure is
    // read when its job comes up; a guardrail is read when its MISTAKE is
    // about to be made, which is a situation an agent does not know it is in.
    // Naming them separately, with what each has already cost, is the only
    // thing that gets one loaded in time.
    if (guardrails.length > 0) {
      lines.push(
        '## Mistakes already made here',
        '',
        'Each of these happened in past sessions. Read the one whose situation applies',
        'before acting in it, not after.',
        '',
        '| Watch for | Skill |',
        '|---|---|',
      )
      for (const s of guardrails) {
        lines.push(`| ${oneLine(s.description)} | \`skills/${s.slug}/SKILL.md\` |`)
      }
      lines.push('')
    }
    if (procedures.length > 0) {
      lines.push('## Match the situation', '', '| When | Skill |', '|---|---|')
      for (const s of procedures) {
        lines.push(`| ${oneLine(s.description)} | \`skills/${s.slug}/SKILL.md\` |`)
      }
      lines.push('')
    }
    lines.push(`_${live.length} skills. Generated by hoppr; do not hand-edit._`)
  }

  const path = `${l.skills}/RESOLVER.md`
  await writeIfChanged(path, `${lines.join('\n')}\n`)
  return l.rel(path)
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim().slice(0, 220)
}

/** Audit every skill against the gate, for `hoppr skills audit`. */
/**
 * Score skills against the gate.
 *
 * Ledgers are excluded rather than scored, because the gate asks questions that
 * do not apply to them: a vocabulary list has no steps and no pitfalls, and its
 * evidence is one quote per line rather than N sessions agreeing. Running them
 * through it anyway would report a permanent, unfixable failure on three files
 * that are working exactly as intended — which is how an audit stops being read.
 */
export function auditSkills(
  _db: Db,
  skills: SkillRow[],
  bodies: Map<string, string>,
  cfg: { minEvidence: number; minConfidence: number },
): Array<{ slug: string; state: string; result: GateResult }> {
  return skills
    .filter((s) => s.kind === 'procedure' || s.kind === 'guardrail')
    .map((s) => ({
      slug: s.slug,
      state: s.state,
      result: promotionGate({
        slug: s.slug,
        description: s.description,
        body: bodies.get(s.slug) ?? '',
        evidenceCount: s.evidence_count,
        reusable: true,
        confidence: s.confidence,
        minEvidence: cfg.minEvidence,
        minConfidence: cfg.minConfidence,
      }),
    }))
}

// ── set-level audit ─────────────────────────────────────────────

export interface Overlap {
  a: string
  b: string
  /** Token overlap of the two descriptions, 0–1. */
  similarity: number
}

/**
 * Pairs of live skills whose descriptions compete for the same situation.
 *
 * The gate scores each skill on its own, which cannot see the failure that
 * actually caps a growing skill set. Demystifying Agent Skills measures it:
 * as pools grow from 5 to 100 the precision with which an agent actually uses
 * the right skill collapses from 29.6% to 3.3% — and splitting by pool
 * composition shows *confusability*, not size, is the stressor. Top-1
 * retrieval on pools of SIMILAR skills falls 70.5% → 53.4%, against
 * 97.7% → 84.1% on random ones.
 *
 * hoppr sits in the worst case of that measurement twice over. It mines
 * automatically, so it reaches large pools without anyone deciding to, and
 * every skill is distilled from one person's work, so the pool is similar by
 * construction. Two skills that both say "use when you are about to report
 * that a change works" do not merely waste a slot — they make each other
 * unreachable.
 *
 * Deliberately a report rather than an automatic merge. Which of two
 * overlapping skills should survive is a judgement about what the person
 * meant, and the wrong answer silently deletes something earned.
 */
export function findOverlaps(
  skills: Array<{ slug: string; description: string; state: string; lifecycle: string }>,
  threshold = 0.5,
): Overlap[] {
  const live = skills
    .filter((s) => s.state === 'accepted' || s.state === 'installed')
    .filter((s) => s.lifecycle !== 'archived')
    .map((s) => ({ slug: s.slug, tokens: triggerTokens(s.description) }))

  const out: Overlap[] = []
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]!
      const b = live[j]!
      const sim = overlap(a.tokens, b.tokens)
      if (sim >= threshold) out.push({ a: a.slug, b: b.slug, similarity: sim })
    }
  }
  return out.sort((x, y) => y.similarity - x.similarity)
}

/**
 * The words a description is matched ON, which is not all of its words.
 *
 * "Use when", "before", "you are about to" appear in every well-formed
 * description — the gate requires them — so counting them makes every pair of
 * good descriptions look alike and the report fires on everything.
 */
const TRIGGER_STOP = new Set([
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
])

function triggerTokens(description: string): Set<string> {
  const out = new Set<string>()
  for (const w of description.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || TRIGGER_STOP.has(w)) continue
    out.add(w.replace(/(ing|ed|es|s)$/, ''))
  }
  return out
}

/**
 * Overlap coefficient, not Jaccard.
 *
 * A short description fully contained in a longer one is the dangerous case —
 * everything the short one matches, the long one matches too — and Jaccard
 * scores that low precisely because the lengths differ.
 */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const x of a) if (b.has(x)) shared++
  return shared / Math.min(a.size, b.size)
}
