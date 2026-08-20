/**
 * Snippet extraction.
 *
 * Deliberately done in application code rather than with FTS5's `snippet()`:
 * we need the same rendering for lexical hits, vector hits (which have no
 * lexical match to highlight), and pure filter listings. One code path means
 * one output shape for the CLI, the MCP tools, and the HTTP API.
 */
export function snippetFor(body: string, query: string, maxChars: number): string {
  const text = collapse(body)
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
