import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { glob } from 'tinyglobby'
import type { Config } from '../config/schema.ts'
import { contentHash } from '../core/hash.ts'
import type { PageType } from '../core/types.ts'
import { extract } from '../intake/extract/index.ts'
import { parsePage } from '../store/frontmatter.ts'
import type { Layout } from '../store/layout.ts'
import * as rawStore from '../store/raw.ts'
import { pageKey } from '../store/wiki.ts'
import { type ChunkOpts, docId, pruneDocs, upsertDoc } from './docs.ts'
import type { Db } from './driver.ts'

export interface CachedVector {
  chunk_hash: string
  model: string
  dim: number
  vec: Uint8Array
  created_at: number
}

/**
 * Carry the embedding cache across a full rebuild.
 *
 * `reindex --full` deletes the database — and the cache lives inside it, so a
 * naive rebuild throws away the only expensive artifact in the system and
 * re-embeds the entire corpus. Saving and restoring it is what makes "the
 * index is disposable" true in tokens as well as in principle.
 *
 * Failing to read the cache is not fatal: the whole point of a full rebuild is
 * that it works even when the database is damaged.
 */
export function saveEmbeddingCache(db: Db): CachedVector[] {
  try {
    return db
      .prepare<CachedVector>('SELECT chunk_hash, model, dim, vec, created_at FROM embedding_cache')
      .all()
  } catch {
    return []
  }
}

export function restoreEmbeddingCache(db: Db, rows: CachedVector[]): number {
  if (rows.length === 0) return 0
  const ins = db.prepare(
    `INSERT OR REPLACE INTO embedding_cache(chunk_hash, model, dim, vec, created_at)
     VALUES (:h,:m,:d,:v,:t)`,
  )
  db.transaction(() => {
    for (const r of rows) {
      ins.run({ h: r.chunk_hash, m: r.model, d: r.dim, v: r.vec, t: r.created_at })
    }
  })
  return rows.length
}

export interface ReindexStats {
  raw: { scanned: number; inserted: number; updated: number; unchanged: number }
  wiki: { scanned: number; inserted: number; updated: number; unchanged: number }
  pruned: number
  embedCacheHits: number
}

/**
 * Rebuild the index from the two tracked tiers.
 *
 * This is the function that makes the database disposable, and the disposable
 * database is what makes everything else safe to get wrong. A bad migration,
 * a corrupt file, a schema change — the answer is always "delete it and
 * reindex", never a careful repair of state you cannot reproduce.
 *
 * `embedding_cache` is keyed by (chunk_hash, model) rather than by row id, so
 * a rebuild re-inserts vectors straight from cache: reindex is cheap in time
 * AND free in tokens.
 */
