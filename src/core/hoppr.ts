import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { type LoadedConfig, loadConfig } from '../config/load.ts'
import type { Config } from '../config/schema.ts'
import { type SyncOptions, type SyncStats, syncAll } from '../connectors/registry.ts'
import { type ChunkOpts, docId, upsertDoc } from '../db/docs.ts'
import type { Db, DriverName } from '../db/driver.ts'
import { openDb } from '../db/open.ts'
import { type ReindexStats, reindex } from '../db/reindex.ts'
import { type Embedder, resolveEmbedder } from '../embed/provider.ts'
import { type EmbedStats, embedPending } from '../embed/reconcile.ts'
import { type AddInput, add as intakeAdd } from '../intake/add.ts'
import { extract } from '../intake/extract/index.ts'
import { isSubprocessProvider, type LlmProvider, resolveLlm } from '../llm/index.ts'
import type { Tier } from '../llm/provider.ts'
import { type FastPassStats, fastPass } from '../organize/fast.ts'
import { search as runSearch, type SearchOptions, type SearchResult } from '../search/index.ts'
import type { Layout } from '../store/layout.ts'
import * as rawStore from '../store/raw.ts'
import { listPages, writeIndex } from '../store/wiki.ts'
import { HopprError } from './errors.ts'
import { contentHash } from './hash.ts'
import { curationFor } from './profiles.ts'
import { parseSource } from './source.ts'
import type { RawRecord } from './types.ts'

/**
 * The facade every surface calls — CLI, MCP, HTTP, daemon. Keeping the logic
 * here is what lets the MCP layer be a genuinely thin adapter instead of a
 * second implementation that drifts.
 */
function firstLine(text: string): string {
  return (text.split('\n').find((l) => l.trim()) ?? 'note').trim().slice(0, 80)
}

/** Never clobber something already sitting in the user's folder. */
async function uniquePathFor(path: string): Promise<string> {
  if (!existsSync(path)) return path
  const ext = path.slice(path.lastIndexOf('.'))
  const stem = path.slice(0, path.lastIndexOf('.'))
  for (let i = 2; i < 500; i++) {
    if (!existsSync(`${stem}-${i}${ext}`)) return `${stem}-${i}${ext}`
  }
  return `${stem}-${Date.now()}${ext}`
}

export class Hoppr {
  readonly layout: Layout
  readonly config: Config
  readonly sources: string[]
  /**
   * Keys from this store's own .env chain. Held per-instance rather than read
   * from process.env, because the daemon runs every hoppr in one process and a
   * process-global variable cannot be per-store.
   */
  readonly secrets: Record<string, string>
  #db?: Db
  #driver?: DriverName
  #vector = false
  #embedder?: Embedder | null
  #llmByTier = new Map<string, LlmProvider | null>()

  constructor(loaded: LoadedConfig) {
    this.layout = loaded.layout
    this.config = loaded.config
    this.sources = loaded.sources
    this.secrets = loaded.secrets ?? {}
  }

  static async open(opts: { root?: string; hopper?: string; cwd?: string } = {}): Promise<Hoppr> {
    return new Hoppr(await loadConfig(opts))
  }

  /** The hoppr's name — its directory under ~/.hoppr. */
  get name(): string {
    return this.config.hopper.name !== 'default' ? this.config.hopper.name : this.layout.name
  }

  get exists(): boolean {
    return existsSync(this.layout.configFile)
  }

  requireStore(): void {
    if (this.exists) return
    // Point at the command that actually creates one. Under the named-hoppr
    // model that is `hoppr new <name>`, not `hoppr init`.
    const name = this.layout.name
    // Lead with the git-shaped path, because that is the model: a hoppr lives
    // in a directory. The named ones are for sources that have no directory.
    throw HopprError.user(
      `no hoppr here (and none named '${name}').\n` +
        '  hoppr init                                 create one in this directory\n' +
        '  hoppr new <name> --from dir:<path>         index a folder elsewhere\n' +
        '  hoppr new <name> --from agents:claude-code index your coding sessions\n' +
        '  hoppr hoppers                              list what exists',
    )
  }

