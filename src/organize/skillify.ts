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

  // 5. Pitfalls. gbrain does not require this; hoppr does, because the whole
  //    premise of mining transcripts is that the FAILURES are the payload. A
  //    skill with no pitfalls is a worse version of the README.
  const hasPitfalls =
    /(?:^|\n)#{1,4}\s*(pitfall|gotcha|failure|common mistake|what goes wrong)/i.test(i.body)
  if (hasPitfalls) reasons.push('records pitfalls seen in practice')
  else failures.push('no pitfalls section — the failures are the reason to mine transcripts')

  const score = reasons.length / (reasons.length + failures.length)
  return { pass: failures.length === 0, score, reasons, failures }
}

const VAGUE = /^(a |an |the )?(skill|guide|helper|utility|process|workflow|approach)\b/i

export function triggerQuality(description: string): { ok: boolean; why: string } {
  const d = description.trim()
  if (d.length < 40) return { ok: false, why: 'description too short to match against' }
  if (VAGUE.test(d)) return { ok: false, why: 'description is generic, not a trigger' }
  // "Use when…", "…when you see…", or explicit symptoms. This is what a model
  // actually pattern-matches on when deciding whether to load a skill.
  if (!/\b(use (this )?when|when (you|the|a|someone)|if (you|the)|symptom)/i.test(d)) {
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
  const ledgers = live.filter((s) => s.kind !== 'procedure')
  const procedures = live.filter((s) => s.kind === 'procedure')

  if (live.length === 0) {
    lines.push('_No accepted skills yet._ Run `hoppr deep`, then `hoppr skills review`.', '')
  } else {
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
    .filter((s) => s.kind === 'procedure')
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
