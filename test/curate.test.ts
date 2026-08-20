import { readFile, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defaults } from '../src/config/schema.ts'
import { Hoppr } from '../src/core/hoppr.ts'
import { extractJson, parseJsonWithRepair } from '../src/llm/json.ts'
import type { JsonOptions, LlmProvider } from '../src/llm/provider.ts'
import { fastPass } from '../src/organize/fast.ts'
import { listPasses, undoPass } from '../src/organize/journal.ts'
import {
  editDistance,
  nearestKnown,
  normalizeTags,
  renderVocabulary,
  type Taxonomy,
  type TaxonomyRules,
} from '../src/organize/taxonomy.ts'
import { Layout } from '../src/store/layout.ts'
import { clip, render } from '../src/store/prompts.ts'
import { readPage } from '../src/store/wiki.ts'
import { tempStore } from './helpers.ts'

const RULES: TaxonomyRules = {
  vocabularySize: 150,
  maxNewTagsPerItem: 2,
  maxTagsPerItem: 7,
  pinned: ['work'],
  stoplist: ['misc', 'stuff'],
  bootstrapFloor: 0, // enforce caps strictly in tests
}

function tax(
  tags: Record<string, { count: number; merged_into?: string; pinned?: boolean }>,
): Taxonomy {
  return { version: 1, tags }
}

/** Scripted provider: no network, no model, fully deterministic. */
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
    if (raw instanceof Error) throw raw
    return {
      value: o.schema.parse(raw),
      usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.001 },
    }
  }
}

function pageResponse(id: string, over: Record<string, unknown> = {}) {
  return {
    pages: [
      {
        id,
        title: 'RRF beats weighted blending',
        summary: 'Rank fusion needs no score calibration.',
        body: 'Because bm25 and cosine live on different scales.',
        tags: ['search'],
        new_tags: [],
        entities: ['SQLite'],
        confidence: 'high',
        fields: {},
        ...over,
      },
    ],
  }
}

async function storeWith(text: string) {
  const t = await tempStore()
  const h = new Hoppr({ layout: new Layout(t.layout.root), config: defaults(), sources: [] })
  const rec = await h.add({ text })
  return { ...t, h, rec }
}

describe('json extraction', () => {
  it('strips code fences, which models emit even when told not to', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}')
  })
  it('finds the object inside surrounding prose', () => {
    expect(extractJson('Here is the JSON:\n{"a":1}\nHope that helps!')).toBe('{"a":1}')
  })
  it('handles braces inside strings without truncating', () => {
    expect(extractJson('{"a":"a } brace","b":2}')).toBe('{"a":"a } brace","b":2}')
  })
  it('handles arrays', () => {
    expect(extractJson('prefix [1,2,3] suffix')).toBe('[1,2,3]')
  })

  it('repairs exactly once, then gives up terminally', async () => {
    const schema = z.object({ n: z.number() })
    let attempts = 0
    const ok = await parseJsonWithRepair('{"n":"x"}', schema, {
      retry: async () => {
        attempts++
        return '{"n": 5}'
      },
    })
    expect(ok.n).toBe(5)
    expect(attempts).toBe(1)

    // Second failure must be terminal, not another retry: more attempts spend
    // tokens without converging, and the caller needs to move on.
    let tries = 0
    await expect(
      parseJsonWithRepair('nope', schema, {
        retry: async () => {
          tries++
          return 'still nope'
        },
      }),
    ).rejects.toThrow(/after one repair/)
    expect(tries).toBe(1)
  })
})

describe('taxonomy convergence', () => {
  it('reuses an existing tag rather than coining a near-duplicate', () => {
    const r = normalizeTags(['ai-agent'], [], tax({ 'ai-agents': { count: 12 } }), RULES)
    expect(r.tags).toEqual(['ai-agents'])
    expect(r.coined).toEqual([])
  })

  it('folds plural and hyphen variants onto one tag', () => {
    expect(nearestKnown('agentic-ai', ['agentic-ai'])).toBe('agentic-ai')
    expect(nearestKnown('hybrid-searches', ['hybrid-search'])).toBe('hybrid-search')
    expect(editDistance('kitten', 'sitting')).toBe(3)
  })

  it('follows an alias to its canonical tag', () => {
    const r = normalizeTags(
      ['ai-agents'],
      [],
      tax({ 'ai-agents': { count: 3, merged_into: 'agentic-ai' }, 'agentic-ai': { count: 30 } }),
      RULES,
    )
    expect(r.tags).toEqual(['agentic-ai'])
  })

  it('rejects stoplist tags', () => {
    const r = normalizeTags(['misc', 'search'], [], tax({ search: { count: 4 } }), RULES)
    expect(r.tags).toEqual(['search'])
    expect(r.rejected[0]).toMatchObject({ tag: 'misc', reason: 'stoplist' })
  })

  it('caps coinage even when the model hides inventions in the existing-tags list', () => {
    // The bypass this closes: without counting these, a model could put every
    // invention in `tags` and the cap would never bind.
    const r = normalizeTags(
      ['brand-new-one', 'brand-new-two', 'brand-new-three'],
      [],
      tax({}),
      RULES,
    )
    expect(r.coined).toHaveLength(2)
    expect(r.rejected.some((x) => x.reason === 'over max_new_tags_per_item')).toBe(true)
  })

  it('lifts the cap while the vocabulary is still forming', () => {
    const r = normalizeTags(['a-tag', 'b-tag', 'c-tag', 'd-tag'], [], tax({}), {
      ...RULES,
      bootstrapFloor: 20,
    })
    expect(r.coined).toHaveLength(4)
  })

  it('caps total tags per page', () => {
    const many = Array.from({ length: 20 }, (_, i) => `tag-${i}`)
    const r = normalizeTags(
      many,
      [],
      tax(Object.fromEntries(many.map((t) => [t, { count: 1 }]))),
      RULES,
    )
    expect(r.tags).toHaveLength(7)
  })

  it('shows retired tags in the prompt so the model stops using them', () => {
    const v = renderVocabulary(
      tax({ 'agentic-ai': { count: 9 }, 'ai-agents': { count: 2, merged_into: 'agentic-ai' } }),
      50,
    )
    expect(v).toContain('agentic-ai (9)')
    expect(v).toContain('ai-agents → agentic-ai')
  })
})

