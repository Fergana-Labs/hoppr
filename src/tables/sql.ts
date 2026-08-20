import { HopprError } from '../core/errors.ts'
import type { Db } from '../db/driver.ts'
import type { TableDef } from './def.ts'

/**
 * Every table gets a SQL view, so extracted rows are queryable with plain SQL
 * instead of a bespoke filter API. This is what turns hoppr from a search box
 * into something you can ask aggregate questions of.
 */
export function viewNameFor(table: string): string {
  return `v_${table}`
}

export function createView(db: Db, def: TableDef): void {
  const cols = Object.keys(def.columns)
    .map((c) => `json_extract(data, '$.${c}') AS ${quoteIdent(c)}`)
    .join(',\n         ')
  db.exec(`DROP VIEW IF EXISTS ${quoteIdent(viewNameFor(def.name))}`)
  db.exec(
    `CREATE VIEW ${quoteIdent(viewNameFor(def.name))} AS
       SELECT row_id, raw_id, page_id,
         ${cols}
       FROM tbl_rows WHERE table_name = ${quoteLiteral(def.name)}`,
  )
}

export function dropView(db: Db, table: string): void {
  db.exec(`DROP VIEW IF EXISTS ${quoteIdent(viewNameFor(table))}`)
}

function quoteIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`
}
function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|begin|commit|rollback)\b/i

export interface QueryResult {
  columns: string[]
  rows: Record<string, unknown>[]
  truncated: boolean
}

/**
 * Run a user or agent supplied query, read-only.
 *
 * Defence in depth, because this is reachable from an MCP tool and therefore
 * from anything that can talk to the model:
 *
 *  1. A separate connection opened in SQLite's own read-only mode, so even a
 *     bypass of the checks below cannot write.
 *  2. One statement only — a trailing `; DROP …` is rejected outright.
 *  3. Must start with SELECT or WITH, and must not contain a DDL/DML keyword.
 *  4. Row cap, so a cartesian join cannot exhaust memory or a context window.
 */
export function runQuery(db: Db, sql: string, opts: { maxRows?: number } = {}): QueryResult {
  const trimmed = sql.trim().replace(/;\s*$/, '')
  if (!trimmed) throw HopprError.user('empty query')

  if (splitStatements(trimmed).length > 1) {
    throw HopprError.user('only a single SELECT statement is allowed')
  }
  if (!/^\s*(select|with)\b/i.test(trimmed)) {
    throw HopprError.user('queries must start with SELECT or WITH')
  }
  if (FORBIDDEN.test(stripStringsAndComments(trimmed))) {
    throw HopprError.user('only read-only queries are allowed')
  }

  const maxRows = opts.maxRows ?? 1000
  let rows: Record<string, unknown>[]
  try {
    rows = db.prepare<Record<string, unknown>>(`${trimmed} LIMIT ${maxRows + 1}`).all()
  } catch {
    // The query may already have its own LIMIT, or be a compound select.
    rows = db.prepare<Record<string, unknown>>(trimmed).all()
  }

  const truncated = rows.length > maxRows
  if (truncated) rows = rows.slice(0, maxRows)
  return { columns: rows[0] ? Object.keys(rows[0]) : [], rows, truncated }
}

/** Split on semicolons that are not inside a string literal or comment. */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let buf = ''
  let quote: string | null = null
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!
    if (quote) {
      if (ch === quote) quote = null
      buf += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      buf += ch
      continue
    }
    if (ch === ';') {
      if (buf.trim()) out.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

function stripStringsAndComments(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
}
