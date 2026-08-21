import { describe, expect, it } from 'vitest'
import { defaults } from '../src/config/schema.ts'
import type { Db } from '../src/db/driver.ts'
import { openDb } from '../src/db/open.ts'
import { chunkDocument, splitByHeading, splitToSize } from '../src/search/chunk.ts'
import { applyBoosts, rrf } from '../src/search/fuse.ts'
import { search } from '../src/search/index.ts'
import { parseQuery, parseWhen, toMatchExpression } from '../src/search/query.ts'
import { snippetFor } from '../src/search/snippet.ts'

const NOW = 1_800_000_000_000

async function seeded(): Promise<Db> {
  const { db } = await openDb(':memory:', { vector: false })
  const ins = db.prepare(
    `INSERT INTO docs(id,tier,kind,ref_id,title,summary,body,tags_text,project,confidence,created,updated,content_hash)
     VALUES (:id,:tier,:kind,:ref,:title,:summary,:body,:tags,:project,:conf,:created,:created,:id)`,
  )
  const day = 86_400_000
  ins.run({
    id: 'raw:R1',
    tier: 'raw',
    kind: 'session',
    ref: 'R1',
    title: 'debugging session',
    summary: '',
    body: 'We tried weighted score blending for hybrid retrieval and it needed constant recalibration.',
    tags: 'search',
    project: 'hoppr',
    conf: 'medium',
    created: NOW - 2 * day,
  })
  ins.run({
    id: 'wiki:concept/rrf-fusion',
    tier: 'curated',
    kind: 'concept',
    ref: 'P1',
    title: 'RRF fusion',
    summary: 'Reciprocal rank fusion needs no score normalization.',
    body: 'Rank position is comparable across arms by construction.',
    tags: 'search ranking',
    project: 'hoppr',
    conf: 'high',
    created: NOW - 2 * day,
  })
  ins.run({
    id: 'wiki:source/grocery',
    tier: 'curated',
    kind: 'source',
    ref: 'P2',
    title: 'Grocery list',
    summary: 'Oat milk and coffee.',
    body: 'Nothing to do with retrieval.',
    tags: 'errands',
    project: 'life',
    conf: 'low',
    created: NOW - 30 * day,
  })
  db.prepare(
    'INSERT INTO wiki(id,path,slug,page_type,title,body,created,updated) VALUES (:i,:p,:s,:t,:ti,:b,:c,:c)',
  ).run({
    i: 'P1',
    p: 'curated/wiki/concepts/rrf-fusion.md',
    s: 'rrf-fusion',
    t: 'concept',
    ti: 'RRF fusion',
    b: '',
    c: NOW,
  })
  return db
}

describe('query parsing', () => {
  it('strips inline filters and keeps the free text', () => {
    const q = parseQuery('rrf fusion tag:search -tag:draft project:hoppr kind:concept since:7d')
    expect(q.text).toBe('rrf fusion')
    expect(q.filters.tags).toEqual(['search'])
    expect(q.filters.notTags).toEqual(['draft'])
    expect(q.filters.project).toBe('hoppr')
    expect(q.filters.kinds).toEqual(['concept'])
    expect(q.filters.since).toBeGreaterThan(0)
  })

  it('accepts comma lists and quoted values', () => {
    const q = parseQuery('kind:concept,entity project:"my project"')
    expect(q.filters.kinds).toEqual(['concept', 'entity'])
    expect(q.filters.project).toBe('my project')
  })

  it('treats an all-filters query as a pure listing', () => {
    expect(parseQuery('tag:search').text).toBe('')
  })

  it('reads relative and absolute times', () => {
    expect(parseWhen('7d')).toBeLessThan(Date.now())
    expect(parseWhen('2026-07-01')).toBe(Date.parse('2026-07-01'))
    expect(parseWhen('nonsense')).toBeUndefined()
    // A bare date as an upper bound must include that whole day.
    expect(parseWhen('2026-07-01', 'until')).toBeGreaterThan(Date.parse('2026-07-01'))
  })

  it('quotes terms so punctuation cannot become FTS5 syntax', () => {
    expect(toMatchExpression("what's this?")).toBe('"what\'s" OR "this?"')
    expect(toMatchExpression('foo-bar')).toBe('"foo-bar"')
    expect(toMatchExpression('pre*')).toBe('"pre"*')
    expect(toMatchExpression('   ')).toBe('')
  })

  it('does not throw on input that would be malformed FTS5', async () => {
    const db = await seeded()
    for (const q of ['AND', '"', 'a OR', '((', 'NEAR/', '*']) {
      expect(() => search(db, defaults(), q, { scope: 'all' })).not.toThrow()
    }
    db.close()
  })
})

