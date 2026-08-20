import { z } from 'zod'
import type { Config } from '../config/schema.ts'
import { contentHash } from '../core/hash.ts'
import { newId } from '../core/ids.ts'
import { docId, upsertDoc } from '../db/docs.ts'
import type { Db } from '../db/driver.ts'
import { type LlmProvider, recordCall } from '../llm/index.ts'
import { buildFilters } from '../search/fts.ts'
import { parseQuery } from '../search/query.ts'
import { writeIfChanged } from '../store/atomic.ts'
import type { Layout } from '../store/layout.ts'
import { coerceRow, type LoadedTable, rowSchemaFor, saveTable } from './def.ts'
import { createView } from './sql.ts'

export interface ExtractStats {
  table: string
  candidates: number
  extracted: number
  unchanged: number
  failed: number
  newEnumValues: Record<string, string[]>
}

interface Candidate {
  doc_id: string
  ref_id: string
  tier: string
  title: string
  body: string
  summary: string
  project: string | null
  raw_id: string | null
}

/**
 * Populate one table from whatever its `match` selector picks out.
 *
 * Rows carry the id of the capture they came from, so every cell traces back
 * to its evidence — `hoppr table show <name> --trace` walks a value to the
 * transcript that produced it. Extraction that cannot be audited is worse than
 * no extraction, because it looks like data.
 */
export async function extractTable(
  db: Db,
  l: Layout,
  cfg: Config,
  llm: LlmProvider,
  table: LoadedTable,
  opts: { limit?: number; rebuild?: boolean; onProgress?: (m: string) => void } = {},
): Promise<ExtractStats> {
  const st: ExtractStats = {
    table: table.def.name,
    candidates: 0,
    extracted: 0,
    unchanged: 0,
    failed: 0,
    newEnumValues: {},
  }

  registerDef(db, table)
  createView(db, table.def)

  const candidates = selectCandidates(db, table, opts.limit ?? 200)
  st.candidates = candidates.length
  if (candidates.length === 0) return st

  const rowSchema = rowSchemaFor(table.def)
  const Out = z.object({ rows: z.array(rowSchema.and(z.object({ source_id: z.string() }))) })
  const batchSize = Math.max(1, Math.min(cfg.curate.fast_batch, 6))

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize)
    opts.onProgress?.(`${table.def.name}: ${i + batch.length}/${candidates.length}`)

    const sourceHashes = new Map(batch.map((c) => [c.doc_id, contentHash(c.body || c.summary)]))
    if (!opts.rebuild) {
      // Skip anything whose source and definition are both unchanged.
      for (const c of [...batch]) {
        const existing = db
          .prepare<{ source_hash: string; prompt_hash: string }>(
            'SELECT source_hash, prompt_hash FROM tbl_rows WHERE table_name = :t AND raw_id = :r LIMIT 1',
          )
          .get({ t: table.def.name, r: c.raw_id ?? c.ref_id })
        if (
          existing?.source_hash === sourceHashes.get(c.doc_id) &&
          existing?.prompt_hash === table.defHash
        ) {
          batch.splice(batch.indexOf(c), 1)
          st.unchanged++
        }
      }
    }
    if (batch.length === 0) continue

    let out: z.infer<typeof Out>
    try {
      const res = await llm.completeJson({
        prompt: buildPrompt(db, table, batch),
        tier: 'fast',
        purpose: `tables.${table.def.name}`,
        schema: Out,
        maxTokens: 8192,
      })
      recordCall(db, llm.id, `tables.${table.def.name}`, 'fast', res.usage, true)
      out = res.value
    } catch {
      st.failed += batch.length
      continue
    }

    const byDoc = new Map(batch.map((c) => [c.doc_id, c]))
    for (const raw of out.rows) {
      const cand = byDoc.get(String(raw.source_id))
      if (!cand) continue
      const { row, newEnumValues } = coerceRow(table.def, raw as Record<string, unknown>)
      for (const [col, vals] of Object.entries(newEnumValues)) {
        st.newEnumValues[col] = [...new Set([...(st.newEnumValues[col] ?? []), ...vals])]
      }

      const rowId = deterministicRowId(table.def.name, cand.raw_id ?? cand.ref_id, row)
      db.prepare(
        `INSERT INTO tbl_rows(table_name,row_id,raw_id,page_id,data,pass_id,source_hash,prompt_hash,pinned)
         VALUES (:t,:r,:raw,:page,:data,:pass,:shash,:phash,0)
         ON CONFLICT(table_name,row_id) DO UPDATE SET
           data=:data, source_hash=:shash, prompt_hash=:phash, pass_id=:pass
         WHERE tbl_rows.pinned = 0`,
      ).run({
        t: table.def.name,
        r: rowId,
        raw: cand.raw_id ?? null,
        page: cand.tier === 'curated' ? cand.ref_id : null,
        data: JSON.stringify(row),
        pass: newId(),
        shash: sourceHashes.get(cand.doc_id) ?? null,
        phash: table.defHash,
      })

      // Project into the unified index, rendered as text, so a query matching
      // only a cell value still finds the row.
      upsertDoc(
        db,
        {
          id: docId.row(table.def.name, rowId),
          tier: 'curated',
          kind: 'table_row',
          refId: rowId,
          title: `${table.def.name} · ${firstValue(row)}`,
          summary: renderRowText(row),
          body: '',
          project: cand.project ?? undefined,
          created: Date.now(),
          updated: Date.now(),
        },
        { maxChars: cfg.index.chunk_chars, overlap: cfg.index.chunk_overlap },
      )
      st.extracted++
    }
  }

  // Converging columns widen their own vocabulary — the definition file is both
  // the output and the dictionary, same as the tag taxonomy.
  if (Object.keys(st.newEnumValues).length > 0) {
    const next = structuredClone(table.def)
    for (const [col, vals] of Object.entries(st.newEnumValues)) {
      const c = next.columns[col]
      if (c?.converging) c.values = [...new Set([...(c.values ?? []), ...vals])]
    }
    await saveTable(l, next)
  }

  await writeRowsFile(db, l, table.def.name)
  return st
}

