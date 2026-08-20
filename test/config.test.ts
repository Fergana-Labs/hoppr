import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deepMerge, loadConfig } from '../src/config/load.ts'
import { defaults } from '../src/config/schema.ts'

const saved = { ...process.env }
afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith('HOPPR_')) delete process.env[k]
  Object.assign(process.env, saved)
})

describe('config', () => {
  it('fills every nested default', () => {
    const d = defaults()
    expect(d.hopper.profile).toBe('manual')
    expect(d.git.mode).toBe('auto')
    expect(d.wiki.layout).toBe('karpathy')
    expect(d.embed.dim).toBe(384)
    expect(d.curate.auto_merge).toBe(false) // propose, never rewrite
    expect(d.skills.auto_install).toBe(false) // a skill changes future behavior
    expect(d.search.tier_boost.curated).toBe(1.5)
  })

  it('arrays replace rather than concatenating', () => {
    expect(deepMerge({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] })
    expect(deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } })).toEqual({ a: { b: 1, c: 3 } })
  })

  it('env overrides beat file config, and HOPPR_A__B nests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hoppr-cfg-'))
    try {
      await writeFile(join(root, 'hoppr.toml'), '[llm]\nprovider = "anthropic"\n')
      process.env.HOPPR_STORE = root
      process.env.HOPPR_LLM_PROVIDER = 'ollama'
      process.env.HOPPR_CURATE__FAST_BATCH = '16'

      const { config } = await loadConfig({ cwd: root })
      expect(config.llm.provider).toBe('ollama')
      expect(config.curate.fast_batch).toBe(16)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('HOPPR_NO_LLM=1 degrades to provider none rather than erroring', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hoppr-cfg-'))
    try {
      process.env.HOPPR_STORE = root
      process.env.HOPPR_NO_LLM = '1'
      const { config } = await loadConfig({ cwd: root })
      expect(config.llm.provider).toBe('none')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects an invalid value with the offending path named', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hoppr-cfg-'))
    try {
      await writeFile(join(root, 'hoppr.toml'), '[llm]\nprovider = "gpt5"\n')
      process.env.HOPPR_STORE = root
      await expect(loadConfig({ cwd: root })).rejects.toThrow(/llm\.provider/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves a hoppr by name under ~/.hoppr', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hoppr-home-'))
    try {
      process.env.HOPPR_HOME = home
      await mkdir(join(home, 'work'), { recursive: true })
      await writeFile(
        join(home, 'work', 'hoppr.toml'),
        '[hopper]\nname = "work"\nsource = "agents:claude-code"\nprofile = "agents"\n',
      )
      const { config, layout } = await loadConfig({ hopper: 'work' })
      expect(layout.root).toBe(join(home, 'work'))
      expect(layout.name).toBe('work')
      expect(config.hopper.profile).toBe('agents')
      expect(config.hopper.source).toBe('agents:claude-code')

      // A hoppr that does not exist yet still resolves to its would-be home,
      // so `hoppr new` has somewhere to write.
      const fresh = await loadConfig({ hopper: 'nope' })
      expect(fresh.layout.root).toBe(join(home, 'nope'))
      expect(fresh.config.hopper.profile).toBe('manual')
    } finally {
      delete process.env.HOPPR_HOME
      await rm(home, { recursive: true, force: true })
    }
  })
})
