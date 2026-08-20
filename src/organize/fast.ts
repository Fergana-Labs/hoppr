import { z } from 'zod'
import type { Config } from '../config/schema.ts'
import { type IgnoreRule, isIgnored, loadIgnoreRules } from '../connectors/ignore.ts'
import { HopprError } from '../core/errors.ts'
import { isoDate } from '../core/ids.ts'
import { curationFor } from '../core/profiles.ts'
import { parseSource } from '../core/source.ts'
import type { Confidence } from '../core/types.ts'
import { docId, upsertDoc } from '../db/docs.ts'
import type { Db } from '../db/driver.ts'
import { type LlmProvider, recordCall, withinBudget } from '../llm/index.ts'
import type { Layout } from '../store/layout.ts'
import { clip, loadPrompt, render } from '../store/prompts.ts'
import {
  appendLog,
  pageKey,
  savePage,
  slugForSource,
  sourceHashOf,
  type WikiPage,
} from '../store/wiki.ts'
import * as journal from './journal.ts'
import {
  bumpCounts,
  loadTaxonomy,
  normalizeTags,
  renderVocabulary,
  reuseRate,
  saveTaxonomy,
  type TaxonomyRules,
} from './taxonomy.ts'

const PageOut = z.object({
  id: z.string(),
  title: z.string().min(1),
  summary: z.string(),
  body: z.string().default(''),
  tags: z.array(z.string()).default([]),
  new_tags: z
    .array(z.union([z.string(), z.object({ tag: z.string(), reason: z.string().optional() })]))
    .default([]),
  entities: z.array(z.string()).default([]),
  project: z.string().nullable().optional(),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
  fields: z.record(z.string(), z.unknown()).default({}),
})
const Batch = z.object({ pages: z.array(PageOut) })

interface Candidate {
  id: string
  title: string | null
  kind: string
  text: string
  created: number
  project: string | null
}

export interface FastPassStats {
  passId: string
  claimed: number
  written: number
  unchanged: number
  failed: number
  /** Captures the model left out of a batch response and had to be re-asked. */
  omitted: number
  skippedPinned: number
  coined: string[]
  reuseRate: number
  batches: number
  logLine: string
}

/**
 * The fast pass: one source page per capture.
 *
 * Batched deliberately. Every provider carries meaningful per-call overhead —
 * the `claude` CLI pays ~2-4s and ~11k cached prompt tokens per invocation —
 * so per-item calls would make a backfill process-bound rather than
 * model-bound. Batching also gives the model several captures of shared
 * context, which measurably improves tag reuse.
 */
