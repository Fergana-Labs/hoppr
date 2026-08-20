import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig, stripIdentity } from '../src/config/load.ts'

let home: string
const saved = process.env.HOPPR_HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hoppr-cfg-'))
  process.env.HOPPR_HOME = home
})
afterEach(() => {
  if (saved === undefined) delete process.env.HOPPR_HOME
  else process.env.HOPPR_HOME = saved
})

function store(name: string, body: string): string {
  const root = join(home, name)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'hoppr.toml'), body)
  return root
}

describe('config inheritance', () => {
  it('inherits shared settings from the global file', async () => {
    writeFileSync(join(home, 'hoppr.toml'), '[llm]\nfast_provider = "openrouter"\n')
    const root = store('a', '[hopper]\nname = "a"\nsource = "manual"\n')
    const { config, sources } = await loadConfig({ root })
    expect(config.llm.fast_provider).toBe('openrouter')
    expect(sources).toHaveLength(2)
  })

  it('lets the store override the global', async () => {
    writeFileSync(join(home, 'hoppr.toml'), '[llm]\nfast_provider = "openrouter"\n')
    const root = store(
      'b',
      '[hopper]\nname = "b"\nsource = "manual"\n[llm]\nfast_provider = "ollama"\n',
    )
    expect((await loadConfig({ root })).config.llm.fast_provider).toBe('ollama')
  })

  it('never inherits identity, so a global cannot repoint a hoppr', async () => {
    // The most destructive thing a shared config could do: silently make every
    // hoppr read someone else's corpus, invisibly, until you searched it.
    writeFileSync(join(home, 'hoppr.toml'), '[hopper]\nsource = "dir:/etc"\nname = "evil"\n')
    const root = store('c', '[hopper]\nname = "c"\nsource = "manual"\n')
    const { config } = await loadConfig({ root })
    expect(config.hopper.source).toBe('manual')
    expect(config.hopper.name).toBe('c')
  })

  it('strips only identity keys, keeping shared ones', () => {
    const out = stripIdentity({
      hopper: { name: 'x', source: 'manual', profile: 'p', raw_mode: 'copy', max_file_mb: 50 },
      llm: { fast_provider: 'openrouter' },
    })
    expect(out.hopper).toEqual({ max_file_mb: 50 })
    expect(out.llm).toEqual({ fast_provider: 'openrouter' })
  })

  it('drops the hopper table entirely when it held nothing but identity', () => {
    expect(stripIdentity({ hopper: { name: 'x', source: 'manual' } }).hopper).toBeUndefined()
  })
})

describe('per-store secrets', () => {
  it('keeps two stores on different keys in one process', async () => {
    // The daemon runs every hoppr in one process. If keys travelled through
    // process.env, whichever store loaded first would own the variable name
    // for all of them — and the second would silently bill the first's account.
    const a = store('a', '[hopper]\nname = "a"\nsource = "manual"\n')
    const b = store('b', '[hopper]\nname = "b"\nsource = "manual"\n')
    writeFileSync(join(a, '.env'), 'OPENROUTER_API_KEY=key-for-a\n')
    writeFileSync(join(b, '.env'), 'OPENROUTER_API_KEY=key-for-b\n')

    const loadedA = await loadConfig({ root: a })
    const loadedB = await loadConfig({ root: b })
    expect(loadedA.secrets?.OPENROUTER_API_KEY).toBe('key-for-a')
    expect(loadedB.secrets?.OPENROUTER_API_KEY).toBe('key-for-b')
  })

  it('lets a store override the global key file', async () => {
    writeFileSync(join(home, '.env'), 'OPENROUTER_API_KEY=global\n')
    const root = store('c', '[hopper]\nname = "c"\nsource = "manual"\n')
    writeFileSync(join(root, '.env'), 'OPENROUTER_API_KEY=local\n')
    expect((await loadConfig({ root })).secrets?.OPENROUTER_API_KEY).toBe('local')
  })
})