  /**
   * Opening the index is lazy and separate from opening the store: `hoppr add`
   * and `hoppr get` work on a store whose database has never been built, and
   * a corrupt index never blocks capture.
   */
  async db(): Promise<Db> {
    if (this.#db) return this.#db
    const opened = await openDb(this.layout.dbFile, { driver: this.config.index.driver })
    this.#db = opened.db
    this.#driver = opened.driver
    this.#vector = opened.vectorAvailable
    return opened.db
  }

  get driver(): DriverName | undefined {
    return this.#driver
  }
  get vectorAvailable(): boolean {
    return this.#vector
  }

  /**
   * Resolved lazily and cached (including the negative result), so a store
   * configured with `provider = "none"`, or one whose ONNX backend is not
   * installed, costs nothing on every search.
   */
  async embedder(): Promise<Embedder | undefined> {
    if (this.#embedder !== undefined) return this.#embedder ?? undefined
    try {
      this.#embedder = (await resolveEmbedder(this.config)) ?? null
    } catch {
      this.#embedder = null
    }
    return this.#embedder ?? undefined
  }

  /** Embed the query if we can. A missing backend degrades to keyword-only. */
  async #queryVector(text: string): Promise<Float32Array | undefined> {
    if (!text.trim() || !this.vectorAvailable) return undefined
    const e = await this.embedder()
    if (!e) return undefined
    try {
      return (await e.embed([text]))[0]
    } catch {
      return undefined
    }
  }

  /**
   * Resolved lazily per TIER and cached, including the negative result.
   *
   * Per tier because tagging and synthesis want different things: tagging is
   * high-volume and belongs on a cheap, fast HTTP model; synthesis runs a few
   * times a night and can afford the good one.
   */
  async llm(tier: Tier = 'quality'): Promise<LlmProvider | undefined> {
    const hit = this.#llmByTier.get(tier)
    if (hit !== undefined) return hit ?? undefined
    const resolved =
      (await resolveLlm(this.config, tier, this.secrets).catch(() => undefined)) ?? null
    this.#llmByTier.set(tier, resolved)
    return resolved ?? undefined
  }

  /**
   * Run the fast pass. Curation is the one thing here that needs a model, and
   * its absence is reported as a clear user error rather than a crash —
   * capture, indexing, and search all keep working without one.
   */
  async curate(
    opts: {
      limit?: number
      dryRun?: boolean
      /** Discard curated/ and regenerate it from the raw tier. */
      rebuild?: boolean
      onProgress?: (m: string) => void
    } = {},
  ): Promise<FastPassStats> {
    this.requireStore()
    const db = await this.db()
    // Tagging is the fast tier — a raw API call, not a CLI subprocess.
    const llm = await this.llm('fast')
    if (!llm) {
      throw HopprError.user(
        'no LLM provider available.\n' +
          '  Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY, install the `claude` CLI,\n' +
          '  or run Ollama locally. Capture and search work without one.',
      )
    }
    if (isSubprocessProvider(llm.id)) {
      // Not fatal, but the user should know why a backfill is crawling.
      opts.onProgress?.(
        `tagging via the ${llm.id} subprocess (~30s/batch). Set OPENROUTER_API_KEY, ` +
          'ANTHROPIC_API_KEY or OPENAI_API_KEY for sub-second calls.',
      )
    }
    if (opts.rebuild) await this.#discardCurated(opts.onProgress)
    const stats = await fastPass(db, this.layout, this.config, llm, opts)
    if (!opts.dryRun && stats.written > 0) await this.rebuildIndexPage()
    return stats
  }

  /**
   * Throw away everything the curator wrote and mark the raw tier for
   * re-curation. This is the operation the whole tier split exists to make
   * safe: a bad prompt or a bad model costs tokens to redo, never data.
   *
   * Pages a human pinned survive — those are not the curator's to discard.
   */
  async #discardCurated(onProgress?: (m: string) => void): Promise<void> {
    const db = await this.db()
    const { listPages } = await import('../store/wiki.ts')
    const { rm } = await import('node:fs/promises')

    const pinned = new Set(
      (await listPages(this.layout).catch(() => []))
        .filter((p) => p.pinned)
        .map((p) => `${p.type}/${p.slug}`),
    )
    let removed = 0
    for (const p of await listPages(this.layout).catch(() => [])) {
      if (pinned.has(`${p.type}/${p.slug}`)) continue
      await rm(this.layout.pageFile(p.type, p.slug), { force: true })
      removed++
    }
    onProgress?.(`discarded ${removed} pages (${pinned.size} pinned kept)`)

    db.transaction(() => {
      const keep = [...pinned]
      const ph = keep.map((_, i) => `:k${i}`).join(',')
      const params: Record<string, unknown> = {}
      keep.forEach((k, i) => {
        params[`k${i}`] = k
      })
      db.prepare(
        keep.length
          ? `DELETE FROM wiki WHERE (page_type || '/' || slug) NOT IN (${ph})`
          : 'DELETE FROM wiki',
      ).run(keep.length ? params : undefined)
      db.prepare(
        "DELETE FROM docs WHERE tier = 'curated' AND kind != 'table_row' AND kind != 'skill'",
      ).run()
      // Everything becomes claimable again; failure counters reset because the
      // prompt or model that failed them is presumably what changed.
      db.prepare('UPDATE raw SET curate_stale = 1, curate_fails = 0, curate_error = NULL').run()
    })
  }

