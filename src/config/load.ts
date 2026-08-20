import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { HopprError } from '../core/errors.ts'
import { Layout } from '../store/layout.ts'
import { type EnvSource, loadDotEnv } from './env.ts'
import { type Config, ConfigSchema } from './schema.ts'

/**
 * Sections that may be split into `schemas/<name>.toml`.
 *
 * `tables` is absent on purpose: a table definition is one file per table and
 * already lives under curated/, because each is independently editable and
 * independently versioned.
 */
export const SCHEMA_SECTIONS = ['graph', 'wiki', 'skills'] as const

export interface LoadedConfig {
  config: Config
  layout: Layout
  /** Config files that actually contributed, in precedence order. */
  sources: string[]
  /** `.env` files that supplied variables, and which ones. */
  envSources?: EnvSource[]
  /** Keys this store's .env files declare, for providers to use directly. */
  secrets?: Record<string, string>
}

/**
 * Precedence, lowest to highest:
 *   defaults < ~/.hoppr/hoppr.toml < <store>/hoppr.toml < HOPPR_* env < CLI flags
 *
 * The one global layer exists because stores now live wherever you made them.
 * Settings that describe YOU rather than a corpus — which model provider, which
 * embedder, whether to auto-commit — should be written once, not copied into
 * every store. Everything identifying (name, source, profile) is per-store and
 * is never inherited, so a global file cannot silently repoint a hoppr at a
 * different corpus.
 *
 * Arrays REPLACE rather than concatenating. A surprising merge is worse than a
 * verbose config: if you write `stoplist = ["foo"]` you get exactly that.
 *
 * API keys are deliberately NOT part of this. They are read from the
 * environment at call time and never written to any config hoppr controls —
 * a store is git-tracked, and a secret in a tracked file survives its own
 * deletion.
 */
export async function loadConfig(
  opts: { root?: string; hopper?: string; cwd?: string; overrides?: Record<string, unknown> } = {},
): Promise<LoadedConfig> {
  const sources: string[] = []
  let merged: Record<string, unknown> = {}

  const root = Layout.resolveRoot(opts.root, opts.hopper, opts.cwd)

  // Global first, so the store's own file overrides it.
  // Keys first: everything downstream reads them from the environment, and the
  // MCP server inherits its client's environment rather than your shell's.
  const { sources: envSources, values: secrets } = loadDotEnv([Layout.home(), root])

  const globalPath = join(Layout.home(), 'hoppr.toml')
  const cfgPath = join(root, 'hoppr.toml')
  if (existsSync(globalPath) && globalPath !== cfgPath) {
    merged = deepMerge(merged, stripIdentity(await readToml(globalPath)))
    sources.push(globalPath)
  }
  if (existsSync(cfgPath)) {
    merged = deepMerge(merged, await readToml(cfgPath))
    sources.push(cfgPath)
  }

  // Then the per-section schema files. They win over the same section in
  // hoppr.toml: if you have bothered to give `graph` its own file, that is
  // where you are editing it.
  for (const section of SCHEMA_SECTIONS) {
    const path = join(root, 'schemas', `${section}.toml`)
    if (!existsSync(path)) continue
    merged = deepMerge(merged, { [section]: await readToml(path) })
    sources.push(path)
  }

  merged = deepMerge(merged, envOverrides())
  if (opts.overrides) merged = deepMerge(merged, opts.overrides)

  const parsed = ConfigSchema.safeParse(merged)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    throw HopprError.user(
      `invalid config at ${first?.path.join('.') || '<root>'}: ${first?.message}`,
    )
  }
  const config = parsed.data
  return { config, layout: new Layout(root), sources, envSources, secrets }
}

/**
 * Identity is per-store and never inherited.
 *
 * A global `[hopper] source = …` would silently repoint every hoppr at one
 * corpus — the single most destructive thing a config file could do here, and
 * completely invisible until you searched and got someone else's data.
 */
export function stripIdentity(cfg: Record<string, unknown>): Record<string, unknown> {
  const { hopper, ...rest } = cfg
  if (!hopper || typeof hopper !== 'object') return cfg
  const {
    name: _n,
    source: _s,
    profile: _p,
    raw_mode: _r,
    ...shared
  } = hopper as Record<string, unknown>
  return Object.keys(shared).length ? { ...rest, hopper: shared } : rest
}

async function readToml(path: string): Promise<Record<string, unknown>> {
  try {
    return parseToml(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch (e) {
    throw HopprError.user(`cannot parse ${path}: ${(e as Error).message}`)
  }
}

/**
 * Named env vars plus a generic `HOPPR_<SECTION>__<KEY>` form
 * (double underscore = nesting).
 */
function envOverrides(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const named: Array<[string, string[]]> = [
    ['HOPPR_SCOPE', ['store', 'scope']],
    ['HOPPR_LLM_PROVIDER', ['llm', 'provider']],
    ['HOPPR_LLM_MODEL_FAST', ['llm', 'models', 'fast']],
    ['HOPPR_LLM_MODEL_QUALITY', ['llm', 'models', 'quality']],
    ['HOPPR_EMBED_PROVIDER', ['embed', 'provider']],
    ['HOPPR_INDEX_DRIVER', ['index', 'driver']],
  ]
  for (const [env, path] of named) {
    const v = process.env[env]
    if (v !== undefined) setPath(out, path, coerce(v))
  }
  if (process.env.HOPPR_NO_LLM === '1') setPath(out, ['llm', 'provider'], 'none')

  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('HOPPR_') || !k.includes('__') || v === undefined) continue
    const path = k.slice('HOPPR_'.length).toLowerCase().split('__')
    setPath(out, path, coerce(v))
  }
  return out
}

function coerce(v: string): unknown {
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^-?\d+$/.test(v)) return Number(v)
  if (/^-?\d*\.\d+$/.test(v)) return Number(v)
  return v
}

function setPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = obj
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]!
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}
    cur = cur[k] as Record<string, unknown>
  }
  cur[path[path.length - 1]!] = value
}

export function deepMerge(
  base: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(next)) {
    const prev = out[k]
    if (isPlain(prev) && isPlain(v)) {
      out[k] = deepMerge(prev, v)
    } else {
      out[k] = v // arrays and scalars replace
    }
  }
  return out
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}
