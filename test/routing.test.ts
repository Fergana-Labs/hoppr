import { describe, expect, it } from 'vitest'
import { defaults } from '../src/config/schema.ts'
import { Hoppr } from '../src/core/hoppr.ts'
import { buildCases } from '../src/organize/cases.ts'
import { fixturesFrom, rank, routingBench } from '../src/organize/routing.ts'
import type { SkillRow } from '../src/organize/skills.ts'
import { Layout } from '../src/store/layout.ts'
import { tempStore } from './helpers.ts'

function skill(slug: string, description: string): SkillRow {
  return {
    slug,
    name: slug,
    description,
    path: null,
    state: 'installed',
    kind: 'guardrail',
    prevents: '',
    lifecycle: 'active',
    body_hash: '',
    evidence_count: 1,
    confidence: 0.9,
    verified_at: null,
    prevents_n: null,
    regress_n: null,
  }
}

describe('ranking a pool against a situation', () => {
  const pool = [
    skill('run-before-reporting', 'Use when about to report that a change works or is finished.'),
    skill(
      'commit-style-here',
      'Use when writing a commit message or a PR title in this repository.',
    ),
    skill(
      'where-things-live',
      'Use when you need to find or add a file and do not know where it belongs.',
    ),
  ]

  it('puts the skill whose situation matches first', () => {
    expect(rank('staging the diff, need a subject line for this commit', pool)[0]).toBe(
      'commit-style-here',
    )
    expect(rank('where does the migration file belong in this tree?', pool)[0]).toBe(
      'where-things-live',
    )
  })

  /**
   * The reason `rankEmbedded` exists and is preferred. A situation that means
   * the same thing in different words scores zero lexically — here the person
   * is plainly about to report a finished change, and not one content word is
   * shared with the skill that should fire.
   */
  it('misses a match with no shared vocabulary, which is why it is the fallback', () => {
    const situation = 'I fixed the parser. Should be good now, writing up the summary.'
    expect(rank(situation, pool)[0]).not.toBe('run-before-reporting')
  })

  /**
   * The gate REQUIRES every description to say "use when", so those words
   * appear in all of them. Scoring them would have every well-formed pair tie
   * and the ranking would be alphabetical noise.
   */
  it('ignores the boilerplate every description is required to share', () => {
    const boiler = [
      skill('a', 'Use when you are about to deploy the worker to production.'),
      skill('b', 'Use when you are about to write a migration against the orders table.'),
    ]
    expect(rank('about to run a migration on orders', boiler)[0]).toBe('b')
    expect(rank('about to deploy the worker', boiler)[0]).toBe('a')
  })

  it('does not let a long description win on surface area alone', () => {
    const lopsided = [
      skill('narrow', 'Use when writing a commit message.'),
      skill(
        'sprawling',
        'Use when writing anything at all: documentation, commit messages, pull request ' +
          'descriptions, status updates, release notes, changelogs, comments, emails, ' +
          'proposals, summaries, reports, tickets, specs, and design notes.',
      ),
    ]
    expect(rank('need a commit message for this', lopsided)[0]).toBe('narrow')
  })
})

const OBJECTION = 'no, you never ran the tests, you just said it worked'

function session(): string {
  return [
    '## Session',
    '',
    '## Transcript',
    '',
    '**user:** fix the parser',
    `**assistant:** ${'Looking at the tokenizer. '.repeat(20)}`,
    '**assistant:** Fixed it — the parser handles the empty case now.',
    `**user:** ${OBJECTION}`,
  ].join('\n')
}

async function store() {
  const t = await tempStore()
  const h = new Hoppr({ layout: new Layout(t.layout.root), config: defaults(), sources: [] })
  return { ...t, h }
}

describe('fixtures', () => {
  /**
   * The point of deriving them from cases: gbrain's skillify asks an author
   * for "trigger phrases users actually type", which tests the author's
   * imagination rather than the router. A case already holds the real
   * situation.
   */
  it('come free from the cases a guardrail was mined from', async () => {
    const { h, cleanup } = await store()
    try {
      const db = await h.db()
      const now = Date.now()
      db.prepare(
        `INSERT INTO raw(id,path,kind,source,media_type,bytes,content_hash,created,captured,text,partial)
         VALUES ('S0','raw/s0.md','session','connector:test','text/markdown',:b,'h',:t,:t,:text,0)`,
      ).run({ b: session().length, t: now, text: session() })
      db.prepare(
        `INSERT INTO corrections(id,raw_id,mode,headline,quote,turns,severity,observed,created)
         VALUES ('c0','S0','claimed-done-without-running','h',:q,2,'rework',:t,:t)`,
      ).run({ q: OBJECTION, t: now })
      db.prepare(
        `INSERT INTO skills(slug,name,description,path,state,kind,prevents,evidence_count,confidence,created,updated)
         VALUES ('run-it','run-it','Use when about to report a change works.',NULL,
                 'installed','guardrail','claimed-done-without-running',1,0.9,:t,:t)`,
      ).run({ t: now })
      await buildCases(db)

      const fx = fixturesFrom(db)
      expect(fx).toHaveLength(1)
      expect(fx[0]!.expect).toBe('run-it')
      // The situation, not the objection — routing happens before the person
      // says anything.
      expect(fx[0]!.situation).not.toContain(OBJECTION)
      expect(fx[0]!.situation).toContain('Fixed it')
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('reports honestly rather than scoring nothing', async () => {
    const { h, cleanup } = await store()
    try {
      const r = await routingBench(await h.db())
      expect(r.results).toEqual([])
      expect(r.logLine).toMatch(/no routing fixtures/)
      h.close()
    } finally {
      await cleanup()
    }
  })

  /**
   * A lexical number and an embedded number are different measurements, and a
   * low one means different things in each — confusable skills in the first
   * case, a weak ranker in the second. The report has to say which it is.
   */
  it('names the ranker that produced its numbers', async () => {
    const { h, cleanup } = await store()
    try {
      expect((await routingBench(await h.db())).method).toBe('lexical')
      h.close()
    } finally {
      await cleanup()
    }
  })
})
