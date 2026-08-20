import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { slugify } from '../core/ids.ts'
import { writeIfChanged } from '../store/atomic.ts'
import type { Layout } from '../store/layout.ts'

export interface TagEntry {
  label?: string
  description?: string
  count: number
  pinned?: boolean
  aliases?: string[]
  merged_into?: string
}

export interface Taxonomy {
  version: number
  tags: Record<string, TagEntry>
}

export interface TaxonomyRules {
  vocabularySize: number
  maxNewTagsPerItem: number
  maxTagsPerItem: number
  pinned: string[]
  stoplist: string[]
  /** Below this many live tags the vocabulary is still forming, and the
   *  per-item coinage cap is lifted so a cold store can bootstrap at all. */
  bootstrapFloor?: number
}

export async function loadTaxonomy(l: Layout): Promise<Taxonomy> {
  if (!existsSync(l.tagsFile)) return { version: 1, tags: {} }
  const parsed = (parseYaml(await readFile(l.tagsFile, 'utf8')) ?? {}) as Partial<Taxonomy>
  return { version: parsed.version ?? 1, tags: parsed.tags ?? {} }
}

export async function saveTaxonomy(l: Layout, tax: Taxonomy): Promise<void> {
  const header = `# The tag vocabulary. Agent-maintained, human-editable.
#
# Existing tags are fed back to the model as preferred vocabulary on every
# pass, so the set converges instead of drifting into near-duplicates like
# "ai-agents" / "agentic AI" / "LLM agents". Pin a tag to protect it from
# ever being merged away.
`
  // Sort keys so the file has a stable order and git diffs stay readable.
  const tags: Record<string, TagEntry> = {}
  for (const k of Object.keys(tax.tags).sort()) tags[k] = tax.tags[k]!
  await writeIfChanged(l.tagsFile, header + stringifyYaml({ version: tax.version, tags }))
}

/**
 * The vocabulary block fed back into the ingest prompt.
 *
 * This is the whole convergence mechanism, and it is worth being precise about
 * why it works: the tag set is simultaneously the model's output AND its
 * dictionary. Asking for free-form topics on each capture independently
 * produces synonyms forever, because nothing in the loop ever sees the other
 * answers. Feeding the existing set back makes reuse the path of least
 * resistance, so the vocabulary settles instead of growing without bound.
 */
export function renderVocabulary(tax: Taxonomy, limit: number): string {
  const live = Object.entries(tax.tags)
    .filter(([, e]) => !e.merged_into)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, limit)

  if (live.length === 0) return '(empty — you are establishing this vocabulary)'

  const lines = live.map(([tag, e]) =>
    e.description ? `${tag} (${e.count}) — ${e.description}` : `${tag} (${e.count})`,
  )

  const retired = Object.entries(tax.tags)
    .filter(([, e]) => e.merged_into)
    .map(([tag, e]) => `${tag} → ${e.merged_into}`)

  if (retired.length) {
    lines.push(
      '',
      'Retired — do NOT use these, use the canonical tag instead:',
      ...retired.slice(0, 40),
    )
  }
  return lines.join('\n')
}

export interface NormalizeResult {
  tags: string[]
  coined: string[]
  rejected: Array<{ tag: string; reason: string }>
}

/**
 * Normalize model-proposed tags IN CODE, not in the prompt.
 *
 * A model asked politely to reuse vocabulary will mostly comply and
 * occasionally invent `ai-agent` next to `ai-agents`. Enforcing the rules
 * deterministically here means convergence does not depend on the model
 * having a good day — and it makes the behaviour testable without an LLM.
 */
