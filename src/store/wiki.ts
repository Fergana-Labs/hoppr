import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { glob } from 'tinyglobby'
import { contentHash } from '../core/hash.ts'
import { isoDate, isoStamp, newId, slugify } from '../core/ids.ts'
import type { Confidence, PageType } from '../core/types.ts'
import { appendLine, type WriteResult, writeIfChanged } from './atomic.ts'
import { buildPage, isPinned, parsePage } from './frontmatter.ts'
import type { Layout } from './layout.ts'

export interface WikiPage {
  id: string
  type: PageType
  slug: string
  title: string
  summary?: string
  body: string
  sources: string[] // raw/ relative paths
  rawIds: string[]
  related: string[] // slugs
  tags: string[]
  project?: string
  confidence: Confidence
  fields: Record<string, unknown>
  created: string
  updated: string
  pinned: boolean
  passId?: string
  sourceHash?: string
  promptHash?: string
}

export interface SavedPage {
  page: WikiPage
  path: string
  result: WriteResult
}

/**
 * TIER 2 writer.
 *
 * Everything here is regenerable from `raw/`, which is what makes an
 * autonomous agent safe to point at it. Two protections keep that from being
 * merely theoretical:
 *
 *  - `pinned` pages keep their prose. A human edit sets the flag, and after
 *    that the curator may still attach new evidence but must not rewrite what
 *    you wrote.
 *  - Every write is skip-if-identical, so `git diff` stays a usable review of
 *    what actually changed rather than a wall of reserialized files.
 */
export async function savePage(l: Layout, page: WikiPage): Promise<SavedPage> {
  const path = l.pageFile(page.type, page.slug)
  const front: Record<string, unknown> = {
    title: page.title,
    type: page.type,
    sources: page.sources,
    related: page.related.map((s) => `[[${s}]]`),
    created: page.created,
    updated: page.updated,
    confidence: page.confidence,
    tags: page.tags,
    ...(page.project ? { project: page.project } : {}),
    ...page.fields,
    hoppr: {
      id: page.id,
      raw_ids: page.rawIds,
      ...(page.passId ? { pass: page.passId } : {}),
      ...(page.sourceHash ? { source_hash: page.sourceHash } : {}),
      ...(page.promptHash ? { prompt_hash: page.promptHash } : {}),
      pinned: page.pinned,
    },
  }
  const result = await writeIfChanged(path, buildPage(front, page.body))
  return { page, path: l.rel(path), result }
}

export async function readPage(
  l: Layout,
  type: PageType,
  slug: string,
): Promise<WikiPage | undefined> {
  const path = l.pageFile(type, slug)
  if (!existsSync(path)) return undefined
  return parseWikiPage(await readFile(path, 'utf8'), type, slug)
}

export function parseWikiPage(text: string, type: PageType, slug: string): WikiPage {
  const { data, body } = parsePage(text)
  const d = data as Record<string, unknown>
  const machine = (d.hoppr ?? {}) as Record<string, unknown>
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
  const fields: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(d)) if (!known.has(k)) fields[k] = v

  return {
    id: String(machine.id ?? newId()),
    type: (String(d.type ?? type) as PageType) ?? type,
    slug,
    title: String(d.title ?? slug),
    summary: typeof d.summary === 'string' ? d.summary : undefined,
    body,
    sources: asStrings(d.sources),
    rawIds: asStrings(machine.raw_ids),
    related: asStrings(d.related).map(stripWikilink),
    tags: asStrings(d.tags),
    project: typeof d.project === 'string' ? d.project : undefined,
    confidence: (String(d.confidence ?? 'medium') as Confidence) ?? 'medium',
    fields,
    created: String(d.created ?? isoDate(new Date())),
    updated: String(d.updated ?? isoDate(new Date())),
    // Through isPinned, so the rule for "a human owns this page" lives in one
    // place. It decides whether the curator rewrites your prose, which is the
    // wrong rule to have two copies of.
    pinned: isPinned(d),
    passId: machine.pass ? String(machine.pass) : undefined,
    sourceHash: machine.source_hash ? String(machine.source_hash) : undefined,
    promptHash: machine.prompt_hash ? String(machine.prompt_hash) : undefined,
  }
}

