import { rm, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { defaults } from '../src/config/schema.ts'
import { Hoppr } from '../src/core/hoppr.ts'
import { docId } from '../src/db/docs.ts'
import { openDb } from '../src/db/open.ts'
import { buildPage } from '../src/store/frontmatter.ts'
import { tempStore } from './helpers.ts'

async function hopprAt(root: string): Promise<Hoppr> {
  return new Hoppr({
    layout: new (await import('../src/store/layout.ts')).Layout(root),
    config: defaults(),
    sources: [],
  })
}

/** Write a wiki page the way the curator will in M3, so the index path is real now. */
async function writePage(
  root: string,
  type: string,
  slug: string,
  front: Record<string, unknown>,
  body: string,
) {
  const { Layout } = await import('../src/store/layout.ts')
  const l = new Layout(root)
  const { ensureDir } = await import('../src/store/atomic.ts')
  await ensureDir(l.pageDir(type))
  await writeFile(
    l.pageFile(type, slug),
    buildPage(
      {
        title: slug,
        type,
        sources: [],
        related: [],
        created: '2026-08-17',
        updated: '2026-08-17',
        confidence: 'medium',
        tags: [],
        hoppr: { id: `page-${slug}`, raw_ids: [], pinned: false },
        ...front,
      },
      body,
    ),
  )
}

describe('unified index', () => {
  it('projects every artifact type into docs, so nothing is silently unsearchable', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const h = await hopprAt(layout.root)
      await h.add({ text: 'a raw capture about vector databases' })
      await writePage(
        layout.root,
        'concept',
        'rrf-fusion',
        { title: 'RRF fusion', summary: 'Reciprocal rank fusion.', tags: ['search'] },
        'Blends rankers without score normalization.',
      )
      const db = await h.db()
      // Table rows and skills have no writers until M6/M8; project them directly
      // so the invariant is asserted for all four kinds from the start.
      db.prepare(
        `INSERT INTO docs(id,tier,kind,ref_id,title,summary,body,tags_text,created,updated,content_hash)
         VALUES ('row:meetings/a','curated','table_row','a','meetings 2026-08-14',
                 'attendees: sam; decisions: killed the v2 rewrite','','meetings',1,1,'h1'),
                ('skill:debug-flaky-vitest','curated','skill','debug-flaky-vitest','debug-flaky-vitest',
                 'Diagnose intermittently failing vitest suites.','','testing',1,1,'h2')`,
      ).run()
      await h.reindex({ prune: false })

      const kinds = db
        .prepare<{ kind: string; n: number }>('SELECT kind, COUNT(*) n FROM docs GROUP BY kind')
        .all()
      const byKind = Object.fromEntries(kinds.map((k) => [k.kind, k.n]))
      expect(byKind.text).toBe(1)
      expect(byKind.concept).toBe(1)
      expect(byKind.table_row).toBe(1)
      expect(byKind.skill).toBe(1)

      // The point of one projection: a query matching ONLY a table cell, or
      // ONLY a skill description, still returns it.
      const row = await h.search('killed the v2 rewrite', { scope: 'all' })
      expect(row.hits[0]?.id).toBe('row:meetings/a')

      const skill = await h.search('intermittently failing suites', { scope: 'all' })
      expect(skill.hits[0]?.id).toBe('skill:debug-flaky-vitest')

      h.close()
    } finally {
      await cleanup()
    }
  })

  it('rebuilds from disk to identical results after the index is deleted', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const h = await hopprAt(layout.root)
      for (const t of [
        'Reciprocal rank fusion at k=60 beat weighted score blending',
        'SQLite FTS5 external content needs explicit triggers',
        'Grocery list: oat milk and coffee',
      ]) {
        await h.add({ text: t })
      }
      // Pin `now`: the recency boost is time-dependent by design, so absolute
      // scores drift between two calls. Ranking is the guarantee, not the float.
      const NOW = 1_800_000_000_000
      const before = (await h.search('fusion', { scope: 'all', now: NOW })).hits.map(
        (x) => [x.id, x.score] as const,
      )
      h.close()

      for (const s of ['', '-wal', '-shm']) await rm(`${layout.dbFile}${s}`, { force: true })

      const h2 = await hopprAt(layout.root)
      const stats = await h2.reindex()
      expect(stats.raw.inserted).toBe(3)
      const after = (await h2.search('fusion', { scope: 'all', now: NOW })).hits.map(
        (x) => [x.id, x.score] as const,
      )
      expect(after).toEqual(before)

      // And without pinning, the ranked order must still be identical.
      const order = (await h2.search('fusion', { scope: 'all' })).hits.map((x) => x.id)
      expect(order).toEqual(before.map(([id]) => id))
      h2.close()
    } finally {
      await cleanup()
    }
  })

  it('is hash-gated: a second reindex touches nothing', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const h = await hopprAt(layout.root)
      await h.add({ text: 'one' })
      await h.add({ text: 'two' })
      const second = await h.reindex()
      expect(second.raw.unchanged).toBe(2)
      expect(second.raw.inserted).toBe(0)
      expect(second.raw.updated).toBe(0)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('resolves wikilinks and flags dangling ones as lint material', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      await writePage(
        layout.root,
        'concept',
        'rrf-fusion',
        { title: 'RRF' },
        'See [[bm25]] and [[nonexistent-page]].',
      )
      await writePage(layout.root, 'concept', 'bm25', { title: 'BM25' }, 'A lexical ranker.')

      const h = await hopprAt(layout.root)
      await h.reindex()
      const db = await h.db()
      const links = db
        .prepare<{ to_slug: string; resolved: number }>(
          'SELECT to_slug, resolved FROM wiki_links ORDER BY to_slug',
        )
        .all()
      expect(links).toEqual([
        { to_slug: 'bm25', resolved: 1 },
        { to_slug: 'nonexistent-page', resolved: 0 },
      ])
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('prunes docs whose backing file is gone', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      await writePage(layout.root, 'concept', 'temporary', { title: 'Temp' }, 'body')
      const h = await hopprAt(layout.root)
      await h.reindex()
      expect((await h.db()).prepare<{ n: number }>('SELECT COUNT(*) n FROM docs').get()?.n).toBe(1)

      await rm(layout.pageFile('concept', 'temporary'))
      const st = await h.reindex()
      expect(st.pruned).toBe(1)
      expect((await h.db()).prepare<{ n: number }>('SELECT COUNT(*) n FROM docs').get()?.n).toBe(0)
      h.close()
    } finally {
      await cleanup()
    }
  })
})

