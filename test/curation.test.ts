import { describe, expect, it } from 'vitest'
import {
  buildsPage,
  curationFor,
  defaultPreset,
  embeddingsEnabled,
  PRESETS,
  presetFor,
} from '../src/core/profiles.ts'

describe('curation presets', () => {
  it('mines skills only where there are procedures to mine', () => {
    // A folder of papers has no workflow in it; mining one would invent a
    // procedure from prose, which is worse than mining nothing.
    expect(PRESETS.agents!.skills).toBe(true)
    expect(PRESETS.papers!.skills).toBe(false)
    expect(PRESETS.notes!.skills).toBe(false)
  })

  it('only advertises page types hoppr can actually build', () => {
    // entity / comparison / digest are specified but not implemented. A preset
    // that lists them promises pages that never appear.
    const implemented = new Set(['source', 'concept'])
    for (const [name, p] of Object.entries(PRESETS)) {
      for (const t of p.pageTypes) {
        expect(implemented.has(t), `${name} claims unimplemented page type '${t}'`).toBe(true)
      }
    }
  })

  it('gates page building on the preset', () => {
    expect(buildsPage({ hopper: { curation: 'notes', profile: 'folder' } }, 'concept')).toBe(true)
    expect(buildsPage({ hopper: { curation: 'papers', profile: 'folder' } }, 'concept')).toBe(false)
    expect(buildsPage({ hopper: { curation: 'minimal', profile: 'folder' } }, 'source')).toBe(false)
  })

  it('needs both a willing preset and a real provider for vectors', () => {
    const base = { hopper: { curation: 'notes', profile: 'folder' as const } }
    expect(embeddingsEnabled({ ...base, embed: { provider: 'local' } })).toBe(true)
    expect(embeddingsEnabled({ ...base, embed: { provider: 'none' } })).toBe(false)
    expect(
      embeddingsEnabled({
        hopper: { curation: 'minimal', profile: 'folder' },
        embed: { provider: 'local' },
      }),
    ).toBe(false)
  })

  it('makes index-only genuinely free of model calls', () => {
    expect(PRESETS['index-only']!.sourcePages).toBe(false)
    expect(PRESETS['index-only']!.pageTypes).toEqual([])
    expect(PRESETS['index-only']!.embeddings).toBe(true)
    expect(PRESETS.minimal!.embeddings).toBe(false)
  })

  it('falls back to the profile default rather than throwing on a typo', () => {
    // A misspelt preset in a config file must not make the store unopenable.
    expect(presetFor('notez', 'agents')).toBe(PRESETS.agents)
    expect(presetFor(undefined, 'folder')).toBe(PRESETS.notes)
    expect(defaultPreset('agents')).toBe('agents')
  })

  it('reads the preset off a config object', () => {
    expect(curationFor({ hopper: { curation: 'papers', profile: 'folder' } })).toBe(PRESETS.papers)
    expect(curationFor({ hopper: { profile: 'agents' } })).toBe(PRESETS.agents)
  })
})

describe('config surface', () => {
  it('ships a default config that validates against the schema', async () => {
    // The ejected TOML is what people read to learn what is configurable. It
    // had drifted: documenting `[store] scope`, removed sessions earlier, and
    // none of the retrieval or graph sections that actually exist.
    const { parse } = await import('smol-toml')
    const { readFile } = await import('node:fs/promises')
    const { ConfigSchema } = await import('../src/config/schema.ts')
    const raw = parse(await readFile('assets/hoppr.default.toml', 'utf8'))
    expect(ConfigSchema.safeParse(raw).success).toBe(true)
  })

  it('documents every top-level section the schema defines', async () => {
    const { readFile } = await import('node:fs/promises')
    const { defaults } = await import('../src/config/schema.ts')
    const toml = await readFile('assets/hoppr.default.toml', 'utf8')
    // `schema`, `connectors` and `integrations` are user-defined tables with
    // nothing meaningful to show as a default.
    const skip = new Set(['schema', 'connectors', 'integrations', 'views', 'index'])
    for (const section of Object.keys(defaults())) {
      if (skip.has(section)) continue
      // `[tables]` is a record of named tables, so it only ever appears in the
      // dotted form `[tables.tags]`. Accept either.
      const present = toml.includes(`[${section}]`) || toml.includes(`[${section}.`)
      expect(present, `[${section}] missing from the shipped config`).toBe(true)
    }
  })
})

describe('rerank methods', () => {
  it('ranks bm25 correctly under weighted fusion, where lower is better', async () => {
    const { fuse } = await import('../src/search/fuse.ts')
    // bm25 returns unbounded NEGATIVES and cosine returns distances: both are
    // better when lower. A naive min-max normalisation ranks the corpus
    // backwards, and rank-based fusion never has to know that.
    const arms = [
      {
        name: 'fts',
        weight: 1,
        lowerIsBetter: true,
        candidates: [
          { docId: 'best', rowid: 1, score: -9 },
          { docId: 'worst', rowid: 2, score: -1 },
        ],
      },
    ]
    expect(fuse(arms, 'weighted')[0]!.docId).toBe('best')
    expect(fuse(arms, 'rrf')[0]!.docId).toBe('best')
    expect(fuse(arms, 'none')[0]!.docId).toBe('best')
  })

  it('none takes the first non-empty arm and preserves its order', async () => {
    const { fuse } = await import('../src/search/fuse.ts')
    const arms = [
      { name: 'fts', weight: 1, candidates: [] },
      {
        name: 'vec',
        weight: 1,
        candidates: [
          { docId: 'a', rowid: 1, score: 0.1 },
          { docId: 'b', rowid: 2, score: 0.2 },
        ],
      },
    ]
    expect(fuse(arms, 'none').map((h) => h.docId)).toEqual(['a', 'b'])
  })
})

describe('seed skills', () => {
  it('ships the two that mining cannot discover', async () => {
    const { listAssets } = await import('../src/core/assets.ts')
    // Mining finds what you do OFTEN. It cannot find what you never wrote
    // down, and in week one it has nothing to cluster at all.
    expect((await listAssets('skills')).sort()).toEqual(['comms-preferences', 'working-agreements'])
  })
})