export async function listPages(l: Layout, type?: PageType): Promise<WikiPage[]> {
  const pattern = type ? `curated/wiki/${dirFor(type)}/*.md` : 'curated/wiki/*/*.md'
  const rels = (await glob([pattern], { cwd: l.root })).sort()
  const out: WikiPage[] = []
  for (const rel of rels) {
    const parts = rel.split('/')
    const slug = parts.pop()!.replace(/\.md$/, '')
    const dir = parts.pop()!
    out.push(parseWikiPage(await readFile(l.abs(rel), 'utf8'), typeForDir(dir), slug))
  }
  return out
}

function dirFor(type: PageType): string {
  return type === 'entity' ? 'entities' : `${type}s`
}
function typeForDir(dir: string): PageType {
  return (dir === 'entities' ? 'entity' : dir.replace(/s$/, '')) as PageType
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : []
}
export function stripWikilink(s: string): string {
  const m = /\[\[([^\]|#]+)/.exec(s)
  return (m?.[1] ?? s).trim()
}

/**
 * A page's identity is its (type, slug), not the capture it came from.
 *
 * A long session legitimately contains several distinct things, and the
 * curator will emit a page for each. Keying on the capture id made those
 * collide on the primary key, so pages existed on disk but never reached the
 * index — invisible to anything that joins through `wiki`. The sources
 * relation is many-to-many precisely so one capture can back several pages.
 */
export function pageKey(type: PageType | string, slug: string): string {
  return `${type}:${slug}`
}

/** Deterministic slug for a page derived from a capture. */
export function slugForSource(title: string, rawId: string): string {
  const base = slugify(title || 'capture')
  // Suffix keeps two captures with the same title from fighting over one page.
  return `${base}-${rawId.slice(-6).toLowerCase()}`
}

/**
 * The gist's two navigation files.
 *
 * `log.md` is append-only — the human-readable trail of what the curator did,
 * and the same text becomes the git commit message. `index.md` is regenerated
 * deterministically from the index every pass: a catalog is exactly the thing
 * code does better than a model, and one that drifts is worse than none.
 */
export async function appendLog(l: Layout, line: string): Promise<void> {
  await appendLine(l.wikiLog, `- ${isoStamp(new Date())} — ${line}`)
}

export async function writeIndex(l: Layout, pages: WikiPage[], counts: Record<string, number>) {
  const byType = new Map<PageType, WikiPage[]>()
  for (const p of pages) {
    const arr = byType.get(p.type) ?? []
    arr.push(p)
    byType.set(p.type, arr)
  }

  const lines: string[] = [
    '# Index',
    '',
    'Catalog of this wiki. Read this first to navigate.',
    '',
    `_Generated ${isoDate(new Date())} — ${pages.length} pages, ${counts.raw ?? 0} captures. Do not hand-edit._`,
    '',
  ]

  const ORDER: PageType[] = ['digest', 'concept', 'entity', 'comparison', 'source']
  for (const type of ORDER) {
    const group = (byType.get(type) ?? []).sort((a, b) => a.title.localeCompare(b.title))
    if (group.length === 0) continue
    lines.push(`## ${dirFor(type)} (${group.length})`, '')
    for (const p of group) {
      const tags = p.tags.length ? ` ${p.tags.map((t) => `#${t}`).join(' ')}` : ''
      const conf = p.confidence === 'high' ? '' : ` _(${p.confidence})_`
      lines.push(`- [[${p.slug}]] — ${p.summary ?? p.title}${conf}${tags}`)
    }
    lines.push('')
  }

  if (pages.length === 0) {
    lines.push(
      '_Nothing curated yet._ Throw something in with `hoppr add`, then run `hoppr curate`.',
      '',
    )
  }
  return writeIfChanged(l.wikiIndex, `${lines.join('\n')}\n`)
}

/** Hash of the source material a page was derived from — drives staleness. */
export function sourceHashOf(texts: string[]): string {
  return contentHash(texts.join('\n---\n'))
}
