import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverUpward, readManifest, register, unregister } from '../src/store/manifest.ts'

let home: string
let tree: string
const saved = process.env.HOPPR_HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hoppr-home-'))
  tree = mkdtempSync(join(tmpdir(), 'hoppr-tree-'))
  process.env.HOPPR_HOME = home
})
afterEach(() => {
  if (saved === undefined) delete process.env.HOPPR_HOME
  else process.env.HOPPR_HOME = saved
})

function makeStore(dir: string): string {
  const root = join(dir, '.hoppr')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'hoppr.toml'), '[hopper]\nname = "t"\n')
  return root
}

describe('upward discovery', () => {
  it('finds a store from a deeply nested working directory', () => {
    const root = makeStore(tree)
    const nested = join(tree, 'a', 'b', 'c')
    mkdirSync(nested, { recursive: true })
    expect(discoverUpward(nested, tmpdir())).toBe(root)
  })

  it('returns nothing when no store is above the cwd', () => {
    const nested = join(tree, 'x', 'y')
    mkdirSync(nested, { recursive: true })
    expect(discoverUpward(nested, tmpdir())).toBeUndefined()
  })

  it('stops at the boundary rather than escaping to an ancestor store', () => {
    // A store ABOVE the stop point must not be adopted — silently binding to a
    // parent store is how a command writes to the wrong place.
    makeStore(tree)
    const nested = join(tree, 'deep')
    mkdirSync(nested, { recursive: true })
    expect(discoverUpward(nested, nested)).toBeUndefined()
  })

  it('does not treat a .hoppr without a config as a store', () => {
    mkdirSync(join(tree, '.hoppr'), { recursive: true })
    expect(discoverUpward(tree, tmpdir())).toBeUndefined()
  })
})

describe('manifest', () => {
  it('round-trips an entry', async () => {
    const root = makeStore(tree)
    await register({ name: 'proj', path: root, source: 'manual' })
    const rows = await readManifest()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('proj')
    expect(rows[0]!.path).toBe(root)
  })

  it('drops entries whose store is gone, rather than erroring', async () => {
    const root = makeStore(tree)
    await register({ name: 'live', path: root, source: 'manual' })
    await register({ name: 'deleted', path: join(tree, 'nope'), source: 'manual' })
    // `rm -rf` on a store should leave nothing to clean up.
    expect((await readManifest()).map((r) => r.name)).toEqual(['live'])
  })

  it('re-registers rather than duplicating when a name or path repeats', async () => {
    const a = makeStore(tree)
    const b = makeStore(join(tree, 'other'))
    await register({ name: 'x', path: a, source: 'manual' })
    await register({ name: 'x', path: b, source: 'dir:/tmp' })
    const rows = await readManifest()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.path).toBe(b)
  })

  it('survives a corrupt index by falling back to empty', async () => {
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'hoppers.json'), '{not json')
    expect(await readManifest()).toEqual([])
  })

  it('unregisters by name or by path', async () => {
    const root = makeStore(tree)
    await register({ name: 'x', path: root, source: 'manual' })
    expect(await unregister('x')).toBe(true)
    expect(await unregister('x')).toBe(false)
  })
})

describe('resolution precedence', () => {
  it('lets an explicit name beat an ambient HOPPR_STORE', async () => {
    // The unpinned MCP server sets HOPPR_STORE in its launch entry, so when
    // ambient won, every `hopper: "x"` request was answered from the default
    // store — wrong data, no error.
    const { Layout } = await import('../src/store/layout.ts')
    const wanted = makeStore(join(tree, 'wanted'))
    const ambient = makeStore(join(tree, 'ambient'))
    await register({ name: 'wanted', path: wanted, source: 'manual' })
    process.env.HOPPR_STORE = ambient
    try {
      expect(Layout.resolveRoot(undefined, 'wanted')).toBe(wanted)
      expect(Layout.resolveRoot()).toBe(ambient)
    } finally {
      delete process.env.HOPPR_STORE
    }
  })

  it('prefers a discovered store over the bare default', async () => {
    const { Layout } = await import('../src/store/layout.ts')
    const root = makeStore(join(tree, 'proj'))
    const nested = join(tree, 'proj', 'a', 'b')
    mkdirSync(nested, { recursive: true })
    expect(Layout.resolveRoot(undefined, undefined, nested)).toBe(root)
  })
})
