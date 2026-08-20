import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { listAssets, readAsset } from '../core/assets.ts'
import { HopprError } from '../core/errors.ts'
import { type Db, type DriverName, openDriver } from './driver.ts'

export interface OpenOptions {
  driver?: 'auto' | DriverName
  /** Load sqlite-vec. Off for pure-FTS paths so a missing extension is not fatal. */
  vector?: boolean
  readonly?: boolean
}

export interface OpenedDb {
  db: Db
  driver: DriverName
  vectorAvailable: boolean
}

const PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA foreign_keys = ON',
  'PRAGMA temp_store = MEMORY',
  'PRAGMA mmap_size = 268435456',
]

export async function openDb(path: string, opts: OpenOptions = {}): Promise<OpenedDb> {
  await mkdir(dirname(path), { recursive: true })
  const db = await openDriver(path, opts.driver ?? 'auto')

  for (const p of PRAGMAS) {
    // WAL is unavailable on some filesystems; a store on a network share should
    // degrade to journal mode rather than refuse to open.
    try {
      db.exec(p)
    } catch {
      /* ignore */
    }
  }

  let vectorAvailable = false
  if (opts.vector !== false) {
    vectorAvailable = await loadVector(db)
  }

  await migrate(db)
  return { db, driver: db.driver, vectorAvailable }
}

async function loadVector(db: Db): Promise<boolean> {
  try {
    const vec = await import('sqlite-vec')
    db.loadExtension(vec.getLoadablePath())
    db.prepare('SELECT vec_version() AS v').get()
    return true
  } catch {
    // Not fatal: keyword search, ingest, and the whole wiki work without it.
    return false
  }
}

/**
 * Migrations exist only so an incremental upgrade doesn't force a full
 * re-chunk. Losing them is never a crisis: the database is derivable from
 * raw/ + curated/, so the answer to a broken migration is `hoppr reindex`.
 */
export async function migrate(db: Db): Promise<number> {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, at INTEGER)')
  const applied = new Set(
    db
      .prepare<{ version: string }>('SELECT version FROM schema_migrations')
      .all()
      .map((r) => r.version),
  )
  const files = (await listAssets('migrations')).filter((f) => f.endsWith('.sql'))
  let count = 0
  for (const f of files) {
    if (applied.has(f)) continue
    const sql = await readAsset('migrations', f)
    try {
      db.transaction(() => {
        db.exec(sql)
        db.prepare('INSERT INTO schema_migrations(version, at) VALUES (:v, :t)').run({
          v: f,
          t: Date.now(),
        })
      })
    } catch (e) {
      throw HopprError.internal(`migration ${f} failed: ${(e as Error).message}`)
    }
    count++
  }
  return count
}

export function dbExists(path: string): boolean {
  return existsSync(path)
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta(key, value) VALUES (:k, :v) ON CONFLICT(key) DO UPDATE SET value = :v',
  ).run({ k: key, v: value })
}

export function getMeta(db: Db, key: string): string | undefined {
  return db.prepare<{ value: string }>('SELECT value FROM meta WHERE key = :k').get({ k: key })
    ?.value
}
