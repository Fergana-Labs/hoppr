import { describe, expect, it } from 'vitest'
import { defaults } from '../src/config/schema.ts'
import { Hoppr } from '../src/core/hoppr.ts'
import type { JsonOptions, LlmProvider } from '../src/llm/provider.ts'
import { outcomeHistory, reliability } from '../src/organize/reliability.ts'
import { findInvocations, judgeSkillUsage, windowAround } from '../src/organize/usage.ts'
import { Layout } from '../src/store/layout.ts'
import { tempStore } from './helpers.ts'

class Judge implements LlmProvider {
  readonly id = 'judge'
  readonly supportsVision = false
  calls = 0
  succeeded = true
  throws = false
  async available() {
    return true
  }
  async completeText() {
    return { text: '', usage: {} }
  }
  async completeJson<T>(o: JsonOptions<T>) {
    this.calls++
    if (this.throws) throw new Error('judge unavailable')
    return {
      value: o.schema.parse({ succeeded: this.succeeded, confidence: 0.9, reason: 'because' }),
      usage: {},
    }
  }
}

function transcript(invocations: string[]) {
  return [
    '## Session',
    '',
    '## Prompts',
    '',
    '> ship the release',
    '',
    '## Transcript',
    '',
    '**user:** ship the release',
    ...invocations.map((a) => `→ Skill: ${a}`),
    '**assistant:** done',
  ].join('\n')
}

async function store(installed: string[]) {
  const t = await tempStore()
  const h = new Hoppr({ layout: new Layout(t.layout.root), config: defaults(), sources: [] })
  const db = await h.db()
  const { writeIfChanged } = await import('../src/store/atomic.ts')
  for (const slug of installed) {
    db.prepare(
      `INSERT INTO skills(slug,name,description,path,state,kind,evidence_count,confidence,created,updated)
       VALUES (:s,:s,'a description long enough to read as a real trigger','p','installed','procedure',2,0.9,:n,:n)`,
    ).run({ s: slug, n: Date.now() })
    await writeIfChanged(
      t.layout.skillFile(slug),
      `---\nname: ${slug}\n---\n## Procedure\n1. do it\n`,
    )
  }
  return { ...t, h, db }
}

async function seed(h: Hoppr, id: string, text: string) {
  const db = await h.db()
  db.prepare(
    `INSERT INTO raw(id,path,kind,source,media_type,bytes,content_hash,created,captured,text,partial)
     VALUES (:id,:p,'session','connector:test','text/markdown',:b,:id,:t,:t,:text,0)`,
  ).run({ id, p: `raw/${id}.md`, b: text.length, t: Date.now(), text })
}

describe('finding an invocation', () => {
  it('reads which skill was loaded, not just that one was', () => {
    // The connector captures a tool call's input for exactly this. A bare
    // `→ Skill` records that a skill ran and not which, which leaves the only
    // question worth asking of a shipped skill unanswerable.
    const hits = findInvocations(transcript(['{"command":"cut-release"}']), ['cut-release'])
    expect(hits.map((x) => x.slug)).toEqual(['cut-release'])
  })

  it('does not let one skill collect another skill’s verdicts', () => {
    const hits = findInvocations(transcript(['{"command":"deploy-hoppr"}']), [
      'deploy',
      'deploy-hoppr',
    ])
    expect(hits.map((x) => x.slug)).toEqual(['deploy-hoppr'])
  })

  it('ignores a session that never loaded one', () => {
    expect(findInvocations('**assistant:** I just did it myself', ['cut-release'])).toEqual([])
  })

  it('windows the work that FOLLOWED, with enough lead-in to see the ask', () => {
    const text = `${'before '.repeat(400)}<<HERE>>${'after '.repeat(400)}`
    const w = windowAround(text, text.indexOf('<<HERE>>'))
    expect(w).toContain('before')
    expect(w).toContain('after')
    expect(w.length).toBeLessThan(text.length)
  })
})

