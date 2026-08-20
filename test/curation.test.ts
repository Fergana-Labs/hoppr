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
