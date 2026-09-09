import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaults } from '../src/config/schema.ts'
import { Hoppr } from '../src/core/hoppr.ts'
import type { JsonOptions, LlmProvider } from '../src/llm/provider.ts'
import { clusterProcedures } from '../src/organize/lessons.ts'
import {
  installSkill,
  listSkills,
  mineSkills,
  setSkillState,
  skillEvidence,
  uninstallSkill,
} from '../src/organize/skills.ts'
import { Layout } from '../src/store/layout.ts'
import { tempStore } from './helpers.ts'

class MockLlm implements LlmProvider {
  readonly id = 'mock'
  readonly supportsVision = true
  calls = 0
  verifies = 0
  supported = true
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
    // Verification is a separate call with its own shape. A mock that replayed
    // the mining payload into it would fail the schema, the verifier would
    // refuse to wave anything through, and every mining test would go red for
    // a reason that has nothing to do with mining.
    if (o.purpose === 'skills.verify') {
      this.verifies++
      return {
        value: o.schema.parse({ supported: this.supported, problem: '', notes: [] }),
        usage: {},
      }
    }
    const raw = this.responses[Math.min(this.calls, this.responses.length - 1)]
    this.calls++
    return { value: o.schema.parse(raw), usage: { costUsd: 0.001 } }
  }
}

/** A transcript whose PROCEDURE is the same, whatever the subject matter is. */
function flakyTestSession(topic: string): string {
  return `## Session
- id: s-${topic}

## Transcript
**user:** the ${topic} tests keep failing intermittently
→ Bash: vitest run --sequence.shuffle
**assistant:** Reproduced. Got a TypeError in the next file.
→ Bash: git bisect start
**assistant:** vi.useFakeTimers leaked. Added useRealTimers in afterEach.
`
}

function unrelatedSession(): string {
  return `## Session
- id: s-css

## Transcript
**user:** make the header sticky
**assistant:** Added position: sticky.
`
}

async function seedSessions(h: Hoppr, texts: string[]) {
  const db = await h.db()
  texts.forEach((text, i) => {
    db.prepare(
      `INSERT INTO raw(id,path,kind,source,media_type,bytes,content_hash,created,captured,text,partial)
       VALUES (:id,:p,'session','connector:test','text/markdown',:b,:h,:t,:t,:text,0)`,
    ).run({ id: `S${i}`, p: `raw/s${i}.md`, b: text.length, h: `h${i}`, t: Date.now(), text })
  })
}

/**
 * Sessions reach the miner already reduced to typed claims. Seeding those
 * directly is what the extraction stage produces.
 */
async function seedLessons(
  h: Hoppr,
  rows: Array<{
    raw: string
    subject: string
    statement: string
    kind?: string
    observed?: number
    /** Did the approach work in that session? Defaults to the ordinary case. */
    outcome?: string
  }>,
) {
  const db = await h.db()
  rows.forEach((r, i) => {
    db.prepare(
      `INSERT INTO lessons(id,raw_id,kind,subject,statement,quote,outcome,confidence,observed,created)
       VALUES (:id,:raw,:kind,:subj,:stmt,'because I said so',:out,0.9,:obs,:now)`,
    ).run({
      id: `L${i}-${r.raw}-${r.subject}`.slice(0, 24),
      raw: r.raw,
      kind: r.kind ?? 'procedure',
      subj: r.subject,
      stmt: r.statement,
      out: r.outcome ?? 'worked',
      obs: r.observed ?? Date.now(),
      now: Date.now(),
    })
  })
}

/** Three sessions that each established something about the same procedure. */
async function seedMinable(h: Hoppr) {
  await seedSessions(h, [flakyTestSession('a'), flakyTestSession('b'), flakyTestSession('c')])
  await seedLessons(
    h,
    ['S0', 'S1', 'S2'].map((raw) => ({
      raw,
      subject: 'debug a flaky vitest suite',
      statement: 'shuffle the seed, then hunt the leaked fake timer',
    })),
  )
}

