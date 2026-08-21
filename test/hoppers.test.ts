import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config/load.ts'
import { dirConnector, stripHtml } from '../src/connectors/dir.ts'
import { syncAll } from '../src/connectors/registry.ts'
import { Hoppr } from '../src/core/hoppr.ts'
import { defaultProfile, defaultRawMode, parseSource } from '../src/core/source.ts'
import {
  countSteps,
  promotionGate,
  triggerQuality,
  writeResolver,
} from '../src/organize/skillify.ts'
import type { SkillRow } from '../src/organize/skills.ts'
import { initStore } from '../src/store/init.ts'
import { createHopper, listHoppers } from '../src/store/registry.ts'

afterEach(() => {
  delete process.env.HOPPR_HOME
})

async function home(): Promise<string> {
  const h = await mkdtemp(join(tmpdir(), 'hoppr-home-'))
  process.env.HOPPR_HOME = h
  return h
}

describe('source specs', () => {
  it('parses each form', () => {
    expect(parseSource('dir:/tmp/x').kind).toBe('dir')
    expect(parseSource('/tmp/x').kind).toBe('dir')
    expect(parseSource('agents:claude-code,codex').harnesses).toEqual(['claude-code', 'codex'])
    expect(parseSource('agents:').harnesses).toEqual([])
    expect(parseSource('manual').kind).toBe('manual')
    expect(() => parseSource('ftp:whatever')).toThrow(/unrecognized source/)
  })

  it('defaults raw mode by who owns the bytes', () => {
    // Your folder: never copied. A harness's logs: copied, because it rotates them.
    expect(defaultRawMode('dir')).toBe('reference')
    expect(defaultRawMode('agents')).toBe('copy')
  })

  it('only mines skills where procedures exist', () => {
    // Whether a hoppr mines skills is decided by its curation preset, not by
    // its profile — see the preset tests. The profile only picks the default.
    expect(defaultProfile('agents')).toBe('agents')
    expect(defaultProfile('dir')).toBe('folder')
  })
})

describe('registry', () => {
  it('creates isolated hoppers under ~/.hoppr and lists them', async () => {
    const h = await home()
    try {
      const src = join(h, '..', `src-${Date.now()}`)
      await mkdir(src, { recursive: true })
      await createHopper({ name: 'papers', source: `dir:${src}` })
      await createHopper({ name: 'work', source: 'agents:claude-code' })

      const rows = await listHoppers()
      expect(rows.map((r) => r.name).sort()).toEqual(['papers', 'work'])
      expect(rows.find((r) => r.name === 'papers')?.rawMode).toBe('reference')
      expect(rows.find((r) => r.name === 'work')?.rawMode).toBe('copy')
      // Every hoppr describes when to use it — that text IS the agent interface.
      expect(rows.every((r) => r.description.length > 10)).toBe(true)

      await expect(createHopper({ name: 'work', source: 'manual' })).rejects.toThrow(
        /already exists/,
      )
      await expect(createHopper({ name: 'bad name', source: 'manual' })).rejects.toThrow(/usable/)
      await rm(src, { recursive: true, force: true })
    } finally {
      await rm(h, { recursive: true, force: true })
    }
  })

  it('resolves each hoppr to its own root, with its own config', async () => {
    const h = await home()
    try {
      await createHopper({ name: 'a', source: 'manual' })
      await createHopper({ name: 'b', source: 'agents:codex' })
      const a = await loadConfig({ hopper: 'a' })
      const b = await loadConfig({ hopper: 'b' })
      expect(a.layout.root).not.toBe(b.layout.root)
      expect(a.config.hopper.profile).toBe('manual')
      expect(b.config.hopper.profile).toBe('agents')
    } finally {
      await rm(h, { recursive: true, force: true })
    }
  })
})

