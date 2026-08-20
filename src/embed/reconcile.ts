import { HopprError } from '../core/errors.ts'
import type { Db } from '../db/driver.ts'
import { getMeta, setMeta } from '../db/open.ts'
import { type Embedder, fromBlob, toBlob, vecInt } from './provider.ts'

export interface EmbedStats {
  embedded: number
  cached: number
  failed: number
  remaining: number
}

/**
 * The vec0 table is created at runtime rather than in a migration, because its
 * width is config-driven and vec0 columns are fixed-width. `embed_dim` and
 * `embed_model` are recorded in meta so a later mismatch is caught loudly at
 * open time instead of producing silently garbage neighbours.
 */
export function ensureVecTable(db: Db, dim: number, model: string): void {
  const storedDim = getMeta(db, 'embed_dim')
  const storedModel = getMeta(db, 'embed_model')

  if (storedDim && Number(storedDim) !== dim) {
    throw HopprError.user(
      `index holds ${storedDim}-dim vectors but ${dim} are configured` +
        `${storedModel ? ` (model was ${storedModel})` : ''}.\n` +
        `Run \`hoppr reindex --full\` to rebuild at the new dimension.`,
    )
  }

  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
    chunk_id INTEGER PRIMARY KEY,
    embedding FLOAT[${dim}] distance_metric=cosine,
    tier TEXT,
    kind TEXT,
    created_day INTEGER,
    +doc_id TEXT
  )`)

  setMeta(db, 'embed_dim', String(dim))
  setMeta(db, 'embed_model', model)
}

interface PendingChunk {
  chunk_id: number
  doc_id: string
  text: string
  chunk_hash: string
  tier: string
  kind: string
  created: number
}

/**
 * The stale-flag reconciler.
 *
 * Two properties matter more than throughput:
 *
 *  1. **Cache before compute.** Vectors are keyed by (chunk_hash, model), so an
 *     unchanged chunk — including every chunk after a full `reindex` — is
 *     restored for free. This is what makes the index genuinely disposable
 *     rather than merely rebuildable-if-you-can-afford-it.
 *
 *  2. **Failure is terminal per row, never per batch.** A document that throws
 *     increments its own counter and the batch continues; at three strikes it
 *     leaves the sweep's partial index permanently and is surfaced by
 *     `hoppr doctor`. Without this, one malformed capture is re-selected
 *     forever and wedges every future pass behind it.
 */
export async function embedPending(
  db: Db,
  embedder: Embedder,
  opts: { batch?: number; limit?: number; onProgress?: (s: EmbedStats) => void } = {},
): Promise<EmbedStats> {
  ensureVecTable(db, embedder.dim, embedder.model)
  const batch = opts.batch ?? 32
  const stats: EmbedStats = { embedded: 0, cached: 0, failed: 0, remaining: 0 }
  let processed = 0

  for (;;) {
    const docs = db
      .prepare<{ id: string }>(
        `SELECT id FROM docs
          WHERE embed_stale = 1 AND embed_fails < 3
          ORDER BY updated DESC
          LIMIT :n`,
      )
      .all({ n: batch })
    if (docs.length === 0) break

    for (const { id } of docs) {
      if (opts.limit && processed >= opts.limit) break
      processed++
      try {
        const r = await embedDoc(db, embedder, id)
        stats.embedded += r.embedded
        stats.cached += r.cached
      } catch (e) {
        stats.failed++
        db.prepare(
          `UPDATE docs SET embed_fails = embed_fails + 1,
             -- Three strikes and the row leaves the partial index for good.
             embed_stale = CASE WHEN embed_fails + 1 >= 3 THEN 0 ELSE 1 END
           WHERE id = :id`,
        ).run({ id })
        if (e instanceof HopprError && e.kind === 'user') throw e
      }
      opts.onProgress?.(stats)
    }
    if (opts.limit && processed >= opts.limit) break
  }

  stats.remaining =
    db
      .prepare<{ n: number }>(
        'SELECT COUNT(*) n FROM docs WHERE embed_stale = 1 AND embed_fails < 3',
      )
      .get()?.n ?? 0
  return stats
}

async function embedDoc(
  db: Db,
  embedder: Embedder,
  docId: string,
): Promise<{ embedded: number; cached: number }> {
  const chunks = db
    .prepare<PendingChunk>(
      `SELECT c.id AS chunk_id, c.doc_id, c.text, c.chunk_hash,
              d.tier, d.kind, d.created
         FROM chunks c JOIN docs d ON d.id = c.doc_id
        WHERE c.doc_id = :id
        ORDER BY c.ord`,
    )
    .all({ id: docId })

  let cached = 0
  let embedded = 0
  const needed: PendingChunk[] = []

  db.prepare('DELETE FROM vec_chunks WHERE doc_id = :id').run({ id: docId })

  for (const ch of chunks) {
    const hit = db
      .prepare<{ vec: Uint8Array }>(
        'SELECT vec FROM embedding_cache WHERE chunk_hash = :h AND model = :m',
      )
      .get({ h: ch.chunk_hash, m: embedder.model })
    if (hit) {
      insertVec(db, ch, fromBlob(hit.vec))
      cached++
    } else {
      needed.push(ch)
    }
  }

  if (needed.length > 0) {
    const vecs = await embedder.embed(needed.map((c) => c.text))
    db.transaction(() => {
      needed.forEach((ch, i) => {
        const v = vecs[i]!
        insertVec(db, ch, v)
        db.prepare(
          `INSERT OR REPLACE INTO embedding_cache(chunk_hash, model, dim, vec, created_at)
           VALUES (:h, :m, :d, :v, :t)`,
        ).run({ h: ch.chunk_hash, m: embedder.model, d: embedder.dim, v: toBlob(v), t: Date.now() })
      })
    })
    embedded = needed.length
  }

  db.prepare(
    `UPDATE docs SET embed_stale = 0, embed_fails = 0, embed_hash = content_hash WHERE id = :id`,
  ).run({ id: docId })

  return { embedded, cached }
}

function insertVec(db: Db, ch: PendingChunk, vec: Float32Array): void {
  db.prepare(
    `INSERT OR REPLACE INTO vec_chunks(chunk_id, embedding, tier, kind, created_day, doc_id)
     VALUES (:id, :v, :tier, :kind, :day, :doc)`,
  ).run({
    id: vecInt(ch.chunk_id),
    v: toBlob(vec),
    tier: ch.tier,
    kind: ch.kind,
    day: vecInt(ch.created / 86_400_000),
    doc: ch.doc_id,
  })
}

/** Rows that gave up. Surfaced by `hoppr doctor`, retryable with `hoppr retry`. */
export function failedDocs(db: Db): Array<{ id: string; fails: number }> {
  return db
    .prepare<{ id: string; fails: number }>(
      'SELECT id, embed_fails AS fails FROM docs WHERE embed_fails >= 3',
    )
    .all()
}

export function resetFailures(db: Db): number {
  return db.prepare('UPDATE docs SET embed_fails = 0, embed_stale = 1 WHERE embed_fails >= 3').run()
    .changes
}