function registerDef(db: Db, t: LoadedTable): void {
  db.prepare(
    `INSERT INTO tbl_defs(name, def, def_hash, prompt_hash, builtin, updated)
     VALUES (:n,:d,:h,:h,0,:u)
     ON CONFLICT(name) DO UPDATE SET def=:d, def_hash=:h, prompt_hash=:h, updated=:u`,
  ).run({ n: t.def.name, d: JSON.stringify(t.def), h: t.defHash, u: Date.now() })
}

function selectCandidates(db: Db, t: LoadedTable, limit: number): Candidate[] {
  const parsed = parseQuery(t.def.match || 'scope:all')
  const { where, params } = buildFilters(parsed.filters)
  return db
    .prepare<Candidate>(
      `SELECT d.id AS doc_id, d.ref_id, d.tier, d.title, d.body, d.summary, d.project,
              (SELECT ws.raw_id FROM wiki_sources ws WHERE ws.page_id = d.ref_id LIMIT 1) AS raw_id
         FROM docs d
        WHERE 1=1 ${where}
        ORDER BY d.updated DESC
        LIMIT :n`,
    )
    .all({ ...params, n: limit })
    .map((c) => ({ ...c, raw_id: c.raw_id ?? (c.tier === 'raw' ? c.ref_id : null) }))
}

function buildPrompt(db: Db, t: LoadedTable, batch: Candidate[]): string {
  const cols = Object.entries(t.def.columns).map(([name, c]) => {
    const bits = [`- ${name}: ${c.type}`]
    if (c.type === 'enum') {
      const existing = c.converging ? distinctValues(db, t.def.name, name) : []
      const vocab = [...new Set([...(c.values ?? []), ...existing])]
      bits.push(`  allowed: ${vocab.join(' | ')}`)
      if (c.converging) {
        bits.push('  Reuse one of the above whenever it fits. Only introduce a new value')
        bits.push('  if none of them describes this row — near-synonyms make the column useless.')
      }
    }
    if (c.required) bits.push('  required')
    if (c.description) bits.push(`  ${c.description}`)
    return bits.join('\n')
  })

  return `Extract structured rows for the table "${t.def.name}".
${t.def.description ? `\n${t.def.description}\n` : ''}
## Columns

${cols.join('\n')}

## Rules

- Emit ${t.def.grain === 'one-per-source' ? 'AT MOST ONE row per source' : 'one row per distinct item found'}.
- Every row must carry the "source_id" it came from, exactly as given below.
- Use null for anything the source does not actually say. Inventing a plausible
  value is worse than an empty cell: it looks like evidence.
- If a source contains nothing relevant to this table, emit no row for it.

## Sources

${batch
  .map(
    (c) =>
      `### source_id: ${c.doc_id}\ntitle: ${c.title}\n\n${(c.body || c.summary).slice(0, 6000)}`,
  )
  .join('\n\n---\n\n')}

## Output

