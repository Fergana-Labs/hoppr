import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { glob } from 'tinyglobby'
import { z } from 'zod'
import { HopprError } from '../core/errors.ts'
import { contentHash } from '../core/hash.ts'
import { writeIfChanged } from '../store/atomic.ts'
import type { Layout } from '../store/layout.ts'

export const ColumnSchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'date', 'enum', 'list[string]', 'list[number]']),
  values: z.array(z.string()).optional(),
  required: z.boolean().default(false),
  description: z.string().optional(),
  /**
   * Feed the column's existing distinct values back to the model as preferred
   * vocabulary. Same trick as the tag taxonomy, applied per column — it is
   * what stops a `sentiment` column accumulating "tense", "strained", and
   * "a bit tense" as three separate values.
   */
  converging: z.boolean().default(false),
  /** Reuse a value already derived on the page instead of re-inferring it. */
  from_page: z.string().optional(),
})

export const TableDefSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'table names must be lowercase snake_case'),
  description: z.string().default(''),
  /** Search-filter syntax: which captures/pages feed this table. */
  match: z.string().default(''),
  grain: z.enum(['one-per-source', 'many-per-source']).default('one-per-source'),
  prompt: z.string().optional(),
  columns: z.record(z.string(), ColumnSchema),
})

export type TableDef = z.infer<typeof TableDefSchema>
export type ColumnDef = z.infer<typeof ColumnSchema>

export interface LoadedTable {
  def: TableDef
  defHash: string
  path: string
}

export async function loadTable(l: Layout, name: string): Promise<LoadedTable> {
  const path = l.tableDef(name)
  if (!existsSync(path)) throw HopprError.notFound(`no table definition: ${name}`)
  return parseTableDef(await readFile(path, 'utf8'), l.rel(path))
}

export function parseTableDef(text: string, path: string): LoadedTable {
  let raw: unknown
  try {
    raw = parseToml(text)
  } catch (e) {
    throw HopprError.user(`cannot parse ${path}: ${(e as Error).message}`)
  }
  const parsed = TableDefSchema.safeParse(raw)
  if (!parsed.success) {
    const i = parsed.error.issues[0]
    throw HopprError.user(`${path}: ${i?.path.join('.') || '<root>'}: ${i?.message}`)
  }
  const def = parsed.data
  for (const [col, c] of Object.entries(def.columns)) {
    if (c.type === 'enum' && (!c.values || c.values.length === 0)) {
      throw HopprError.user(`${path}: column '${col}' is an enum with no values`)
    }
  }
  return { def, defHash: contentHash(JSON.stringify(def)), path }
}

export async function listTables(l: Layout): Promise<LoadedTable[]> {
  const files = await glob(['curated/tables/*.table.toml'], { cwd: l.root })
  const out: LoadedTable[] = []
  for (const f of files.sort()) {
    out.push(parseTableDef(await readFile(l.abs(f), 'utf8'), f))
  }
  return out
}

export async function saveTable(l: Layout, def: TableDef): Promise<string> {
  const body = renderTableDef(def)
  await writeIfChanged(l.tableDef(def.name), body)
  return l.rel(l.tableDef(def.name))
}

/** Hand-written rather than raw TOML dump: this file is meant to be edited. */
export function renderTableDef(def: TableDef): string {
  const head = [
    `name = ${JSON.stringify(def.name)}`,
    def.description ? `description = ${JSON.stringify(def.description)}` : '',
    `match = ${JSON.stringify(def.match)}`,
    `grain = ${JSON.stringify(def.grain)}`,
    def.prompt ? `prompt = ${JSON.stringify(def.prompt)}` : '',
    '',
    '[columns]',
  ].filter(Boolean)

  const cols = Object.entries(def.columns).map(([name, c]) => {
    const parts: string[] = [`type = ${JSON.stringify(c.type)}`]
    if (c.values?.length) parts.push(`values = ${stringifyToml({ v: c.values }).slice(4).trim()}`)
    if (c.required) parts.push('required = true')
    if (c.converging) parts.push('converging = true')
    if (c.from_page) parts.push(`from_page = ${JSON.stringify(c.from_page)}`)
    if (c.description) parts.push(`description = ${JSON.stringify(c.description)}`)
    return `${name} = { ${parts.join(', ')} }`
  })

  return `# Extraction table. Edit freely — changing a column marks affected rows
# stale, and the next curate pass backfills just that column rather than
# re-extracting everything you already have.
${head.join('\n')}
${cols.join('\n')}
`
}

/** A zod schema for one extracted row, derived from the column definitions. */
export function rowSchemaFor(def: TableDef): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [name, c] of Object.entries(def.columns)) {
    let base: z.ZodTypeAny
    switch (c.type) {
      case 'number':
        base = z.number()
        break
      case 'boolean':
        base = z.boolean()
        break
      case 'list[string]':
        base = z.array(z.string())
        break
      case 'list[number]':
        base = z.array(z.number())
        break
      case 'enum':
        // Not z.enum(): a converging column must be able to ACCEPT a new value
        // so it can be appended to the vocabulary. Validation of membership
        // happens in coercion, where we can widen instead of reject.
        base = z.string()
        break
      default:
        base = z.string()
    }
    shape[name] = c.required ? base : base.nullable().optional()
  }
  return z.object(shape).passthrough()
}

/**
 * Coerce defensively. A model returning `"3"` for a number, or a bare string
 * for a list, is a formatting slip — dropping the whole row over it loses real
 * information for no reason.
 */
export function coerceRow(def: TableDef, raw: Record<string, unknown>) {
  const out: Record<string, unknown> = {}
  const newEnumValues: Record<string, string[]> = {}

  for (const [name, c] of Object.entries(def.columns)) {
    const v = raw[name]
    if (v === undefined || v === null || v === '') {
      out[name] = null
      continue
    }
    switch (c.type) {
      case 'number': {
        const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''))
        out[name] = Number.isFinite(n) ? n : null
        break
      }
      case 'boolean':
        out[name] = typeof v === 'boolean' ? v : /^(true|yes|1)$/i.test(String(v))
        break
      case 'list[string]':
        out[name] = Array.isArray(v) ? v.map(String) : [String(v)]
        break
      case 'list[number]':
        out[name] = (Array.isArray(v) ? v : [v]).map(Number).filter(Number.isFinite)
        break
      case 'date': {
        const t = Date.parse(String(v))
        out[name] = Number.isNaN(t) ? String(v) : new Date(t).toISOString().slice(0, 10)
        break
      }
      case 'enum': {
        const s = String(v)
        const allowed = c.values ?? []
        if (allowed.includes(s)) out[name] = s
        else if (c.converging) {
          // Widen the vocabulary rather than discarding a real observation.
          out[name] = s
          const seen = newEnumValues[name] ?? []
          seen.push(s)
          newEnumValues[name] = seen
        } else {
          const near = allowed.find((a) => a.toLowerCase() === s.toLowerCase())
          out[name] = near ?? null
        }
        break
      }
      default:
        out[name] = String(v)
    }
  }
  return { row: out, newEnumValues }
}
