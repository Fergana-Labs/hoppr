import { stripHtml } from '../../connectors/dir.ts'
import { type FetchContext, type FetchedDoc, getText, UA, type UrlHandler } from './types.ts'

/** Title, description and canonical author out of the usual meta tags. */
function htmlMeta(html: string): { title?: string; meta: Record<string, unknown> } {
  const pick = (re: RegExp) => re.exec(html)?.[1]?.trim()
  const title =
    pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) ??
    pick(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const meta: Record<string, unknown> = {}
  const desc = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i)
  const author = pick(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)/i)
  const published = pick(
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)/i,
  )
  if (desc) meta.description = desc
  if (author) meta.author = author
  if (published) meta.published = published
  return { title: title ? stripHtml(title) : undefined, meta }
}

/**
 * arXiv. The abstract page is metadata; the paper is one hop away.
 *
 * Worth a dedicated handler rather than letting the generic one scrape the abs
 * page, because the abstract is the least useful 3% of a paper and the generic
 * handler would stop there and call it done.
 */
export const arxivHandler: UrlHandler = {
  id: 'arxiv',
  // ONLY the abstract page. Claiming /pdf/ too would make this handler answer
  // its own follow-up hop with the same abstract, capturing the metadata twice
  // and never fetching the paper.
  match: (u) => /(^|\.)arxiv\.org$/i.test(u.hostname) && /\/abs\//i.test(u.pathname),
  async fetch(url, ctx) {
    const id = /abs\/([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)/i.exec(url.pathname)?.[1]
    if (!id) return undefined

    // The export API gives clean metadata with no scraping at all.
    const api = await getText(
      `https://export.arxiv.org/api/query?id_list=${id}`,
      ctx,
      'application/atom+xml',
    )
    // Scope to <entry>: the feed has its own <title>, which is the query
    // echoed back. Reading the outer one titles every paper "arXiv Query: …".
    const entry = /<entry>([\s\S]*?)<\/entry>/.exec(api?.body ?? '')?.[1] ?? ''
    const x = (tag: string) =>
      new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(entry)?.[1]?.trim()
    const title = x('title')?.replace(/\s+/g, ' ')
    const summary = x('summary')?.replace(/\s+/g, ' ')
    const authors = [...entry.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1])

    const pdf = `https://arxiv.org/pdf/${id}`
    return {
      title: title ? `${title} (arXiv:${id})` : `arXiv:${id}`,
      text: [title, authors.length ? `Authors: ${authors.join(', ')}` : '', summary]
        .filter(Boolean)
        .join('\n\n'),
      meta: { arxiv_id: id, authors, pdf, published: x('published') },
      // The paper itself, captured as its own record with its own full text.
      follow: ctx.depth > 0 ? [pdf] : undefined,
      handler: 'arxiv',
    }
  },
}

/**
 * YouTube: the transcript, not the page.
 *
 * A video page is navigation chrome and a description; everything worth
 * indexing is in the caption track. Reaching it directly no longer works —
 * YouTube answers the `timedtext` endpoint with 200 and an empty body for
 * server-side requests, in every subtitle format. Verified, not assumed.
 *
 * So: use `yt-dlp` when it is on PATH. Keeping up with YouTube's countermeasures
 * is that project's entire job and it would be a losing battle to reimplement
 * here. Without it we still capture title and description and say plainly that
 * the transcript is missing, rather than silently indexing a video as if its
 * description were its content.
 */
export const youtubeHandler: UrlHandler = {
  id: 'youtube',
  match: (u) => /(^|\.)(youtube\.com|youtu\.be)$/i.test(u.hostname),
  async fetch(url, ctx) {
    const id =
      url.searchParams.get('v') ||
      /^\/(?:embed|shorts|live)\/([\w-]{11})/.exec(url.pathname)?.[1] ||
      (url.hostname.endsWith('youtu.be') ? url.pathname.slice(1) : '')
    if (!id) return undefined

    const page = await getText(`https://www.youtube.com/watch?v=${id}`, ctx)
    const { title, meta } = page ? htmlMeta(page.body) : { title: undefined, meta: {} }
    const transcript = await ytDlpTranscript(id, ctx.timeoutMs)

    return {
      title: title ?? `YouTube ${id}`,
      text:
        transcript ||
        [
          '[No transcript captured — install `yt-dlp` to index spoken content,',
          'or this video may have no captions.]',
          '',
          String(meta.description ?? ''),
        ].join('\n'),
      meta: { ...meta, video_id: id, has_transcript: Boolean(transcript) },
      handler: 'youtube',
    }
  },
}

