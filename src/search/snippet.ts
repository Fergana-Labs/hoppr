/**
 * Snippet extraction.
 *
 * Deliberately done in application code rather than with FTS5's `snippet()`:
 * we need the same rendering for lexical hits, vector hits (which have no
 * lexical match to highlight), and pure filter listings. One code path means
 * one output shape for the CLI, the MCP tools, and the HTTP API.
 */
export function snippetFor(body: string, query: string, maxChars: number): string {
  const text = collapse(unescapeJsonish(body))
  if (!text) return ''
  if (text.length <= maxChars) return text

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter((t) => t.length > 2)

  const at = terms.length ? bestWindow(text.toLowerCase(), terms, maxChars) : 0
  const start = backToBoundary(text, at)
  const slice = text.slice(start, start + maxChars)
  const end = forwardToBoundary(slice)

  return `${start > 0 ? '…' : ''}${slice.slice(0, end).trim()}${
    start + end < text.length ? '…' : ''
  }`
}

function collapse(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Densest window of query terms — where the answer most likely is. */
function bestWindow(lower: string, terms: string[], width: number): number {
  const hits: number[] = []
  for (const t of terms) {
    let i = lower.indexOf(t)
    while (i !== -1 && hits.length < 500) {
      hits.push(i)
      i = lower.indexOf(t, i + t.length)
    }
  }
  if (hits.length === 0) return 0
  hits.sort((a, b) => a - b)

  let best = hits[0]!
  let bestCount = 0
  for (const h of hits) {
    const count = hits.filter((x) => x >= h && x < h + width).length
    if (count > bestCount) {
      bestCount = count
      best = h
    }
  }
  return Math.max(0, best - Math.floor(width / 4))
}

function backToBoundary(text: string, at: number): number {
  if (at === 0) return 0
  const sp = text.lastIndexOf(' ', at)
  return sp > at - 40 && sp > 0 ? sp + 1 : at
}

function forwardToBoundary(slice: string): number {
  const sp = slice.lastIndexOf(' ')
  return sp > slice.length - 40 && sp > 0 ? sp : slice.length
}

/**
 * Make a JSON-shaped body readable in a one-line snippet.
 *
 * A `.jsonl` transcript surfaces as `\\u201cTypes of MachineLearning
 * Papers\\u201d` and `\\nThought:` — technically the file's contents and
 * unreadable as a search result. Decoding the escapes costs nothing and is the
 * difference between a snippet you can skim and one you skip.
 *
 * Deliberately only unescapes; it does not parse. A malformed or truncated
 * JSON line still has to render as something.
 */
export function unescapeJsonish(s: string): string {
  if (!/\\[un"]/.test(s)) return s
  return s
    .replace(/\\{2,}/g, '\\')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(Number.parseInt(h, 16)))
    .replace(/\\n/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\"/g, '"')
}