export async function reindex(
  db: Db,
  l: Layout,
  cfg: Config,
  opts: { prune?: boolean } = {},
): Promise<ReindexStats> {
  const chunkOpts: ChunkOpts = {
    maxChars: cfg.index.chunk_chars,
    overlap: cfg.index.chunk_overlap,
  }
  const stats: ReindexStats = {
    raw: { scanned: 0, inserted: 0, updated: 0, unchanged: 0 },
    wiki: { scanned: 0, inserted: 0, updated: 0, unchanged: 0 },
    pruned: 0,
    embedCacheHits: 0,
  }
  const seen = new Set<string>()

  // Reference rows have no file under raw/ to walk — their truth is the
  // external path plus the extracted text already in the index. Rebuilding
  // those means re-projecting, not re-reading someone else's folder.
  for (const row of db
    .prepare<{
      id: string
      kind: string
      title: string | null
      text: string | null
      created: number
      captured: number
      origin: string | null
    }>(
      "SELECT id, kind, title, text, created, captured, origin FROM raw WHERE raw_mode = 'reference'",
    )
    .all()) {
    stats.raw.scanned++
    // Safety net for the sync-time prune: if the file is gone, so is the row.
    // Guarded on the parent directory still existing, so an unmounted volume
    // does not read as a mass deletion.
    const ext = row.origin
      ? (JSON.parse(row.origin) as { external_path?: string }).external_path
      : undefined
    if (ext && !existsSync(ext) && existsSync(dirname(ext))) {
      db.prepare('DELETE FROM raw WHERE id = :id').run({ id: row.id })
      continue
    }
    const id = docId.raw(row.id)
    seen.add(id)
    const r = upsertDoc(
      db,
      {
        id,
        tier: 'raw',
        kind: row.kind,
        refId: row.id,
        title: row.title ?? '',
        body: row.text ?? '',
        tags: originTags(row.origin ? JSON.parse(row.origin) : undefined),
        project: originProject(row.origin ? JSON.parse(row.origin) : undefined),
        created: row.created,
        updated: row.captured,
      },
      chunkOpts,
    )
    stats.raw[r === 'inserted' ? 'inserted' : r === 'updated' ? 'updated' : 'unchanged']++
  }

  for (const rec of await rawStore.list(l)) {
    stats.raw.scanned++
    const ex = await extract(l, rec).catch(() => ({ text: rec.title ?? '', binary: true }))
    const created = Date.parse(rec.created) || Date.now()
    const captured = Date.parse(rec.captured) || created
    const st = await stat(l.abs(rec.path)).catch(() => undefined)
    const text = ex.text
    const hash = contentHash(text)

    db.prepare(
      `INSERT INTO raw
         (id,path,kind,source,external_id,media_type,title,bytes,content_hash,
          created,captured,file_mtime_ms,text,origin,partial)
       VALUES
         (:id,:path,:kind,:source,:external_id,:media_type,:title,:bytes,:content_hash,
          :created,:captured,:mtime,:text,:origin,:partial)
       ON CONFLICT(id) DO UPDATE SET
         path=:path, title=:title, bytes=:bytes, captured=:captured, file_mtime_ms=:mtime,
         text=:text, origin=:origin, partial=:partial,
         content_hash=:content_hash,
         -- Staleness is a hash comparison, never a bare boolean: re-scanning an
         -- unchanged capture must cost zero tokens.
         curate_stale = CASE WHEN raw.curate_hash IS :content_hash THEN raw.curate_stale ELSE 1 END`,
    ).run({
      id: rec.id,
      path: rec.path,
      kind: rec.kind,
      source: rec.source,
      external_id: rec.external_id ?? null,
      media_type: rec.media_type,
      title: rec.title ?? null,
      bytes: rec.bytes,
      content_hash: hash,
      created,
      captured,
      mtime: st ? Math.round(st.mtimeMs) : 0,
      text,
      origin: rec.origin ? JSON.stringify(rec.origin) : null,
      partial: rec.partial ? 1 : 0,
    })

    const id = docId.raw(rec.id)
    seen.add(id)
    const r = upsertDoc(
      db,
      {
        id,
        tier: 'raw',
        kind: rec.kind,
        refId: rec.id,
        title: rec.title ?? '',
        body: text,
        tags: originTags(rec.origin),
        project: originProject(rec.origin),
        created,
        updated: captured,
      },
      chunkOpts,
    )
    stats.raw[r === 'inserted' ? 'inserted' : r === 'updated' ? 'updated' : 'unchanged']++
  }

  for (const rel of (await glob(['curated/wiki/*/*.md'], { cwd: l.root })).sort()) {
    stats.wiki.scanned++
    const parsed = parsePage(await readFile(l.abs(rel), 'utf8'))
    const d = parsed.data as Record<string, unknown>
    const machine = (d.hoppr ?? {}) as Record<string, unknown>
    const type = String(d.type ?? 'source') as PageType
    const slug = rel.split('/').pop()!.replace(/\.md$/, '')
    const id = docId.wiki(type, slug)
    seen.add(id)

    // Derive the key rather than trusting frontmatter: older pages carry an
    // id scheme that collided, and reindex is how a store heals from that.
    const pageId = pageKey(type, slug)
    const created = Date.parse(String(d.created ?? '')) || Date.now()
    const updated = Date.parse(String(d.updated ?? '')) || created
    const tags = Array.isArray(d.tags) ? (d.tags as string[]) : []

    // A row for this (type, slug) under an older id scheme would collide on
    // the unique index rather than the primary key. Reindex is how a store
    // heals from a key change, so clear the impostor first.
    db.prepare('DELETE FROM wiki WHERE page_type = :t AND slug = :s AND id <> :id').run({
      t: type,
      s: slug,
      id: pageId,
    })
    db.prepare(
      `INSERT INTO wiki
         (id,path,slug,page_type,title,summary,body,project,confidence,fields,
          created,updated,pass_id,source_hash,prompt_hash,pinned)
       VALUES
         (:id,:path,:slug,:type,:title,:summary,:body,:project,:confidence,:fields,
          :created,:updated,:pass,:shash,:phash,:pinned)
       ON CONFLICT(id) DO UPDATE SET
         path=:path, slug=:slug, page_type=:type, title=:title, summary=:summary,
         body=:body, project=:project, confidence=:confidence, fields=:fields,
         updated=:updated, pass_id=:pass, source_hash=:shash, prompt_hash=:phash, pinned=:pinned`,
    ).run({
      id: pageId,
      path: rel,
      slug,
      type,
      title: String(d.title ?? slug),
      summary: typeof d.summary === 'string' ? d.summary : null,
      body: parsed.body,
      project: typeof d.project === 'string' ? d.project : null,
      confidence: String(d.confidence ?? 'medium'),
      fields: JSON.stringify(userFields(d)),
      created,
      updated,
      pass: machine.pass ? String(machine.pass) : null,
      shash: machine.source_hash ? String(machine.source_hash) : null,
      phash: machine.prompt_hash ? String(machine.prompt_hash) : null,
      pinned: machine.pinned === true ? 1 : 0,
    })

    db.prepare('DELETE FROM wiki_tags WHERE page_id = :id').run({ id: pageId })
    const insTag = db.prepare(
      'INSERT OR IGNORE INTO wiki_tags(page_id, tag, origin) VALUES (:p, :t, :o)',
    )
    for (const t of tags) insTag.run({ p: pageId, t, o: 'agent' })

    db.prepare('DELETE FROM wiki_sources WHERE page_id = :id').run({ id: pageId })
    const insSrc = db.prepare('INSERT OR IGNORE INTO wiki_sources(page_id, raw_id) VALUES (:p, :r)')
    for (const rawId of rawIdsFrom(d, machine)) insSrc.run({ p: pageId, r: rawId })

    db.prepare('DELETE FROM wiki_links WHERE from_id = :id').run({ id: pageId })
    const insLink = db.prepare(
      'INSERT OR IGNORE INTO wiki_links(from_id, to_slug, route, resolved) VALUES (:f, :t, :r, 0)',
    )
    for (const to of wikilinksIn(parsed.body, d)) {
      insLink.run({ f: pageId, t: to, r: 'related' })
    }

    const r = upsertDoc(
      db,
      {
        id,
        tier: 'curated',
        kind: type,
        refId: pageId,
        title: String(d.title ?? slug),
        summary: typeof d.summary === 'string' ? d.summary : '',
        body: parsed.body,
        tags,
        project: typeof d.project === 'string' ? d.project : undefined,
        confidence: (String(d.confidence ?? 'medium') as 'high' | 'medium' | 'low') ?? 'medium',
        created,
        updated,
      },
      chunkOpts,
    )
    stats.wiki[r === 'inserted' ? 'inserted' : r === 'updated' ? 'updated' : 'unchanged']++
  }

  // A [[link]] resolves once its target page exists. Anything left unresolved
  // is a dangling link and becomes a lint finding, not a silent dead end.
  db.exec(`UPDATE wiki_links SET resolved = CASE
             WHEN EXISTS (SELECT 1 FROM wiki w WHERE w.slug = wiki_links.to_slug) THEN 1 ELSE 0 END`)

  if (opts.prune !== false) stats.pruned = pruneDocs(db, seen)
  stats.embedCacheHits = primeFromCache(db, cfg.embed.model)
  return stats
}

