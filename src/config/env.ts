import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface EnvSource {
  path: string
  /** Variables this file actually set (were unset in the environment). */
  keys: string[]
  /** Every variable the file declares, applied or not. */
  defines: string[]
}

/**
 * Keys live in a `.env` beside the config, not in the config.
 *
 * Two constraints force this shape. A store is a git repo and `hoppr.toml` is
 * tracked, so a key written there would be committed — and deleting it later
 * does not remove it from history. But the environment alone is not enough
 * either: the MCP server is spawned by the CLIENT (Claude Code, Cursor), so it
 * inherits that application's environment, which for a GUI launch contains
 * nothing from your shell profile. Env-only keys work in a terminal and
 * silently fail under the exact integration this tool exists for.
 *
 * So: a file, in a known place, gitignored and 0600 — and the real environment
 * still wins, so `OPENAI_API_KEY=… hoppr …` overrides for one call and CI needs
 * no file at all.
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line
      .slice(0, eq)
      .replace(/^export\s+/, '')
      .trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = line.slice(eq + 1).trim()
    const quoted = /^(['"])([\s\S]*)\1$/.exec(value)
    if (quoted) {
      value = quoted[2] ?? ''
      // Only double quotes get escapes, matching every other dotenv reader.
      if (quoted[1] === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"')
    } else {
      // An unquoted trailing comment is a comment, not part of the secret.
      value = value.replace(/\s+#.*$/, '').trim()
    }
    out[key] = value
  }
  return out
}

/**
 * Load `.env` from each directory, lowest precedence first. Never overwrites a
 * variable that is already set: the real environment is the override.
 */
export interface DotEnvResult {
  sources: EnvSource[]
  /**
   * Everything the files declared, later directories winning — INDEPENDENT of
   * process.env. The daemon runs many hoppers in one process, so a per-store
   * key cannot be carried by a process-global variable: the first store loaded
   * would own the name for every other one.
   */
  values: Record<string, string>
}

export function loadDotEnv(dirs: string[], env: NodeJS.ProcessEnv = process.env): DotEnvResult {
  const sources: EnvSource[] = []
  const values: Record<string, string> = {}
  for (const dir of dirs) {
    const path = join(dir, '.env')
    if (!existsSync(path)) continue
    let parsed: Record<string, string>
    try {
      parsed = parseDotEnv(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
    const applied: string[] = []
    const defines = Object.keys(parsed)
    Object.assign(values, parsed)
    for (const [k, v] of Object.entries(parsed)) {
      if (env[k] !== undefined && env[k] !== '') continue
      env[k] = v
      applied.push(k)
    }
    if (defines.length) sources.push({ path, keys: applied, defines })
  }
  return { sources, values }
}

/**
 * Where a variable came from, so `doctor` names the file you would edit.
 *
 * Reports the file that DECLARES the key even when the live environment
 * overrode it — "there is also a key in this file" is the thing you need to
 * know when the two disagree, and reporting only the winner hides it.
 */
export function envOrigin(key: string, sources: EnvSource[]): string {
  const applied = sources.find((s) => s.keys.includes(key))
  if (applied) return applied.path
  const declared = sources.find((s) => s.defines.includes(key))
  if (declared) return `environment, overriding ${declared.path}`
  return 'environment'
}
