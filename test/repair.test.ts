import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { defaults } from '../src/config/schema.ts'
import { Hoppr } from '../src/core/hoppr.ts'
import type { JsonOptions, LlmProvider } from '../src/llm/provider.ts'
import { buildCases } from '../src/organize/cases.ts'
import { listPrinciples, retrievePrinciples, seedPrinciples } from '../src/organize/principles.ts'
import { repairSkill, revisionHistory } from '../src/organize/repair.ts'
import { Layout } from '../src/store/layout.ts'
import { tempStore } from './helpers.ts'

const OBJECTION = 'no, you never ran the tests, you just said it worked'

function session(objection = OBJECTION, topic = 'parser'): string {
  return [
    '## Session',
    '',
    '## Transcript',
    '',
    `**user:** fix the ${topic}`,
    `**assistant:** ${`Looking at the ${topic}. `.repeat(20)}`,
    `**assistant:** Fixed it — the ${topic} handles the empty case now.`,
    `**user:** ${objection}`,
  ].join('\n')
}

/**
 * Enough cases for a skill-level verdict to be conclusive.
 *
 * A verdict over one or two cases does not reproduce — `prevents === 0` is a
 * single flip from `prevents === 1` — so the episode refuses to act on it, and
 * a fixture below the bar tests the refusal rather than the loop.
 */
const OBJECTIONS = [
  OBJECTION,
  'you said it was green but you never started the suite at all',
  'stop, that is not what the ticket asked for at any point',
  'why did you rewrite the whole module for one line of change',
  'I already told you the config lives in the other directory',
  'that is the third time you have assumed instead of checking',
  'you skipped the migration step entirely and called it done',
  'no, revert that, the schema was fine as it was before',
]

const GOOD_BODY = [
  '## The rule',
  'Run it before you say it works.',
  '## Procedure',
  '1. `npm run check`',
  '2. Quote the counts in the summary.',
  '## Pitfalls',
  '- claiming a fix works because the types check',
  '## Do not use when',
  '- the change is a comment, where running proves nothing',
].join('\n\n')

async function store() {
  const t = await tempStore()
  const h = new Hoppr({ layout: new Layout(t.layout.root), config: defaults(), sources: [] })
  return { ...t, h }
}

async function seed(h: Hoppr, layout: Layout, slug = 'run-it-first') {
  const db = await h.db()
  const now = Date.now()
  OBJECTIONS.forEach((objection, i) => {
    const text = session(objection, `parser${i}`)
    db.prepare(
      `INSERT INTO raw(id,path,kind,source,media_type,bytes,content_hash,created,captured,text,partial)
       VALUES (:id,:p,'session','connector:test','text/markdown',:b,:id,:t,:t,:text,0)`,
    ).run({ id: `S${i}`, p: `raw/s${i}.md`, b: text.length, t: now, text })
    db.prepare(
      `INSERT INTO corrections(id,raw_id,mode,cluster,headline,quote,turns,severity,observed,created)
       VALUES (:id,:raw,'claimed-done-without-running','claimed-done-without-running',
               'Claimed the fix worked without running anything.',:q,3,'rework',:t,:t)`,
    ).run({ id: `c${i}`, raw: `S${i}`, q: objection, t: now })
  })
  db.prepare(
    `INSERT INTO skills(slug,name,description,path,state,kind,prevents,evidence_count,confidence,created,updated)
     VALUES (:s,:s,'Use when about to report that a change works or is finished.',NULL,
             'proposed','guardrail','claimed-done-without-running',1,0.9,:t,:t)`,
  ).run({ s: slug, t: now })
  await buildCases(db)
  db.exec("UPDATE cases SET split = 'holdout'")
  await mkdir(layout.skillDir(slug), { recursive: true })
  await writeFile(
    layout.skillFile(slug),
    `---\nname: ${slug}\ndescription: Use when about to report that a change works or is finished.\n---\n\n${GOOD_BODY}\n`,
  )
}

