import { sha256 } from '../core/hash.ts'
import type { Db } from '../db/driver.ts'
import { contentTokens, jaccard } from './lessons.ts'

/**
 * Reusable repair patterns, kept separately from any skill.
 *
 * A diagnosis says what failed in this skill on this case. A principle says
 * what to do about that *shape* of failure, in a form that transfers to a
 * skill with nothing else in common. SkillRevise separates them for exactly
 * that reason, and hoppr has been carrying half the idea already:
 * `skill_rejected_edits` remembers what did not work, and nothing remembered
 * what did.
 *
 * Every field earns its place. `consider` is what retrieval matches against,
 * so it describes the symptom rather than the cure — a memory indexed on cures
 * can only be searched by someone who already knows which cure they want.
 * `anchor` names what the executor should do differently, because an edit that
 * improves the prose without changing behaviour is the thing execution anchors
 * exist to prevent. `avoid` is required: a principle that claims to apply
 * everywhere will be applied everywhere.
 */
export interface Principle {
  id: string
  defect: string
  consider: string
  repair: string
  anchor: string
  avoid: string
  origin: string
  used: number
  worked: number
}

/**
 * The shipped memory.
 *
 * Grounded in measured defect classes rather than invented: Task-Implementation
 * Fault accounts for 86 of 125 confirmed functional failures (Incorrect
 * Required-Element Fill 46, Required-Element Omission 36), Artifact
 * Misplacement 24, Excessive Verification 67 of 182 efficiency regressions,
 * and Skill-Body Context Bloat 43 of 46 context-overhead cases. Those are the
 * repairs worth knowing before a store has learned any of its own.
 */
export const SEED_PRINCIPLES: Array<Omit<Principle, 'id' | 'used' | 'worked' | 'origin'>> = [
  {
    defect: 'required-element-omission',
    consider:
      'the work came out incomplete — a field, a step, or a parameter the task named was never produced',
    repair:
      'name the required elements explicitly as a checklist the skill says must all be present, separate from any example',
    anchor: 'the executor enumerates the task-required elements and confirms each before finishing',
    avoid:
      'a task whose requirements vary per invocation — a fixed checklist then becomes a wrong one',
  },
  {
    defect: 'incorrect-required-element-fill',
    consider:
      "the work was produced but wrong in a specific way — wrong unit, wrong API, wrong shape — matching the skill's example rather than the task",
    repair:
      "mark every concrete value in the skill as an example, and say that the task's own values win over it",
    anchor: 'the executor reads its parameters from the task rather than copying the skill',
    avoid: 'a skill whose values ARE the point, such as a fixed protocol or a required constant',
  },
  {
    defect: 'excessive-verification',
    consider:
      'the work came out right but took far longer than the change warranted — repeated checks, rebuilds, or audits',
    repair:
      'condition the verification the skill prescribes on the size and risk of the change, and say where a step can be skipped',
    anchor:
      'the executor runs the cheap check on a small change and the full sequence only on a risky one',
    avoid:
      'a change class where a missed check is unrecoverable — anything shipped, deleted, or migrated',
  },
  {
    defect: 'artifact-misplacement',
    consider:
      'the right thing was built in the wrong place — a path, module, or integration point the task had specified',
    repair:
      'state that any path the task names overrides the layout the skill describes, and remove absolute paths from the body',
    anchor:
      'the executor writes to the task-specified path and treats the skill layout as a fallback',
    avoid: 'a skill about a fixed repository layout, where the location is the content',
  },
  {
    defect: 'skill-body-context-bloat',
    consider: 'the skill is long and every model call that loads it pays for the whole thing',
    repair:
      'cut the body to the rule and the steps, and move examples, templates and long checklists behind a reference the agent opens on demand',
    anchor: 'the executor loads the short body and reaches for the detail only when it needs it',
    avoid: 'a body already short — trimming further removes the procedure and leaves a slogan',
  },
  {
    defect: 'guidance-misapplied',
    consider: 'the skill fired in a situation it does not fit and made that situation worse',
    repair:
      'add or sharpen the boundary section so it names the situations where following this would be wrong',
    anchor: 'the executor recognises the case as out of scope and does not apply the skill',
    avoid:
      'a skill that already declines correctly — another boundary narrows it into never matching',
  },
  {
    defect: 'unverifiable-outcome',
    consider: 'the skill says what to do but nothing in it says how anyone would know it worked',
    repair:
      'add the concrete check that distinguishes done from claimed, and what its output looks like',
    anchor: 'the executor produces evidence a reader can check rather than an assertion',
    avoid: 'work with no checkable output, where inventing one prescribes a ritual',
  },
  {
    defect: 'unreachable-trigger',
    consider:
      'the skill is sound but never gets loaded, or loses to a neighbour that covers the same ground',
    repair:
      'rewrite the description to name the concrete situation and the moment it arises, in the words a person would use',
    anchor: 'a router matching on the description reaches this skill in its own situation',
    avoid:
      'a description already specific — broadening it to win more matches is what caused the collision',
  },
]

export function seedPrinciples(db: Db): number {
  let n = 0
  for (const p of SEED_PRINCIPLES) {
    const id = sha256(`principle ${p.defect}`).slice(0, 24)
    const r = db
      .prepare(
        `INSERT INTO principles(id, defect, consider, repair, anchor, avoid, origin, created)
         VALUES (:id,:defect,:consider,:repair,:anchor,:avoid,'seed',:now)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run({ id, ...p, now: Date.now() })
    if (r.changes > 0) n++
  }
  return n
}

export function listPrinciples(db: Db): Principle[] {
  return db.prepare<Principle>('SELECT * FROM principles ORDER BY defect').all()
}

/**
 * The principles worth binding to this diagnosis.
 *
 * Matched on `consider`, which describes the symptom — the reviser knows what
 * went wrong, not which repair it wants, so indexing on the cure would make
 * the memory searchable only by someone who no longer needs it.
 *
 * Ranked by fit, then by whether the principle has actually worked before.
 * A principle applied ten times and never followed by a passing revision is
 * worth less than an untried one, and the counter is the only thing here that
 * knows the difference.
 */
export function retrievePrinciples(db: Db, diagnosis: string, k = 3): Principle[] {
  const q = contentTokens(diagnosis)
  return listPrinciples(db)
    .map((p) => ({
      p,
      fit: jaccard(q, contentTokens(`${p.consider} ${p.defect}`)),
      // Laplace-smoothed, so an untried principle reads as no opinion rather
      // than as a failure — the same shape as skill reliability.
      eta: (p.worked + 1) / (p.used + 2),
    }))
    .filter((x) => x.fit > 0)
    .sort((a, b) => b.fit - a.fit || b.eta - a.eta)
    .slice(0, k)
    .map((x) => x.p)
}

export function recordPrincipleUse(db: Db, ids: string[], worked: boolean): void {
  for (const id of ids) {
    db.prepare('UPDATE principles SET used = used + 1, worked = worked + :w WHERE id = :id').run({
      w: worked ? 1 : 0,
      id,
    })
  }
}

export function renderPrinciples(ps: Principle[]): string {
  if (ps.length === 0) return '_none matched — repair from the diagnosis alone._'
  return ps
    .map((p) =>
      [
        `### ${p.defect}`,
        `**Consider when:** ${p.consider}`,
        `**Repair:** ${p.repair}`,
        `**The edit must change what the executor does:** ${p.anchor}`,
        `**Do not apply when:** ${p.avoid}`,
      ].join('\n'),
    )
    .join('\n\n')
}
