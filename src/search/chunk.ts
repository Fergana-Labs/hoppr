import { sha256 } from '../core/hash.ts'

export interface Chunk {
  ord: number
  heading: string | null
  text: string
  chunkHash: string
}

export interface ChunkOptions {
  maxChars?: number
  overlap?: number
}

/**
 * Markdown-aware chunking.
 *
 * Chunk 0 is always the "card" — title, summary, tags — so a short keyword
 * query ("that pdf about RRF") matches the distilled representation rather
 * than landing on some paragraph deep in a transcript. Everything after it
 * follows heading boundaries, then paragraphs, then a hard character split.
 */
export function chunkDocument(card: string, body: string, opts: ChunkOptions = {}): Chunk[] {
  const maxChars = opts.maxChars ?? 3200
  const overlap = opts.overlap ?? 320
  const out: Chunk[] = []
  const push = (heading: string | null, text: string) => {
    const t = text.trim()
    if (!t) return
    out.push({ ord: out.length, heading, text: t, chunkHash: sha256(t) })
  }

  push(null, card)

  for (const section of splitByHeading(body)) {
    for (const piece of splitToSize(section.text, maxChars, overlap)) {
      push(section.heading, section.heading ? `${section.heading}\n\n${piece}` : piece)
    }
  }
  return out
}

interface Section {
  heading: string | null
  text: string
}

export function splitByHeading(md: string): Section[] {
  const lines = md.split('\n')
  const sections: Section[] = []
  let heading: string | null = null
  let buf: string[] = []
  let inFence = false

  const flush = () => {
    const text = buf.join('\n').trim()
    if (text) sections.push({ heading, text })
    buf = []
  }

  for (const line of lines) {
    // Never split inside a fenced code block — a transcript is full of them,
    // and a chunk that starts mid-snippet embeds as noise.
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (!inFence && /^#{1,6}\s+\S/.test(line)) {
      flush()
      heading = line.replace(/^#{1,6}\s+/, '').trim()
      continue
    }
    buf.push(line)
  }
  flush()
  return sections.length ? sections : [{ heading: null, text: md.trim() }]
}

export function splitToSize(text: string, maxChars: number, overlap: number): string[] {
  if (text.length <= maxChars) return [text]
  const paras = text.split(/\n{2,}/)
  const out: string[] = []
  let cur = ''

  const flush = () => {
    if (!cur.trim()) return
    out.push(cur.trim())
    // Carry a tail forward so a fact spanning a boundary is retrievable
    // from either side.
    cur = overlap > 0 ? tail(cur, overlap) : ''
  }

  for (const p of paras) {
    if (p.length > maxChars) {
      flush()
      for (let i = 0; i < p.length; i += maxChars - overlap) {
        out.push(p.slice(i, i + maxChars).trim())
      }
      cur = ''
      continue
    }
    if (cur.length + p.length + 2 > maxChars) flush()
    cur = cur ? `${cur}\n\n${p}` : p
  }
  if (cur.trim()) out.push(cur.trim())
  return out.filter(Boolean)
}

function tail(s: string, n: number): string {
  if (s.length <= n) return s
  const cut = s.slice(s.length - n)
  const nl = cut.indexOf('\n')
  return nl > 0 ? cut.slice(nl + 1) : cut
}

/** The card: what a short keyword query should hit first. */
export function buildCard(parts: {
  title?: string
  summary?: string
  tags?: string[]
  kind?: string
  project?: string
}): string {
  const bits = [parts.title, parts.summary]
  if (parts.tags?.length) bits.push(parts.tags.join(' '))
  if (parts.project) bits.push(parts.project)
  if (parts.kind) bits.push(parts.kind)
  return bits.filter(Boolean).join('\n')
}
