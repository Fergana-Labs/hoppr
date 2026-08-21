import type { Config } from '../config/schema.ts'
import { contentHash } from '../core/hash.ts'
import { newId } from '../core/ids.ts'
import { parseSource, type RawMode } from '../core/source.ts'
import { docId, upsertDoc } from '../db/docs.ts'
import type { Db } from '../db/driver.ts'
import { redact, summarizeHits } from '../intake/redact.ts'
import type { LlmProvider } from '../llm/provider.ts'
import type { Layout } from '../store/layout.ts'
import * as rawStore from '../store/raw.ts'
import { claudeCode } from './claude-code.ts'
import { codex } from './codex.ts'
import { dirConnector } from './dir.ts'
import { openclaw } from './openclaw.ts'
import { opencode } from './opencode.ts'
import type { Connector, ConnectorSource, IngestCandidate } from './types.ts'

export const HARNESS_CONNECTORS: Connector[] = [claudeCode, codex, openclaw, opencode]
export const CONNECTORS: Connector[] = [...HARNESS_CONNECTORS, dirConnector]

/** Config keys may be written with either separator; accept both. */
function configFor(cfg: Config, id: string): Record<string, unknown> {
  return (cfg.connectors[id] ?? cfg.connectors[id.replace(/-/g, '_')] ?? {}) as Record<
    string,
    unknown
  >
}

export interface SyncStats {
  connector: string
  detected: boolean
  sources: number
  scanned: number
  captured: number
  updated: number
  skipped: number
  errors: number
  /** Captures containing a credential that was scrubbed on the way in. */
  redacted: number
  /** Reference rows whose underlying file no longer exists. */
  pruned: number
  /** Sources older than the window, not pulled. Reported, never silent. */
  outsideWindow: number
}

export interface SyncOptions {
  /** Only pull sources touched since this instant. */
  since?: number
  full?: boolean
  dryRun?: boolean
  onProgress?: (msg: string) => void
  /** This hoppr's own keys, for the vision extractor. */
  secrets?: Record<string, string>
}

/**
 * Pull from every enabled connector.
 *
 * Two behaviours matter more than throughput:
 *
 *  - **A bounded first sync.** Backfilling thousands of historical sessions on
 *    install, silently, at LLM cost, is how a tool gets uninstalled. The
 *    default window is 30 days and the skipped count is always reported, so
 *    "there is more" is visible rather than implied.
 *  - **A failing source is quarantined, not fatal.** Its error count rises and
 *    the sweep moves on; one harness changing its format upstream degrades
 *    that connector alone and never stops the others.
 */
export async function syncAll(
  db: Db,
  l: Layout,
  cfg: Config,
  opts: SyncOptions = {},
): Promise<SyncStats[]> {
  const spec = parseSource(cfg.hopper.source)
  const out: SyncStats[] = []

  // A hoppr pulls from ITS source, not from everything installed on the
  // machine. That isolation is the point: a folder hoppr must never quietly
  // start ingesting your Claude Code history.
  if (spec.kind === 'dir') {
    const conf = {
      ...configFor(cfg, 'dir'),
      path: spec.path,
      exclude: cfg.hopper.exclude,
      max_file_mb: cfg.hopper.max_file_mb,
      use_gitignore: cfg.hopper.use_gitignore,
      extract: cfg.retrieval.extract,
      transcript_max_chars: cfg.intake.transcript_max_chars,
      tool_result_max_chars: cfg.intake.tool_result_max_chars,
    }
    out.push(await syncOne(db, l, cfg, dirConnector, conf, opts))
    return out
  }

  if (spec.kind === 'manual') return out

  const wanted = spec.harnesses ?? []
  for (const c of HARNESS_CONNECTORS) {
    if (wanted.length && !wanted.includes(c.id)) continue
    const conf = configFor(cfg, c.id)
    if (conf.enabled === false) continue
    out.push(await syncOne(db, l, cfg, c, conf, opts))
  }
  return out
}