{"rows": [{"source_id": "...", ${Object.keys(t.def.columns)
    .map((c) => `"${c}": ...`)
    .join(', ')}}]}`
}

function distinctValues(db: Db, table: string, column: string): string[] {
  return db
    .prepare<{ v: string }>(
      `SELECT DISTINCT json_extract(data, '$.${column}') AS v
         FROM tbl_rows WHERE table_name = :t AND v IS NOT NULL LIMIT 100`,
    )
    .all({ t: table })
    .map((r) => String(r.v))
}

/**
 * Deterministic row id: re-extracting the same source must update its row, not
 * append a near-duplicate every pass.
 */
function deterministicRowId(table: string, sourceId: string, row: Record<string, unknown>): string {
  return contentHash(`${table}|${sourceId}|${JSON.stringify(Object.keys(row).sort())}`).slice(7, 23)
}

function firstValue(row: Record<string, unknown>): string {
  for (const v of Object.values(row)) {
    if (v !== null && v !== undefined && v !== '') return String(Array.isArray(v) ? v[0] : v)
  }
  return '(empty)'
}

export function renderRowText(row: Record<string, unknown>): string {
  return Object.entries(row)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    .join(' · ')
}

/** Mirror rows to JSONL so the data is readable and diffable without the index. */
export async function writeRowsFile(db: Db, l: Layout, table: string): Promise<void> {
  const rows = db
    .prepare<{ row_id: string; raw_id: string | null; data: string }>(
      'SELECT row_id, raw_id, data FROM tbl_rows WHERE table_name = :t ORDER BY row_id',
    )
    .all({ t: table })
  const body = rows
    .map((r) => JSON.stringify({ row_id: r.row_id, raw_id: r.raw_id, ...JSON.parse(r.data) }))
    .join('\n')
  await writeIfChanged(l.tableRows(table), body ? `${body}\n` : '')
}

/**
 * Read hand edits back out of `<table>.jsonl`.
 *
 * The file was write-only: rows were exported to it and nothing ever read them
 * back, so editing a wrong cell — the obvious thing to do when you see one —
 * was silently undone by the next pass. Now the file is the truth, the same
 * way a hand-edited wiki page is.
 *
 * An edited or hand-written row is PINNED, so extraction maintains everything
 * around it and never overwrites what you wrote. A row you delete from the
 * file stays deleted: re-extracting it would make the file unfixable.
 */
export async function adoptRowEdits(db: Db, l: Layout, table: string): Promise<number> {
  const { existsSync } = await import('node:fs')
  const { readFile } = await import('node:fs/promises')
  const path = l.tableRows(table)
  if (!existsSync(path)) return 0

  const current = new Map(
    db
      .prepare<{ row_id: string; data: string }>(
        'SELECT row_id, data FROM tbl_rows WHERE table_name = :t',
      )
      .all({ t: table })
      .map((r) => [r.row_id, r.data]),
  )

  let adopted = 0
  const seen = new Set<string>()
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    if (!line.trim()) continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line)
    } catch {
      continue // a malformed line is not a reason to discard the rest
    }
    const { row_id, raw_id, ...data } = parsed as {
      row_id?: string
      raw_id?: string
      [k: string]: unknown
    }
    // A hand-written row need not carry an id; give it a stable one.
    const id =
      row_id ??
      `manual-${contentHash(JSON.stringify(data))
        .replace(/^sha256:/, '')
        .slice(0, 16)}`
    seen.add(id)
    const next = JSON.stringify(data)
    if (current.get(id) === next) continue

    db.prepare(
      `INSERT INTO tbl_rows (table_name,row_id,raw_id,page_id,data,pass_id,source_hash,prompt_hash,pinned)
       VALUES (:t,:id,:raw,NULL,:data,'manual','','',1)
       ON CONFLICT(table_name,row_id) DO UPDATE SET data = :data, pinned = 1`,
    ).run({ t: table, id, raw: raw_id ?? null, data: next })
    adopted++
  }

  // Deleting a line means deleting the row. Re-extracting it would make the
  // file impossible to correct.
  for (const id of current.keys()) {
    if (seen.has(id)) continue
    db.prepare('DELETE FROM tbl_rows WHERE table_name = :t AND row_id = :id').run({ t: table, id })
    adopted++
  }
  return adopted
}

export interface AllTablesStats {
  tables: number
  written: number
  failed: number
}

/**
 * Fill every defined table from captures that have not been through it.
 *
 * This is what makes a table a standing instruction rather than a one-off
 * report: define the schema once, and everything that arrives afterwards is
 * classified into it on the next pass. Without this, `hoppr tables rebuild`
 * had to be run by hand and a table silently went stale the moment you stopped
 * thinking about it.
 *
 * Incremental by `source_hash` and `prompt_hash`, so a pass over an unchanged
 * corpus costs nothing, and pinned rows are never overwritten.
 */
export async function extractAllTables(
  db: Db,
  l: Layout,
  cfg: Config,
  llm: LlmProvider,
  opts: { onProgress?: (m: string) => void } = {},
): Promise<AllTablesStats> {
  const out: AllTablesStats = { tables: 0, written: 0, failed: 0 }
  const { listTables } = await import('./def.ts')
  for (const table of await listTables(l)) {
    out.tables++
    try {
      // Hand edits first, so extraction sees them as pinned and leaves them be.
      await adoptRowEdits(db, l, table.def.name).catch(() => 0)
      const st = await extractTable(db, l, cfg, llm, table, { onProgress: opts.onProgress })
      out.written += st.extracted
      out.failed += st.failed
    } catch {
      // One broken definition must not stop the others.
      out.failed++
    }
  }
  return out
}