export function normalizeTags(
  proposed: string[],
  newProposed: string[],
  tax: Taxonomy,
  rules: TaxonomyRules,
): NormalizeResult {
  const out: string[] = []
  const coined: string[] = []
  const rejected: Array<{ tag: string; reason: string }> = []
  const stop = new Set(rules.stoplist.map((s) => s.toLowerCase()))
  const known = Object.keys(tax.tags).filter((t) => !tax.tags[t]!.merged_into)
  // A cold store has no vocabulary to reuse; capping coinage there would
  // starve the very set the cap exists to protect.
  const bootstrapping = known.length < (rules.bootstrapFloor ?? 20)

  const accept = (tag: string, _isNew: boolean) => {
    const slug = slugify(tag)
    if (!slug || slug === 'untitled') return
    if (out.includes(slug)) return
    if (stop.has(slug)) {
      rejected.push({ tag: slug, reason: 'stoplist' })
      return
    }
    if (out.length >= rules.maxTagsPerItem) {
      rejected.push({ tag: slug, reason: 'over max_tags_per_item' })
      return
    }

    // Follow an alias to its canonical form.
    const entry = tax.tags[slug]
    if (entry?.merged_into) {
      if (!out.includes(entry.merged_into)) out.push(entry.merged_into)
      return
    }
    if (entry) {
      out.push(slug)
      return
    }

    // Unknown tag: is it a near-duplicate of one we already have?
    const near = nearestKnown(slug, known)
    if (near) {
      if (!out.includes(near)) out.push(near)
      rejected.push({ tag: slug, reason: `near-duplicate of ${near}` })
      return
    }

    // A tag the model listed as existing but which does not exist is still a
    // coinage. Counting it as one closes the obvious bypass: without this the
    // model could put every invention in `tags` and the cap would never bind.
    if (!bootstrapping && coined.length >= rules.maxNewTagsPerItem) {
      rejected.push({ tag: slug, reason: 'over max_new_tags_per_item' })
      return
    }
    coined.push(slug)
    out.push(slug)
  }

  for (const t of proposed) accept(t, false)
  for (const t of newProposed) accept(t, true)
  return { tags: out, coined, rejected }
}

/** Same stem, or within edit distance 2 — the shapes real synonyms take. */
export function nearestKnown(tag: string, known: string[]): string | undefined {
  const stem = (s: string) => s.replace(/(ies|es|s)$/, '').replace(/-/g, '')
  const target = stem(tag)
  for (const k of known) if (stem(k) === target) return k
  for (const k of known) {
    if (Math.abs(k.length - tag.length) > 2) continue
    if (editDistance(k, tag) <= 2 && Math.min(k.length, tag.length) >= 5) return k
  }
  return undefined
}

export function editDistance(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1)
  const cur = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!
  }
  return prev[b.length]!
}

export function bumpCounts(tax: Taxonomy, tags: string[], pinned: string[]): Taxonomy {
  const now = { ...tax, tags: { ...tax.tags } }
  for (const t of tags) {
    const e = now.tags[t]
    now.tags[t] = e
      ? { ...e, count: e.count + 1 }
      : { count: 1, ...(pinned.includes(t) ? { pinned: true } : {}) }
  }
  for (const p of pinned) {
    if (!now.tags[p]) now.tags[p] = { count: 0, pinned: true }
  }
  return now
}

/** Recompute counts from ground truth, so a rebuild cannot drift. */
export function recount(tax: Taxonomy, allPageTags: string[][]): Taxonomy {
  const counts = new Map<string, number>()
  for (const tags of allPageTags) for (const t of tags) counts.set(t, (counts.get(t) ?? 0) + 1)
  const tags: Record<string, TagEntry> = {}
  for (const [k, e] of Object.entries(tax.tags)) {
    tags[k] = { ...e, count: counts.get(k) ?? (e.pinned || e.merged_into ? e.count : 0) }
  }
  for (const [k, n] of counts) if (!tags[k]) tags[k] = { count: n }
  return { ...tax, tags }
}

/** Share of assigned tags that already existed — the convergence metric. */
export function reuseRate(assigned: string[], coined: string[]): number {
  if (assigned.length === 0) return 1
  return (assigned.length - coined.length) / assigned.length
}