/**
 * Fill vectors from the content-addressed cache. This is why a rebuild costs
 * no tokens: the same chunk text under the same model is the same vector.
 */
function primeFromCache(db: Db, model: string): number {
  const row = db
    .prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM chunks c
        WHERE EXISTS (SELECT 1 FROM embedding_cache e
                       WHERE e.chunk_hash = c.chunk_hash AND e.model = :m)`,
    )
    .get({ m: model })
  return row?.n ?? 0
}

function userFields(d: Record<string, unknown>): Record<string, unknown> {
  const known = new Set([
    'title',
    'type',
    'sources',
    'related',
    'created',
    'updated',
    'confidence',
    'tags',
    'project',
    'hoppr',
  ])
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(d)) if (!known.has(k)) out[k] = v
  return out
}

/** Prefer the machine namespace; fall back to parsing the human `sources:` paths. */
function rawIdsFrom(d: Record<string, unknown>, machine: Record<string, unknown>): string[] {
  if (Array.isArray(machine.raw_ids)) return (machine.raw_ids as unknown[]).map(String)
  if (!Array.isArray(d.sources)) return []
  return (d.sources as unknown[])
    .map((s) => /([0-9A-HJKMNP-TV-Z]{26})/.exec(String(s))?.[1])
    .filter((x): x is string => Boolean(x))
}

export function wikilinksIn(body: string, d: Record<string, unknown>): string[] {
  const found = new Set<string>()
  for (const m of body.matchAll(/\[\[([^\]|#]+)/g)) found.add(m[1]!.trim())
  if (Array.isArray(d.related)) {
    for (const r of d.related as unknown[]) {
      const m = /\[\[([^\]|#]+)/.exec(String(r))
      if (m) found.add(m[1]!.trim())
    }
  }
  return [...found]
}

function originTags(origin: unknown): string[] {
  const o = origin as Record<string, unknown> | undefined
  return Array.isArray(o?.tags) ? (o.tags as string[]) : []
}

function originProject(origin: unknown): string | undefined {
  const o = origin as Record<string, unknown> | undefined
  return typeof o?.project === 'string' ? o.project : undefined
}
