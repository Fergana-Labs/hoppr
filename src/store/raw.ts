/**
 * TIER 1 — the irreplaceable layer.
 *
 * This module deliberately exports NO function that rewrites or deletes an
 * existing capture's bytes. That is the whole point: the curator imports from
 * here, so if there is no mutating export, there is no way for an LLM pass to
 * damage the one tier you cannot regenerate. A lint rule and a test enforce it.
 *
 * The two writers that do exist are intake-only and both are strictly additive:
 *   append()        — create a new record
 *   extendPartial() — append MORE bytes to a still-live session capture
 *
 * Bytes once written are never changed. `seal()` finalizes the provenance
 * sidecar (metadata, not content) when a session goes quiet.
 */
import { existsSync } from 'node:fs'
import { appendFile, readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { glob } from 'tinyglobby'
import { HopprError } from '../core/errors.ts'
import { contentHash, sha256 } from '../core/hash.ts'
import { isoStamp, newId } from '../core/ids.ts'
import type { RawKind, RawMeta, RawRecord, SourceKind } from '../core/types.ts'
import { ensureDir, writeAtomic } from './atomic.ts'
import type { Layout } from './layout.ts'

export interface AppendOptions {
  bytes: Buffer | string
  kind: RawKind
  source: SourceKind
  mediaType: string
  title?: string
  externalId?: string
  created?: Date
  origin?: Record<string, unknown>
  partial?: boolean
  /** File extension for the stored artifact, e.g. '.jsonl'. Inferred if absent. */
  ext?: string
}

const EXT_BY_MEDIA: Record<string, string> = {
  'text/markdown': '.md',
  'text/plain': '.txt',
  'text/html': '.html',
  'application/json': '.json',
  'application/x-ndjson': '.jsonl',
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
}

function extFor(o: AppendOptions): string {
  if (o.ext) return o.ext.startsWith('.') ? o.ext : `.${o.ext}`
  return EXT_BY_MEDIA[o.mediaType] ?? '.txt'
}

/** Create a new raw record. Never overwrites: a colliding id is a hard error. */
export async function append(l: Layout, o: AppendOptions): Promise<RawRecord> {
  const id = newId()
  const now = new Date()
  const created = o.created ?? now
  const ext = extFor(o)
  const file = l.rawFile(now, id, ext)
  const metaFile = l.rawMetaFile(now, id)

  if (existsSync(file)) throw HopprError.internal(`raw id collision: ${id}`)

  const buf = typeof o.bytes === 'string' ? Buffer.from(o.bytes, 'utf8') : o.bytes
  await ensureDir(l.rawDir(now))
  await writeAtomic(file, buf)

  const meta: RawMeta = {
    id,
    kind: o.kind,
    source: o.source,
    external_id: o.externalId,
    media_type: o.mediaType,
    created: isoStamp(created),
    captured: isoStamp(now),
    bytes: buf.byteLength,
    hash: sha256(buf),
    title: o.title,
    origin: o.origin,
    partial: o.partial ?? false,
  }
  await writeAtomic(metaFile, `${JSON.stringify(meta, null, 2)}\n`)
  return { ...meta, path: l.rel(file) }
}

/**
 * Append more bytes to a still-live capture (a session that grew). Additive
 * only — existing bytes are never rewritten. Refuses once the record is sealed.
 */
export async function extendPartial(
  l: Layout,
  rec: RawRecord,
  moreBytes: Buffer | string,
): Promise<RawRecord> {
  if (!rec.partial) {
    throw HopprError.internal(`cannot extend sealed raw record ${rec.id}`)
  }
  const abs = l.abs(rec.path)
  const buf = typeof moreBytes === 'string' ? Buffer.from(moreBytes, 'utf8') : moreBytes
  if (buf.byteLength === 0) return rec

  await appendFile(abs, buf)
  const s = await stat(abs)
  const full = await readFile(abs)
  const next: RawRecord = {
    ...rec,
    bytes: s.size,
    hash: sha256(full),
    captured: isoStamp(new Date()),
  }
  await writeMeta(l, next)
  return next
}

/** Finalize the provenance sidecar when a session goes quiet. Metadata only. */
export async function seal(l: Layout, rec: RawRecord): Promise<RawRecord> {
  if (!rec.partial) return rec
  const next = { ...rec, partial: false }
  await writeMeta(l, next)
  return next
}

async function writeMeta(l: Layout, rec: RawRecord): Promise<void> {
  const { path, ...meta } = rec
  await writeAtomic(l.abs(metaPathFor(path)), `${JSON.stringify(meta, null, 2)}\n`)
}

function metaPathFor(rawRelPath: string): string {
  const ext = extname(rawRelPath)
  return `${rawRelPath.slice(0, rawRelPath.length - ext.length)}.meta.json`
}

// ── read side ──────────────────────────────────────────────────────

export async function readMeta(l: Layout, rawRelPath: string): Promise<RawRecord> {
  const metaAbs = l.abs(metaPathFor(rawRelPath))
  if (!existsSync(metaAbs)) throw HopprError.notFound(`no sidecar for ${rawRelPath}`)
  const meta = JSON.parse(await readFile(metaAbs, 'utf8')) as RawMeta
  return { ...meta, path: rawRelPath }
}

export async function readBytes(l: Layout, rec: RawRecord): Promise<Buffer> {
  return readFile(l.abs(rec.path))
}

export async function readText(l: Layout, rec: RawRecord): Promise<string> {
  return readFile(l.abs(rec.path), 'utf8')
}

/** Walk every capture. Sidecars are the authority — an artifact without one is orphaned. */
export async function list(l: Layout): Promise<RawRecord[]> {
  const metas = await glob(['raw/**/*.meta.json'], {
    cwd: l.root,
    ignore: ['raw/blobs/**'],
    absolute: false,
  })
  const out: RawRecord[] = []
  for (const m of metas.sort()) {
    const meta = JSON.parse(await readFile(l.abs(m), 'utf8')) as RawMeta
    const artifact = await findArtifact(l, m)
    if (!artifact) continue
    out.push({ ...meta, path: artifact })
  }
  return out
}

async function findArtifact(l: Layout, metaRel: string): Promise<string | undefined> {
  const stem = metaRel.slice(0, -'.meta.json'.length)
  const hits = await glob([`${stem}.*`], { cwd: l.root, absolute: false })
  return hits.find((h) => !h.endsWith('.meta.json'))
}

export async function exists(l: Layout, rawRelPath: string): Promise<boolean> {
  return existsSync(l.abs(rawRelPath))
}

/** Content hash of the extracted text, used for curate staleness. */
export function textHash(text: string): string {
  return contentHash(text)
}

/** Resolve a capture by ULID without scanning every sidecar. */
export async function findById(l: Layout, id: string): Promise<RawRecord | undefined> {
  const hits = await glob([`raw/**/${id}.meta.json`], { cwd: l.root, absolute: false })
  const metaRel = hits[0]
  if (!metaRel) return undefined
  const meta = JSON.parse(await readFile(l.abs(metaRel), 'utf8')) as RawMeta
  const artifact = await findArtifact(l, metaRel)
  if (!artifact) throw HopprError.notFound(`sidecar without artifact: ${metaRel}`)
  return { ...meta, path: artifact }
}

/** Prefix match, so you can type the first 8 characters of a ULID. */
export async function resolveId(l: Layout, prefix: string): Promise<RawRecord | undefined> {
  const exact = await findById(l, prefix)
  if (exact) return exact
  const hits = await glob([`raw/**/${prefix}*.meta.json`], { cwd: l.root, absolute: false })
  if (hits.length === 0) return undefined
  if (hits.length > 1) {
    throw HopprError.user(`ambiguous id '${prefix}' — matches ${hits.length} captures`)
  }
  const meta = JSON.parse(await readFile(l.abs(hits[0]!), 'utf8')) as RawMeta
  const artifact = await findArtifact(l, hits[0]!)
  if (!artifact) return undefined
  return { ...meta, path: artifact }
}
