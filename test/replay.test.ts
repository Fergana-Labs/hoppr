import { describe, expect, it } from 'vitest'
import { defaults } from '../src/config/schema.ts'
import { Hoppr } from '../src/core/hoppr.ts'
import type { JsonOptions, LlmProvider } from '../src/llm/provider.ts'
import { buildCases, caseCounts, cutLeadIn, listCases, splitFor } from '../src/organize/cases.ts'
import { verifySkill } from '../src/organize/replay.ts'
import { Layout } from '../src/store/layout.ts'
import { tempStore } from './helpers.ts'

const OBJECTION = 'no, you never ran the tests, you just said it worked'

/**
 * A session shaped the way `renderTranscript` writes one: user turns are
 * repeated in a `## Prompts` block above the body, which is why every cut has
 * to be made from `## Transcript` onward.
 */
function session(objection = OBJECTION): string {
  return [
    '## Session',
    '',
    '## Prompts',
    '',
    '> fix the parser',
    `> ${objection}`,
    '',
    '## Transcript',
    '',
    '**user:** fix the parser',
    `**assistant:** ${'Looking at the tokenizer now. '.repeat(20)}`,
    '**assistant:** Fixed it — the parser handles the empty case correctly now.',
    `**user:** ${objection}`,
    '**assistant:** You are right, let me run them.',
  ].join('\n')
}

async function store() {
  const t = await tempStore()
  const h = new Hoppr({ layout: new Layout(t.layout.root), config: defaults(), sources: [] })
  return { ...t, h }
}

async function seed(h: Hoppr, id = 'S0', text = session(), mode = 'claimed-done-without-running') {
  const db = await h.db()
  db.prepare(
    `INSERT INTO raw(id,path,kind,source,media_type,bytes,content_hash,created,captured,text,partial)
     VALUES (:id,:p,'session','connector:test','text/markdown',:b,:h,:t,:t,:text,0)`,
  ).run({ id, p: `raw/${id}.md`, b: text.length, h: id, t: Date.now(), text })
  db.prepare(
    `INSERT INTO corrections(id,raw_id,mode,headline,quote,turns,severity,observed,created)
     VALUES (:id,:raw,:mode,'Claimed the fix worked without running anything.',:q,3,'rework',:t,:t)`,
  ).run({ id: `c-${id}`, raw: id, mode, q: OBJECTION, t: Date.now() })
}

describe('cutting a case out of a transcript', () => {
  /**
   * The one property everything else rests on. A lead-in carrying the person's
   * objection hands both arms the answer, every candidate scores perfectly,
   * and the bench becomes an expensive way to agree with itself.
   */
  it('stops before the correction, and keeps what led to it', () => {
    const cut = cutLeadIn(session(), OBJECTION)
    expect(cut).not.toBeNull()
    expect(cut!.leadIn).not.toContain(OBJECTION)
    // Not even the marker that a user turn is starting — an arm that can see
    // one is coming knows something the real agent did not.
    expect(cut!.leadIn.trimEnd().endsWith('**user:**')).toBe(false)
    expect(cut!.leadIn).toContain('Fixed it')
    expect(cut!.wrongMove).toContain('Fixed it')
  })

  it('cuts from the transcript, not from the prompts block above it', () => {
    // The prompts block repeats every user turn verbatim. Matching there would
    // cut the lead-in out of a list of prompts instead of the conversation.
    const cut = cutLeadIn(session(), OBJECTION)
    expect(cut!.leadIn).toContain('**assistant:**')
  })

  it('refuses a correction it cannot place in the conversation', () => {
    expect(cutLeadIn(session(), 'something nobody ever said in this session')).toBeNull()
    expect(cutLeadIn('a document with no transcript at all', OBJECTION)).toBeNull()
  })
})

describe('the held-out split', () => {
  it('is decided by the id and nothing else', () => {
    // A split re-rolled each pass would let a skill drift into passing by
    // being scored until the easy cases landed on the holdout side — the
    // failure a held-out split exists to prevent.
    const ids = [...Array(40)].map((_, i) => `case-${i}`)
    expect(ids.map(splitFor)).toEqual(ids.map(splitFor))
  })

  /**
   * `sha256()` returns a `sha256:`-prefixed digest. Parsing from character
   * zero gives NaN, `NaN % 2 === 0` is false, and every case in the store
   * silently landed on the holdout side — the train half empty, the design
   * inert, and nothing about it visible from the outside.
   */
  it('actually divides, rather than sending everything one way', () => {
    const ids = [...Array(400)].map((_, i) => `case-${i}`)
    const train = ids.filter((i) => splitFor(i) === 'train').length
    expect(train).toBeGreaterThan(150)
    expect(train).toBeLessThan(250)
  })
})