describe('clustering on what a session established', () => {
  async function withLessons(rows: Array<{ raw: string; subject: string; kind?: string }>) {
    const t = await tempStore()
    const h = new Hoppr({ layout: new Layout(t.layout.root), config: defaults(), sources: [] })
    await seedSessions(
      h,
      rows.map(() => unrelatedSession()),
    )
    await seedLessons(
      h,
      rows.map((r) => ({ ...r, statement: `we do ${r.subject} this way` })),
    )
    return { h, t, db: await h.db() }
  }

  it('groups the things a tool-trace signature could never see', async () => {
    // Every one of these is invisible to clustering on tool names, shell
    // commands, and error classes — which is what this replaced.
    const { h, t, db } = await withLessons([
      { raw: 'S0', subject: 'deploy hoppr' },
      { raw: 'S1', subject: 'deploying the hoppr package' },
      { raw: 'S2', subject: 'deploy hoppr' },
      { raw: 'S3', subject: 'answer inbound sales email' },
    ])
    try {
      const clusters = clusterProcedures(db, 3)
      expect(clusters).toHaveLength(1)
      expect(clusters[0]!.rawIds.sort()).toEqual(['S0', 'S1', 'S2'])
      h.close()
    } finally {
      await t.cleanup()
    }
  })

  it('counts distinct sessions, not repeated mentions in one', async () => {
    // One session that talks about deploying three times is one piece of
    // evidence. Counting mentions would let a single long session mint a skill.
    const { h, t, db } = await withLessons([
      { raw: 'S0', subject: 'deploy hoppr' },
      { raw: 'S0', subject: 'deploy the hoppr cli' },
      { raw: 'S0', subject: 'deploying hoppr' },
    ])
    try {
      expect(clusterProcedures(db, 3)).toHaveLength(0)
      h.close()
    } finally {
      await t.cleanup()
    }
  })

  it('leaves ledger kinds out of procedure clustering', async () => {
    const { h, t, db } = await withLessons([
      { raw: 'S0', subject: 'writing tone', kind: 'preference' },
      { raw: 'S1', subject: 'writing tone', kind: 'preference' },
      { raw: 'S2', subject: 'writing tone', kind: 'preference' },
    ])
    try {
      // Preferences become a ledger, not a mined procedure — they have no
      // steps and no pitfalls to find.
      expect(clusterProcedures(db, 3)).toHaveLength(0)
      h.close()
    } finally {
      await t.cleanup()
    }
  })
})

