import type { RawRecord } from '../../core/types.ts'
import type { Layout } from '../../store/layout.ts'
import * as rawStore from '../../store/raw.ts'

export interface Extracted {
  text: string
  title?: string
  /** True when we could not read this artifact as text at all. */
  binary?: boolean
}

const TEXTUAL = /^(text\/|application\/(json|x-ndjson|yaml|xml|javascript))/

/**
 * Turn a raw artifact into plain text for indexing.
 *
 * The output is written to `raw.text` in the index and NEVER back into raw/ —
 * extraction is derived data. That is what lets an improved extractor
 * re-derive better text from captures you already have, without re-capturing
 * anything.
 */
export async function extract(l: Layout, rec: RawRecord): Promise<Extracted> {
  if (rec.media_type === 'application/x-ndjson' && rec.kind === 'session') {
    return extractTranscript(await rawStore.readText(l, rec))
  }
  if (TEXTUAL.test(rec.media_type)) {
    return { text: await rawStore.readText(l, rec) }
  }
  // PDFs, images and friends land here until their extractors ship. The
  // capture is already durable; only its searchable text is pending.
  return { text: rec.title ?? '', binary: true }
}

/**
 * Placeholder transcript renderer. The real per-harness mapping lands with the
 * connectors; this keeps a JSONL capture searchable in the meantime instead of
 * silently indexing nothing.
 */
export function extractTranscript(jsonl: string): Extracted {
  const out: string[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line) as Record<string, unknown>
      const t = pickText(o)
      if (t) out.push(t)
    } catch {
      // A truncated final line is normal in a file being appended to live.
    }
  }
  return { text: out.join('\n\n') }
}

function pickText(o: Record<string, unknown>): string | undefined {
  const msg = (o.message ?? o.payload ?? o) as Record<string, unknown>
  const content = msg?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === 'object' && b && 'text' in b ? String((b as { text: unknown }).text) : '',
      )
      .filter(Boolean)
      .join('\n')
  }
  if (typeof msg?.text === 'string') return msg.text as string
  return undefined
}