describe('ranking', () => {
  it('RRF needs no score normalization between arms', () => {
    const fused = rrf([
      {
        name: 'fts',
        weight: 1,
        candidates: [
          { docId: 'a', rowid: 1, score: -9.2 },
          { docId: 'b', rowid: 2, score: -1.1 },
        ],
      },
      {
        name: 'vec',
        weight: 1,
        candidates: [
          { docId: 'c', rowid: 3, score: 0.12 },
          { docId: 'b', rowid: 2, score: 0.44 },
        ],
      },
    ])
    // 'b' places in both arms and wins despite being second in each.
    expect(fused[0]!.docId).toBe('b')
    expect(fused[0]!.ranks).toEqual({ fts: 2, vec: 2 })
  })

  it('boosts curated over raw, and high confidence over low', () => {
    const cfg = {
      tier: { curated: 1.5 },
      kind: { concept: 1.2 },
      confidence: { high: 1.15, medium: 1.0, low: 0.8 },
      recencyHalfLifeDays: 180,
      now: NOW,
    }
    const base = 0.01
    const curated = applyBoosts(
      base,
      { tier: 'curated', kind: 'concept', confidence: 'high', created: NOW },
      cfg,
    )
    const raw = applyBoosts(
      base,
      { tier: 'raw', kind: 'session', confidence: 'medium', created: NOW },
      cfg,
    )
    expect(curated).toBeGreaterThan(raw)
  })

  it('decays old content gently rather than eliminating it', () => {
    const cfg = { tier: {}, kind: {}, confidence: {}, recencyHalfLifeDays: 180, now: NOW }
    const fresh = applyBoosts(
      1,
      { tier: 'raw', kind: 'x', confidence: 'medium', created: NOW },
      cfg,
    )
    const ancient = applyBoosts(
      1,
      { tier: 'raw', kind: 'x', confidence: 'medium', created: NOW - 5 * 365 * 86_400_000 },
      cfg,
    )
    expect(ancient).toBeLessThan(fresh)
    // A five-year-old note that is the only answer must still be findable.
    expect(ancient).toBeGreaterThan(0.5)
  })

  it('a curated page outranks the raw capture it was distilled from', async () => {
    const db = await seeded()
    const res = search(db, defaults(), 'retrieval blending fusion', { scope: 'all', now: NOW })
    expect(res.hits[0]!.id).toBe('wiki:concept/rrf-fusion')
    db.close()
  })
})

describe('filters', () => {
  it('apply inside the arm, before ranking', async () => {
    const db = await seeded()
    const cfg = defaults()
    const all = search(db, cfg, 'retrieval OR recalibration OR fusion', { scope: 'all', now: NOW })
    expect(all.hits.length).toBeGreaterThan(1)

    const filtered = search(db, cfg, 'retrieval recalibration fusion project:life', {
      scope: 'all',
      now: NOW,
    })
    for (const h of filtered.hits) expect(h.project).toBe('life')
    db.close()
  })

  it('scope narrows to a tier', async () => {
    const db = await seeded()
    const raw = search(db, defaults(), 'blending', { scope: 'raw', now: NOW })
    expect(raw.hits.every((h) => h.tier === 'raw')).toBe(true)
    const curated = search(db, defaults(), 'blending', { scope: 'curated', now: NOW })
    expect(curated.hits.every((h) => h.tier === 'curated')).toBe(true)
    db.close()
  })

  it('negated tags exclude', async () => {
    const db = await seeded()
    const res = search(db, defaults(), 'tag:search -tag:ranking', { scope: 'all', now: NOW })
    expect(res.hits.map((h) => h.id)).toEqual(['raw:R1'])
    db.close()
  })
})

