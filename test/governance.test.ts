import { describe, expect, it } from 'vitest'
import { defaults } from '../src/config/schema.ts'
import { Hoppr } from '../src/core/hoppr.ts'
import { checkGrounding, commandsIn } from '../src/organize/grounding.ts'
import {
  ACTIVE_FLOOR,
  ARCHIVE_FLOOR,
  recordOutcome,
  refreshLifecycles,
  reliability,
} from '../src/organize/reliability.ts'
import { applyEdits, editDigest } from '../src/organize/revise.ts'
import { writeResolver } from '../src/organize/skillify.ts'
import type { SkillRow } from '../src/organize/skills.ts'
import { glossaryExpand } from '../src/search/glossary.ts'
import { Layout } from '../src/store/layout.ts'
import { tempStore } from './helpers.ts'

async function store() {
  const t = await tempStore()
  const h = new Hoppr({ layout: new Layout(t.layout.root), config: defaults(), sources: [] })
  return { ...t, h, db: await h.db() }
}

function seedSkill(db: Awaited<ReturnType<typeof store>>['db'], slug: string) {
  db.prepare(
    `INSERT INTO skills(slug,name,description,path,state,kind,evidence_count,confidence,created,updated,pinned)
     VALUES (:s,:s,'a description long enough to be a real trigger sentence','p','accepted','procedure',3,0.9,:n,:n,0)`,
  ).run({ s: slug, n: Date.now() })
}

describe('evidence grounding', () => {
  it('flags a command no transcript ever ran', () => {
    // A signal handed to the verifier, not a verdict on its own. A skill can
    // name only real commands and still be a complete misreading — the agent
    // tried a path, hit an error, worked around it, and wrote the first
    // attempt up as the procedure.
    const body = '## Procedure\n1. Run `npm run deploy:prod`\n2. Watch the logs'
    const evidence = '→ Bash: npm run build\n**assistant:** then I ran wrangler deploy'
    expect(checkGrounding(body, evidence).invented).toEqual(['npm run deploy:prod'])
  })

  it('tells apart two scripts of the same runner', () => {
    // `npm run <script>` is the commonest shape a mined skill gets wrong, and
    // stopping at "npm run" would let any transcript that ever built ground a
    // skill that invents a deploy script.
    const cmds = commandsIn('npm run build then npm run deploy:prod')
    expect([...cmds].sort()).toEqual(['npm run build', 'npm run deploy:prod'])
  })

  it('accepts a command that appears in the evidence', () => {
    const body = '## Procedure\n1. `wrangler deploy`'
    expect(checkGrounding(body, '→ Bash: wrangler deploy --env prod').invented).toEqual([])
  })

  it('does not fire on a skill with no commands at all', () => {
    // Plenty of real procedures are judgement, not shell. Grounding must not
    // treat "has no commands" as "invented its commands".
    const r = checkGrounding('## Procedure\n1. Ask before assuming the schema', 'anything')
    expect(r.invented).toEqual([])
    expect(r.grounded).toBe(0)
  })

  it('ignores prose that merely mentions a runner', () => {
    // A false positive discards a real skill, and the alternative to a mined
    // skill is no skill — so the extractor requires runner + subcommand.
    expect([...commandsIn('we use npm, not yarn, in this repo')]).toEqual([])
  })
})

