import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { defaults } from '../src/config/schema.ts'
import { add, deriveTitle } from '../src/intake/add.ts'
import { renderClaudeMd } from '../src/store/claudemd.ts'
import { initStore } from '../src/store/init.ts'
import { PAGE_DIRS, storeDirs } from '../src/store/layout.ts'
import * as rawStore from '../src/store/raw.ts'
import { tempStore } from './helpers.ts'

describe('init', () => {
  it('creates the Karpathy wiki skeleton and is idempotent', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      for (const d of storeDirs(layout)) expect(existsSync(d), d).toBe(true)
      for (const dir of Object.values(PAGE_DIRS)) {
        expect(existsSync(layout.pageDir(Object.keys(PAGE_DIRS)[0]!))).toBe(true)
        expect(dir).toMatch(/s$/) // entities, not entitys
      }
      expect(existsSync(layout.wikiIndex)).toBe(true)
      expect(existsSync(layout.wikiLog)).toBe(true)
      expect(existsSync(layout.claudeMd)).toBe(true)
      expect(existsSync(layout.tagsFile)).toBe(true)

      const logBefore = await readFile(layout.wikiLog, 'utf8')
      const r = await initStore(layout.root, defaults())
      expect(r.created).toBe(false)
      // log.md is append-only; re-init must not restamp it
      expect(await readFile(layout.wikiLog, 'utf8')).toBe(logBefore)
    } finally {
      await cleanup()
    }
  })

  it('gitignores exactly the rebuildable tiers', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const gi = await readFile(layout.gitignore, 'utf8')
      // Only `.index/` is rebuildable now. `views/`, `inbox/` and `state/`
      // were listed here while nothing ever wrote to them — the views
      // generator was never built, the daemon's pidfile moved to ~/.hoppr when
      // one process took over every hoppr, and the inbox was a drop zone from
      // before the watched folder existed.
      expect(gi).toContain('.index/')
      expect(gi).toContain('.env')
      for (const gone of ['views/', 'inbox/', 'state/']) expect(gi).not.toContain(gone)
      expect(gi).not.toContain('raw/')
      expect(gi).not.toContain('curated/')
    } finally {
      await cleanup()
    }
  })
})

describe('CLAUDE.md', () => {
  it('documents the one rule and the wiki contract', () => {
    const md = renderClaudeMd(defaults())
    expect(md).toContain('NEVER modify or delete through hoppr')
    expect(md).toContain('curated/wiki/index.md')
    expect(md).toContain('[[wikilinks]]')
    expect(md).toContain('confidence: high')
    expect(md).toContain('### Ingest')
    expect(md).toContain('### Search')
    expect(md).toContain('### Lint')
    expect(md).toContain('kebab-case')
  })

  it('surfaces user-defined schema fields so the agent knows to fill them', () => {
    const cfg = defaults()
    cfg.schema = {
      status: { type: 'enum', values: ['idea', 'active'], description: 'pipeline stage' },
    }
    const md = renderClaudeMd(cfg)
    expect(md).toContain('status: idea')
    expect(md).toContain('pipeline stage')
  })
})

describe('intake', () => {
  it('captures text with a derived title and a provenance sidecar', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const rec = await add(layout, { text: '# RRF notes\n\nk=60 wins.' })
      expect(rec.title).toBe('RRF notes')
      expect(rec.kind).toBe('text')
      expect(rec.source).toBe('cli')
      // Named after the content, with the id kept as a suffix: 9,000 files
      // called 01M0GNYKK3KK…md is a directory you can query but never browse.
      expect(rec.path).toMatch(/^raw\/\d{4}\/\d{2}\/\d{2}\/rrf-notes-[0-9A-Z]{6}\.md$/)

      const back = await rawStore.readMeta(layout, rec.path)
      expect(back.id).toBe(rec.id)
      expect(back.hash).toBe(rec.hash)
      expect(await rawStore.readText(layout, rec)).toBe('# RRF notes\n\nk=60 wins.')
    } finally {
      await cleanup()
    }
  })

  it('resolves a capture by id prefix and rejects an ambiguous one', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const a = await add(layout, { text: 'alpha' })
      expect((await rawStore.resolveId(layout, a.id.slice(0, 14)))?.id).toBe(a.id)
      expect(await rawStore.resolveId(layout, 'ZZZZZZ')).toBeUndefined()
      await add(layout, { text: 'beta' })
      // ULIDs share a timestamp head; a 4-char prefix must be reported ambiguous,
      // never silently resolved to whichever file the glob happened to list first.
      await expect(rawStore.resolveId(layout, a.id.slice(0, 4))).rejects.toThrow(/ambiguous/)
    } finally {
      await cleanup()
    }
  })

  it('captures a url immediately, so a dead network never loses the save', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const rec = await add(layout, { url: 'https://example.com/x' })
      expect(rec.kind).toBe('url')
      expect(rec.external_id).toBe('url:https://example.com/x')
      expect(rec.origin?.fetched).toBe(false)
    } finally {
      await cleanup()
    }
  })

  it('refuses an empty capture rather than writing a blank record', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      await expect(add(layout, { text: '   ' })).rejects.toThrow(/nothing to add/)
    } finally {
      await cleanup()
    }
  })

  it('derives a title from the first meaningful line', () => {
    expect(deriveTitle('\n\n## Heading here\nrest')).toBe('Heading here')
    expect(deriveTitle('- a bullet')).toBe('a bullet')
    expect(deriveTitle('x'.repeat(200)).length).toBeLessThanOrEqual(80)
    expect(deriveTitle('')).toBe('Untitled')
  })
})
