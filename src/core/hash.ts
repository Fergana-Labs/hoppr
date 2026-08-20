import { createHash } from 'node:crypto'

/**
 * Content hash used for staleness. Normalization matters: re-saving a file with
 * different line endings or trailing whitespace must NOT look like a content
 * change, or every pass re-curates the whole corpus for free.
 */
export function normalizeText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function sha256(input: string | Uint8Array): string {
  const h = createHash('sha256')
  h.update(input)
  return `sha256:${h.digest('hex')}`
}

/** Hash of normalized text — the value stored in `content_hash`. */
export function contentHash(body: string): string {
  return sha256(normalizeText(body))
}
