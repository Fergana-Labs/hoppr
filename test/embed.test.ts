import { describe, expect, it } from 'vitest'
import type { Db } from '../src/db/driver.ts'
import { openDb } from '../src/db/open.ts'
import {
  type Embedder,
  fitDimension,
  fromBlob,
  normalize,
  toBlob,
  vecInt,
} from '../src/embed/provider.ts'
import { embedPending, ensureVecTable, failedDocs, resetFailures } from '../src/embed/reconcile.ts'
import { parseQuery } from '../src/search/query.ts'
import { vectorSearch } from '../src/search/vector.ts'

/** Deterministic stand-in: no model download, fully reproducible vectors. */
class FakeEmbedder implements Embedder {
  readonly id = 'fake'
  readonly model = 'fake-v1'
  readonly dim = 8
  calls = 0
  failOn: (t: string) => boolean = () => false

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls++
    return texts.map((t) => {
      if (this.failOn(t)) throw new Error(`poison chunk: ${t.slice(0, 20)}`)
      const v = new Float32Array(this.dim)
      for (let i = 0; i < t.length; i++) v[i % this.dim]! += t.charCodeAt(i) / 255
      return normalize(v)
    })
  }
}

async function seededDb(texts: string[]): Promise<Db> {
  const { db } = await openDb(':memory:', { vector: true })
  texts.forEach((t, i) => {
    db.prepare(
      `INSERT INTO docs(id,tier,kind,ref_id,title,summary,body,tags_text,created,updated,content_hash)
       VALUES (:id,'curated','concept',:id,:t,'',:t,'',:c,:c,:h)`,
    ).run({ id: `d${i}`, t, c: 1_700_000_000_000 + i, h: `h${i}` })
    db.prepare(
      'INSERT INTO chunks(doc_id, ord, heading, text, chunk_hash) VALUES (:d,0,NULL,:t,:h)',
    ).run({ d: `d${i}`, t, h: `ch${i}` })
  })
  return db
}

describe('vec0 binding', () => {
  /**
   * Regression test for a bug that silently disabled vector search: both
   * SQLite drivers bind plain JS numbers with REAL affinity, and vec0 rejects
   * a REAL primary key. Everything else looked healthy while search quietly
   * returned nothing.
   */
  it('rejects a REAL primary key and accepts vecInt', async () => {
    const { db } = await openDb(':memory:', { vector: true })
    ensureVecTable(db, 4, 'test')
    const vec = toBlob(new Float32Array([1, 0, 0, 0]))
    const row = { v: vec, tier: 'raw', kind: 'x', day: vecInt(20_000), doc: 'd' }

    expect(() =>
      db
        .prepare(
          'INSERT INTO vec_chunks(chunk_id,embedding,tier,kind,created_day,doc_id) VALUES (:id,:v,:tier,:kind,:day,:doc)',
        )
        .run({ ...row, id: 1 }),
    ).toThrow(/integer/i)

    expect(() =>
      db
        .prepare(
          'INSERT INTO vec_chunks(chunk_id,embedding,tier,kind,created_day,doc_id) VALUES (:id,:v,:tier,:kind,:day,:doc)',
        )
        .run({ ...row, id: vecInt(1) }),
    ).not.toThrow()

    expect(db.prepare<{ n: number }>('SELECT COUNT(*) n FROM vec_chunks').get()?.n).toBe(1)
    db.close()
  })

  it('refuses to open at a different dimension rather than returning garbage neighbours', async () => {
    const { db } = await openDb(':memory:', { vector: true })
    ensureVecTable(db, 8, 'model-a')
    expect(() => ensureVecTable(db, 384, 'model-b')).toThrow(/reindex --full/)
    db.close()
  })
})

describe('vector helpers', () => {
  it('normalizes to unit length', () => {
    const v = normalize(new Float32Array([3, 4]))
    expect(Math.hypot(v[0]!, v[1]!)).toBeCloseTo(1, 6)
  })
  it('truncates longer vectors so a provider swap is not a schema migration', () => {
    expect(fitDimension(new Float32Array([1, 2, 3, 4]), 2).length).toBe(2)
  })
  it('refuses to pad a shorter vector, and says what to change', () => {
    expect(() => fitDimension(new Float32Array([1, 2]), 4)).toThrow(/set \[embed\] dim = 2/)
  })
  it('round-trips through a blob', () => {
    const v = normalize(new Float32Array([0.1, 0.2, 0.3, 0.4]))
    const back = fromBlob(toBlob(v))
    expect([...back]).toEqual([...v])
  })
})