describe('bounded revision', () => {
  const body = '## Procedure\n\n1. one\n\n## Pitfalls seen in practice\n\n- old pitfall'

  it('caps edits at the budget', () => {
    const edits = [1, 2, 3, 4, 5, 6].map((n) => ({
      op: 'append' as const,
      section: 'Procedure',
      text: `step ${n}`,
      why: '',
    }))
    const r = applyEdits(body, edits, 4)
    expect(r.applied).toHaveLength(4)
    expect(r.skipped).toHaveLength(2)
  })

  it('creates a missing section rather than dropping the edit', () => {
    // A skill with no pitfalls section and a newly observed failure is the
    // single most valuable revision available; refusing it would block it.
    const r = applyEdits(
      '## Procedure\n\n1. one',
      [{ op: 'append', section: 'Pitfalls seen in practice', text: '- it hangs', why: '' }],
      4,
    )
    expect(r.applied).toHaveLength(1)
    expect(r.body).toContain('## Pitfalls seen in practice')
    expect(r.body).toContain('- it hangs')
  })

  it('preserves what it is not editing', () => {
    const r = applyEdits(
      body,
      [{ op: 'append', section: 'Pitfalls seen in practice', text: '- new pitfall', why: '' }],
      4,
    )
    expect(r.body).toContain('- old pitfall')
    expect(r.body).toContain('1. one')
    expect(r.body).toContain('- new pitfall')
  })

  it('skips a delete for a section that does not exist', () => {
    const r = applyEdits(body, [{ op: 'delete', section: 'Nope', text: '', why: '' }], 4)
    expect(r.applied).toHaveLength(0)
  })

  it('gives an edit the same digest regardless of its justification', () => {
    // The buffer has to recognize a rejected edit when the model re-proposes
    // it with a different rationale, which is what it always does.
    const a = { op: 'append' as const, section: 'Procedure', text: 'do X', why: 'because A' }
    const b = { op: 'append' as const, section: 'procedure', text: 'do X', why: 'because B' }
    expect(editDigest(a)).toBe(editDigest(b))
  })
})