describe('building cases', () => {
  it('builds one per correction and assigns it a side', async () => {
    const { h, cleanup } = await store()
    try {
      await seed(h)
      const db = await h.db()
      const st = await buildCases(db)
      expect(st.built).toBe(1)
      expect(st.train + st.holdout).toBe(1)
      expect(caseCounts(db).total).toBe(1)
      const [kase] = listCases(db)
      expect(kase!.correction).toBe(OBJECTION)
      expect(kase!.lead_in).not.toContain(OBJECTION)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('is idempotent, and counts a correction it could not place', async () => {
    const { h, cleanup } = await store()
    try {
      await seed(h)
      // A correction whose quote never appears in the transcript body has no
      // "before" to replay from — that is not a weaker case, it is not a case.
      const db = await h.db()
      db.prepare(
        `INSERT INTO corrections(id,raw_id,mode,headline,quote,turns,severity,observed,created)
         VALUES ('c-ghost','S0','some-mode','h','a line nobody in this session ever typed',1,'annoyance',:t,:t)`,
      ).run({ t: Date.now() })

      const first = await buildCases(db)
      expect(first.built).toBe(1)
      expect(first.unplaceable).toBe(1)
      expect((await buildCases(db)).built).toBe(0)
      h.close()
    } finally {
      await cleanup()
    }
  })
})

/**
 * Drives both arms and the judge. `moves` is what each arm returns; `verdict`
 * is what the judge says about them.
 */
class BenchLlm implements LlmProvider {
  readonly id = 'mock'
  readonly supportsVision = true
  arms: Array<{ skill: boolean }> = []
  readonly verdict: { baseline_recurred: boolean; skill_recurred: boolean }
  constructor(verdict: { baseline_recurred: boolean; skill_recurred: boolean }) {
    this.verdict = verdict
  }
  async available() {
    return true
  }
  async completeText() {
    return { text: '', usage: {} }
  }
  async completeJson<T>(o: JsonOptions<T>) {
    if (o.purpose === 'replay.judge') {
      return { value: o.schema.parse({ ...this.verdict, reason: 'because' }), usage: {} }
    }
    this.arms.push({ skill: o.purpose === 'replay.arm.skill' })
    return { value: o.schema.parse({ move: 'ship it', why: 'seems fine' }), usage: {} }
  }
}

async function seedSkill(h: Hoppr, slug: string, mode: string) {
  const db = await h.db()
  const now = Date.now()
  db.prepare(
    `INSERT INTO skills(slug,name,description,path,state,kind,prevents,evidence_count,confidence,created,updated)
     VALUES (:s,:s,'Use when about to report a change works.',NULL,'proposed','guardrail',:m,1,0.9,:now,:now)`,
  ).run({ s: slug, m: mode, now })
}

describe('the bench', () => {
  it('credits a skill only when the baseline failed the same case', async () => {
    const { h, layout, cleanup } = await store()
    try {
      await seed(h)
      const db = await h.db()
      await buildCases(db)
      await seedSkill(h, 'run-it-first', 'claimed-done-without-running')
      // Force the single case onto the holdout side so the skill is scored on
      // evidence it was not written from.
      db.exec("UPDATE cases SET split = 'holdout'")

      const llm = new BenchLlm({ baseline_recurred: true, skill_recurred: false })
      const v = await verifySkill(
        db,
        layout,
        defaults(),
        llm,
        'run-it-first',
        '## The rule\nRun it.',
        { samples: 1 },
      )
      expect(v.prevents).toBe(1)
      expect(v.regressions).toBe(0)
      expect(v.pass).toBe(true)
      // One arm with the skill, one without — the comparison is the verdict.
      expect(llm.arms.filter((a) => a.skill)).toHaveLength(1)
      expect(llm.arms.filter((a) => !a.skill)).toHaveLength(1)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('gives no credit when the baseline handled the case anyway', async () => {
    const { h, layout, cleanup } = await store()
    try {
      await seed(h)
      const db = await h.db()
      await buildCases(db)
      await seedSkill(h, 'run-it-first', 'claimed-done-without-running')
      db.exec("UPDATE cases SET split = 'holdout'")

      const llm = new BenchLlm({ baseline_recurred: false, skill_recurred: false })
      const v = await verifySkill(
        db,
        layout,
        defaults(),
        llm,
        'run-it-first',
        '## The rule\nRun it.',
      )
      expect(v.inert).toBe(1)
      expect(v.prevents).toBe(0)
      // It claims to prevent a specific failure and prevented none of it.
      expect(v.pass).toBe(false)
      h.close()
    } finally {
      await cleanup()
    }
  })

  /**
   * The disqualifying verdict. Breaking a situation that was already working
   * is the failure with no upside — the person had that behaviour and the
   * skill took it away.
   */
  it('fails a skill that breaks a case the baseline handled', async () => {
    const { h, layout, cleanup } = await store()
    try {
      await seed(h)
      const db = await h.db()
      await buildCases(db)
      await seedSkill(h, 'run-it-first', 'claimed-done-without-running')
      db.exec("UPDATE cases SET split = 'holdout'")

      const llm = new BenchLlm({ baseline_recurred: false, skill_recurred: true })
      const v = await verifySkill(
        db,
        layout,
        defaults(),
        llm,
        'run-it-first',
        '## The rule\nRun it.',
      )
      expect(v.regressions).toBe(1)
      expect(v.pass).toBe(false)
      expect(v.why).toMatch(/regression/)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('reuses the cached baseline instead of recomputing it per candidate', async () => {
    const { h, layout, cleanup } = await store()
    try {
      await seed(h)
      const db = await h.db()
      await buildCases(db)
      await seedSkill(h, 'first', 'claimed-done-without-running')
      await seedSkill(h, 'second', 'claimed-done-without-running')
      db.exec("UPDATE cases SET split = 'holdout'")

      const llm = new BenchLlm({ baseline_recurred: true, skill_recurred: false })
      await verifySkill(db, layout, defaults(), llm, 'first', '## The rule\nRun it.', {
        samples: 1,
      })
      await verifySkill(db, layout, defaults(), llm, 'second', '## The rule\nRun it twice.', {
        samples: 1,
      })
      // The no-skill arm does not depend on the candidate, so it is computed
      // once and read back for every skill scored against this case.
      expect(llm.arms.filter((a) => !a.skill)).toHaveLength(1)
      expect(llm.arms.filter((a) => a.skill)).toHaveLength(2)
      h.close()
    } finally {
      await cleanup()
    }
  })

  /**
   * The reason samples exist. Measured on this store's own corrections, the
   * same skill scored against the same case moved from `regression` to
   * `prevents` between two runs — so one draw reports which way the coin
   * landed, and this bench retires skills.
   */
  it('takes a majority across draws instead of trusting one', async () => {
    const { h, layout, cleanup } = await store()
    try {
      await seed(h)
      const db = await h.db()
      await buildCases(db)
      await seedSkill(h, 'run-it-first', 'claimed-done-without-running')
      db.exec("UPDATE cases SET split = 'holdout'")

      // One unlucky draw calls it a regression; the other two do not.
      let call = 0
      const llm = new BenchLlm({ baseline_recurred: true, skill_recurred: false })
      const inner = llm.completeJson.bind(llm)
      llm.completeJson = async (o) => {
        if (o.purpose === 'replay.judge') {
          call++
          return {
            value: o.schema.parse({
              baseline_recurred: call !== 1,
              skill_recurred: call === 1,
              reason: 'r',
            }),
            usage: {},
          }
        }
        return inner(o)
      }

      const v = await verifySkill(db, layout, defaults(), llm, 'run-it-first', '## Rule\nRun.', {
        samples: 3,
      })
      expect(call).toBe(3)
      expect(v.regressions).toBe(0)
      expect(v.prevents).toBe(1)
      expect(v.results[0]!.agreement).toBe(2)
      expect(v.results[0]!.samples).toBe(3)
    } finally {
      await cleanup()
    }
  })

  /**
   * `regression` retires a skill outright, so it must not be reachable by a
   * plurality — one draw out of three saying so is noise, not a finding.
   */
  it('needs a real majority to call something a regression', async () => {
    const { h, layout, cleanup } = await store()
    try {
      await seed(h)
      const db = await h.db()
      await buildCases(db)
      await seedSkill(h, 'run-it-first', 'claimed-done-without-running')
      db.exec("UPDATE cases SET split = 'holdout'")

      // regression, inert, both-fail — regression leads on count but is only 1 of 3.
      let call = 0
      const llm = new BenchLlm({ baseline_recurred: false, skill_recurred: false })
      const inner = llm.completeJson.bind(llm)
      llm.completeJson = async (o) => {
        if (o.purpose === 'replay.judge') {
          call++
          const draws = [
            { baseline_recurred: false, skill_recurred: true },
            { baseline_recurred: false, skill_recurred: false },
            { baseline_recurred: true, skill_recurred: true },
          ]
          return { value: o.schema.parse({ ...draws[call - 1], reason: 'r' }), usage: {} }
        }
        return inner(o)
      }

      const v = await verifySkill(db, layout, defaults(), llm, 'run-it-first', '## Rule\nRun.', {
        samples: 3,
      })
      expect(v.regressions).toBe(0)
      expect(v.results[0]!.verdict).not.toBe('regression')
    } finally {
      await cleanup()
    }
  })

  /**
   * A 1/1/1 split means every draw disagreed. Naming the arbitrary winner
   * would turn a coin flip into a finding, so the bench reports that it could
   * not resolve the case instead.
   */
  it('reports a case no two draws agreed on as unresolved', async () => {
    const { h, layout, cleanup } = await store()
    try {
      await seed(h)
      const db = await h.db()
      await buildCases(db)
      await seedSkill(h, 'run-it-first', 'claimed-done-without-running')
      db.exec("UPDATE cases SET split = 'holdout'")

      let call = 0
      const llm = new BenchLlm({ baseline_recurred: false, skill_recurred: false })
      const inner = llm.completeJson.bind(llm)
      llm.completeJson = async (o) => {
        if (o.purpose === 'replay.judge') {
          call++
          const draws = [
            { baseline_recurred: true, skill_recurred: false }, // prevents
            { baseline_recurred: false, skill_recurred: false }, // inert
            { baseline_recurred: true, skill_recurred: true }, // both-fail
          ]
          return { value: o.schema.parse({ ...draws[call - 1], reason: 'r' }), usage: {} }
        }
        return inner(o)
      }

      const v = await verifySkill(db, layout, defaults(), llm, 'run-it-first', '## Rule\nRun.', {
        samples: 3,
      })
      expect(v.unstable).toBe(1)
      expect(v.prevents).toBe(0)
      expect(v.results[0]!.verdict).toBe('unstable')
      expect(v.results[0]!.reason).toMatch(/no two draws agreed/)
      // An unresolved run is not a pass — nothing was measured.
      expect(v.pass).toBe(false)
    } finally {
      await cleanup()
    }
  })

  /**
   * Not the same as testing the claim and finding nothing. Failing a skill
   * because the split happened to put all of its mode's cases on the training
   * side would be failing it for arithmetic.
   */
  it('separates an untested claim from a tested-and-empty one', async () => {
    const { h, layout, cleanup } = await store()
    try {
      await seed(h)
      const db = await h.db()
      await buildCases(db)
      await seedSkill(h, 'unrelated-guard', 'some-other-mode')
      db.exec("UPDATE cases SET split = 'holdout'")

      const v = await verifySkill(
        db,
        layout,
        defaults(),
        new BenchLlm({ baseline_recurred: false, skill_recurred: false }),
        'unrelated-guard',
        '## The rule\nDo the thing.',
      )
      expect(v.ownTested).toBe(0)
      expect(v.regressions).toBe(0)
      expect(v.pass).toBe(false)
      expect(v.why).toMatch(/no holdout case/)
    } finally {
      await cleanup()
    }
  })

  /**
   * Three draws stabilise a CASE verdict and not a SKILL verdict: the latter
   * is a threshold over a handful of cases, and one flip crosses it. Measured
   * on this store, the same skill against the same cases scored pass, then
   * fail, then pass — none of the cases were noisy, `prevents === 0` was just
   * one case away from `prevents === 1`.
   */
  it('marks a verdict from too few cases inconclusive', async () => {
    const { h, layout, cleanup } = await store()
    try {
      await seed(h)
      const db = await h.db()
      await buildCases(db)
      await seedSkill(h, 'run-it-first', 'claimed-done-without-running')
      db.exec("UPDATE cases SET split = 'holdout'")

      const v = await verifySkill(
        db,
        layout,
        defaults(),
        new BenchLlm({ baseline_recurred: true, skill_recurred: false }),
        'run-it-first',
        '## The rule\nRun it.',
        { samples: 1 },
      )
      expect(v.conclusive).toBe(false)
      expect(v.why).toMatch(/does not reproduce/)
      // And it must not move reliability — that is how noise becomes a lifecycle.
      const outcomes = db
        .prepare<{ n: number }>("SELECT COUNT(*) n FROM skill_outcomes WHERE source = 'used'")
        .get()
      expect(outcomes?.n).toBe(0)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('says so rather than passing when there is nothing to replay against', async () => {
    const { h, layout, cleanup } = await store()
    try {
      await seedSkill(h, 'run-it-first', 'claimed-done-without-running')
      const v = await verifySkill(
        await h.db(),
        layout,
        defaults(),
        new BenchLlm({ baseline_recurred: true, skill_recurred: false }),
        'run-it-first',
        '## The rule\nRun it.',
      )
      expect(v.cases).toBe(0)
      expect(v.pass).toBe(false)
      expect(v.why).toMatch(/no holdout cases/)
      h.close()
    } finally {
      await cleanup()
    }
  })
})
