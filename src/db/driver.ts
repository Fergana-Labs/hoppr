import { HopprError } from '../core/errors.ts'

export type DriverName = 'better-sqlite3' | 'node-sqlite'

export interface RunResult {
  changes: number
  lastInsertRowid: number
}

export interface Stmt<T = Record<string, unknown>> {
  get(params?: unknown): T | undefined
  all(params?: unknown): T[]
  run(params?: unknown): RunResult
}

export interface Db {
  readonly driver: DriverName
  exec(sql: string): void
  prepare<T = Record<string, unknown>>(sql: string): Stmt<T>
  transaction<T>(fn: () => T): T
  loadExtension(path: string): void
  close(): void
}

/**
 * Two implementations behind one ~40-line interface.
 *
 * `better-sqlite3` is faster and the default, but a Node/ABI combination
 * without a prebuild drops the user into node-gyp, Python, and a C++ compiler
 * — which is the single most common way `npx <tool>` fails on a stranger's
 * laptop. Node 24's built-in `node:sqlite` covers everything we need (FTS5,
 * bm25, and sqlite-vec via loadExtension — all verified), so we fall back to
 * it automatically rather than failing to install.
 */
export interface DriverOptions {
  /** Open the database read-only. Used for third-party databases we are a guest in. */
  readonly?: boolean
}

export async function openDriver(
  path: string,
  preference: 'auto' | DriverName = 'auto',
  opts: DriverOptions = {},
): Promise<Db> {
  if (preference !== 'node-sqlite') {
    try {
      return await openBetterSqlite(path, opts)
    } catch (e) {
      if (preference === 'better-sqlite3') {
        throw HopprError.user(
          `better-sqlite3 failed to load: ${(e as Error).message}\n` +
            'Set [index] driver = "node-sqlite" to use the built-in driver instead.',
        )
      }
    }
  }
  return openNodeSqlite(path, opts)
}

async function openBetterSqlite(path: string, opts: DriverOptions = {}): Promise<Db> {
  const { default: Database } = await import('better-sqlite3')
  // better-sqlite3 takes readonly as an option; it does not parse `file:…?mode=ro`.
  const db = new Database(path, opts.readonly ? { readonly: true } : {})
  return {
    driver: 'better-sqlite3',
    exec: (sql) => void db.exec(sql),
    prepare: <T>(sql: string) => {
      const st = db.prepare(sql)
      return {
        get: (p?: unknown) => (p === undefined ? st.get() : st.get(p)) as T | undefined,
        all: (p?: unknown) => (p === undefined ? st.all() : st.all(p)) as T[],
        run: (p?: unknown) => {
          const r = p === undefined ? st.run() : st.run(p)
          return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) }
        },
      }
    },
    transaction: <T>(fn: () => T) => db.transaction(fn)(),
    loadExtension: (p) => db.loadExtension(p),
    close: () => db.close(),
  }
}

async function openNodeSqlite(path: string, opts: DriverOptions = {}): Promise<Db> {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path, { allowExtension: true, readOnly: opts.readonly ?? false })
  let depth = 0
  return {
    driver: 'node-sqlite',
    exec: (sql) => db.exec(sql),
    prepare: <T>(sql: string) => {
      const st = db.prepare(sql)
      return {
        get: (p?: unknown) => (p === undefined ? st.get() : st.get(p as never)) as T | undefined,
        all: (p?: unknown) => (p === undefined ? st.all() : st.all(p as never)) as T[],
        run: (p?: unknown) => {
          const r = p === undefined ? st.run() : st.run(p as never)
          return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
        },
      }
    },
    // node:sqlite has no transaction helper. Track depth so nested calls become
    // a single outer transaction rather than an error on the inner BEGIN.
    transaction: <T>(fn: () => T): T => {
      if (depth++ > 0) {
        try {
          return fn()
        } finally {
          depth--
        }
      }
      db.exec('BEGIN')
      try {
        const out = fn()
        db.exec('COMMIT')
        return out
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      } finally {
        depth--
      }
    },
    loadExtension: (p) => {
      db.enableLoadExtension(true)
      db.loadExtension(p)
      db.enableLoadExtension(false)
    },
    close: () => db.close(),
  }
}