describe('reliability', () => {
  it('reads as no-opinion before anything is observed', async () => {
    const { h, db, cleanup } = await store()
    try {
      seedSkill(db, 'x')
      // Laplace smoothing: 0.5 means "nothing seen", not "half right".
      expect(reliability(db, 'x').eta).toBe(0.5)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('counts a rejection and an uninstall against a skill', async () => {
    const { h, db, cleanup } = await store()
    try {
      seedSkill(db, 'x')
      recordOutcome(db, 'x', 'fail', 'rejected')
      recordOutcome(db, 'x', 'fail', 'edited')
      recordOutcome(db, 'x', 'fail', 'uninstalled')
      const r = reliability(db, 'x')
      expect(r.trials).toBe(3)
      expect(r.eta).toBeCloseTo(1 / 5)
      expect(refreshLifecycles(db, ARCHIVE_FLOOR)).toBeGreaterThan(0)
      expect(reliability(db, 'x').lifecycle).toBe('archived')
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('stays probationary until there is enough evidence to judge', async () => {
    const { h, db, cleanup } = await store()
    try {
      seedSkill(db, 'x')
      recordOutcome(db, 'x', 'fail', 'edited')
      refreshLifecycles(db, ARCHIVE_FLOOR)
      // One bad outcome is not a trend, and archiving on it is noise.
      expect(reliability(db, 'x').lifecycle).toBe('probationary')
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('never archives when the floor is zero', async () => {
    const { h, db, cleanup } = await store()
    try {
      seedSkill(db, 'x')
      for (let i = 0; i < 5; i++) recordOutcome(db, 'x', 'fail', 'marked')
      refreshLifecycles(db, 0)
      expect(reliability(db, 'x').lifecycle).not.toBe('archived')
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('drops an archived skill from the dispatcher without deleting it', async () => {
    const { layout, h, cleanup } = await store()
    try {
      const rows = [
        { slug: 'good', lifecycle: 'active' },
        { slug: 'stale', lifecycle: 'archived' },
      ].map((r) => ({
        ...r,
        name: r.slug,
        description: `use this when ${r.slug} happens and you need a procedure for it`,
        path: null,
        state: 'accepted',
        kind: 'procedure',
        evidence_count: 3,
        confidence: 0.9,
        pinned: 0,
        body_hash: '',
      })) as unknown as SkillRow[]
      await writeResolver(layout, rows)
      const { readFile } = await import('node:fs/promises')
      const md = await readFile(`${layout.skills}/RESOLVER.md`, 'utf8')
      expect(md).toContain('good')
      expect(md).not.toContain('stale')
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('has an active floor above the archive floor', () => {
    expect(ACTIVE_FLOOR).toBeGreaterThan(ARCHIVE_FLOOR)
  })
})

describe('glossary query expansion', () => {
  async function withTerm() {
    const s = await store()
    s.db
      .prepare(
        `INSERT INTO lessons(id,raw_id,kind,subject,statement,quote,outcome,confidence,observed,created)
         VALUES ('L1','R1','vocabulary','sitrep','a comparative status report across branches','q','unknown',0.9,1,1)`,
      )
      .run()
    return s
  }

  it('expands a query containing a recorded term', async () => {
    const { h, db, cleanup } = await withTerm()
    try {
      // The failure this fixes: the documents say "status report" and you
      // search for the word you actually use.
      const e = glossaryExpand(db, 'sitrep')
      expect(e.from).toEqual(['sitrep'])
      expect(e.terms).toContain('status')
      expect(e.terms).toContain('report')
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('leaves an unrelated query alone', async () => {
    const { h, db, cleanup } = await withTerm()
    try {
      expect(glossaryExpand(db, 'invoice from March').terms).toEqual([])
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('does not re-add words the query already has', async () => {
    const { h, db, cleanup } = await withTerm()
    try {
      expect(glossaryExpand(db, 'sitrep status')).toMatchObject({ from: ['sitrep'] })
      expect(glossaryExpand(db, 'sitrep status').terms).not.toContain('status')
      h.close()
    } finally {
      await cleanup()
    }
  })
})

describe('hands-off marking', () => {
  it('writes a rule that actually matches the file it protects', async () => {
    const { layout, h, cleanup } = await store()
    try {
      const { isHandsOff, markHandsOff } = await import('../src/organize/handsoff.ts')
      const cfg = defaults()
      await markHandsOff(cfg, layout, 'skills/deploy/**', 'hand-edited 2026-08-21')
      // This is gitignore syntax: `#` only opens a comment at the start of a
      // line. Putting the reason after the pattern made it part of the
      // pattern, which then matched nothing — every protect rule silently
      // inert, and a hand-edit quietly overwritten on the next pass.
      expect(isHandsOff(cfg, layout, 'skills/deploy/SKILL.md')).toBe(true)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('is idempotent', async () => {
    const { layout, h, cleanup } = await store()
    try {
      const { markHandsOff } = await import('../src/organize/handsoff.ts')
      const cfg = defaults()
      expect(await markHandsOff(cfg, layout, 'skills/a/**', 'once')).toBe(true)
      expect(await markHandsOff(cfg, layout, 'skills/a/**', 'again')).toBe(false)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('keeps earlier locks when a later one is added', async () => {
    const { layout, h, cleanup } = await store()
    try {
      const { isHandsOff, markHandsOff } = await import('../src/organize/handsoff.ts')
      const cfg = defaults()
      await markHandsOff(cfg, layout, 'skills/a/**', 'first')
      await markHandsOff(cfg, layout, 'skills/b/**', 'second')
      expect(isHandsOff(cfg, layout, 'skills/a/SKILL.md')).toBe(true)
      expect(isHandsOff(cfg, layout, 'skills/b/SKILL.md')).toBe(true)
      h.close()
    } finally {
      await cleanup()
    }
  })
})

describe('the test suite itself', () => {
  it('cannot reach the real home directory', async () => {
    const { homedir } = await import('node:os')
    // Installing a skill writes to ~/.claude/skills. Before this guard, one
    // run put three real skills into the developer's home, where they loaded
    // into the next agent session.
    expect(homedir()).toContain('hoppr-home-')
    expect(homedir()).not.toBe(process.env.PWD)
  })
})
