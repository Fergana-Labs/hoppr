/**
 * URL handlers: the second plugin point.
 *
 * hoppr already has `Connector` — "here is a place, keep pulling from it".
 * That is the wrong shape for a link. A bookmark, an arXiv paper, a YouTube
 * video and a blog post are all *one URL that has to be turned into text*, and
 * how you do that is entirely per-domain: an arXiv abstract page hides the
 * paper behind a second URL, a YouTube page hides the words behind a caption
 * track, a blog post is just HTML.
 *
 * So a handler answers one question — given this URL, what is the text? — and
 * may hand back further URLs to follow, which is what makes multi-hop
 * (abs page → PDF → full text) fall out rather than needing its own machinery.
 */
export interface FetchedDoc {
  title?: string
  text: string
  /** Indexed alongside the text: authors, duration, publication date. */
  meta?: Record<string, unknown>
  /** URLs worth capturing as their own records, e.g. abs page → PDF. */
  follow?: string[]
  /** What produced this, for provenance and for `hoppr doctor`. */
  handler: string
}

export interface FetchContext {
  /** Hop budget. Handlers must not follow links once this reaches zero. */
  depth: number
  timeoutMs: number
  fetch: typeof globalThis.fetch
}

export interface UrlHandler {
  readonly id: string
  /** Cheap and synchronous — no network, no guessing. */
  match(url: URL): boolean
  fetch(url: URL, ctx: FetchContext): Promise<FetchedDoc | undefined>
}

/** Shared, so every handler identifies itself the same way. */
export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) hoppr/0.1'

export async function getText(
  url: string,
  ctx: FetchContext,
  accept = 'text/html,application/xhtml+xml',
): Promise<{ body: string; contentType: string } | undefined> {
  try {
    const res = await ctx.fetch(url, {
      headers: { 'user-agent': UA, accept },
      signal: AbortSignal.timeout(ctx.timeoutMs),
      redirect: 'follow',
    })
    if (!res.ok) return undefined
    return { body: await res.text(), contentType: res.headers.get('content-type') ?? '' }
  } catch {
    return undefined
  }
}