describe('judging a shipped skill', () => {
  it('records a real outcome, not a correction', async () => {
    const { layout, h, db, cleanup } = await store(['cut-release'])
    try {
      await seed(h, 'S1', transcript(['{"command":"cut-release"}']))
      const llm = new Judge()
      const st = await judgeSkillUsage(db, layout, defaults(), llm)
      expect(st.invocations).toBe(1)
      // Everything feeding reliability before this was a human intervening.
      // This one is about whether the work came out right.
      expect(outcomeHistory(db, 'cut-release')[0]!.source).toBe('used')
      expect(reliability(db, 'cut-release').passes).toBe(1)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('counts a failure against the skill', async () => {
    const { layout, h, db, cleanup } = await store(['cut-release'])
    try {
      await seed(h, 'S1', transcript(['{"command":"cut-release"}']))
      const llm = new Judge()
      llm.succeeded = false
      await judgeSkillUsage(db, layout, defaults(), llm)
      expect(reliability(db, 'cut-release').passes).toBe(0)
      expect(reliability(db, 'cut-release').trials).toBe(1)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('archives a skill that keeps not landing', async () => {
    const { layout, h, db, cleanup } = await store(['cut-release'])
    try {
      for (const id of ['S1', 'S2', 'S3']) {
        await seed(h, id, transcript(['{"command":"cut-release"}']))
      }
      const llm = new Judge()
      llm.succeeded = false
      await judgeSkillUsage(db, layout, defaults(), llm)
      // Out of the dispatcher, still on disk and still searchable.
      expect(reliability(db, 'cut-release').lifecycle).toBe('archived')
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('counts one verdict per skill per session', async () => {
    const { layout, h, db, cleanup } = await store(['cut-release'])
    try {
      await seed(
        h,
        'S1',
        transcript([
          '{"command":"cut-release"}',
          '{"command":"cut-release"}',
          '{"command":"cut-release"}',
        ]),
      )
      const llm = new Judge()
      await judgeSkillUsage(db, layout, defaults(), llm)
      // Three invocations in one session is one piece of evidence about that
      // session, the same reason clustering counts sessions and not mentions.
      expect(llm.calls).toBe(1)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('reads each session once, ever', async () => {
    const { layout, h, db, cleanup } = await store(['cut-release'])
    try {
      await seed(h, 'S1', transcript(['{"command":"cut-release"}']))
      const llm = new Judge()
      await judgeSkillUsage(db, layout, defaults(), llm)
      await judgeSkillUsage(db, layout, defaults(), llm)
      expect(llm.calls).toBe(1)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('does not count against a skill when the judge cannot run', async () => {
    const { layout, h, db, cleanup } = await store(['cut-release'])
    try {
      await seed(h, 'S1', transcript(['{"command":"cut-release"}']))
      const llm = new Judge()
      llm.throws = true
      await judgeSkillUsage(db, layout, defaults(), llm)
      // The refuter treats silence as no-confidence because it is admitting a
      // new skill. Here silence is no EVIDENCE, and a flaky judge must not be
      // able to retire something that was working.
      expect(reliability(db, 'cut-release').trials).toBe(0)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('leaves sessions unread until something has actually shipped', async () => {
    const { layout, h, db, cleanup } = await store([])
    try {
      await seed(h, 'S1', transcript(['{"command":"cut-release"}']))
      const llm = new Judge()
      const st = await judgeSkillUsage(db, layout, defaults(), llm)
      expect(llm.calls).toBe(0)
      expect(st.sessionsRead).toBe(0)
      // Burning through the backlog now would leave the first installed skill
      // with no history to be judged against.
      expect(
        db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM raw WHERE usage_at IS NULL').get()?.n,
      ).toBe(1)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('ignores a skill that is only proposed', async () => {
    const { layout, h, db, cleanup } = await store(['cut-release'])
    try {
      db.prepare("UPDATE skills SET state = 'proposed' WHERE slug = 'cut-release'").run()
      await seed(h, 'S1', transcript(['{"command":"cut-release"}']))
      const llm = new Judge()
      await judgeSkillUsage(db, layout, defaults(), llm)
      // It has never been in anyone's context, so a session cannot contain a
      // real use of it.
      expect(llm.calls).toBe(0)
      h.close()
    } finally {
      await cleanup()
    }
  })
})