describe('prompt templating', () => {
  it('substitutes and leaves unknown placeholders visible rather than blank', () => {
    expect(render('a {{x}} b {{y}}', { x: 1 })).toBe('a 1 b {{y}}')
  })
  it('clips from head AND tail, so a transcript keeps its setup and conclusion', () => {
    const long = `START${'x'.repeat(5000)}END`
    const c = clip(long, 200)
    expect(c.startsWith('START')).toBe(true)
    expect(c.endsWith('END')).toBe(true)
    expect(c).toContain('elided')
  })
})

describe('fast pass', () => {
  it('writes a source page, links it to its capture, and clears staleness', async () => {
    const { layout, h, rec, cleanup } = await storeWith('RRF at k=60 beat weighted blending')
    try {
      const db = await h.db()
      const llm = new MockLlm([pageResponse(rec.id)])
      const st = await fastPass(db, layout, defaults(), llm)

      expect(st.written).toBe(1)
      expect(st.failed).toBe(0)

      const pages = await import('../src/store/wiki.ts').then((m) => m.listPages(layout, 'source'))
      expect(pages).toHaveLength(1)
      expect(pages[0]!.sources[0]).toBe(rec.path)
      expect(pages[0]!.rawIds).toEqual([rec.id])

      // The capture is no longer claimable, so a second pass is a no-op.
      const again = await fastPass(db, layout, defaults(), llm)
      expect(again.claimed).toBe(0)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('records entities as a field, not as links to pages that do not exist', async () => {
    const { layout, h, rec, cleanup } = await storeWith('a capture mentioning SQLite')
    try {
      const db = await h.db()
      await fastPass(db, layout, defaults(), new MockLlm([pageResponse(rec.id)]))
      const pages = await import('../src/store/wiki.ts').then((m) => m.listPages(layout, 'source'))
      // A [[link]] to a page that is never built dangles forever and buries
      // the real lint findings.
      expect(pages[0]!.related).toEqual([])
      expect(pages[0]!.fields.entities).toEqual(['SQLite'])
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('never overwrites a page a human has pinned', async () => {
    const { layout, h, rec, cleanup } = await storeWith('some capture worth keeping')
    try {
      const db = await h.db()
      await fastPass(db, layout, defaults(), new MockLlm([pageResponse(rec.id)]))
      const pages = await import('../src/store/wiki.ts').then((m) => m.listPages(layout, 'source'))
      const slug = pages[0]!.slug
      const path = layout.pageFile('source', slug)

      const original = await readFile(path, 'utf8')
      const mine = original
        .replace('pinned: false', 'pinned: true')
        .replace(/\n\n[\s\S]*$/, '\n\nMy own words, which the curator must not touch.\n')
      await writeFile(path, mine)

      db.prepare('UPDATE raw SET curate_stale = 1').run()
      const st = await fastPass(
        db,
        layout,
        defaults(),
        new MockLlm([pageResponse(rec.id, { body: 'REWRITTEN' })]),
      )

      expect(st.skippedPinned).toBe(1)
      expect(st.written).toBe(0)
      const after = await readFile(path, 'utf8')
      expect(after).toContain('My own words')
      expect(after).not.toContain('REWRITTEN')
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('keeps one page per capture even when the model retitles', async () => {
    const { layout, h, rec, cleanup } = await storeWith('a capture that will be retitled')
    try {
      const db = await h.db()
      const wiki = await import('../src/store/wiki.ts')

      await fastPass(db, layout, defaults(), new MockLlm([pageResponse(rec.id)]))
      expect(await wiki.listPages(layout, 'source')).toHaveLength(1)

      // The slug comes from the model's title, and models retitle freely.
      // Keying the lookup on the slug produced a SECOND page for one capture.
      db.prepare('UPDATE raw SET curate_stale = 1').run()
      await fastPass(
        db,
        layout,
        defaults(),
        new MockLlm([pageResponse(rec.id, { title: 'A completely different title' })]),
      )
      const pages = await wiki.listPages(layout, 'source')
      expect(pages).toHaveLength(1)
      expect(pages[0]!.title).toBe('A completely different title')
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('respects a pin even after the model retitles the page', async () => {
    const { layout, h, rec, cleanup } = await storeWith('a capture worth pinning')
    try {
      const db = await h.db()
      const wiki = await import('../src/store/wiki.ts')
      await fastPass(db, layout, defaults(), new MockLlm([pageResponse(rec.id)]))
      const [page] = await wiki.listPages(layout, 'source')
      const path = layout.pageFile('source', page!.slug)

      const mine = (await readFile(path, 'utf8'))
        .replace('pinned: false', 'pinned: true')
        .replace(/\n\n[\s\S]*$/, '\n\nMy own words.\n')
      await writeFile(path, mine)

      // A pin lives at the OLD slug; the check must find it by capture id.
      db.prepare('UPDATE raw SET curate_stale = 1').run()
      const st = await fastPass(
        db,
        layout,
        defaults(),
        new MockLlm([pageResponse(rec.id, { title: 'Renamed by the model' })]),
      )
      expect(st.skippedPinned).toBe(1)
      expect(await wiki.listPages(layout, 'source')).toHaveLength(1)
      expect(await readFile(path, 'utf8')).toContain('My own words')
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('fails terminally per capture: one bad row cannot wedge the pass', async () => {
    const { layout, h, cleanup } = await storeWith('first')
    try {
      await h.add({ text: 'second' })
      const db = await h.db()
      // The model returns a page for neither capture — both must be counted,
      // or they would be re-claimed forever.
      const llm = new MockLlm([{ pages: [] }])
      for (let i = 0; i < 3; i++) await fastPass(db, layout, defaults(), llm)

      const stuck = db
        .prepare<{ n: number }>('SELECT COUNT(*) n FROM raw WHERE curate_fails >= 3')
        .get()?.n
      expect(stuck).toBe(2)
      const claimable = db
        .prepare<{ n: number }>(
          'SELECT COUNT(*) n FROM raw WHERE curate_stale = 1 AND curate_fails < 3',
        )
        .get()?.n
      expect(claimable).toBe(0) // the sweep terminates instead of looping
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('records enough to reverse itself, and undo restores the store', async () => {
    const { layout, h, rec, cleanup } = await storeWith('reversible capture')
    try {
      const db = await h.db()
      const st = await fastPass(db, layout, defaults(), new MockLlm([pageResponse(rec.id)]))
      const pages = await import('../src/store/wiki.ts').then((m) => m.listPages(layout, 'source'))
      expect(pages).toHaveLength(1)

      const passes = listPasses(db)
      expect(passes[0]!.passId).toBe(st.passId)

      await undoPass(db, layout, st.passId)
      const after = await import('../src/store/wiki.ts').then((m) => m.listPages(layout, 'source'))
      expect(after).toHaveLength(0)

      // And raw/ is untouched by an undo, because the journal cannot contain it.
      expect(await readFile(layout.abs(rec.path), 'utf8')).toContain('reversible capture')
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('refuses to run once the daily budget is spent', async () => {
    const { layout, h, rec, cleanup } = await storeWith('expensive capture')
    try {
      const db = await h.db()
      db.prepare(
        "INSERT INTO llm_calls(at, provider, purpose, cost_usd, ok) VALUES (:at,'mock','x',99.0,1)",
      ).run({ at: Date.now() })
      await expect(
        fastPass(db, layout, defaults(), new MockLlm([pageResponse(rec.id)])),
      ).rejects.toThrow(/budget/)
      h.close()
    } finally {
      await cleanup()
    }
  })

  it('dry run writes nothing', async () => {
    const { layout, h, rec, cleanup } = await storeWith('dry capture')
    try {
      const db = await h.db()
      const st = await fastPass(db, layout, defaults(), new MockLlm([pageResponse(rec.id)]), {
        dryRun: true,
      })
      expect(st.written).toBe(1)
      const pages = await import('../src/store/wiki.ts').then((m) => m.listPages(layout, 'source'))
      expect(pages).toHaveLength(0)
      h.close()
    } finally {
      await cleanup()
    }
  })
})

describe('prompt staleness', () => {
  it('stamps the prompt hash so an edited prompt can re-stale what it produced', async () => {
    const { layout, h, rec, cleanup } = await storeWith('capture for hashing')
    try {
      const db = await h.db()
      await fastPass(db, layout, defaults(), new MockLlm([pageResponse(rec.id)]))
      const pages = await import('../src/store/wiki.ts').then((m) => m.listPages(layout, 'source'))
      const page = await readPage(layout, 'source', pages[0]!.slug)
      expect(page?.promptHash).toMatch(/^sha256:/)
      expect(page?.sourceHash).toMatch(/^sha256:/)
      h.close()
    } finally {
      await cleanup()
    }
  })
})