type Verdicts = { baseline_recurred: boolean; skill_recurred: boolean }

/**
 * Drives the whole episode: the two replay arms, the bench judge, and the
 * repair call.
 *
 * The verdict is keyed on whether a repair has happened yet rather than on a
 * call counter, because a single bench run makes one judge call per sample and
 * a counter-based mock silently lets the pre-repair scoring pass on a majority.
 */
class RepairLlm implements LlmProvider {
  readonly id = 'mock'
  readonly supportsVision = true
  repairs = 0
  judges = 0
  readonly before: Verdicts
  readonly after: Verdicts
  readonly repair: Record<string, unknown>
  constructor(before: Verdicts, after: Verdicts, repair: Record<string, unknown>) {
    this.before = before
    this.after = after
    this.repair = repair
  }
  async available() {
    return true
  }
  async completeText() {
    return { text: '', usage: {} }
  }
  async completeJson<T>(o: JsonOptions<T>) {
    if (o.purpose === 'skills.repair') {
      this.repairs++
      return { value: o.schema.parse(this.repair), usage: {} }
    }
    if (o.purpose === 'replay.judge') {
      this.judges++
      const v = this.repairs === 0 ? this.before : this.after
      return { value: o.schema.parse({ ...v, reason: 'because' }), usage: {} }
    }
    return { value: o.schema.parse({ move: 'ship it', why: 'fine' }), usage: {} }
  }
}

const REVISED = [
  '## The rule',
  'Run it, and quote what it printed.',
  '## Procedure',
  '1. `npm run check`',
  '2. Paste the counts.',
  '## Pitfalls',
  '- a clean typecheck is not evidence about behaviour',
  '## Do not use when',
  '- the change is a comment',
].join('\n\n')

