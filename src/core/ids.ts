import { ulid } from 'ulid'

/**
 * ULIDs: lexical sort == chronological sort, and the id is recoverable from a
 * filename with zero database.
 */
export function newId(): string {
  return ulid()
}

const RESERVED = new Set(['index', 'log', 'overview', 'con', 'aux', 'nul', 'prn'])

/**
 * kebab-case slug, per the LLM-wiki naming convention. Deterministic: the same
 * title always yields the same slug, which is what makes name reservation work.
 */
export function slugify(input: string, maxLen = 72): string {
  let s = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  if (s.length > maxLen) {
    s = s.slice(0, maxLen).replace(/-[^-]*$/, '')
  }
  if (!s) s = 'untitled'
  if (RESERVED.has(s)) s = `${s}-page`
  return s
}

/** `2026/08/17` shard path — keeps directories small enough for ls and chokidar. */
export function datePath(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}/${m}/${day}`
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Stable ISO-8601 UTC to the second. Deterministic serialization keeps git diffs small. */
export function isoStamp(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`
}
