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

describe('shipped examples', () => {
  it('every example config parses and validates', async () => {
    // Examples that do not load are worse than no examples: someone copies one
    // and gets a config error on a tool they have used for five minutes.
    const { parse } = await import('smol-toml')
    const { readFile, readdir } = await import('node:fs/promises')
    const { ConfigSchema } = await import('../src/config/schema.ts')
    const base = 'docs/examples'
    let checked = 0
    for (const dir of await readdir(base, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      for (const f of await readdir(`${base}/${dir.name}`)) {
        if (!f.endsWith('hoppr.toml')) continue
        const raw = parse(await readFile(`${base}/${dir.name}/${f}`, 'utf8'))
        const r = ConfigSchema.safeParse(raw)
        expect(r.success, `${dir.name}/${f}: ${JSON.stringify(r.error?.issues?.[0])}`).toBe(true)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(3)
  })

  it('every example table definition loads', async () => {
    const { readFile } = await import('node:fs/promises')
    const { parseTableDef } = await import('../src/tables/def.ts')
    const path = 'docs/examples/tables/meetings.table.toml'
    const { def } = parseTableDef(await readFile(path, 'utf8'), path)
    expect(def.name).toBe('meetings')
    // scope:raw, not kind:source — the summary has already dropped the detail.
    expect(def.match).toBe('scope:raw')
    expect(def.columns.outcome?.converging).toBe(true)
  })

  it('the example .hopprignore splits both sections', async () => {
    const { readFile } = await import('node:fs/promises')
    const { parseIgnoreSets, isIgnored } = await import('../src/connectors/ignore.ts')
    const sets = parseIgnoreSets(await readFile('docs/examples/notes-folder/.hopprignore', 'utf8'))
    expect(isIgnored('drafts/x.md', sets.skip)).toBe(true)
    expect(isIgnored('archive/old.md', sets.noCurate)).toBe(true)
    expect(isIgnored('archive/old.md', sets.skip)).toBe(false)
  })
})

describe('schemas in their own files', () => {
  it('a wiki outline in schemas/wiki.toml actually loads', async () => {
    // The example first wrote `[[wiki.outline]]`, which nests to
    // wiki.wiki.outline and is SILENTLY dropped — it validated precisely
    // because zod strips unknown keys. Sections inside a schema file are
    // relative to the section the file names.
    const { parse } = await import('smol-toml')
    const { readFile } = await import('node:fs/promises')
    const { ConfigSchema } = await import('../src/config/schema.ts')
    const raw = parse(await readFile('docs/examples/schemas/wiki.toml', 'utf8'))
    const cfg = ConfigSchema.parse({ wiki: raw })
    expect(cfg.wiki.outline.length).toBeGreaterThanOrEqual(4)
    expect(cfg.wiki.outline.map((o) => o.path)).toContain('overview.md')
    // A trailing slash reserves a folder without dictating its pages.
    expect(cfg.wiki.outline.some((o) => o.path.endsWith('/'))).toBe(true)
    expect(cfg.wiki.orientation).toContain('search team')
  })

  it('a graph schema file carries its prompts', async () => {
    const { parse } = await import('smol-toml')
    const { readFile } = await import('node:fs/promises')
    const { ConfigSchema } = await import('../src/config/schema.ts')
    const raw = parse(await readFile('docs/examples/schemas/graph.toml', 'utf8'))
    const cfg = ConfigSchema.parse({ graph: raw })
    expect(cfg.graph.relations.length).toBeGreaterThanOrEqual(4)
    for (const r of cfg.graph.relations) {
      // A relation with no description is a name the model has to guess at.
      expect(r.description.length, `${r.name} has no description`).toBeGreaterThan(20)
    }
  })
})