/**
 * The fast-tier provider, resolved at most once per process and only if a
 * connector asks. Most syncs touch no images at all, and resolving a provider
 * probes the environment (and, for Ollama, the network).
 */
const visionCache = new Map<string, Promise<LlmProvider | undefined>>()
function visionLlm(cfg: Config, secrets: Record<string, string>): Promise<LlmProvider | undefined> {
  // Keyed by hoppr: one daemon process serves many, and they may hold
  // different keys for the same provider.
  const key = cfg.hopper.name
  let hit = visionCache.get(key)
  if (!hit) {
    hit = import('../llm/index.ts').then((m) => m.resolveLlm(cfg, 'fast', secrets))
    visionCache.set(key, hit)
  }
  return hit
}

export async function syncOne(
  db: Db,
  l: Layout,
  cfg: Config,
  c: Connector,
  conf: Record<string, unknown>,
  opts: SyncOptions,
): Promise<SyncStats> {
  const st: SyncStats = {
    connector: c.id,
    detected: false,
    sources: 0,
    scanned: 0,
    captured: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    redacted: 0,
    pruned: 0,
    outsideWindow: 0,
  }

  st.detected = await c.detect(conf).catch(() => false)
  if (!st.detected) return st

  const since = opts.full ? 0 : (opts.since ?? Date.now() - 30 * 86_400_000)
  const sources = await c.discover(conf).catch(() => [] as ConnectorSource[])
  st.sources = sources.length

  // A reference-mode source can DISAPPEAR — someone deletes or renames a file
  // and the index would otherwise keep claiming it exists forever. discover()
  // already stats the whole tree, so the set it returns is the ground truth.
  //
  // Guarded on a non-empty result: an unmounted drive or a permissions blip
  // must not be read as "the user deleted everything".
  if (!opts.dryRun && sources.length > 0) {
    st.pruned = pruneMissingReferences(db, c.id, sources)
  }

  for (const source of sources) {
    if (source.mtimeMs !== undefined && source.mtimeMs < since) {
      st.outsideWindow++
      continue
    }
    st.scanned++
    opts.onProgress?.(`${c.id}: ${source.label}`)

    const row = db
      .prepare<{ cursor: string; error_count: number }>(
        'SELECT cursor, error_count FROM connector_cursors WHERE connector = :c AND source_key = :k',
      )
      .get({ c: c.id, k: source.key })

    // A source that has failed repeatedly is quarantined: retrying it every
    // minute forever would bury the log and starve healthy sources.
    if ((row?.error_count ?? 0) >= 5) {
      st.skipped++
      continue
    }

    let cursor: unknown = row?.cursor ? safeParse(row.cursor) : undefined
    try {
      for (let guard = 0; guard < 50; guard++) {
        const res = await c.pull(source, {
          cursor,
          config: conf,
          since,
          log: (m) => opts.onProgress?.(`${c.id}: ${m}`),
          llm: () => visionLlm(cfg, opts.secrets ?? {}),
        })
        cursor = res.cursor
        for (const item of res.items) {
          // Scrub BEFORE anything is written: a secret that reaches raw/ would
          // be committed to git, where deleting it later does not remove it.
          const scrub = redact(item.body, {
            enabled: cfg.intake.redact,
            entropy: cfg.intake.redact_entropy,
            extraPatterns: cfg.intake.redact_patterns,
          })
          if (scrub.redacted) {
            st.redacted++
            opts.onProgress?.(`${c.id}: redacted ${summarizeHits(scrub.hits)} in ${source.label}`)
          }
          const r = await upsertCapture(
            db,
            l,
            cfg,
            { ...item, body: scrub.text },
            c.id,
            opts.dryRun,
            cfg.hopper.raw_mode,
          )
          if (r === 'created') st.captured++
          else if (r === 'updated') st.updated++
          else st.skipped++
        }
        if (res.done) break
      }
      if (!opts.dryRun) saveCursor(db, c.id, source.key, cursor, null)
    } catch (e) {
      st.errors++
      if (!opts.dryRun) saveCursor(db, c.id, source.key, cursor, (e as Error).message)
      opts.onProgress?.(`${c.id}: ${source.label} failed — ${(e as Error).message.slice(0, 100)}`)
    }
  }
  return st
}

