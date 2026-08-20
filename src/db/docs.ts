import { contentHash } from '../core/hash.ts'
import type { Confidence } from '../core/types.ts'
import { buildCard, chunkDocument } from '../search/chunk.ts'
import type { Db } from './driver.ts'

export interface DocInput {
  id: string
  tier: 'raw' | 'curated'
  kind: string
  refId: string
  title?: string
  summary?: string
  body?: string
  tags?: string[]
  project?: string
  confidence?: Confidence
  created: number
  updated: number
}

export interface ChunkOpts {
  maxChars: number
  overlap: number
}

export type UpsertResult = 'inserted' | 'updated' | 'unchanged'

/**
 * Upsert one artifact into the unified search projection.
 *
 * Everything searchable goes through this single function — raw captures,
 * wiki pages, extracted table rows, skills. That is what guarantees a new
 * artifact type is searchable both lexically and semantically the moment it
 * exists, instead of needing its own FTS table and its own vector arm.
 *
 * Re-chunking is gated on the content hash: an unchanged document costs one
 * hash comparison and no writes, which is what keeps a full reindex cheap.
 */
export function upsertDoc(db: Db, input: DocInput, chunkOpts: ChunkOpts): UpsertResult {
  const card = buildCard({
    title: input.title,
    summary: input.summary,
    tags: input.tags,
    kind: input.kind,
    project: input.project,
  })
  const body = input.body ?? ''
  const hash = contentHash([card, body].join('\n\n'))

  const existing = db
    .prepare<{ content_hash: string }>('SELECT content_hash FROM docs WHERE id = :id')
    .get({ id: input.id })

  if (existing?.content_hash === hash) return 'unchanged'

  const row = {
    id: input.id,
    tier: input.tier,
    kind: input.kind,
    ref_id: input.refId,
    title: input.title ?? '',
    summary: input.summary ?? '',
    body,
    tags_text: (input.tags ?? []).join(' '),
    project: input.project ?? null,
    confidence: input.confidence ?? 'medium',
    created: input.created,
    updated: input.updated,
    content_hash: hash,
  }

  return db.transaction((): UpsertResult => {
    if (existing) {
      db.prepare(
        `UPDATE docs SET
           tier=:tier, kind=:kind, ref_id=:ref_id, title=:title, summary=:summary, body=:body,
           tags_text=:tags_text, project=:project, confidence=:confidence,
           created=:created, updated=:updated, content_hash=:content_hash,
           embed_stale=1, embed_fails=0
         WHERE id=:id`,
      ).run(row)
    } else {
      db.prepare(
        `INSERT INTO docs
           (id,tier,kind,ref_id,title,summary,body,tags_text,project,confidence,created,updated,content_hash)
         VALUES
           (:id,:tier,:kind,:ref_id,:title,:summary,:body,:tags_text,:project,:confidence,:created,:updated,:content_hash)`,
      ).run(row)
    }
    rechunk(db, input.id, card, body, chunkOpts)
    return existing ? 'updated' : 'inserted'
  })
}

function rechunk(db: Db, docId: string, card: string, body: string, o: ChunkOpts): void {
  db.prepare('DELETE FROM chunks WHERE doc_id = :id').run({ id: docId })
  const ins = db.prepare(
    'INSERT INTO chunks(doc_id, ord, heading, text, chunk_hash) VALUES (:d,:o,:h,:t,:c)',
  )
  for (const ch of chunkDocument(card, body, { maxChars: o.maxChars, overlap: o.overlap })) {
    ins.run({ d: docId, o: ch.ord, h: ch.heading, t: ch.text, c: ch.chunkHash })
  }
}

export function deleteDoc(db: Db, id: string): void {
  db.prepare('DELETE FROM docs WHERE id = :id').run({ id })
}

/** Remove docs whose backing artifact no longer exists on disk. */
export function pruneDocs(db: Db, keepIds: Set<string>, tier?: 'raw' | 'curated'): number {
  const rows = db
    .prepare<{ id: string }>(
      tier ? 'SELECT id FROM docs WHERE tier = :tier' : 'SELECT id FROM docs',
    )
    .all(tier ? { tier } : undefined)
  let n = 0
  for (const r of rows) {
    if (!keepIds.has(r.id)) {
      deleteDoc(db, r.id)
      n++
    }
  }
  return n
}

// ── id conventions ────────────────────────────────────────────────
export const docId = {
  raw: (id: string) => `raw:${id}`,
  wiki: (type: string, slug: string) => `wiki:${type}/${slug}`,
  row: (table: string, rowId: string) => `row:${table}/${rowId}`,
  skill: (slug: string) => `skill:${slug}`,
}

export function parseDocId(id: string): { scheme: string; rest: string } {
  const i = id.indexOf(':')
  return i < 0 ? { scheme: 'unknown', rest: id } : { scheme: id.slice(0, i), rest: id.slice(i + 1) }
}
