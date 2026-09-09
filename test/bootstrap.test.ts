import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaults } from '../src/config/schema.ts'
import { Hoppr } from '../src/core/hoppr.ts'
import { bootstrapSkills, detectProject } from '../src/store/bootstrap.ts'
import { buildFrontDoor, FRONT_DOOR } from '../src/store/frontdoor.ts'
import { git } from '../src/store/git.ts'
import { Layout } from '../src/store/layout.ts'
import { tempStore } from './helpers.ts'

async function store() {
  const t = await tempStore()
  const h = new Hoppr({ layout: new Layout(t.layout.root), config: defaults(), sources: [] })
  return { ...t, h }
}

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hoppr-proj-'))
  for (const [p, body] of Object.entries(files)) {
    const full = join(dir, p)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, body)
  }
  return dir
}

describe('project detection', () => {
  it('orders verify commands cheapest-check-first, not alphabetically', async () => {
    const dir = await project({
      'package.json': JSON.stringify({
        scripts: { test: 'vitest run', check: 'biome check', build: 'tsup' },
      }),
      'package-lock.json': '{}',
    })
    try {
      const p = await detectProject(dir)
      expect(p.stacks).toEqual(['node'])
      expect(p.packageManager).toBe('npm')
      // A type error makes a test failure unreadable, so check precedes test.
      expect(p.verify).toEqual(['npm run check', 'npm run build', 'npm run test'])
      expect(p.focusedTest).toBe('npm run test -- <file>')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  /**
   * The defect this catches shipped a skill telling an agent to run typecheck,
   * lint and test twice — this repo's `check` is all three. A generated skill
   * whose first instruction wastes a minute teaches its reader to ignore it.
   */
  it('collapses an aggregate script instead of listing what it already runs', async () => {
    const dir = await project({
      'package.json': JSON.stringify({
        scripts: {
          typecheck: 'tsc --noEmit',
          lint: 'biome check',
          test: 'vitest run',
          build: 'tsup',
          check: 'npm run typecheck && npm run lint && npm test',
          prepublishOnly: 'npm run check && npm run build',
        },
      }),
    })
    try {
      // …and `prepublishOnly` covers both survivors, but is not itself a way
      // anyone checks their work, so it hides nothing.
      expect((await detectProject(dir)).verify).toEqual(['npm run check', 'npm run build'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads the default branch, not whichever branch is checked out', async () => {
    const dir = await project({ 'a.txt': 'x' })
    try {
      await git(dir, ['init', '-q'])
      await git(dir, ['config', 'user.email', 'a@b.c'])
      await git(dir, ['config', 'user.name', 'a'])
      await git(dir, ['add', '.'])
      await git(dir, ['commit', '-qm', 'first'])
      await git(dir, ['branch', '-M', 'main'])
      await git(dir, ['checkout', '-qb', 'a-feature-branch'])
      expect((await detectProject(dir)).defaultBranch).toBe('main')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads the package manager off the lockfile', async () => {
    const dir = await project({
      'package.json': JSON.stringify({ scripts: { test: 'vitest' } }),
      'pnpm-lock.yaml': '',
    })
    try {
      expect((await detectProject(dir)).verify).toEqual(['pnpm run test'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('bootstrap skills', () => {
  /**
   * The rule the whole module exists for. A pack of generally-good advice is
   * true, unobjectionable and useless: it tells an agent nothing about THIS
   * place, and every generic line loaded into a session displaces a specific
   * one. So a project with nothing detectable gets nothing.
   */
  it('writes no skill it could not fill in with something specific', async () => {
    const { layout, h, cleanup } = await store()
    const dir = await project({ 'notes.txt': 'hello' })
    try {
      const r = await bootstrapSkills(await h.db(), layout, defaults(), dir)
      expect(r.written).toEqual([])
      expect(r.skipped).toBeGreaterThan(0)
      expect(existsSync(layout.skillFile('verify-before-done'))).toBe(false)
      h.close()
    } finally {
      await cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('puts the detected commands into the skill it writes', async () => {
    const { layout, h, cleanup } = await store()
    const dir = await project({
      'package.json': JSON.stringify({ scripts: { check: 'tsc', test: 'vitest run' } }),
      'src/index.ts': '',
      'test/a.test.ts': '',
      'docs/readme.md': '',
    })
    try {
      const r = await bootstrapSkills(await h.db(), layout, defaults(), dir)
      expect(r.written).toContain('verify-before-done')
      const body = await readFile(layout.skillFile('verify-before-done'), 'utf8')
      expect(body).toContain('npm run check')
      expect(body).toContain('npm run test')
      // Three known directories is a layout worth naming; two is not.
      expect(r.written).toContain('where-things-live')
      const where = await readFile(layout.skillFile('where-things-live'), 'utf8')
      expect(where).toContain('`src/`')
      expect(where).toContain('`test/`')
      h.close()
    } finally {
      await cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('stops regenerating a starter skill once someone edits it', async () => {
    const { layout, h, cleanup } = await store()
    const dir = await project({
      'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
    })
    try {
      const db = await h.db()
      await bootstrapSkills(db, layout, defaults(), dir)
      const path = layout.skillFile('verify-before-done')
      const mine =
        '---\nname: verify-before-done\ndescription: Use when I say so.\n---\n\nMy own words.\n'
      await writeFile(path, mine)
      await bootstrapSkills(db, layout, defaults(), dir)
      expect(await readFile(path, 'utf8')).toBe(mine)
      h.close()
    } finally {
      await cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('front door', () => {
  it('writes nothing at all when there is nothing standing to say', async () => {
    const { layout, h, cleanup } = await store()
    try {
      const r = await buildFrontDoor(await h.db(), layout, defaults())
      expect(r.empty).toBe(true)
      expect(existsSync(layout.skillFile(FRONT_DOOR))).toBe(false)
      h.close()
    } finally {
      await cleanup()
    }
  })

  /**
   * The bug: bucketing by `kind === 'procedure'` sent every bootstrap skill to
   * the ledger branch, which renders from the configured ledger list — so the
   * three skills written at init never appeared in the file an agent reads.
   */
  it('routes to a starter skill instead of dropping a kind it does not know', async () => {
    const { layout, h, cleanup } = await store()
    try {
      const db = await h.db()
      const now = Date.now()
      db.prepare(
        `INSERT INTO skills(slug,name,description,path,state,kind,evidence_count,confidence,created,updated)
         VALUES ('verify-before-done','v','Use when about to report a change works.',NULL,
                 'accepted','bootstrap',0,1,:now,:now)`,
      ).run({ now })
      await buildFrontDoor(db, layout, defaults())
      const body = await readFile(layout.skillFile(FRONT_DOOR), 'utf8')
      expect(body).toContain('verify-before-done')
      // …and says where it came from, since nothing here was observed.
      expect(body).toContain('Nothing has been learned from their sessions yet')
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('inlines the standing context and routes to the situational skills', async () => {
    const { layout, h, cleanup } = await store()
    try {
      const db = await h.db()
      const now = Date.now()
      for (const [i, l] of [
        ['response length', 'Answer in one sentence when one will do.', 'prefer'],
        ['committing', 'Never commit without being asked.', 'must'],
      ].entries()) {
        db.prepare(
          `INSERT INTO lessons(id,raw_id,kind,subject,statement,quote,strength,outcome,confidence,observed,created)
           VALUES (:id,'R0','preferences',:subj,:stmt,'q',:str,'unknown',1,:now,:now)`,
        ).run({ id: `L${i}`, subj: l[0], stmt: l[1], str: l[2], now })
      }
      db.prepare(
        `INSERT INTO skills(slug,name,description,path,state,kind,prevents,evidence_count,confidence,created,updated)
         VALUES ('run-before-reporting','r','Use when about to report a change works.',NULL,
                 'accepted','guardrail','claimed-done-without-running',2,0.9,:now,:now)`,
      ).run({ now })

      const r = await buildFrontDoor(db, layout, defaults())
      expect(r.empty).toBe(false)
      const body = await readFile(layout.skillFile(FRONT_DOOR), 'utf8')
      // A binding rule read after an advisory one has already been disobeyed.
      expect(body.indexOf('**MUST**')).toBeLessThan(body.indexOf('**PREFER**'))
      expect(body).toContain('Never commit without being asked.')
      expect(body).toContain('run-before-reporting')
      // The description is the trigger — it has to say WHEN, not what it is.
      expect(body).toContain('Use at the START of')
      h.close()
    } finally {
      await cleanup()
    }
  })
})