/**
 * Drop reference rows whose file is gone.
 *
 * Only reference rows: a copy-mode capture owns its content and stays valid
 * even if the upstream owner changes or removes the original.
 */
function pruneMissingReferences(db: Db, connectorId: string, sources: ConnectorSource[]): number {
  const live = new Set(sources.map((s) => s.key))
  const rows = db
    .prepare<{ id: string; external_path: string }>(
      `SELECT id, external_path FROM raw
        WHERE raw_mode = 'reference' AND source = :src AND external_path IS NOT NULL`,
    )
    .all({ src: `connector:${connectorId}` })

  let n = 0
  for (const r of rows) {
    if (live.has(r.external_path)) continue
    db.prepare('DELETE FROM docs WHERE id = :d').run({ d: docId.raw(r.id) })
    db.prepare('DELETE FROM raw WHERE id = :id').run({ id: r.id })
    db.prepare('DELETE FROM connector_cursors WHERE connector = :c AND source_key = :k').run({
      c: connectorId,
      k: r.external_path,
    })
    n++
  }
  return n
}

type UpsertOutcome = 'created' | 'updated' | 'unchanged'

/**
 * One capture per session, updated in place.
 *
 * A three-hour session polled every minute must produce ONE record that grows,
 * not 180 near-duplicates. `external_id` is the identity; the content hash
 * decides whether anything actually changed.
 */