export async function fastPass(
  db: Db,
  l: Layout,
  cfg: Config,
  llm: LlmProvider,
  opts: { limit?: number; dryRun?: boolean; onProgress?: (msg: string) => void } = {},
): Promise<FastPassStats> {
  const passId = journal.newPassId()
  const prompt = await loadPrompt(l, 'ingest')
  const tagCfg = (cfg.tables.tags ?? {}) as Record<string, unknown>
  const rules: TaxonomyRules = {
    vocabularySize: Number(tagCfg.vocabulary_size ?? 150),
    maxNewTagsPerItem: Number(tagCfg.max_new_tags_per_item ?? 2),
    maxTagsPerItem: Number(tagCfg.max_tags_per_item ?? 7),
    pinned: (tagCfg.pinned as string[]) ?? [],
    stoplist: (tagCfg.stoplist as string[]) ?? [],
    bootstrapFloor: Number(tagCfg.bootstrap_floor ?? 20),
  }

  const stats: FastPassStats = {
    passId,
    claimed: 0,
    written: 0,
    unchanged: 0,
    failed: 0,
    omitted: 0,
    skippedPinned: 0,
    coined: [],
    reuseRate: 1,
    batches: 0,
    logLine: '',
  }

  const budget = withinBudget(db, cfg)
  if (!budget.ok) {
    throw HopprError.user(
      `daily LLM budget reached ($${budget.spent.toFixed(2)} of $${budget.cap.toFixed(2)}) — ` +
        'raise [curate.budget] max_usd_per_day or wait',
    )
  }

  const candidates = claim(db, cfg, opts.limit)
  stats.claimed = candidates.length
  if (candidates.length === 0) {
    stats.logLine = 'fast pass — nothing to curate'
    return stats
  }

  let tax = await loadTaxonomy(l)
  let allAssigned = 0
  const batchSize = cfg.curate.fast_batch

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize)
    stats.batches++
    opts.onProgress?.(`batch ${stats.batches} — ${batch.length} captures`)

    const rendered = render(prompt.template, {
      vocabulary: renderVocabulary(tax, rules.vocabularySize),
      max_new_tags: rules.maxNewTagsPerItem,
      max_tags: rules.maxTagsPerItem,
      stoplist: rules.stoplist.join(', ') || '(none)',
      schema: renderSchema(cfg),
      captures: batch
        .map(
          (c) =>
            `### capture ${c.id}\nkind: ${c.kind}\ntitle: ${c.title ?? '(none)'}\n\n${clip(
              c.text,
              prompt.maxInputChars,
            )}`,
        )
        .join('\n\n---\n\n'),
    })

    let out: z.infer<typeof Batch>
    try {
      const res = await llm.completeJson({
        prompt: rendered,
        system: prompt.system,
        tier: prompt.tier,
        purpose: 'curate.fast',
        schema: Batch,
        maxTokens: 8192,
      })
      recordCall(db, llm.id, 'curate.fast', prompt.tier, res.usage, true)
      out = res.value
    } catch (e) {
      // Terminal per row, never per batch: bump each capture's own counter and
      // keep going. One malformed capture must not wedge every future pass.
      for (const c of batch) markFailure(db, c.id, (e as Error).message)
      stats.failed += batch.length
      opts.onProgress?.(`batch ${stats.batches} failed: ${(e as Error).message.slice(0, 80)}`)
      continue
    }

    const byId = new Map(batch.map((c) => [c.id, c]))
    for (const page of out.pages) {
      const cand = byId.get(page.id)
      if (!cand) continue
      byId.delete(page.id)
      try {
        const r = await writeSourcePage(
          db,
          l,
          cfg,
          cand,
          page,
          tax,
          rules,
          passId,
          prompt.hash,
          opts.dryRun,
        )
        if (r.skippedPinned) stats.skippedPinned++
        else if (r.changed) stats.written++
        else stats.unchanged++
        stats.coined.push(...r.coined)
        allAssigned += r.assigned
        tax = r.tax
      } catch (e) {
        markFailure(db, cand.id, (e as Error).message)
        stats.failed++
      }
    }
    // Models routinely drop items from a large batch response. That is NOT the
    // same as a poison capture: the item was never answered, not answered
    // badly. Counting it as a strike would permanently abandon perfectly good
    // captures, so re-ask for the stragglers individually before giving up.
    if (byId.size > 0) {
      stats.omitted += byId.size
      opts.onProgress?.(`re-asking for ${byId.size} omitted capture(s)`)
      for (const missed of [...byId.values()]) {
        try {
          const retry = await llm.completeJson({
            prompt: render(prompt.template, {
              vocabulary: renderVocabulary(tax, rules.vocabularySize),
              max_new_tags: rules.maxNewTagsPerItem,
              max_tags: rules.maxTagsPerItem,
              stoplist: rules.stoplist.join(', ') || '(none)',
              schema: renderSchema(cfg),
              captures: `### capture ${missed.id}\nkind: ${missed.kind}\ntitle: ${
                missed.title ?? '(none)'
              }\n\n${clip(missed.text, prompt.maxInputChars)}`,
            }),
            system: prompt.system,
            tier: prompt.tier,
            purpose: 'curate.fast.retry',
            schema: Batch,
            maxTokens: 4096,
          })
          recordCall(db, llm.id, 'curate.fast.retry', prompt.tier, retry.usage, true)
          const page = retry.value.pages.find((p) => p.id === missed.id) ?? retry.value.pages[0]
          if (!page) throw new Error('model omitted the capture again when asked alone')
          const r = await writeSourcePage(
            db,
            l,
            cfg,
            missed,
            { ...page, id: missed.id },
            tax,
            rules,
            passId,
            prompt.hash,
            opts.dryRun,
          )
          if (r.skippedPinned) stats.skippedPinned++
          else if (r.changed) stats.written++
          else stats.unchanged++
          stats.coined.push(...r.coined)
          allAssigned += r.assigned
          tax = r.tax
        } catch (e) {
          // Only now is it a strike — it failed even with the whole call to itself.
          markFailure(db, missed.id, (e as Error).message)
          stats.failed++
        }
      }
    }
  }

  if (!opts.dryRun) await saveTaxonomy(l, tax)
  stats.reuseRate = reuseRate(new Array(allAssigned).fill('x'), stats.coined)

  const parts = [`${stats.written} pages written`]
  if (stats.unchanged) parts.push(`${stats.unchanged} unchanged`)
  if (stats.skippedPinned) parts.push(`${stats.skippedPinned} pinned`)
  if (stats.omitted) parts.push(`${stats.omitted} re-asked`)
  if (stats.failed) parts.push(`${stats.failed} failed`)
  if (stats.coined.length) parts.push(`new tags: ${[...new Set(stats.coined)].join(', ')}`)
  stats.logLine = `fast pass — ${stats.claimed} captures, ${parts.join(', ')}`
  if (!opts.dryRun && stats.claimed > 0) await appendLog(l, stats.logLine)

  return stats
}