describe('folder hoppr — reference mode', () => {
  async function fixture() {
    const h = await home()
    const src = await mkdtemp(join(tmpdir(), 'hoppr-src-'))
    await writeFile(join(src, 'note.md'), '# Rank fusion\nRRF at k=60 needs no calibration.\n')
    await mkdir(join(src, 'sub'), { recursive: true })
    await writeFile(join(src, 'sub', 'deep.md'), '# Deep\nNested content about timers.\n')
    await writeFile(join(src, 'ignore.bin'), 'binary-ish')
    await createHopper({ name: 'papers', source: `dir:${src}` })
    const hp = await Hoppr.open({ hopper: 'papers' })
    await initStore(hp.layout.root, hp.config)
    return { h, src, hp }
  }

  it('indexes files without copying them, and creates no raw/ at all', async () => {
    const { h, src, hp } = await fixture()
    try {
      const db = await hp.db()
      const stats = await syncAll(db, hp.layout, hp.config, { full: true })
      expect(stats[0]!.connector).toBe('dir')
      expect(stats[0]!.captured).toBe(2) // .bin is not indexable

      // The whole point: hoppr owns no copy of your folder.
      expect(existsSync(join(hp.layout.root, 'raw'))).toBe(false)

      const rows = db
        .prepare<{ n: number }>("SELECT COUNT(*) n FROM raw WHERE raw_mode='reference'")
        .get()
      expect(rows?.n).toBe(2)

      // Searchable the moment it lands, without a separate reindex.
      const res = await hp.search('rank fusion', { scope: 'all' })
      expect(res.hits.length).toBeGreaterThan(0)
      hp.close()
    } finally {
      await rm(src, { recursive: true, force: true })
      await rm(h, { recursive: true, force: true })
    }
  })

  it('never writes to the source folder', async () => {
    const { h, src, hp } = await fixture()
    try {
      const before = await readFile(join(src, 'note.md'), 'utf8')
      const db = await hp.db()
      await syncAll(db, hp.layout, hp.config, { full: true })
      await hp.reindex()
      expect(await readFile(join(src, 'note.md'), 'utf8')).toBe(before)
      hp.close()
    } finally {
      await rm(src, { recursive: true, force: true })
      await rm(h, { recursive: true, force: true })
    }
  })

  it('re-indexes only what changed, and resolves back to the real path', async () => {
    const { h, src, hp } = await fixture()
    try {
      const db = await hp.db()
      await syncAll(db, hp.layout, hp.config, { full: true })
      const again = await syncAll(db, hp.layout, hp.config, { full: true })
      expect(again[0]!.captured + again[0]!.updated).toBe(0) // nothing changed

      await writeFile(join(src, 'note.md'), '# Rank fusion\nAddendum: k=60.\n')
      const third = await syncAll(db, hp.layout, hp.config, { full: true })
      expect(third[0]!.updated).toBe(1)

      const hit = (await hp.search('addendum', { scope: 'all' })).hits[0]!
      const rec = await hp.resolveRaw(hit.refId)
      // The capture points at the ORIGINAL file, outside the store.
      expect(rec?.path.startsWith(src)).toBe(true)
      expect(await hp.readRawText(rec!)).toContain('Addendum')
      hp.close()
    } finally {
      await rm(src, { recursive: true, force: true })
      await rm(h, { recursive: true, force: true })
    }
  })

  it('prunes a capture when its file is deleted, but not when the volume vanishes', async () => {
    const { h, src, hp } = await fixture()
    try {
      const db = await hp.db()
      await syncAll(db, hp.layout, hp.config, { full: true })
      expect(db.prepare<{ n: number }>('SELECT COUNT(*) n FROM raw').get()?.n).toBe(2)

      // A deleted file must stop being searchable — otherwise the index keeps
      // claiming a document exists forever.
      await rm(join(src, 'note.md'))
      const after = await syncAll(db, hp.layout, hp.config, { full: true })
      expect(after[0]!.pruned).toBe(1)
      expect(db.prepare<{ n: number }>('SELECT COUNT(*) n FROM raw').get()?.n).toBe(1)
      expect((await hp.search('rank fusion', { scope: 'all' })).hits).toHaveLength(0)

      // …but an unreadable source directory is a blip, not a mass deletion.
      await rm(join(src, 'sub'), { recursive: true, force: true })
      await rm(src, { recursive: true, force: true })
      const blip = await syncAll(db, hp.layout, hp.config, { full: true })
      expect(blip[0]?.pruned ?? 0).toBe(0)
      expect(db.prepare<{ n: number }>('SELECT COUNT(*) n FROM raw').get()?.n).toBe(1)
      hp.close()
    } finally {
      await rm(src, { recursive: true, force: true })
      await rm(h, { recursive: true, force: true })
    }
  })

  it('a folder hoppr never pulls from your agent logs', async () => {
    const { h, src, hp } = await fixture()
    try {
      const db = await hp.db()
      const stats = await syncAll(db, hp.layout, hp.config, { full: true })
      // Isolation is the point: only the dir connector ran.
      expect(stats.map((s) => s.connector)).toEqual(['dir'])
      hp.close()
    } finally {
      await rm(src, { recursive: true, force: true })
      await rm(h, { recursive: true, force: true })
    }
  })

  it('skips oversized and excluded files', async () => {
    const src = await mkdtemp(join(tmpdir(), 'hoppr-src-'))
    try {
      await mkdir(join(src, 'node_modules'), { recursive: true })
      await writeFile(join(src, 'node_modules', 'pkg.md'), 'should be ignored')
      await writeFile(join(src, 'ok.md'), 'keep me')
      const found = await dirConnector.discover({ path: src, max_file_mb: 20 })
      expect(found.map((f) => f.label)).toEqual(['ok.md'])
    } finally {
      await rm(src, { recursive: true, force: true })
    }
  })

  it('strips html to text', () => {
    expect(stripHtml('<p>Hello <b>world</b></p><script>evil()</script>')).toBe('Hello world')
  })
})