  /** Pages semantically near a given one. */
  async related(id: string, limit = 5) {
    this.requireStore()
    const db = await this.db()
    const doc = db
      .prepare<{ title: string; summary: string }>('SELECT title, summary FROM docs WHERE id = :id')
      .get({ id })
    if (!doc) throw HopprError.notFound(`no such id: ${id}`)
    const res = await this.search(`${doc.title} ${doc.summary}`, { scope: 'all', limit: limit + 1 })
    return res.hits.filter((h) => h.id !== id).slice(0, limit)
  }

  /** Regenerate wiki/index.md — deterministic, so it can never drift. */
  async rebuildIndexPage(): Promise<void> {
    if (!this.config.wiki.generate_index) return
    const pages = await listPages(this.layout)
    await writeIndex(this.layout, pages, await this.stats())
  }

  /** Pull from every enabled harness connector. */
  async sync(opts: SyncOptions = {}): Promise<SyncStats[]> {
    this.requireStore()
    return syncAll(await this.db(), this.layout, this.config, { secrets: this.secrets, ...opts })
  }

  /** Populate one table, or every table, from whatever their selectors match. */
  async extractTables(
    opts: {
      name?: string
      limit?: number
      rebuild?: boolean
      onProgress?: (m: string) => void
    } = {},
  ) {
    this.requireStore()
    const db = await this.db()
    // Extraction is per row, in volume: fast tier.
    const llm = await this.llm('fast')
    if (!llm) throw HopprError.user('table extraction needs an LLM provider')
    const { listTables, loadTable } = await import('../tables/def.ts')
    const { extractTable } = await import('../tables/extract.ts')
    const tables = opts.name
      ? [await loadTable(this.layout, opts.name)]
      : await listTables(this.layout)
    const out = []
    for (const t of tables) out.push(await extractTable(db, this.layout, this.config, llm, t, opts))
    return out
  }

  async sql(query: string, maxRows?: number) {
    this.requireStore()
    const db = await this.db()
    // Refresh views first: a definition edited on disk should be queryable
    // immediately, without a curate pass in between.
    const { listTables } = await import('../tables/def.ts')
    const { createView, runQuery } = await import('../tables/sql.ts')
    for (const t of await listTables(this.layout).catch(() => [])) createView(db, t.def)
    return runQuery(db, query, { maxRows })
  }

