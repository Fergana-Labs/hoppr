import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaults } from '../src/config/schema.ts'
import { Hoppr } from '../src/core/hoppr.ts'
import type { JsonOptions, LlmProvider } from '../src/llm/provider.ts'
import {
  clusterByProcedure,
  installSkill,
  listSkills,
  mineSkills,
  procedureSignature,
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

describe('procedural clustering', () => {
  it('signals on tools, commands and errors — not on subject matter', () => {
    const sig = procedureSignature(flakyTestSession('auth'))
    expect([...sig]).toContain('tool:bash')
    expect([...sig]).toContain('cmd:vitest-run')
    expect([...sig]).toContain('err:TypeError')
    // The topic word is deliberately absent: two sessions about "auth" are not
    // a skill; two that debug the same way are.
    expect([...sig].some((s) => s.includes('auth'))).toBe(false)
  })

  it('groups sessions that share a procedure, and excludes one that does not', () => {
    const sessions = [
      { id: 'a', title: '', text: flakyTestSession('auth') },
      { id: 'b', title: '', text: flakyTestSession('billing') },
      { id: 'c', title: '', text: flakyTestSession('search') },
      { id: 'd', title: '', text: unrelatedSession() },
    ]
    const clusters = clusterByProcedure(sessions, 3)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.map((s) => s.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('forms no cluster when a workflow happened only once', () => {
    const sessions = [
      { id: 'a', title: '', text: flakyTestSession('auth') },
      { id: 'd', title: '', text: unrelatedSession() },
    ]
    expect(clusterByProcedure(sessions, 3)).toHaveLength(0)
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
        body: '## Procedure\n1. Reproduce with `vitest run --sequence.shuffle`\n2. Bisect to the first offending file\n3. Add vi.useRealTimers() to afterEach\n\n## Pitfalls seen in practice\n- fake timers leak into the next file, so the failure surfaces far from its cause',
        evidence: ['S0', 'S1', 'S2'],
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
      await seedSessions(h, [flakyTestSession('a'), flakyTestSession('b'), flakyTestSession('c')])
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
      await seedSessions(h, [flakyTestSession('a'), flakyTestSession('b'), flakyTestSession('c')])
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
      await seedSessions(h, [flakyTestSession('a'), flakyTestSession('b'), flakyTestSession('c')])
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
      await seedSessions(h, [flakyTestSession('a'), flakyTestSession('b'), flakyTestSession('c')])
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
      await seedSessions(h, [flakyTestSession('a'), flakyTestSession('b'), flakyTestSession('c')])
      const db = await h.db()
      const weak = {
        skills: [
          { ...proposal.skills[0]!, slug: 'weak-one', confidence: 0.2 },
          { ...proposal.skills[0]!, slug: 'thin-one', evidence: ['S0'] },
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
    await seedSessions(h, [flakyTestSession('a'), flakyTestSession('b'), flakyTestSession('c')])
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
              body: '## Procedure\n1. Reproduce with `vitest run --sequence.shuffle`\n2. Bisect to the first offending file\n\n## Pitfalls seen in practice\n- fake timers leak across files',
              evidence: ['S0', 'S1', 'S2'],
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
