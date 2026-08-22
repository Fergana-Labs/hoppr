import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { defaults } from '../src/config/schema.ts'
import { Hoppr } from '../src/core/hoppr.ts'
import type { JsonOptions, LlmProvider } from '../src/llm/provider.ts'
import { buildLedgers } from '../src/organize/ledger.ts'
import { currentLessons, extractLessons, normalizeSubject } from '../src/organize/lessons.ts'
import { listSkills, setSkillState } from '../src/organize/skills.ts'
import { Layout } from '../src/store/layout.ts'
import { tempStore } from './helpers.ts'

class MockLlm implements LlmProvider {
  readonly id = 'mock'
  readonly supportsVision = true
  calls = 0
  readonly responses: unknown[]
  constructor(responses: unknown[]) {
    this.responses = responses
  }
  async available() {
    return true
  }
  async completeText() {
    return { text: '', usage: {} }
  }
  async completeJson<T>(o: JsonOptions<T>) {
    const raw = this.responses[Math.min(this.calls, this.responses.length - 1)]
    this.calls++
    return { value: o.schema.parse(raw), usage: { costUsd: 0.001 } }
  }
}

async function store() {
  const t = await tempStore()
  const h = new Hoppr({ layout: new Layout(t.layout.root), config: defaults(), sources: [] })
  return { ...t, h }
}

/**
 * A session in the shape `renderTranscript` writes: a `## Prompts` block that
 * holds what the human typed, and a body that holds everything else. The
 * attribution check reads both, so a fixture that skips them is not a fixture.
 */
function transcript(said: string[], agentSaid = 'I will do that.') {
  return [
    '## Session',
    '',
    '- source: claude-code',
    '',
    '## Prompts',
    '',
    ...said.map((p) => `> ${p}`),
    '',
    '## Transcript',
    '',
    ...said.map((p) => `**user:** ${p}`),
    `**assistant:** ${agentSaid}`,
  ].join('\n')
}

async function seedSession(h: Hoppr, id: string, text: string, observed = Date.now()) {
  const db = await h.db()
  db.prepare(
    `INSERT INTO raw(id,path,kind,source,media_type,bytes,content_hash,created,captured,text,partial)
     VALUES (:id,:p,'session','connector:test','text/markdown',:b,:h,:t,:t,:text,0)`,
  ).run({ id, p: `raw/${id}.md`, b: text.length, h: id, t: observed, text })
}

const SAID = 'no, plainer than that — and never say delightful'

function lesson(over: Record<string, unknown> = {}) {
  return {
    session: 'S0',
    kind: 'preferences',
    subject: 'writing tone',
    statement: 'Keep copy plain; never use the word "delightful".',
    quote: SAID,
    confidence: 0.9,
    ...over,
  }
}