describe('collapse', () => {
  it('folds a raw hit into the curated page that cites it, keeping a pointer back', async () => {
    const db = await seeded()
    db.prepare('INSERT INTO wiki_sources(page_id, raw_id) VALUES (:p,:r)').run({ p: 'P1', r: 'R1' })

    const res = search(db, defaults(), 'blending fusion retrieval', { scope: 'all', now: NOW })
    const ids = res.hits.map((h) => h.id)
    expect(ids).toContain('wiki:concept/rrf-fusion')
    // The transcript does not appear as a second, competing result …
    expect(ids).not.toContain('raw:R1')
    // … but drilling down to it is still one hop away.
    expect(res.hits.find((h) => h.id === 'wiki:concept/rrf-fusion')?.matchedInSource).toBe('R1')
    db.close()
  })
})

describe('chunking', () => {
  it('makes chunk 0 the card, so short keyword queries hit the distillation', () => {
    const chunks = chunkDocument('RRF fusion\nReciprocal rank fusion.\nsearch ranking', 'body text')
    expect(chunks[0]!.ord).toBe(0)
    expect(chunks[0]!.text).toContain('RRF fusion')
  })

  it('splits on headings but never inside a fenced code block', () => {
    const md = '# One\ntext\n\n```\n# not a heading\n```\n\n# Two\nmore'
    const secs = splitByHeading(md)
    expect(secs.map((s) => s.heading)).toEqual(['One', 'Two'])
    expect(secs[0]!.text).toContain('# not a heading')
  })

  it('overlaps windows so a fact spanning a boundary stays retrievable', () => {
    const text = Array.from({ length: 40 }, (_, i) => `paragraph ${i} with some filler words`).join(
      '\n\n',
    )
    const parts = splitToSize(text, 300, 80)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(320)
  })

  it('hard-splits a single paragraph longer than the window', () => {
    const parts = splitToSize('x'.repeat(5000), 1000, 100)
    expect(parts.length).toBeGreaterThan(4)
  })
})

describe('snippets', () => {
  it('centres on the densest cluster of query terms', () => {
    const body = `${'filler '.repeat(200)}the answer is reciprocal rank fusion${' filler'.repeat(200)}`
    expect(snippetFor(body, 'reciprocal fusion', 120)).toContain('reciprocal rank fusion')
  })
  it('returns short bodies whole, with no ellipsis', () => {
    expect(snippetFor('short body', 'body', 400)).toBe('short body')
  })
  it('strips code fences rather than emitting a wall of them', () => {
    expect(snippetFor('before\n```\nlots of code\n```\nafter', 'before', 400)).toContain('[code]')
  })
})

describe('readable results', () => {
  it('decodes escaped JSON so a .jsonl snippet can be skimmed', async () => {
    const { unescapeJsonish } = await import('../src/search/snippet.ts')
    // A transcript surfaced as `\\u201cTypes of ML Papers\\u201d` — the file's
    // contents, and unreadable as a search result.
    const raw = String.raw`go_back()\\nThought: We\\u2019re back. The \\u201cTypes\\u201d link`
    const out = unescapeJsonish(raw)
    expect(out).toContain('We’re back')
    expect(out).toContain('“Types”')
    expect(out).not.toContain('\\u')
  })

  it('leaves ordinary prose untouched', async () => {
    const { unescapeJsonish } = await import('../src/search/snippet.ts')
    const prose = 'RRF with k=60 beat weighted blending; see the "ranking" note.'
    expect(unescapeJsonish(prose)).toBe(prose)
  })

  it('disambiguates a filename that repeats across a tree', async () => {
    const { titleFor } = await import('../src/connectors/dir.ts')
    // A benchmark run leaves dozens of transcript.jsonl, and eight results all
    // called "transcript" have told you nothing.
    expect(
      titleFor(
        '/x/r21/baseline-skill/00aa905a/transcript.jsonl',
        'r21/baseline-skill/00aa905a/transcript.jsonl',
      ),
    ).toBe('transcript — baseline-skill/00aa905a')
    // A distinctive name is left alone.
    expect(titleFor('/x/attention-is-all-you-need.pdf', 'attention-is-all-you-need.pdf')).toBe(
      'attention-is-all-you-need',
    )
  })
})
