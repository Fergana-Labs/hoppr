import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db/open.ts'
import { coerceRow, parseTableDef, renderTableDef, rowSchemaFor } from '../src/tables/def.ts'
import { createView, runQuery, splitStatements, viewNameFor } from '../src/tables/sql.ts'

const DEF = `
name = "meetings"
description = "Meetings I attended."
match = "kind:session"
grain = "one-per-source"

[columns]
date = { type = "date", required = true }
attendees = { type = "list[string]" }
sentiment = { type = "enum", values = ["positive", "neutral"], converging = true }
score = { type = "number" }
`

describe('table definitions', () => {
  it('parses and round-trips through the rendered form', () => {
    const t = parseTableDef(DEF, 'x.toml')
    expect(t.def.name).toBe('meetings')
    expect(Object.keys(t.def.columns)).toEqual(['date', 'attendees', 'sentiment', 'score'])
    const again = parseTableDef(renderTableDef(t.def), 'x.toml')
    expect(again.def).toEqual(t.def)
  })

  it('rejects a bad name and an enum with no values', () => {
    expect(() => parseTableDef('name = "Bad Name"\n[columns]\na = {type="string"}', 'x')).toThrow(
      /snake_case/,
    )
    expect(() => parseTableDef('name = "t"\n[columns]\na = {type="enum"}', 'x')).toThrow(
      /no values/,
    )
  })

  it('changing a column changes the hash, which is what triggers a backfill', () => {
    const a = parseTableDef(DEF, 'x')
    const b = parseTableDef(`${DEF}\nextra = { type = "string" }\n`, 'x')
    expect(b.defHash).not.toBe(a.defHash)
  })
})

describe('row coercion', () => {
  const def = parseTableDef(DEF, 'x').def

  it('coerces the formatting slips models actually make', () => {
    const { row } = coerceRow(def, {
      date: 'August 14, 2026',
      attendees: 'sam', // a bare string where a list was asked for
      sentiment: 'positive',
      score: '42',
    })
    expect(row.date).toBe('2026-08-14')
    expect(row.attendees).toEqual(['sam'])
    expect(row.score).toBe(42)
  })

  it('nulls a missing value rather than inventing one', () => {
    const { row } = coerceRow(def, { date: '2026-01-01' })
    expect(row.attendees).toBeNull()
    expect(row.score).toBeNull()
  })

  it('widens a converging enum instead of discarding the observation', () => {
    const { row, newEnumValues } = coerceRow(def, { date: '2026-01-01', sentiment: 'tense' })
    expect(row.sentiment).toBe('tense')
    expect(newEnumValues.sentiment).toEqual(['tense'])
  })

  it('rejects an out-of-range value on a NON-converging enum', () => {
    const strict = parseTableDef(
      'name = "t"\n[columns]\nk = { type = "enum", values = ["a","b"] }',
      'x',
    ).def
    expect(coerceRow(strict, { k: 'zzz' }).row.k).toBeNull()
    // …but a pure case difference is a slip, not a new value.
    expect(coerceRow(strict, { k: 'A' }).row.k).toBe('a')
  })

  it('builds a schema that accepts nulls for optional columns', () => {
    const schema = rowSchemaFor(def)
    expect(schema.safeParse({ date: '2026-01-01' }).success).toBe(true)
    expect(schema.safeParse({ attendees: ['a'] }).success).toBe(false) // date is required
  })
})

describe('generated views and the read-only gate', () => {
  async function seeded() {
    const { db } = await openDb(':memory:', { vector: false })
    const def = parseTableDef(DEF, 'x').def
    createView(db, def)
    const ins = db.prepare(
      "INSERT INTO tbl_rows(table_name,row_id,raw_id,data) VALUES ('meetings',:r,:raw,:d)",
    )
    ins.run({
      r: 'r1',
      raw: 'RAW1',
      d: JSON.stringify({ date: '2026-08-14', sentiment: 'positive', score: 3 }),
    })
    ins.run({
      r: 'r2',
      raw: 'RAW2',
      d: JSON.stringify({ date: '2026-08-15', sentiment: 'tense', score: 5 }),
    })
    return db
  }

  it('exposes JSON cells as real columns', async () => {
    const db = await seeded()
    const r = runQuery(
      db,
      `SELECT date, sentiment, score FROM ${viewNameFor('meetings')} ORDER BY date`,
    )
    expect(r.rows).toEqual([
      { date: '2026-08-14', sentiment: 'positive', score: 3 },
      { date: '2026-08-15', sentiment: 'tense', score: 5 },
    ])
    db.close()
  })

  it('keeps provenance so every cell traces back to a capture', async () => {
    const db = await seeded()
    const r = runQuery(db, 'SELECT raw_id FROM v_meetings ORDER BY raw_id')
    expect(r.rows.map((x) => x.raw_id)).toEqual(['RAW1', 'RAW2'])
    db.close()
  })

  it('aggregates', async () => {
    const db = await seeded()
    const r = runQuery(
      db,
      'SELECT sentiment, COUNT(*) n FROM v_meetings GROUP BY sentiment ORDER BY sentiment',
    )
    expect(r.rows).toHaveLength(2)
    db.close()
  })

  for (const bad of [
    'DROP TABLE raw',
    'DELETE FROM raw',
    'UPDATE raw SET text = 1',
    'INSERT INTO raw VALUES (1)',
    'ATTACH DATABASE "/etc/passwd" AS x',
    'PRAGMA writable_schema = 1',
    'SELECT 1; DROP TABLE raw',
    'select 1; delete from raw',
  ]) {
    it(`refuses: ${bad.slice(0, 34)}`, async () => {
      const db = await seeded()
      expect(() => runQuery(db, bad)).toThrow()
      db.close()
    })
  }

  it('allows a semicolon inside a string literal', () => {
    expect(splitStatements("SELECT ';' AS x")).toHaveLength(1)
    expect(splitStatements('SELECT 1; SELECT 2')).toHaveLength(2)
  })

  it('allows WITH, and caps runaway result sets', async () => {
    const db = await seeded()
    expect(() => runQuery(db, 'WITH t AS (SELECT 1 AS a) SELECT * FROM t')).not.toThrow()
    const r = runQuery(db, 'SELECT * FROM v_meetings', { maxRows: 1 })
    expect(r.rows).toHaveLength(1)
    expect(r.truncated).toBe(true)
    db.close()
  })
})