describe('lesson extraction', () => {
  /**
   * The regression that motivated the rewrite. Clustering used to run on tool
   * names, shell commands, and error classes, which gave every one of these an
   * EMPTY signature — invisible no matter how often they recurred.
   */
  it('captures rules and world-facts, none of which have a tool trace', async () => {
    const { layout, h, cleanup } = await store()
    try {
      await seedSession(h, 'S0', transcript([SAID]))
      const db = await h.db()
      const st = await extractLessons(
        db,
        layout,
        defaults(),
        new MockLlm([
          {
            lessons: [
              lesson(),
              lesson({ kind: 'glossary', subject: 'customer contracts' }),
              lesson({ kind: 'glossary', subject: 'deep pass' }),
            ],
          },
        ]),
      )
      expect(st.lessons).toBe(3)
      expect(st.byKind).toEqual({ preferences: 1, glossary: 2 })
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('drops a lesson with no quote, because that one was inferred', async () => {
    const { layout, h, cleanup } = await store()
    try {
      await seedSession(h, 'S0', transcript([SAID]))
      const db = await h.db()
      const st = await extractLessons(
        db,
        layout,
        defaults(),
        new MockLlm([{ lessons: [lesson({ quote: '   ' }), lesson({ subject: 'kept' })] }]),
      )
      expect(st.lessons).toBe(1)
      expect(currentLessons(db, 'preferences').map((l) => l.subject)).toEqual(['kept'])
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('refuses a ledger claim quoting the agent rather than the person', async () => {
    const { layout, h, cleanup } = await store()
    try {
      // Measured on eight real transcripts: four of six extracted preferences
      // quoted hoppr's OWN curation prompts, which sit in the transcript as
      // ordinary prose because an agent that reads a prompt file has that file
      // in its context. Unchecked, the preferences ledger fills with the tool's
      // voice reflected back, cited as though the person had said it.
      const agentLine = 'Reusing existing tags is what makes the tag set converge instead of drift'
      await seedSession(h, 'S0', transcript([SAID], agentLine))
      const db = await h.db()
      const st = await extractLessons(
        db,
        layout,
        defaults(),
        new MockLlm([
          {
            lessons: [
              lesson({ subject: 'taxonomy maintenance', quote: agentLine }),
              lesson({ subject: 'writing tone' }),
            ],
          },
        ]),
      )
      expect(st.unattributed).toBe(1)
      expect(currentLessons(db, 'preferences').map((l) => l.subject)).toEqual(['writing tone'])
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('still credits the agent for a procedure, where doing IS the evidence', async () => {
    const { layout, h, cleanup } = await store()
    try {
      const agentLine = 'Ran npm run build, then wrangler deploy, and it went out clean'
      await seedSession(h, 'S0', transcript([SAID], agentLine))
      const db = await h.db()
      await extractLessons(
        db,
        layout,
        defaults(),
        new MockLlm([
          { lessons: [lesson({ kind: 'procedure', subject: 'deploy', quote: agentLine })] },
        ]),
      )
      // A procedure is a record of what was done. Requiring the human to have
      // narrated it would discard every procedure worth having.
      expect(currentLessons(db, 'procedure')).toHaveLength(1)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('does not treat a harness injection as something the person said', async () => {
    const { layout, h, cleanup } = await store()
    try {
      // Reminders, memory recalls and CLAUDE.md content arrive inside user-role
      // messages, so they land in the Prompts block. They are normative prose in
      // the second person — the exact shape of a preference — and 59 of 346 real
      // sessions here carry one. The person typed none of it.
      const injected = 'Always prefer the dedicated file tools over shell commands'
      await seedSession(h, 'S0', transcript([`<system-reminder>${injected}</system-reminder>`]))
      const db = await h.db()
      const st = await extractLessons(
        db,
        layout,
        defaults(),
        new MockLlm([{ lessons: [lesson({ subject: 'tool choice', quote: injected })] }]),
      )
      expect(st.unattributed).toBe(1)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('reads each session once, ever', async () => {
    const { layout, h, cleanup } = await store()
    try {
      await seedSession(h, 'S0', transcript([SAID]))
      const db = await h.db()
      const llm = new MockLlm([{ lessons: [lesson()] }])
      await extractLessons(db, layout, defaults(), llm)
      const again = await extractLessons(db, layout, defaults(), llm)
      // A transcript is immutable, so re-reading it can only spend tokens
      // arriving at the same answer.
      expect(llm.calls).toBe(1)
      expect(again.sessionsRead).toBe(0)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('retries a session whose extraction failed, rather than losing it', async () => {
    const { layout, h, cleanup } = await store()
    try {
      await seedSession(h, 'S0', transcript([SAID]))
      const db = await h.db()
      const broken: LlmProvider = {
        id: 'broken',
        supportsVision: false,
        available: async () => true,
        completeText: async () => ({ text: '', usage: {} }),
        completeJson: async () => {
          throw new Error('rate limited')
        },
      }
      const failed = await extractLessons(db, layout, defaults(), broken)
      expect(failed.failed).toBe(1)

      const ok = await extractLessons(
        db,
        layout,
        defaults(),
        new MockLlm([{ lessons: [lesson()] }]),
      )
      expect(ok.lessons).toBe(1)
      h.close()
    } finally {
      await cleanup()
    }
  })
})

describe('supersession', () => {
  it('takes the newest statement per subject, by when it was SAID', async () => {
    const { layout, h, cleanup } = await store()
    try {
      const march = Date.parse('2026-03-01')
      const august = Date.parse('2026-08-01')
      // Deliberately ingested out of order: a backfill that reaches March after
      // August must not overwrite August's answer with a stale one.
      await seedSession(h, 'AUG', transcript([SAID]), august)
      await seedSession(h, 'MAR', transcript([SAID]), march)
      const db = await h.db()
      await extractLessons(
        db,
        layout,
        defaults(),
        new MockLlm([
          { lessons: [lesson({ session: 'AUG', statement: 'Make it punchier.' })] },
          { lessons: [lesson({ session: 'MAR', statement: 'Keep it plain.' })] },
        ]),
        { limit: 1 },
      )
      await extractLessons(
        db,
        layout,
        defaults(),
        new MockLlm([{ lessons: [lesson({ session: 'MAR', statement: 'Keep it plain.' })] }]),
      )

      const now = currentLessons(db, 'preferences')
      expect(now).toHaveLength(1)
      expect(now[0]!.statement).toBe('Make it punchier.')
      // The superseded row is not deleted — `skills why` still resolves it, and
      // the file is in git, so the reversal reads as a diff.
      expect(db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM lessons').get()?.n).toBe(2)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('normalizes subjects so casing and punctuation do not fork a line', () => {
    expect(normalizeSubject('  Deep Pass. ')).toBe('deep pass')
    expect(normalizeSubject('deep_pass')).toBe('deep pass')
  })
})

describe('ledgers', () => {
  async function withLedger() {
    const s = await store()
    const db = await s.h.db()
    await seedSession(s.h, 'S0', transcript([SAID]))
    await extractLessons(
      db,
      s.layout,
      defaults(),
      new MockLlm([
        {
          lessons: [
            lesson(),
            lesson({ kind: 'glossary', subject: 'deep pass', statement: 'The nightly pass.' }),
            lesson({ kind: 'glossary', subject: 'contracts', statement: 'Drive, under Legal.' }),
          ],
        },
      ]),
    )
    return { ...s, db }
  }

  it('writes one file per kind, every line citing its capture', async () => {
    const { layout, h, db, cleanup } = await withLedger()
    try {
      const st = await buildLedgers(db, layout, defaults())
      expect(st.entries).toBe(3)

      const prefs = await readFile(layout.skillFile('preferences'), 'utf8')
      expect(prefs).toContain('name: preferences')
      expect(prefs).toContain('never use the word "delightful"')
      // Auditable: the line names the capture it came from.
      expect(prefs).toContain('S0')

      expect(await readFile(layout.skillFile('glossary'), 'utf8')).toContain('deep pass')
      expect(await readFile(layout.skillFile('glossary'), 'utf8')).toContain('Drive, under Legal.')
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('auto-accepts by default, because every line is a quote', async () => {
    const { layout, h, db, cleanup } = await withLedger()
    try {
      await buildLedgers(db, layout, defaults())
      // `approve = "ledgers"`. A ledger line is something the person typed,
      // assembled by code and superseded on change; a mined procedure is a
      // model's prose. Making someone triage the first to reach the second is
      // how a review queue stops being read.
      // `approve` answers one question: does a human gate this? A "no" that
      // still leaves a second command to run is not a no — it is the same
      // two-step gate under another name. So an auto-accepted ledger installs.
      expect(listSkills(db).every((s) => s.state === 'installed')).toBe(true)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('still proposes when approve = "review"', async () => {
    const { layout, h, db, cleanup } = await withLedger()
    try {
      const cfg = defaults()
      cfg.skills.approve = 'review'
      await buildLedgers(db, layout, cfg)
      expect(listSkills(db).every((s) => s.state === 'proposed')).toBe(true)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('builds a ledger declared only in config', async () => {
    const { layout, h, cleanup } = await store()
    try {
      const db = await h.db()
      // The point of the change: adding a fourth kind is a config line, not a
      // TypeScript edit to a hardcoded LEDGERS constant.
      const cfg = defaults()
      cfg.skills.have = [...cfg.skills.have, 'constraints']
      // A bin is defined by the prompt, so adding one means adding a section
      // there — the config only says which of them this store collects.
      const { writeFile, readFile: rf } = await import('node:fs/promises')
      const prompt = await rf(layout.promptFile('lesson-extract'), 'utf8')
      await writeFile(
        layout.promptFile('lesson-extract'),
        prompt.replace(
          '### preferences',
          '### constraints\nheading: Hard limits\n\nWhat hard limits must hold?\n\n### preferences',
        ),
      )
      await seedSession(h, 'S0', transcript([SAID]))
      await extractLessons(
        db,
        layout,
        cfg,
        new MockLlm([{ lessons: [lesson({ kind: 'constraints', subject: 'budget' })] }]),
      )
      const st = await buildLedgers(db, layout, cfg)
      expect(st.entries).toBe(1)
      expect(await readFile(layout.skillFile('constraints'), 'utf8')).toContain('budget')
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('drops a kind the config never declared', async () => {
    const { layout, h, cleanup } = await store()
    try {
      const db = await h.db()
      await seedSession(h, 'S0', transcript([SAID]))
      const st = await extractLessons(
        db,
        layout,
        defaults(),
        new MockLlm([{ lessons: [lesson({ kind: 'vibes' })] }]),
      )
      // A model inventing a kind would otherwise mint a ledger nobody asked
      // for and no prompt described.
      expect(st.lessons).toBe(0)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('stays rejected once rejected', async () => {
    const { layout, h, db, cleanup } = await withLedger()
    try {
      await buildLedgers(db, layout, defaults())
      setSkillState(db, 'preferences', 'rejected')
      await buildLedgers(db, layout, defaults())
      // "I do not want hoppr tracking my preferences" has to survive the next
      // nightly pass.
      expect(listSkills(db).find((s) => s.slug === 'preferences')!.state).toBe('rejected')
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('leaves a hand-edited ledger alone, and says so in a file you can see', async () => {
    const { layout, h, db, cleanup } = await withLedger()
    try {
      await buildLedgers(db, layout, defaults())
      const { writeFile } = await import('node:fs/promises')
      await writeFile(layout.skillFile('preferences'), '---\nname: preferences\n---\nmine now\n')

      // Detection is what makes this work — you edit a line and the nightly
      // pass does not eat it. What changed is where the state is written.
      const { reconcileSkills } = await import('../src/organize/skills.ts')
      await reconcileSkills(db, layout, defaults())
      await buildLedgers(db, layout, defaults())

      expect(await readFile(layout.skillFile('preferences'), 'utf8')).toContain('mine now')
      // Its own file, not a section of .hopprignore. Two rule sets about two
      // different people's files; sharing one file made that split invisible.
      const locked = await readFile(`${layout.root}/LOCKED`, 'utf8')
      expect(locked).toContain('skills/preferences/**')
      // Greppable, in git, and undone by deleting the line — rather than an
      // invisible column you needed a CLI command to discover.
      expect(locked).toContain('hand-edited')
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('records the hand-edit as a correction against the skill', async () => {
    const { layout, h, db, cleanup } = await withLedger()
    try {
      await buildLedgers(db, layout, defaults())
      const { writeFile } = await import('node:fs/promises')
      await writeFile(layout.skillFile('preferences'), '---\nname: preferences\n---\nmine now\n')
      const { reconcileSkills } = await import('../src/organize/skills.ts')
      await reconcileSkills(db, layout, defaults())

      const { reliability } = await import('../src/organize/reliability.ts')
      // Somebody read it, used it, and had to fix it. That is the most
      // informative signal available without a benchmark.
      expect(reliability(db, 'preferences').trials).toBeGreaterThan(0)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('writes nothing at all when there is nothing to say', async () => {
    const { layout, h, cleanup } = await store()
    try {
      const db = await h.db()
      const st = await buildLedgers(db, layout, defaults())
      expect(st.entries).toBe(0)
      // An empty ledger would still cost every future session the tokens to
      // read "nothing recorded yet".
      expect(existsSync(layout.skillFile('preferences'))).toBe(false)
      h.close()
    } finally {
      await cleanup()
    }
  })
})

describe('declaring what should exist', () => {
  it('is two lists of names, not a repeated block per skill', async () => {
    const { defaults } = await import('../src/config/schema.ts')
    const cfg = defaults()
    expect(cfg.skills.have).toEqual([
      'glossary',
      'preferences',
      'comms-preferences',
      'working-agreements',
    ])
    expect(cfg.skills.find).toEqual([])
  })

  it('reads each bin from the prompt, which is on disk and editable', async () => {
    const { readAsset } = await import('../src/core/assets.ts')
    const { parseBins } = await import('../src/organize/wants.ts')
    const bins = parseBins(await readAsset('prompts', 'lesson-extract.md'))
    expect([...bins.keys()].sort()).toEqual(['glossary', 'preferences', 'procedure'])
    // The question is the whole point of a bin. One without it collects
    // whatever the model guessed its name meant.
    expect(bins.get('glossary')!.ask.length).toBeGreaterThan(80)
    expect(bins.get('preferences')!.graded).toBe(true)
    expect(bins.get('glossary')!.graded).toBe(false)
    expect(bins.get('preferences')!.heading).toBe('How work gets done here')
  })

  it('treats a name with no bin as a file hoppr ships', async () => {
    const { defaults } = await import('../src/config/schema.ts')
    const { resolveWants } = await import('../src/organize/wants.ts')
    const { tempStore } = await import('./helpers.ts')
    const t = await tempStore()
    try {
      const w = await resolveWants(t.layout, defaults())
      expect(w.ledgers.map((x) => x.name)).toEqual(['glossary', 'preferences'])
      expect(w.packaged).toEqual(['comms-preferences', 'working-agreements'])
      // `procedure` is a bin the prompt defines but never a ledger; naming it
      // must not mint a procedure/SKILL.md.
      expect(w.ledgers.some((x) => x.name === 'procedure')).toBe(false)
    } finally {
      await t.cleanup()
    }
  })

  it('runs exactly what the file says, with nothing added back', async () => {
    const { defaults } = await import('../src/config/schema.ts')
    const { resolveWants } = await import('../src/organize/wants.ts')
    const { tempStore } = await import('./helpers.ts')
    const t = await tempStore()
    try {
      const cfg = defaults()
      cfg.skills.have = cfg.skills.have.filter((n) => n !== 'preferences')
      const w = await resolveWants(t.layout, cfg)
      expect(w.ledgers.map((x) => x.name)).toEqual(['glossary'])
    } finally {
      await t.cleanup()
    }
  })
})

describe('a new store can see what it will do', () => {
  it('writes real values, not a retyped copy that can drift', async () => {
    const { readFile } = await import('node:fs/promises')
    const { createHopper } = await import('../src/store/registry.ts')
    const { defaults } = await import('../src/config/schema.ts')
    const { tempStore } = await import('./helpers.ts')
    const t = await tempStore()
    try {
      const { mkdir } = await import('node:fs/promises')
      const dir = `${t.layout.root}/new`
      await mkdir(dir, { recursive: true })
      await createHopper({ name: 'newstore', source: `dir:${dir}`, curation: 'agents', root: dir })
      const toml = await readFile(`${dir}/hoppr.toml`, 'utf8')
      const d = defaults()
      // Values come from defaults(), so the file a store is born with cannot
      // drift from what the code does. A store's config used to have three
      // sections while the schema had twenty.
      expect(toml).toContain(`approve        = "${d.skills.approve}"`)
      expect(toml).toContain('have = [')
      expect(toml).toContain(`min_evidence   = ${d.skills.min_evidence}`)
      expect(toml).toContain(`archive_below  = ${d.skills.archive_below}`)
      expect(toml).toContain('[retrieval]')
    } finally {
      await t.cleanup()
    }
  })

  it('leaves out sections the preset does not use', async () => {
    const { readFile } = await import('node:fs/promises')
    const { createHopper } = await import('../src/store/registry.ts')
    const { tempStore } = await import('./helpers.ts')
    const t = await tempStore()
    try {
      const { mkdir } = await import('node:fs/promises')
      const dir = `${t.layout.root}/papers`
      await mkdir(dir, { recursive: true })
      await createHopper({ name: 'papers', source: `dir:${dir}`, curation: 'papers', root: dir })
      const toml = await readFile(`${dir}/hoppr.toml`, 'utf8')
      // Explaining a preferences ledger to a folder of PDFs is the same noise
      // this is meant to remove.
      expect(toml).not.toContain('[skills]')
      expect(toml).not.toContain('skills.want')
    } finally {
      await t.cleanup()
    }
  })
})

describe('the prompt is the bin definition', () => {
  it('names only the bins this store collects', async () => {
    const { layout, h, cleanup } = await store()
    try {
      await seedSession(h, 'S0', transcript([SAID]))
      const db = await h.db()
      const cfg = defaults()
      cfg.skills.have = ['glossary']
      const llm = new MockLlm([{ lessons: [] }])
      const seen: string[] = []
      const spy = {
        ...llm,
        id: 'spy',
        available: async () => true,
        completeText: async () => ({ text: '', usage: {} }),
        completeJson: async (o: { prompt: string; schema: { parse: (v: unknown) => unknown } }) => {
          seen.push(o.prompt)
          return { value: o.schema.parse({ lessons: [] }), usage: {} }
        },
      }
      await extractLessons(db, layout, cfg, spy as never)
      // The prompt keeps every bin it knows, in one readable place. What
      // changes per store is which of them are switched on — spending a model
      // call on a bin whose results get discarded is pure waste.
      expect(seen[0]).toContain('`glossary`')
      expect(seen[0]).toContain('`procedure`')
      expect(seen[0]).not.toMatch(/collect only these bins:[^.]*preferences/)
      h.close()
    } finally {
      await cleanup()
    }
  })
})

describe('a bin describes itself to two audiences', () => {
  it('does not ship the extractor question as the reader-facing description', async () => {
    const { readAsset } = await import('../src/core/assets.ts')
    const { parseBins } = await import('../src/organize/wants.ts')
    const bins = parseBins(await readAsset('prompts', 'lesson-extract.md'))
    for (const [name, bin] of bins) {
      // Deriving the description from the question looked like it avoided
      // drift and instead put "Which nouns in these sessions would a new agent
      // get wrong?" on a file agents match against to decide whether to open
      // it — imperative, about "these sessions", addressed to the extractor.
      expect(bin.description, `${name} description is the question`).not.toBe(bin.ask)
      expect(bin.description, `${name} description asks a question`).not.toMatch(/\?$/)
      expect(bin.description.length, `${name} has no description`).toBeGreaterThan(30)
    }
  })
})