describe('reconciler', () => {
  it('embeds pending docs and reports what it did', async () => {
    const db = await seededDb(['alpha text', 'beta text', 'gamma text'])
    const e = new FakeEmbedder()
    const st = await embedPending(db, e)
    expect(st.embedded).toBe(3)
    expect(st.failed).toBe(0)
    expect(st.remaining).toBe(0)
    expect(db.prepare<{ n: number }>('SELECT COUNT(*) n FROM vec_chunks').get()?.n).toBe(3)
    db.close()
  })

  it('restores from cache instead of recomputing — this is what makes reindex free', async () => {
    const db = await seededDb(['alpha text', 'beta text'])
    const e = new FakeEmbedder()
    await embedPending(db, e)
    const callsAfterFirst = e.calls

    // Simulate a rebuild: vectors gone, docs stale again, cache intact.
    db.exec('DELETE FROM vec_chunks')
    db.exec('UPDATE docs SET embed_stale = 1')

    const st = await embedPending(db, e)
    expect(st.cached).toBe(2)
    expect(st.embedded).toBe(0)
    expect(e.calls).toBe(callsAfterFirst) // not one extra model call
    db.close()
  })

  it('fails terminally per row: one poison doc cannot wedge the sweep', async () => {
    const db = await seededDb(['good one', 'POISON', 'good two', 'good three'])
    const e = new FakeEmbedder()
    e.failOn = (t) => t.includes('POISON')

    // Three passes: each retries the poison row once, the others succeed and stay done.
    for (let i = 0; i < 3; i++) await embedPending(db, e)

    const failed = failedDocs(db)
    expect(failed).toHaveLength(1)
    expect(failed[0]!.fails).toBeGreaterThanOrEqual(3)

    // Everything else completed, and the sweep terminates rather than looping.
    const pending = db
      .prepare<{ n: number }>(
        'SELECT COUNT(*) n FROM docs WHERE embed_stale = 1 AND embed_fails < 3',
      )
      .get()?.n
    expect(pending).toBe(0)
    expect(db.prepare<{ n: number }>('SELECT COUNT(*) n FROM vec_chunks').get()?.n).toBe(3)

    // And the terminal row is recoverable on demand, not lost.
    expect(resetFailures(db)).toBe(1)
    db.close()
  })

  it('re-embeds only what changed', async () => {
    const db = await seededDb(['alpha', 'beta'])
    const e = new FakeEmbedder()
    await embedPending(db, e)
    db.prepare("UPDATE docs SET embed_stale = 1 WHERE id = 'd0'").run()
    const st = await embedPending(db, e)
    expect(st.cached + st.embedded).toBe(1)
    db.close()
  })
})

describe('vector search', () => {
  it('ranks by cosine distance and returns one hit per document', async () => {
    const db = await seededDb(['the quick brown fox', 'a slow green turtle'])
    const e = new FakeEmbedder()
    await embedPending(db, e)

    const q = (await e.embed(['the quick brown fox']))[0]!
    const hits = vectorSearch(db, q, parseQuery('').filters, 10)
    expect(hits[0]!.docId).toBe('d0')
    expect(new Set(hits.map((h) => h.docId)).size).toBe(hits.length)
    db.close()
  })

  it('applies tag and project filters exactly, via brute force', async () => {
    const db = await seededDb(['alpha one', 'alpha two'])
    db.prepare("UPDATE docs SET project = 'keep' WHERE id = 'd0'").run()
    db.prepare("UPDATE docs SET project = 'drop' WHERE id = 'd1'").run()
    const e = new FakeEmbedder()
    await embedPending(db, e)

    const q = (await e.embed(['alpha']))[0]!
    const hits = vectorSearch(db, q, parseQuery('project:keep').filters, 10)
    expect(hits.map((h) => h.docId)).toEqual(['d0'])
    db.close()
  })

  it('returns nothing rather than throwing when no vectors exist yet', async () => {
    const db = await seededDb(['alpha'])
    const hits = vectorSearch(db, new Float32Array(8), parseQuery('').filters, 10)
    expect(hits).toEqual([])
    db.close()
  })
})