  async embed(opts: { batch?: number; limit?: number; onProgress?: (s: EmbedStats) => void } = {}) {
    this.requireStore()
    const db = await this.db()
    const e = await this.embedder()
    if (!e) {
      throw HopprError.user(
        curationFor(this.config).embeddings
          ? 'no embedding provider available — set [embed] provider, or install the ONNX backend'
          : `this hoppr's curation preset ('${this.config.hopper.curation ?? 'minimal'}') ` +
              'does not use vectors. Keyword search still works; switch preset to enable them.',
      )
    }
    if (!this.vectorAvailable) {
      throw HopprError.user('sqlite-vec is not loadable in this database; vector search is off')
    }
    return embedPending(db, e, opts)
  }

  get chunkOpts(): ChunkOpts {
    return { maxChars: this.config.index.chunk_chars, overlap: this.config.index.chunk_overlap }
  }

  close(): void {
    this.#db?.close()
    this.#db = undefined
  }

  /** Capture, then index it immediately so it is searchable before the command returns. */
  async add(input: AddInput): Promise<RawRecord> {
    this.requireStore()
    /**
     * In a folder hoppr, a note you type belongs IN THE FOLDER.
     *
     * It used to land at `.hoppr/raw/2026/08/20/01M0GH4B48….md` — a ULID in a
     * dated tree, invisible beside the files it sits among. The folder is
     * already the raw tier; a second hidden one is a concept nobody asked for.
     * Written as a readable slugged file and picked up by the sync below, so
     * `raw/` exists only where there is genuinely no folder: copied transcripts.
     */
    const spec = parseSource(this.config.hopper.source)
    const folder =
      this.config.hopper.raw_mode === 'reference' && spec.kind === 'dir' ? spec.path : undefined

    // A FILE added to a folder hoppr is copied into the folder, for the same
    // reason: it then lives where you can see it, and the watcher and the
    // debounced pass handle it exactly like every other file there.
    if (folder && input.file) {
      const { copyFile } = await import('node:fs/promises')
      const src = resolve(input.file)
      const dest = await uniquePathFor(join(folder, basename(src)))
      await copyFile(src, dest)
      await this.sync({}).catch(() => undefined)
      const db = await this.db()
      const row = db
        .prepare<RawRecord>('SELECT * FROM raw WHERE external_path = :p')
        .get({ p: dest })
      if (row) return row
      throw HopprError.transient(`copied to ${dest} but could not index it`)
    }

    if (folder && input.text && !input.file && !input.url) {
      const { writeIfChanged } = await import('../store/atomic.ts')
      const { slugify } = await import('./ids.ts')
      const title = input.title ?? firstLine(input.text)
      const path = await uniquePathFor(join(folder, `${slugify(title).slice(0, 60) || 'note'}.md`))
      await writeIfChanged(
        path,
        input.title ? `# ${input.title}\n\n${input.text}\n` : `${input.text}\n`,
      )
      await this.sync({}).catch(() => undefined)
      const db = await this.db()
      const row = db
        .prepare<RawRecord>('SELECT * FROM raw WHERE external_path = :p')
        .get({ p: path })
      if (row) return row
      throw HopprError.transient(`wrote ${path} but could not index it`)
    }

    const rec = await intakeAdd(this.layout, {
      ...input,
      redaction: input.redaction ?? {
        enabled: this.config.intake.redact,
        entropy: this.config.intake.redact_entropy,
        extraPatterns: this.config.intake.redact_patterns,
      },
    })

    await this.indexRaw(rec).catch(() => {
      // Indexing is a convenience here, not the contract. A broken index must
      // never lose a capture — `hoppr reindex` will pick it up.
    })
    return rec
  }