/** Auto-generated captions are fine here: we want words, not typography. */
async function ytDlpTranscript(id: string, timeoutMs: number): Promise<string> {
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { mkdtemp, readdir, readFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const dir = await mkdtemp(join(tmpdir(), 'hoppr-yt-'))
    try {
      // yt-dlp exits nonzero for reasons that do not mean failure — a version
      // nag, one unavailable subtitle language among several. It had written
      // the captions and we were throwing them away. Judge by the output.
      await promisify(execFile)(
        'yt-dlp',
        [
          '--skip-download',
          '--write-auto-sub',
          '--write-sub',
          '--sub-lang',
          'en.*',
          '--sub-format',
          'vtt',
          '-o',
          join(dir, 't.%(ext)s'),
          `https://www.youtube.com/watch?v=${id}`,
        ],
        { timeout: Math.max(timeoutMs, 60_000) },
      ).catch(() => undefined)

      const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.vtt'))
      if (!files.length) return ''
      // Prefer a real caption track over the auto-generated one when both exist.
      const best =
        files.find((f) => !/orig|auto/.test(f) && /\.en\.vtt$/.test(f)) ?? (files[0] as string)
      return vttToText(await readFile(join(dir, best), 'utf8'))
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  } catch {
    // Not installed, or the video has no captions. Both are ordinary.
    return ''
  }
}

/**
 * WebVTT → prose. Auto-generated captions repeat each line as a rolling
 * two-line window, so consecutive duplicates have to go or the transcript
 * comes out roughly twice its true length with every phrase doubled.
 */
export function vttToText(vtt: string): string {
  const out: string[] = []
  for (const raw of vtt.split('\n')) {
    const line = raw.trim()
    if (!line || line === 'WEBVTT') continue
    if (line.includes('-->')) continue
    if (/^(Kind|Language|NOTE|STYLE|REGION):?/.test(line)) continue
    // Inline karaoke timing tags, e.g. <00:00:04.320><c>word</c>
    const clean = line.replace(/<[^>]*>/g, '').trim()
    if (!clean || clean === '[Music]') continue
    if (out[out.length - 1] === clean) continue
    out.push(clean)
  }
  return out.join(' ').replace(/\s+/g, ' ').trim()
}

/** A direct PDF link — including the one arXiv hands us. */
export const pdfUrlHandler: UrlHandler = {
  id: 'pdf-url',
  match: (u) => /\.pdf($|\?)/i.test(u.pathname + u.search) || /arxiv\.org\/pdf\//i.test(u.href),
  async fetch(url, ctx) {
    try {
      const res = await ctx.fetch(url.href, {
        headers: { 'user-agent': UA, accept: 'application/pdf' },
        signal: AbortSignal.timeout(ctx.timeoutMs),
        redirect: 'follow',
      })
      if (!res.ok) return undefined
      const { writeFile, unlink, mkdtemp } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const dir = await mkdtemp(join(tmpdir(), 'hoppr-pdf-'))
      const path = join(dir, 'doc.pdf')
      await writeFile(path, Buffer.from(await res.arrayBuffer()))
      const { extractPdfText } = await import('../extract/pdf.ts')
      let text = await extractPdfText(path)
      if (text.length < 40) {
        const { ocrPdf } = await import('../extract/ocr.ts')
        text = await ocrPdf(path)
      }
      await unlink(path).catch(() => {})
      if (!text.trim()) return undefined
      return {
        title: decodeURIComponent(url.pathname.split('/').pop() ?? url.href),
        text,
        handler: 'pdf-url',
      }
    } catch {
      return undefined
    }
  },
}

/** Anything else: readable text out of the HTML. */
export const genericHandler: UrlHandler = {
  id: 'generic',
  match: () => true,
  async fetch(url, ctx) {
    const page = await getText(url.href, ctx)
    if (!page) return undefined
    if (page.contentType.includes('application/pdf')) return pdfUrlHandler.fetch(url, ctx)
    const { title, meta } = htmlMeta(page.body)
    // Drop the chrome before stripping tags, or every capture is a nav menu.
    const body = page.body
      .replace(/<(nav|header|footer|aside|form|noscript)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    const text = stripHtml(body)
    if (text.length < 20) return undefined
    return { title, text, meta, handler: 'generic' }
  },
}

function _decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
}

/**
 * Order matters: the generic handler matches everything, so it must be last.
 * Specific handlers claim their domain before the fallback sees it.
 */
export const HANDLERS: UrlHandler[] = [arxivHandler, youtubeHandler, pdfUrlHandler, genericHandler]

export function handlerFor(url: URL): UrlHandler {
  return HANDLERS.find((h) => h.match(url)) ?? genericHandler
}

export async function fetchUrl(
  href: string,
  opts: { depth?: number; timeoutMs?: number; fetchImpl?: typeof globalThis.fetch } = {},
): Promise<FetchedDoc | undefined> {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  const ctx: FetchContext = {
    depth: opts.depth ?? 1,
    timeoutMs: opts.timeoutMs ?? 20_000,
    fetch: opts.fetchImpl ?? globalThis.fetch,
  }
  return handlerFor(url).fetch(url, ctx)
}
