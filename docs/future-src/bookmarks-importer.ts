/**
 * Netscape bookmark HTML — the format every browser exports and none document.
 *
 * Chrome, Firefox, Safari and Edge all emit the same 1994 shape: nested <DL>
 * lists of <A HREF> with ADD_DATE and TAGS attributes, and <H3> headers naming
 * the folder. The folder path is worth keeping: it is a taxonomy a human
 * already built by hand, and it makes better tags than anything inferred.
 */
export interface Bookmark {
  url: string
  title: string
  addedAt?: number
  /** Folder path, outermost first. Becomes tags. */
  folders: string[]
  tags: string[]
}

export function parseBookmarks(html: string): Bookmark[] {
  const out: Bookmark[] = []
  const stack: string[] = []
  // One pass over the tokens that matter, in document order — the nesting is
  // conveyed by <DL>/</DL> around <H3>, not by valid XML we could parse.
  const token = /<h3[^>]*>([\s\S]*?)<\/h3>|<\/dl>|<a\s+([^>]*)>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while (true) {
    m = token.exec(html)
    if (!m) break
    if (m[1] !== undefined) {
      stack.push(decode(strip(m[1])))
      continue
    }
    if (m[0].toLowerCase() === '</dl>') {
      stack.pop()
      continue
    }
    const attrs = m[2] ?? ''
    const href = /href="([^"]*)"/i.exec(attrs)?.[1]
    if (!href || !/^https?:/i.test(href)) continue
    const added = Number(/add_date="(\d+)"/i.exec(attrs)?.[1] ?? 0)
    const tagAttr = /tags="([^"]*)"/i.exec(attrs)?.[1] ?? ''
    out.push({
      url: decode(href),
      title: decode(strip(m[3] ?? '')) || href,
      // Browsers write seconds; a few write milliseconds.
      addedAt: added ? (added > 1e11 ? added : added * 1000) : undefined,
      folders: [...stack],
      tags: tagAttr
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    })
  }
  return out
}

function strip(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}