describe('skillify promotion gate', () => {
  const good = {
    slug: 'debug-flaky-vitest',
    description:
      'Use when tests pass locally but fail in CI, or a test passes alone and fails in a full run.',
    body: '## Procedure\n1. Run with --sequence.shuffle\n2. Bisect the ordering\n\n## Pitfalls seen in practice\n- fake timers leak across files',
    evidenceCount: 4,
    confidence: 0.8,
    minEvidence: 3,
    minConfidence: 0.6,
  }

  it('passes a skill that recurs, says when to use it, and records pitfalls', () => {
    const r = promotionGate(good)
    expect(r.pass).toBe(true)
    expect(r.failures).toEqual([])
  })

  it('gates out a description that never says WHEN', () => {
    const r = promotionGate({ ...good, description: 'A guide to debugging tests in this repo.' })
    expect(r.pass).toBe(false)
    expect(r.failures.join(' ')).toMatch(/WHEN|generic/)
  })

  it('gates out narrative with no steps', () => {
    const r = promotionGate({
      ...good,
      body: 'We spent an afternoon on this and eventually it worked.',
    })
    expect(r.pass).toBe(false)
    expect(r.failures.join(' ')).toMatch(/step/)
  })

  it('gates out a skill with no pitfalls — the failures are the payload', () => {
    const r = promotionGate({ ...good, body: '## Procedure\n1. Do it\n2. Done' })
    expect(r.pass).toBe(false)
    expect(r.failures.join(' ')).toMatch(/pitfall/)
  })

  it('gates out a one-off', () => {
    expect(promotionGate({ ...good, evidenceCount: 1 }).pass).toBe(false)
  })

  it('recognizes trigger quality and counts steps', () => {
    expect(
      triggerQuality('Use when the build fails after a dependency bump and node-gyp errors appear.')
        .ok,
    ).toBe(true)
    expect(triggerQuality('A helper skill.').ok).toBe(false)
    expect(countSteps('1. a\n2. b\n3. c')).toBe(3)
  })
})

describe('skill resolver', () => {
  it('lists only accepted skills, so a proposal is never routed to', async () => {
    const h = await home()
    try {
      await createHopper({ name: 'work', source: 'agents:codex' })
      const hp = await Hoppr.open({ hopper: 'work' })
      await initStore(hp.layout.root, hp.config)
      const rows = [
        {
          slug: 'a-skill',
          name: 'a',
          description: 'Use when X happens.',
          path: null,
          state: 'accepted',
          evidence_count: 3,
          confidence: 0.8,
          pinned: 0,
        },
        {
          slug: 'b-proposal',
          name: 'b',
          description: 'Use when Y happens.',
          path: null,
          state: 'proposed',
          evidence_count: 3,
          confidence: 0.8,
          pinned: 0,
        },
      ] as SkillRow[]
      const rel = await writeResolver(hp.layout, rows)
      const text = await readFile(join(hp.layout.root, rel), 'utf8')
      expect(text).toContain('a-skill')
      expect(text).not.toContain('b-proposal')
      expect(text).toContain('Do not load them all')
      hp.close()
    } finally {
      await rm(h, { recursive: true, force: true })
    }
  })
})

describe('reindex on a reference-mode hoppr', () => {
  it('does not empty the store', async () => {
    // `reindex --full` rebuilds from raw/ and curated/. A folder hoppr has no
    // raw/ — the folder IS the raw tier — so a rebuild found nothing to read
    // and left search returning nothing until someone thought to run `sync`.
    // The files were never at risk; the claim that a rebuild "costs nothing"
    // was.
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'hoppr-reidx-'))
    writeFileSync(join(dir, 'note.md'), '# Ranking\n\nRRF with k=60 beat weighted blending.')

    const home = mkdtempSync(join(tmpdir(), 'hoppr-home-'))
    mkdirSync(home, { recursive: true })
    const prev = process.env.HOPPR_HOME
    process.env.HOPPR_HOME = home
    try {
      const { createHopper } = await import('../src/store/registry.ts')
      const { initStore } = await import('../src/store/init.ts')
      const { Hoppr } = await import('../src/core/hoppr.ts')

      const info = await createHopper({ name: 'ref', source: `dir:${dir}` })
      const h = await Hoppr.open({ root: info.root })
      await initStore(h.layout.root, h.config)
      await h.sync({})

      const count = async () =>
        (await h.db()).prepare<{ n: number }>('SELECT count(*) n FROM raw').get()?.n ?? 0
      expect(await count()).toBe(1)

      // rebuildIndex closes and reopens the database, so a handle captured
      // before it is dead afterwards — ask for it again.
      await h.rebuildIndex({})
      // Reference sources are re-scanned, because for them the filesystem is
      // the durable tier and there is no raw/ to rebuild from.
      await h.sync({})
      const after = await count()
      expect(after).toBe(1)
      h.close()
    } finally {
      if (prev === undefined) delete process.env.HOPPR_HOME
      else process.env.HOPPR_HOME = prev
    }
  })
})