describe('mining', () => {
  const proposal = {
    skills: [
      {
        slug: 'debug-flaky-vitest',
        name: 'debug-flaky-vitest',
        description:
          'Diagnose intermittently failing vitest suites. Use when tests pass alone but fail in a full run, or when CI is red and local is green.',
        body: '## Procedure\n1. Reproduce with `vitest run --sequence.shuffle`\n2. Bisect to the first offending file\n3. Add vi.useRealTimers() to afterEach\n\n## Pitfalls seen in practice\n- fake timers leak into the next file, so the failure surfaces far from its cause\n\n## Do not use when\n- the failure is deterministic — that is an ordinary bug, not flakiness',
        evidence: ['S0', 'S1', 'S2'],
        reusable: true,
        confidence: 0.85,
      },
    ],
  }

  async function store() {
    const t = await tempStore()
    const h = new Hoppr({ layout: new Layout(t.layout.root), config: defaults(), sources: [] })
    return { ...t, h }
  }

  it("resolves evidence against the cluster, not the model's echoed ids", async () => {
    const { layout, h, cleanup } = await store()
    try {
      await seedMinable(h)
      const db = await h.db()
      // Transcripts carry their own session UUIDs, and models return those
      // instead of the ids we supplied — which would leave every source
      // dangling and make `skills why` useless.
      const bogus = {
        skills: [
          {
            ...proposal.skills[0]!,
            evidence: ['s-a-uuid-from-inside-the-transcript', 'not-a-hoppr-id', 'nope'],
          },
        ],
      }
      await mineSkills(db, layout, defaults(), new MockLlm([bogus]))
      const ev = skillEvidence(db, 'debug-flaky-vitest')
        .map((e) => e.raw_id)
        .sort()
      expect(ev).toEqual(['S0', 'S1', 'S2'])
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('writes a proposal with SKILL.md and a provenance marker', async () => {
    const { layout, h, cleanup } = await store()
    try {
      await seedMinable(h)
      const db = await h.db()
      const st = await mineSkills(db, layout, defaults(), new MockLlm([proposal]))
      expect(st.proposed).toBe(1)

      const md = await readFile(layout.skillFile('debug-flaky-vitest'), 'utf8')
      // The frontmatter contract other harnesses read.
      expect(md).toContain('name: debug-flaky-vitest')
      expect(md).toContain('description:')
      expect(md).toContain('Pitfalls')

      const meta = JSON.parse(await readFile(layout.skillMeta('debug-flaky-vitest'), 'utf8'))
      expect(meta.managed_by).toBe('hoppr')
      expect(meta.sources).toHaveLength(3)

      // Auditable: evidence walks back to the exact sessions.
      expect(
        skillEvidence(db, 'debug-flaky-vitest')
          .map((e) => e.raw_id)
          .sort(),
      ).toEqual(['S0', 'S1', 'S2'])
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('lands as a proposal, never installed', async () => {
    const { layout, h, cleanup } = await store()
    try {
      await seedMinable(h)
      const db = await h.db()
      await mineSkills(db, layout, defaults(), new MockLlm([proposal]))
      expect(listSkills(db)[0]!.state).toBe('proposed')
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('does not re-propose something a human rejected', async () => {
    const { layout, h, cleanup } = await store()
    try {
      await seedMinable(h)
      const db = await h.db()
      await mineSkills(db, layout, defaults(), new MockLlm([proposal]))
      setSkillState(db, 'debug-flaky-vitest', 'rejected')

      const again = await mineSkills(db, layout, defaults(), new MockLlm([proposal]))
      expect(again.proposed).toBe(0)
      expect(again.rejectedAgain).toBe(1)
      expect(listSkills(db)[0]!.state).toBe('rejected')
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('drops low-confidence and thin-evidence proposals', async () => {
    const { layout, h, cleanup } = await store()
    try {
      await seedMinable(h)
      const db = await h.db()
      const weak = {
        skills: [
          { ...proposal.skills[0]!, slug: 'weak-one', confidence: 0.2 },
          // Not "thin evidence" any more — one session is fine if the job
          // plainly repeats. What fails is the miner judging that it does not.
          { ...proposal.skills[0]!, slug: 'one-off', evidence: ['S0'], reusable: false },
        ],
      }
      const st = await mineSkills(db, layout, defaults(), new MockLlm([weak]))
      expect(st.proposed).toBe(0)
      // They are recorded as `weak` rather than discarded, so an audit can
      // show what was mined and why it did not earn a place.
      expect(st.weak).toBeGreaterThan(0)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('honours `mine = "off"` without disabling the ledgers', async () => {
    const { layout, h, cleanup } = await store()
    try {
      await seedMinable(h)
      const db = await h.db()
      const cfg = defaults()
      cfg.skills.mine = 'off'
      const llm = new MockLlm([proposal])
      const st = await mineSkills(db, layout, cfg, llm)
      expect(st.proposed).toBe(0)
      expect(llm.calls).toBe(0)
      // Distinct from `enabled = false`: mining is a quality-tier call per
      // cluster with uncertain precision, while the ledgers are assembled by
      // code from claims already extracted and cost nothing.
      expect(st.logLine).toContain('ledgers still build')
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('mines only the named subjects under `mine = "targeted"`', async () => {
    const { layout, h, cleanup } = await store()
    try {
      await seedMinable(h)
      const db = await h.db()
      const cfg = defaults()
      cfg.skills.mine = 'targeted'
      cfg.skills.find = ['cutting a release']
      const llm = new MockLlm([proposal])
      expect((await mineSkills(db, layout, cfg, llm)).proposed).toBe(0)
      expect(llm.calls).toBe(0)

      // The target is a short phrase; the cluster subject is longer and more
      // specific, so matching is containment rather than similarity.
      cfg.skills.find = ['flaky vitest']
      expect((await mineSkills(db, layout, cfg, llm)).proposed).toBe(1)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('says so rather than silently mining nothing when targets are unset', async () => {
    const { layout, h, cleanup } = await store()
    try {
      await seedMinable(h)
      const db = await h.db()
      const cfg = defaults()
      cfg.skills.mine = 'targeted'
      const st = await mineSkills(db, layout, cfg, new MockLlm([proposal]))
      expect(st.logLine).toContain('[skills] find')
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('mines nothing at all when no procedure recurs', async () => {
    const { layout, h, cleanup } = await store()
    try {
      await seedSessions(h, [unrelatedSession(), unrelatedSession(), unrelatedSession()])
      const db = await h.db()
      const llm = new MockLlm([proposal])
      const st = await mineSkills(db, layout, defaults(), llm)
      expect(st.proposed).toBe(0)
      // And it did not even ask the model — an empty answer costs nothing.
      expect(llm.calls).toBe(0)
      h.close()
    } finally {
      await cleanup()
    }
  })
})

describe('installing', () => {
  async function withSkill() {
    const t = await tempStore()
    const h = new Hoppr({ layout: new Layout(t.layout.root), config: defaults(), sources: [] })
    await seedMinable(h)
    const db = await h.db()
    await mineSkills(
      db,
      layout(h),
      defaults(),
      new MockLlm([
        {
          skills: [
            {
              slug: 'debug-flaky-vitest',
              name: 'debug-flaky-vitest',
              description:
                'Diagnose intermittently failing vitest suites. Use when a test passes alone but fails in a full run.',
              body: '## Procedure\n1. Reproduce with `vitest run --sequence.shuffle`\n2. Bisect to the first offending file\n\n## Pitfalls seen in practice\n- fake timers leak across files\n\n## Do not use when\n- the failure is deterministic — that is an ordinary bug, not flakiness',
              evidence: ['S0', 'S1', 'S2'],
              reusable: true,
              confidence: 0.9,
            },
          ],
        },
      ]),
    )
    return { ...t, h, db }
  }
  const layout = (h: Hoppr) => h.layout

  it('refuses to install a proposal without review', async () => {
    const { h, db, cleanup } = await withSkill()
    try {
      await expect(installSkill(h.layout, db, 'debug-flaky-vitest')).rejects.toThrow(
        /still a proposal/,
      )
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('installs once accepted, and is idempotent', async () => {
    const { layout: l, h, db, cleanup } = await withSkill()
    try {
      setSkillState(db, 'debug-flaky-vitest', 'accepted')
      const target = join(l.root, 'fake-claude-skills')
      const a = await installSkill(h.layout, db, 'debug-flaky-vitest', { target })
      expect(a.outcome).toBe('installed')
      expect(existsSync(join(target, 'debug-flaky-vitest', 'SKILL.md'))).toBe(true)
      expect(listSkills(db)[0]!.state).toBe('installed')

      const b = await installSkill(h.layout, db, 'debug-flaky-vitest', { target })
      expect(b.outcome).toBe('skipped')
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('never overwrites a hand-written skill directory', async () => {
    const { layout: l, h, db, cleanup } = await withSkill()
    try {
      setSkillState(db, 'debug-flaky-vitest', 'accepted')
      const target = join(l.root, 'fake-claude-skills')
      const dir = join(target, 'debug-flaky-vitest')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'SKILL.md'), 'MY OWN HAND-WRITTEN SKILL\n')

      const r = await installSkill(h.layout, db, 'debug-flaky-vitest', { target })
      expect(r.outcome).toBe('conflict')
      expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toContain('MY OWN HAND-WRITTEN')

      // …unless explicitly forced.
      const forced = await installSkill(h.layout, db, 'debug-flaky-vitest', { target, force: true })
      expect(forced.outcome).toBe('installed')
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('uninstalls only what it owns', async () => {
    const { layout: l, h, db, cleanup } = await withSkill()
    try {
      setSkillState(db, 'debug-flaky-vitest', 'accepted')
      const target = join(l.root, 'fake-claude-skills')
      await installSkill(h.layout, db, 'debug-flaky-vitest', { target })
      const dir = join(target, 'debug-flaky-vitest')

      const r = await uninstallSkill(db, 'debug-flaky-vitest', dir)
      expect(r.outcome).toBe('installed')
      expect(existsSync(dir)).toBe(false)

      // A directory without our marker is left alone.
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'SKILL.md'), 'theirs')
      const skipped = await uninstallSkill(db, 'debug-flaky-vitest', dir)
      expect(skipped.outcome).toBe('skipped')
      expect(existsSync(dir)).toBe(true)
      h.close()
    } finally {
      await cleanup()
    }
  })
})
