import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { writeIfChanged } from './atomic.ts'
import { hopprHome, userHome } from './home.ts'

export interface ManifestEntry {
  name: string
  /** Absolute path to the store root — the directory holding hoppr.toml. */
  path: string
  source: string
  registered: number
}

/**
 * The manifest of every hoppr, wherever it lives.
 *
 * A hoppr's store lives in the directory you created it in, the way a git repo
 * does. That makes a hoppr movable, cloneable, and deletable with `rm -rf` —
 * but it also means a bare `ls ~/.hoppr` can no longer see them all, and the
 * daemon needs to see them all.
 *
 * So: the manifest is an INDEX, never the source of truth. Each store's own
 * hoppr.toml still defines it, and a store whose path has gone is dropped on
 * read rather than erroring — you should be able to delete a hoppr with `rm`
 * and have nothing left to clean up.
 */
export function manifestPath(): string {
  return join(hopprHome(), 'hoppers.json')
}

export async function readManifest(): Promise<ManifestEntry[]> {
  const path = manifestPath()
  if (!existsSync(path)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    // A corrupt index is not a corrupt hoppr. Fall back to the directory scan.
    return []
  }
  const rows = Array.isArray(parsed) ? parsed : ((parsed as { hoppers?: unknown })?.hoppers ?? [])
  if (!Array.isArray(rows)) return []
  return rows
    .filter((r): r is ManifestEntry => Boolean(r && typeof (r as ManifestEntry).path === 'string'))
    .map((r) => ({
      name: String(r.name ?? ''),
      path: resolve(String(r.path)),
      source: String(r.source ?? 'manual'),
      registered: Number(r.registered ?? 0),
    }))
    .filter((r) => r.name && existsSync(join(r.path, 'hoppr.toml')))
}

/** Add or update one entry. Keyed by path, so moving a store re-registers it. */
export async function register(entry: Omit<ManifestEntry, 'registered'>): Promise<void> {
  const path = resolve(entry.path)
  const rows = (await readManifest()).filter((r) => r.path !== path && r.name !== entry.name)
  rows.push({ ...entry, path, registered: Date.now() })
  await writeManifest(rows)
}

export async function unregister(nameOrPath: string): Promise<boolean> {
  const rows = await readManifest()
  const target = resolve(nameOrPath)
  const kept = rows.filter((r) => r.name !== nameOrPath && r.path !== target)
  if (kept.length === rows.length) return false
  await writeManifest(kept)
  return true
}

async function writeManifest(rows: ManifestEntry[]): Promise<void> {
  const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name))
  await writeIfChanged(manifestPath(), `${JSON.stringify(sorted, null, 2)}\n`)
}

/**
 * Synchronous lookup for `Layout.resolveRoot`, which every command calls before
 * anything async exists. Reading a small JSON file synchronously once per
 * invocation is cheaper than making path resolution async everywhere.
 */
export function manifestLookup(name: string): string | undefined {
  const path = manifestPath()
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const rows: ManifestEntry[] = Array.isArray(parsed) ? parsed : (parsed?.hoppers ?? [])
    const hit = rows.find((r) => r?.name === name)
    if (!hit) return undefined
    const root = resolve(String(hit.path))
    return existsSync(join(root, 'hoppr.toml')) ? root : undefined
  } catch {
    return undefined
  }
}

/**
 * Walk up from `start` looking for a `.hoppr/` store, the way git finds `.git`.
 *
 * Stops at the filesystem root and at the user's home directory. The home stop
 * matters: without it, running hoppr anywhere under `~` with a stray `~/.hoppr`
 * would silently bind every command to the global store instead of falling
 * through to the named default, which is a confusing way to write to the wrong
 * place.
 */
export function discoverUpward(start: string, stopAt = userHome()): string | undefined {
  let dir = resolve(start)
  for (;;) {
    const candidate = join(dir, '.hoppr')
    if (existsSync(join(candidate, 'hoppr.toml'))) return candidate
    if (dir === stopAt) return undefined
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}