  async indexRaw(rec: RawRecord): Promise<void> {
    const db = await this.db()
    const ex = await extract(this.layout, rec).catch(() => ({ text: rec.title ?? '' }))
    const created = Date.parse(rec.created) || Date.now()
    const captured = Date.parse(rec.captured) || created
    const origin = (rec.origin ?? {}) as Record<string, unknown>

    db.prepare(
      `INSERT INTO raw
         (id,path,kind,source,external_id,media_type,title,bytes,content_hash,
          created,captured,file_mtime_ms,text,origin,partial)
       VALUES
         (:id,:path,:kind,:source,:external_id,:media_type,:title,:bytes,:hash,
          :created,:captured,0,:text,:origin,:partial)
       ON CONFLICT(id) DO UPDATE SET
         bytes=:bytes, captured=:captured, text=:text, partial=:partial, content_hash=:hash,
         curate_stale = CASE WHEN raw.curate_hash IS :hash THEN raw.curate_stale ELSE 1 END`,
    ).run({
      id: rec.id,
      path: rec.path,
      kind: rec.kind,
      source: rec.source,
      external_id: rec.external_id ?? null,
      media_type: rec.media_type,
      title: rec.title ?? null,
      bytes: rec.bytes,
      hash: contentHash(ex.text),
      created,
      captured,
      text: ex.text,
      origin: rec.origin ? JSON.stringify(rec.origin) : null,
      partial: rec.partial ? 1 : 0,
    })

    upsertDoc(
      db,
      {
        id: docId.raw(rec.id),
        tier: 'raw',
        kind: rec.kind,
        refId: rec.id,
        title: rec.title ?? '',
        body: ex.text,
        tags: Array.isArray(origin.tags) ? (origin.tags as string[]) : [],
        project: typeof origin.project === 'string' ? origin.project : undefined,
        created,
        updated: captured,
      },
      this.chunkOpts,
    )
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult> {
    this.requireStore()
    const db = await this.db()
    const mode = opts.mode ?? 'hybrid'
    const queryVector =
      opts.queryVector ??
      (mode === 'fts' ? undefined : await this.#queryVector(stripFilters(query)))
    return runSearch(db, this.config, query, { ...opts, queryVector })
  }

  async reindex(opts: { prune?: boolean } = {}): Promise<ReindexStats> {
    this.requireStore()
    return reindex(await this.db(), this.layout, this.config, opts)
  }

  /**
   * Delete the index and rebuild it from disk, carrying the embedding cache
   * across so the rebuild costs no tokens. `forgetEmbeddings` is the true
   * nuclear option, for when the vectors themselves are suspect.
   */
  async rebuildIndex(opts: { forgetEmbeddings?: boolean } = {}): Promise<ReindexStats> {
    this.requireStore()
    const { restoreEmbeddingCache, saveEmbeddingCache } = await import('../db/reindex.ts')

    let cache: Awaited<ReturnType<typeof saveEmbeddingCache>> = []
    if (!opts.forgetEmbeddings && existsSync(this.layout.dbFile)) {
      cache = saveEmbeddingCache(await this.db())
    }
    this.close()

    const { rm } = await import('node:fs/promises')
    for (const suffix of ['', '-wal', '-shm']) {
      await rm(`${this.layout.dbFile}${suffix}`, { force: true })
    }

    const db = await this.db()
    const restored = restoreEmbeddingCache(db, cache)
    const stats = await this.reindex()
    stats.embedCacheHits = restored
    return stats
  }

  async resolveRaw(idOrPrefix: string): Promise<RawRecord | undefined> {
    const owned = await rawStore.resolveId(this.layout, idOrPrefix)
    if (owned) return owned
    // Reference rows have no file in the store; reconstruct the record from
    // the index so `source` still resolves to the real file on disk.
    const db = await this.db()
    const row = db
      .prepare<{
        id: string
        kind: string
        source: string
        external_id: string | null
        media_type: string
        title: string | null
        bytes: number
        content_hash: string
        created: number
        captured: number
        origin: string | null
        external_path: string | null
      }>(
        `SELECT id, kind, source, external_id, media_type, title, bytes, content_hash,
                created, captured, origin, external_path
           FROM raw WHERE raw_mode = 'reference' AND (id = :q OR id LIKE :pfx) LIMIT 2`,
      )
      .get({ q: idOrPrefix, pfx: `${idOrPrefix}%` })
    if (!row) return undefined
    return {
      id: row.id,
      kind: row.kind as RawRecord['kind'],
      source: row.source as RawRecord['source'],
      external_id: row.external_id ?? undefined,
      media_type: row.media_type,
      created: new Date(row.created).toISOString(),
      captured: new Date(row.captured).toISOString(),
      bytes: row.bytes,
      hash: row.content_hash,
      title: row.title ?? undefined,
      origin: row.origin ? (JSON.parse(row.origin) as Record<string, unknown>) : undefined,
      partial: false,
      // Absolute: this file lives outside the store, and that is the point.
      path: row.external_path ?? '',
    }
  }

  /** Read a capture's text, from the store or from its original location. */
  /**
   * The READABLE form of a capture, which for a PDF, image, or Office file is
   * the extracted text — not the bytes. `hoppr get` on a screenshot used to
   * dump a PNG to the terminal; the bytes are what `hoppr source` is for.
   */
  /** The captured bytes exactly as stored — ground truth, never the rendering. */
  async readRawBytes(rec: RawRecord): Promise<string> {
    const external = (rec.origin as { external_path?: string } | undefined)?.external_path
    const { readFile } = await import('node:fs/promises')
    if (external) {
      return readFile(external, 'utf8').catch(() => `(source file is no longer at ${external})`)
    }
    return readFile(this.layout.abs(rec.path), 'utf8').catch(
      () => `(capture is no longer at ${rec.path})`,
    )
  }

  async readRawText(rec: RawRecord): Promise<string> {
    // The index already holds the extraction, so prefer it over re-reading a
    // file we would only have to extract again.
    const db = await this.db()
    const row = db
      .prepare<{ text: string | null }>('SELECT text FROM raw WHERE id = :id')
      .get({ id: rec.id })
    if (row?.text) return row.text

    const external = (rec.origin as { external_path?: string } | undefined)?.external_path
    if (external) {
      const { readFile } = await import('node:fs/promises')
      return readFile(external, 'utf8').catch(() => `(source file is no longer at ${external})`)
    }
    return rawStore.readText(this.layout, rec)
  }

  async stats(): Promise<Record<string, number>> {
    const db = await this.db()
    const one = (sql: string) => db.prepare<{ n: number }>(sql).get()?.n ?? 0
    return {
      raw: one('SELECT COUNT(*) n FROM raw'),
      wiki: one('SELECT COUNT(*) n FROM wiki'),
      docs: one('SELECT COUNT(*) n FROM docs'),
      chunks: one('SELECT COUNT(*) n FROM chunks'),
      skills: one('SELECT COUNT(*) n FROM skills'),
      uncurated: one(
        'SELECT COUNT(*) n FROM raw WHERE curate_stale=1 AND curate_fails<3 AND partial=0',
      ),
      failed: one('SELECT COUNT(*) n FROM raw WHERE curate_fails>=3'),
      unembedded: one('SELECT COUNT(*) n FROM docs WHERE embed_stale=1 AND embed_fails<3'),
      embed_failed: one('SELECT COUNT(*) n FROM docs WHERE embed_fails>=3'),
    }
  }
}

/** Filter tokens are metadata, not meaning — embedding them dilutes the vector. */
function stripFilters(q: string): string {
  return q
    .replace(
      /(-?)(tag|project|kind|type|source|scope|confidence|since|until|is):("[^"]*"|\S+)/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim()
}