/**
 * Claim work. The partial index does the filtering: a capture that has failed
 * three times is simply not in it, and one still being written (`partial`) is
 * excluded because spending a model call on a half-finished transcript is waste.
 */
function claim(db: Db, cfg: Config, limit?: number): Candidate[] {
  const rows = db
    .prepare<Candidate & { relative_path: string | null }>(
      `SELECT r.id, r.title, r.kind, r.text, r.created,
              json_extract(r.origin, '$.project') AS project,
              json_extract(r.origin, '$.relative_path') AS relative_path
         FROM raw r
        WHERE r.curate_stale = 1 AND r.curate_fails < 3 AND r.partial = 0
          AND r.text IS NOT NULL AND length(r.text) > 0
        ORDER BY r.captured DESC
        LIMIT :n`,
    )
    .all({ n: limit ?? cfg.curate.fast_batch * 8 })

  if (!curationFor(cfg).sourcePages) {
    // This preset builds no pages, so there is nothing to spend a model call
    // on. Clear the flag rather than filtering, or every pass re-claims them.
    for (const r of rows) {
      db.prepare('UPDATE raw SET curate_stale = 0 WHERE id = :id').run({ id: r.id })
    }
    return []
  }
  // The `[no-curate]` section of .hopprignore: indexed and searchable, never
  // sent to a model. Marked non-stale rather than filtered, or every pass
  // would re-claim them forever.
  const rules = noCurateRules(cfg)
  if (rules.length === 0) return rows
  const keep: Candidate[] = []
  for (const r of rows) {
    const path = r.relative_path
    if (path && isIgnored(path, rules)) {
      db.prepare('UPDATE raw SET curate_stale = 0 WHERE id = :id').run({ id: r.id })
      continue
    }
    keep.push(r)
  }
  return keep
}

/** Cached per source root: read once per process, not once per batch. */
const noCurateCache = new Map<string, IgnoreRule[]>()
function noCurateRules(cfg: Config): IgnoreRule[] {
  const spec = parseSource(cfg.hopper.source)
  const key = spec.path ?? cfg.hopper.name
  let hit = noCurateCache.get(key)
  if (!hit) {
    hit = loadIgnoreRules(spec.path ? [spec.path] : [], false).noCurate
    noCurateCache.set(key, hit)
  }
  return hit
}