async function upsertCapture(
  db: Db,
  l: Layout,
  cfg: Config,
  item: IngestCandidate,
  connectorId: string,
  dryRun?: boolean,
  rawMode: RawMode = 'copy',
): Promise<UpsertOutcome> {
  const existing = db
    .prepare<{ id: string; path: string; content_hash: string }>(
      'SELECT id, path, content_hash FROM raw WHERE external_id = :e',
    )
    .get({ e: item.externalId })

  const hash = contentHash(item.body)
  if (existing?.content_hash === hash) return 'unchanged'
  if (dryRun) return existing ? 'updated' : 'created'

  const externalPath =
    typeof item.origin.external_path === 'string' ? item.origin.external_path : null

  // ── reference mode ───────────────────────────────────────────────
  // Nothing is written to disk at all. The row points at the real file and
  // carries its extracted text; hoppr never opens the original for writing.
  if (rawMode === 'reference') {
    if (existing) {
      db.prepare(
        `UPDATE raw SET text = :text, content_hash = :hash, bytes = :bytes, captured = :now,
           title = :title, external_path = :ext, raw_mode = 'reference', curate_stale = 1
         WHERE id = :id`,
      ).run({
        id: existing.id,
        text: item.body,
        hash,
        bytes: Buffer.byteLength(item.body),
        now: item.updatedAt.getTime(),
        title: item.title ?? null,
        ext: externalPath,
      })
      projectCapture(db, cfg, existing.id, item)
      return 'updated'
    }
    const id = newId()
    db.prepare(
      `INSERT INTO raw (id,path,kind,source,external_id,media_type,title,bytes,content_hash,
                        created,captured,file_mtime_ms,text,origin,partial,external_path,raw_mode)
       VALUES (:id,:path,:kind,:source,:ext_id,'text/markdown',:title,:bytes,:hash,
               :created,:captured,:mtime,:text,:origin,0,:ext,'reference')`,
    ).run({
      id,
      // `path` is informational for reference rows — the truth is external_path.
      path: externalPath ?? item.externalId,
      kind: item.kind,
      source: `connector:${connectorId}`,
      ext_id: item.externalId,
      title: item.title ?? null,
      bytes: Number(item.origin.bytes ?? Buffer.byteLength(item.body)),
      hash,
      created: item.createdAt.getTime(),
      captured: item.updatedAt.getTime(),
      mtime: Number(item.origin.mtime_ms ?? 0),
      text: item.body,
      origin: JSON.stringify({ ...item.origin, project: item.project }),
      ext: externalPath,
    })
    projectCapture(db, cfg, id, item)
    return 'created'
  }

  // ── copy mode ────────────────────────────────────────────────────
  // Used where the upstream owner may change or remove the original. Agent
  // connectors store normalized session snapshots here.
  if (existing) {
    const { writeAtomic } = await import('../store/atomic.ts')
    await writeAtomic(l.abs(existing.path), item.body)
    db.prepare(
      `UPDATE raw SET text = :text, content_hash = :hash, bytes = :bytes,
         captured = :now, partial = :partial, title = :title, curate_stale = 1
       WHERE id = :id`,
    ).run({
      id: existing.id,
      text: item.body,
      hash,
      bytes: Buffer.byteLength(item.body),
      now: item.updatedAt.getTime(),
      partial: item.partial ? 1 : 0,
      title: item.title ?? null,
    })
    projectCapture(db, cfg, existing.id, item)
    return 'updated'
  }

  const rec = await rawStore.append(l, {
    bytes: item.body,
    kind: item.kind,
    source: `connector:${connectorId}`,
    mediaType: 'text/markdown',
    ext: '.md',
    title: item.title,
    externalId: item.externalId,
    created: item.createdAt,
    origin: { ...item.origin, project: item.project },
    partial: item.partial,
  })

  db.prepare(
    `INSERT INTO raw (id,path,kind,source,external_id,media_type,title,bytes,content_hash,
                      created,captured,file_mtime_ms,text,origin,partial,raw_mode)
     VALUES (:id,:path,:kind,:source,:ext,'text/markdown',:title,:bytes,:hash,
             :created,:captured,0,:text,:origin,:partial,'copy')`,
  ).run({
    id: rec.id,
    path: rec.path,
    kind: item.kind,
    source: `connector:${connectorId}`,
    ext: item.externalId,
    title: item.title ?? null,
    bytes: rec.bytes,
    hash,
    created: item.createdAt.getTime(),
    captured: item.updatedAt.getTime(),
    text: item.body,
    origin: JSON.stringify({ ...item.origin, project: item.project }),
    partial: item.partial ? 1 : 0,
  })
  projectCapture(db, cfg, rec.id, item)
  return 'created'
}

/**
 * Make a capture searchable the moment it lands.
 *
 * Without this a synced capture sits in `raw` but not in `docs`, so
 * `hoppr search` silently misses it until the next reindex — which reads to
 * a user as "sync didn't work".
 */
function projectCapture(db: Db, cfg: Config, rawId: string, item: IngestCandidate): void {
  upsertDoc(
    db,
    {
      id: docId.raw(rawId),
      tier: 'raw',
      kind: item.kind,
      refId: rawId,
      title: item.title ?? '',
      body: item.body,
      project: item.project,
      created: item.createdAt.getTime(),
      updated: item.updatedAt.getTime(),
    },
    { maxChars: cfg.index.chunk_chars, overlap: cfg.index.chunk_overlap },
  )
}

function saveCursor(db: Db, connector: string, key: string, cursor: unknown, error: string | null) {
  db.prepare(
    `INSERT INTO connector_cursors(connector, source_key, cursor, last_ok_at, last_error, error_count)
     VALUES (:c,:k,:cur,:ok,:err,:n)
     ON CONFLICT(connector, source_key) DO UPDATE SET
       cursor = :cur,
       last_ok_at = COALESCE(:ok, connector_cursors.last_ok_at),
       last_error = :err,
       error_count = CASE WHEN :err IS NULL THEN 0 ELSE connector_cursors.error_count + 1 END`,
  ).run({
    c: connector,
    k: key,
    cur: JSON.stringify(cursor ?? {}),
    ok: error ? null : Date.now(),
    err: error,
    n: error ? 1 : 0,
  })
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}
