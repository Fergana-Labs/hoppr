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

  it('only advertises page types hoppr can actually build', async () => {
    // entity / comparison / digest are specified but not implemented. A preset
    // that lists them promises pages that never appear.
    const { BUILT_PAGE_TYPES } = await import('../src/store/layout.ts')
    const implemented = new Set<string>(BUILT_PAGE_TYPES)
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

describe('docs stay in step with the code', () => {
  const read = async (f: string) => (await import('node:fs/promises')).readFile(f, 'utf8')
  const DOCS = ['README.md', 'docs/COMMANDS.md', 'docs/FILE-TYPES.md', 'assets/hoppr.default.toml']

  it('documents every config key somewhere', async () => {
    // Docs drift silently and are only noticed by someone following them and
    // finding nothing. Config is the surface where that hurts most.
    const { defaults } = await import('../src/config/schema.ts')
    const all = (await Promise.all(DOCS.map(read))).join('\n')
    const missing: string[] = []
    for (const [section, val] of Object.entries(defaults())) {
      if (!val || typeof val !== 'object' || Array.isArray(val)) continue
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) continue
        if (!all.includes(k)) missing.push(`${section}.${k}`)
      }
    }
    expect(missing, `undocumented: ${missing.join(', ')}`).toEqual([])
  })

  it('has no config key that nothing reads', async () => {
    // The reverse failure: a knob that looks like a feature and does nothing.
    // `wiki.comparison_enabled` configured page types that were never built.
    const { readdir, readFile } = await import('node:fs/promises')
    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = []
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`
        if (e.isDirectory()) out.push(...(await walk(p)))
        else if (e.name.endsWith('.ts') && p !== 'src/config/schema.ts') out.push(p)
      }
      return out
    }
    const src = (await Promise.all((await walk('src')).map((f) => readFile(f, 'utf8')))).join('\n')
    const { defaults } = await import('../src/config/schema.ts')
    // Keys read via a spread or passed whole are exempt; these are the leaf
    // scalars a person would set expecting something to happen.
    const exempt = new Set(['name', 'description', 'model', 'provider', 'host', 'port', 'dim'])
    const dead: string[] = []
    for (const [section, val] of Object.entries(defaults())) {
      if (!val || typeof val !== 'object' || Array.isArray(val)) continue
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) continue
        if (exempt.has(k)) continue
        if (!src.includes(k)) dead.push(`${section}.${k}`)
      }
    }
    expect(dead, `config nothing reads: ${dead.join(', ')}`).toEqual([])
  })
})

describe('no two knobs for one thing', () => {
  it('has exactly one setting for RRF damping', async () => {
    // `search.rrf_k` was documented as "still honoured" and was unreachable:
    // `retrieval.rerank.k` always carries a default, so the `??` beside it
    // never fell through. A setting that does nothing is worse than none,
    // and the existing "config nothing reads" test could not catch it —
    // the key WAS referenced, just never reached.
    const { defaults } = await import('../src/config/schema.ts')
    const cfg = defaults() as Record<string, Record<string, unknown>>
    expect(cfg.search).not.toHaveProperty('rrf_k')
    expect(cfg.retrieval?.rerank).toHaveProperty('k')
  })

  it('has no export that nothing anywhere calls', async () => {
    // Thirteen of these had accumulated. Dead code is not free: it is read,
    // trusted and maintained by whoever comes next.
    //
    // "Nothing calls it" means ZERO occurrences outside its own declaration —
    // not "nothing in another file", which flags every internal helper that
    // happens to be exported. Getting that distinction wrong is what made the
    // first version of this test cry wolf on twenty healthy functions.
    const { readdir, readFile } = await import('node:fs/promises')
    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = []
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`
        if (e.isDirectory()) out.push(...(await walk(p)))
        else if (e.name.endsWith('.ts')) out.push(p)
      }
      return out
    }
    const files = [...(await walk('src')), ...(await walk('test'))]
    const corpus = (await Promise.all(files.map((f) => readFile(f, 'utf8')))).join('\n')

    const dead: string[] = []
    for (const body of await Promise.all((await walk('src')).map((f) => readFile(f, 'utf8')))) {
      for (const m of body.matchAll(/^export (?:async )?function ([a-zA-Z_]\w*)/gm)) {
        const name = m[1] as string
        const uses = (corpus.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length
        if (uses <= 1) dead.push(name)
      }
    }
    expect(dead, `nothing calls: ${dead.join(', ')}`).toEqual([])
  })
})

describe('the shipped config has no keys the schema dropped', () => {
  it('every key in hoppr.default.toml still exists', async () => {
    // The mirror of "every schema key is documented". zod STRIPS unknown keys
    // rather than rejecting them, so a setting removed from the schema keeps
    // sitting in the shipped config looking real — `inbox = "inbox"` survived
    // the inbox being deleted.
    const { parse } = await import('smol-toml')
    const { readFile } = await import('node:fs/promises')
    const { ConfigSchema } = await import('../src/config/schema.ts')
    const raw = parse(await readFile('assets/hoppr.default.toml', 'utf8')) as Record<
      string,
      Record<string, unknown>
    >
    // Read the SCHEMA, not defaults(): an optional key with no default is a
    // real setting that simply does not appear in the defaults object.
    const shapeOf = (schema: unknown): Record<string, unknown> => {
      let node = schema as { def?: { innerType?: unknown; shape?: unknown; type?: string } }
      for (let i = 0; i < 6 && node?.def && !node.def.shape; i++) {
        node = (node.def.innerType ?? node.def) as typeof node
      }
      return ((node?.def?.shape ?? {}) as Record<string, unknown>) ?? {}
    }
    const top = shapeOf(ConfigSchema)
    const known: Record<string, Record<string, unknown>> = {}
    for (const [k, v] of Object.entries(top)) known[k] = shapeOf(v)
    const stale: string[] = []
    for (const [section, val] of Object.entries(raw)) {
      if (!(section in known)) {
        stale.push(section)
        continue
      }
      if (!val || typeof val !== 'object') continue
      for (const key of Object.keys(val)) {
        // Record-typed sections (tables, connectors) take arbitrary names.
        if (['tables', 'connectors', 'integrations', 'schema'].includes(section)) continue
        if (!(key in (known[section] ?? {}))) stale.push(`${section}.${key}`)
      }
    }
    expect(stale, `config keys the schema no longer has: ${stale.join(', ')}`).toEqual([])
  })
})