function markFailure(db: Db, rawId: string, error: string): void {
  db.prepare(
    `UPDATE raw SET curate_fails = curate_fails + 1,
       curate_error = :e,
       curate_stale = CASE WHEN curate_fails + 1 >= 3 THEN 0 ELSE 1 END
     WHERE id = :id`,
  ).run({ id: rawId, e: error.slice(0, 500) })
}

interface WriteResult {
  changed: boolean
  skippedPinned: boolean
  coined: string[]
  assigned: number
  tax: Awaited<ReturnType<typeof loadTaxonomy>>
}

async function writeSourcePage(
  db: Db,
  l: Layout,
  cfg: Config,
  cand: Candidate,
  out: z.infer<typeof PageOut>,
  tax: Awaited<ReturnType<typeof loadTaxonomy>>,
  rules: TaxonomyRules,
  passId: string,
  promptHash: string,
  dryRun?: boolean,
): Promise<WriteResult> {
  const slug = slugForSource(out.title, cand.id)
  const rawPath = db
    .prepare<{ path: string }>('SELECT path FROM raw WHERE id = :id')
    .get({ id: cand.id })?.path

  // Look the existing page up by CAPTURE, not by slug.
  //
  // The slug is derived from the model's title, and the model retitles freely
  // between runs. Keying on it meant a retitle silently produced a SECOND page
  // for the same capture — and skipped the pinned-page check, because the pin
  // lived at the old slug. One capture, one page.
  const prior = db
    .prepare<{ page_type: string; slug: string }>(
      `SELECT w.page_type, w.slug FROM wiki_sources ws
         JOIN wiki w ON w.id = ws.page_id
        WHERE ws.raw_id = :raw AND w.page_type = 'source' LIMIT 1`,
    )
    .get({ raw: cand.id })

  const wikiMod = await import('../store/wiki.ts')
  const existing = prior
    ? await wikiMod.readPage(l, 'source', prior.slug)
    : await wikiMod.readPage(l, 'source', slug)

  if (existing?.pinned) {
    // A human wrote this. Keep the prose; the evidence link is still ours to
    // maintain, but nothing else on the page gets touched.
    db.prepare('UPDATE raw SET curate_stale = 0, curate_hash = content_hash WHERE id = :id').run({
      id: cand.id,
    })
    return { changed: false, skippedPinned: true, coined: [], assigned: 0, tax }
  }

  const newTagStrings = out.new_tags.map((t) => (typeof t === 'string' ? t : t.tag))
  const norm = normalizeTags(out.tags, newTagStrings, tax, rules)

  const page: WikiPage = {
    id: pageKey('source', slug),
    type: 'source',
    slug,
    title: out.title,
    summary: out.summary,
    body: out.body.trim(),
    sources: rawPath ? [rawPath] : [],
    rawIds: [cand.id],
    // Entities are recorded as a field, NOT as [[wikilinks]]. Linking to an
    // entity page that does not exist yet makes every mention a permanent
    // dangling link — which drowned the lint report in noise it generated
    // itself. When entity pages ship, these become links.
    related: [],
    tags: norm.tags,
    project: out.project ?? cand.project ?? undefined,
    confidence: out.confidence as Confidence,
    fields: {
      ...out.fields,
      ...(out.entities.length ? { entities: [...new Set(out.entities)].slice(0, 8) } : {}),
    },
    created: existing?.created ?? isoDate(new Date(cand.created)),
    updated: isoDate(new Date()),
    pinned: false,
    passId,
    sourceHash: sourceHashOf([cand.text]),
    promptHash,
  }

  if (dryRun) {
    return {
      changed: true,
      skippedPinned: false,
      coined: norm.coined,
      assigned: norm.tags.length,
      tax,
    }
  }

  // A retitle changes the slug; retire the old file so one capture never ends
  // up with two pages on disk.
  if (prior && prior.slug !== slug) {
    const { rm } = await import('node:fs/promises')
    await rm(l.pageFile('source', prior.slug), { force: true })
    db.prepare("DELETE FROM wiki WHERE page_type = 'source' AND slug = :s").run({ s: prior.slug })
    db.prepare('DELETE FROM docs WHERE id = :d').run({ d: docId.wiki('source', prior.slug) })
  }

  const before = await journal.snapshot(l, l.rel(l.pageFile('source', slug)))
  const saved = await savePage(l, page)
  if (saved.result !== 'unchanged') {
    journal.record(db, {
      passId,
      targetKind: 'wiki',
      targetId: saved.path,
      op: before === undefined ? 'create' : 'update',
      before,
      after: undefined,
    })
  }

  db.prepare(
    `INSERT INTO wiki(id,path,slug,page_type,title,summary,body,project,confidence,fields,
                      created,updated,pass_id,source_hash,prompt_hash,pinned)
     VALUES (:id,:path,:slug,'source',:title,:summary,:body,:project,:conf,:fields,
             :created,:updated,:pass,:shash,:phash,0)
     ON CONFLICT(id) DO UPDATE SET
       path=:path, slug=:slug, title=:title, summary=:summary, body=:body, project=:project,
       confidence=:conf, fields=:fields, updated=:updated, pass_id=:pass,
       source_hash=:shash, prompt_hash=:phash`,
  ).run({
    id: page.id,
    path: saved.path,
    slug,
    title: page.title,
    summary: page.summary ?? null,
    body: page.body,
    project: page.project ?? null,
    conf: page.confidence,
    fields: JSON.stringify(page.fields),
    created: Date.parse(page.created) || cand.created,
    updated: Date.now(),
    pass: passId,
    shash: page.sourceHash ?? null,
    phash: promptHash,
  })

  db.prepare('DELETE FROM wiki_tags WHERE page_id = :id').run({ id: page.id })
  const insTag = db.prepare(
    'INSERT OR IGNORE INTO wiki_tags(page_id, tag, origin) VALUES (:p,:t,:o)',
  )
  for (const t of page.tags) insTag.run({ p: page.id, t, o: 'agent' })
  db.prepare('INSERT OR IGNORE INTO wiki_sources(page_id, raw_id) VALUES (:p,:r)').run({
    p: page.id,
    r: cand.id,
  })

  upsertDoc(
    db,
    {
      id: docId.wiki('source', slug),
      tier: 'curated',
      kind: 'source',
      refId: page.id,
      title: page.title,
      summary: page.summary,
      body: page.body,
      tags: page.tags,
      project: page.project,
      confidence: page.confidence,
      created: Date.parse(page.created) || cand.created,
      updated: Date.now(),
    },
    { maxChars: cfg.index.chunk_chars, overlap: cfg.index.chunk_overlap },
  )

  db.prepare(
    'UPDATE raw SET curate_stale = 0, curate_fails = 0, curate_error = NULL, curate_hash = content_hash WHERE id = :id',
  ).run({ id: cand.id })

  return {
    changed: saved.result !== 'unchanged',
    skippedPinned: false,
    coined: norm.coined,
    assigned: norm.tags.length,
    tax: bumpCounts(tax, norm.tags, rules.pinned),
  }
}

function renderSchema(cfg: Config): string {
  const entries = Object.entries(cfg.schema)
  if (entries.length === 0) return '(none configured — return an empty "fields" object)'
  return entries
    .map(([name, f]) => {
      const type = f.type === 'enum' ? `one of ${(f.values ?? []).join(' | ')}` : f.type
      return `- ${name} (${type})${f.description ? ` — ${f.description}` : ''}`
    })
    .join('\n')
}