describe('principle memory', () => {
  it('ships seeded and is idempotent', async () => {
    const { h, cleanup } = await store()
    try {
      const db = await h.db()
      expect(seedPrinciples(db)).toBeGreaterThan(0)
      expect(seedPrinciples(db)).toBe(0)
      // Every principle says where it must NOT be applied. One that claims to
      // apply everywhere will be applied everywhere.
      expect(listPrinciples(db).every((p) => p.avoid.length > 10)).toBe(true)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('retrieves on the symptom, not the cure', async () => {
    const { h, cleanup } = await store()
    try {
      const db = await h.db()
      seedPrinciples(db)
      // A reviser knows what went wrong, not which repair it wants — indexing
      // on the cure would make the memory searchable only by someone who has
      // already stopped needing it.
      const got = retrievePrinciples(
        db,
        'the work came out right but took far longer than the change warranted, repeated rebuilds',
      )
      expect(got[0]?.defect).toBe('excessive-verification')
      h.close()
    } finally {
      await cleanup()
    }
  })
})

describe('the repair episode', () => {
  it('does nothing to a skill the bench already passes', async () => {
    const { h, layout, cleanup } = await store()
    try {
      await seed(h, layout)
      const llm = new RepairLlm(
        { baseline_recurred: true, skill_recurred: false },
        { baseline_recurred: true, skill_recurred: false },
        {},
      )
      const r = await repairSkill(await h.db(), layout, defaults(), llm, 'run-it-first')
      expect(r.outcome).toBe('unchanged')
      expect(r.detail).toMatch(/already passes/)
      expect(llm.repairs).toBe(0)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('keeps the first candidate that clears the bench, and writes it', async () => {
    const { h, layout, cleanup } = await store()
    try {
      await seed(h, layout)
      // Fails at first; every judgement after the repair says it prevented.
      const llm = new RepairLlm(
        { baseline_recurred: false, skill_recurred: true },
        { baseline_recurred: true, skill_recurred: false },
        {
          body: REVISED,
          changed: ['quote the output'],
          principles: [],
          abandon: false,
        },
      )
      const db = await h.db()
      const r = await repairSkill(db, layout, defaults(), llm, 'run-it-first')
      expect(r.outcome).toBe('kept')
      expect(r.rounds).toBe(1)
      expect(await readFile(layout.skillFile('run-it-first'), 'utf8')).toContain('Paste the counts')
      expect(revisionHistory(db, 'run-it-first')[0]?.outcome).toBe('kept')
      h.close()
    } finally {
      await cleanup()
    }
  })

  /**
   * A reviser with no exit narrows a skill until it stops firing, which makes
   * the failures disappear without fixing anything. "This should not exist" is
   * a real answer and the prompt asks for it.
   */
  it('accepts the reviser abandoning a skill it cannot save', async () => {
    const { h, layout, cleanup } = await store()
    try {
      await seed(h, layout)
      const before = await readFile(layout.skillFile('run-it-first'), 'utf8')
      const llm = new RepairLlm(
        { baseline_recurred: false, skill_recurred: true },
        { baseline_recurred: true, skill_recurred: false },
        {
          body: REVISED,
          changed: [],
          principles: [],
          abandon: true,
          reason: 'the mode groups two unrelated failures',
        },
      )
      const r = await repairSkill(await h.db(), layout, defaults(), llm, 'run-it-first')
      expect(r.outcome).toBe('abandoned')
      expect(r.detail).toMatch(/unrelated/)
      // Abandoning must not quietly rewrite the file it gave up on.
      expect(await readFile(layout.skillFile('run-it-first'), 'utf8')).toBe(before)
      h.close()
    } finally {
      await cleanup()
    }
  })

  /**
   * Measured on the first real episode: two of three rounds died on "no
   * boundary section", the reviser having dropped a required heading the
   * prompt had already asked for. A round exists to fix the failures, and
   * spending one on a formatting slip is waste.
   */
  it('hands a gate complaint back inside the round instead of burning it', async () => {
    const { h, layout, cleanup } = await store()
    try {
      await seed(h, layout)
      const llm = new RepairLlm(
        { baseline_recurred: false, skill_recurred: true },
        { baseline_recurred: true, skill_recurred: false },
        {},
      )
      // First draft drops the boundary; the retry, having been told, restores it.
      const inner = llm.completeJson.bind(llm)
      llm.completeJson = async (o) => {
        if (o.purpose === 'skills.repair') {
          llm.repairs++
          const dropped =
            '## The rule\n\nRun it.\n\n## Procedure\n\n1. `npm run check`\n2. Quote it.'
          return {
            value: o.schema.parse({
              body: llm.repairs === 1 ? dropped : REVISED,
              changed: [],
              principles: [],
              abandon: false,
            }),
            usage: {},
          }
        }
        return inner(o)
      }

      const db = await h.db()
      const r = await repairSkill(db, layout, defaults(), llm, 'run-it-first', { budget: 1 })
      // Two repair calls, one round, and the skill shipped.
      expect(llm.repairs).toBe(2)
      expect(r.rounds).toBe(1)
      expect(r.outcome).toBe('kept')
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('discards a candidate that fails the gate, without shipping it', async () => {
    const { h, layout, cleanup } = await store()
    try {
      await seed(h, layout)
      const before = await readFile(layout.skillFile('run-it-first'), 'utf8')
      const llm = new RepairLlm(
        { baseline_recurred: false, skill_recurred: true },
        { baseline_recurred: true, skill_recurred: false },
        {
          // No boundary and no steps — a slogan, which is what a reviser
          // produces when it "fixes" a skill by softening it.
          body: '## The rule\n\nJust be careful about everything, always.',
          changed: [],
          principles: [],
          abandon: false,
        },
      )
      const db = await h.db()
      const r = await repairSkill(db, layout, defaults(), llm, 'run-it-first', { budget: 2 })
      expect(r.outcome).toBe('unchanged')
      expect(await readFile(layout.skillFile('run-it-first'), 'utf8')).toBe(before)
      expect(revisionHistory(db, 'run-it-first').every((x) => x.outcome === 'rejected')).toBe(true)
      h.close()
    } finally {
      await cleanup()
    }
  })
})