describe('driver parity', () => {
  it('both drivers produce the same schema and the same search results', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const results: Record<string, unknown[]> = {}
      for (const driver of ['better-sqlite3', 'node-sqlite'] as const) {
        const path = `${layout.dbFile}.${driver}`
        const { db } = await openDb(path, { driver })
        const cfg = defaults()

        db.prepare(
          `INSERT INTO docs(id,tier,kind,ref_id,title,summary,body,tags_text,created,updated,content_hash)
           VALUES (:id,'curated','concept','x',:t,:s,:b,'search',1,1,'h')`,
        ).run({
          id: docId.wiki('concept', 'rrf'),
          t: 'RRF fusion',
          s: 'Reciprocal rank fusion at k=60.',
          b: 'Blends a lexical ranker with a vector ranker.',
        })

        const tables = db
          .prepare<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
          )
          .all()
          .map((r) => r.name)
        const { search } = await import('../src/search/index.ts')
        results[driver] = [
          tables,
          search(db, cfg, 'fusion ranker', { scope: 'all' }).hits.map((h) => h.id),
        ]
        db.close()
        for (const s of ['', '-wal', '-shm']) await rm(`${path}${s}`, { force: true })
      }
      expect(results['node-sqlite']).toEqual(results['better-sqlite3'])
    } finally {
      await cleanup()
    }
  })
})

describe('read-only opening', () => {
  /**
   * The opencode connector is a guest in another application's live database.
   * Regression test for two bugs found together: better-sqlite3 does not parse
   * `file:…?mode=ro` URIs (so the URI form silently fell through to the other
   * driver), and esbuild rewrote `node:sqlite` to a bare `sqlite` import in the
   * bundle — which broke the fallback in the BUILT artifact while it kept
   * working from source.
   */
  it('refuses writes, on both drivers', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const path = `${layout.dbFile}.ro`
      const { db } = await openDb(path)
      db.prepare(
        `INSERT INTO raw(id,path,kind,source,media_type,bytes,content_hash,created,captured)
         VALUES ('R','p','text','cli','text/plain',1,'h',1,1)`,
      ).run()
      db.close()

      const { openDriver } = await import('../src/db/driver.ts')
      for (const driver of ['better-sqlite3', 'node-sqlite'] as const) {
        const ro = await openDriver(path, driver, { readonly: true })
        expect(ro.prepare<{ n: number }>('SELECT COUNT(*) n FROM raw').get()?.n).toBe(1)
        expect(() => ro.exec('CREATE TABLE intruder (a)')).toThrow(/readonly|read-only/i)
        ro.close()
      }
      for (const s of ['', '-wal', '-shm']) await rm(`${path}${s}`, { force: true })
    } finally {
      await cleanup()
    }
  })
})

describe('migrations', () => {
  it('are idempotent across reopens', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const path = `${layout.dbFile}.mig`
      const a = await openDb(path)
      const n1 = a.db.prepare<{ n: number }>('SELECT COUNT(*) n FROM schema_migrations').get()?.n
      a.db.close()
      const b = await openDb(path)
      const n2 = b.db.prepare<{ n: number }>('SELECT COUNT(*) n FROM schema_migrations').get()?.n
      expect(n2).toBe(n1)
      b.db.close()
      for (const s of ['', '-wal', '-shm']) await rm(`${path}${s}`, { force: true })
    } finally {
      await cleanup()
    }
  })
})
