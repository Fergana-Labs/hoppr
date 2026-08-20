import { type Document, parseDocument, stringify } from 'yaml'
import { HopprError } from '../core/errors.ts'

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export interface ParsedPage {
  /** Live YAML document — mutate this, not a plain object, to preserve comments. */
  doc: Document.Parsed
  data: Record<string, unknown>
  body: string
  hadFrontmatter: boolean
}

/**
 * Round-trip parse. We deliberately use `parseDocument` rather than a
 * plain `parse`: it keeps comments, key order, and quoting style, so a
 * curator pass that touches one field produces a one-line git diff instead
 * of reformatting the whole file. (This is why we do not use gray-matter
 * for write-back — it re-serializes and destroys all of that.)
 */
export function parsePage(text: string): ParsedPage {
  const m = FENCE.exec(text)
  if (!m) {
    const doc = parseDocument('{}') as Document.Parsed
    return { doc, data: {}, body: text, hadFrontmatter: false }
  }
  const doc = parseDocument(m[1] ?? '') as Document.Parsed
  if (doc.errors.length) {
    throw HopprError.terminal(`invalid frontmatter: ${doc.errors[0]?.message}`)
  }
  const data = (doc.toJS() ?? {}) as Record<string, unknown>
  return { doc, data, body: text.slice(m[0].length), hadFrontmatter: true }
}

export function serializePage(doc: Document.Parsed | Document, body: string): string {
  const yaml = String(doc).trimEnd()
  const trimmed = body.replace(/^\n+/, '').trimEnd()
  return `---\n${yaml}\n---\n\n${trimmed}\n`
}

/**
 * Canonical key order for newly created pages. Fixed order is part of
 * deterministic serialization — it is what makes diffs reviewable.
 */
const KEY_ORDER = [
  'title',
  'type',
  'sources',
  'related',
  'created',
  'updated',
  'confidence',
  'tags',
  'project',
]

export function buildPage(front: Record<string, unknown>, body: string): string {
  const ordered: Record<string, unknown> = {}
  for (const k of KEY_ORDER) {
    if (front[k] !== undefined) ordered[k] = front[k]
  }
  // user-schema fields, alphabetized so their order never depends on the model
  const extra = Object.keys(front)
    .filter((k) => !KEY_ORDER.includes(k) && k !== 'hoppr')
    .sort()
  for (const k of extra) ordered[k] = front[k]
  // machine namespace always last
  if (front.hoppr !== undefined) ordered.hoppr = front.hoppr

  const yaml = stringify(ordered, { lineWidth: 100, nullStr: '' }).trimEnd()
  const trimmed = body.replace(/^\n+/, '').trimEnd()
  return `---\n${yaml}\n---\n\n${trimmed}\n`
}

/** Mutate one top-level key on a parsed doc, preserving everything else. */
export function setField(doc: Document.Parsed, key: string, value: unknown): void {
  doc.set(key, value)
}

export function getMachineMeta(data: Record<string, unknown>): Record<string, unknown> {
  const h = data.hoppr
  return h && typeof h === 'object' ? (h as Record<string, unknown>) : {}
}

/** True if a human has edited this page and the curator must leave prose alone. */
export function isPinned(data: Record<string, unknown>): boolean {
  return getMachineMeta(data).pinned === true
}
