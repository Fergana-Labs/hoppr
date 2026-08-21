import { readFile, stat } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { HopprError } from '../core/errors.ts'
import type { SourceKind } from '../core/types.ts'
import type { Layout } from '../store/layout.ts'
import * as raw from '../store/raw.ts'
import { redact } from './redact.ts'

/** Extensions whose contents are prose or code, and so can be scrubbed. */
const TEXT_EXTS = new Set([
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.rst',
  '.org',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.toml',
  '.csv',
  '.tsv',
  '.html',
  '.htm',
  '.env',
  '.sh',
  '.log',
])

export interface RedactionConfig {
  enabled: boolean
  extraPatterns: string[]
  /** The entropy net beneath the vendor patterns. */
  entropy?: boolean
}

export interface AddInput {
  text?: string
  file?: string
  url?: string
  title?: string
  tags?: string[]
  project?: string
  source?: SourceKind
  redaction?: RedactionConfig
}

const MEDIA_BY_EXT: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.ndjson': 'application/x-ndjson',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.csv': 'text/csv',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
}

/**
 * Intake writes tier 1 and nothing else. It is deliberately synchronous and
 * cheap: `hoppr add` must never block on an LLM or on the daemon. Curation is
 * a separate, later, resumable step — so a capture is durable the moment the
 * command returns, even with no daemon and no API key.
 */
export async function add(l: Layout, input: AddInput) {
  const source: SourceKind = input.source ?? 'cli'

  if (input.file) {
    const abs = resolve(input.file)
    const s = await stat(abs).catch(() => {
      throw HopprError.user(`no such file: ${input.file}`)
    })
    if (!s.isFile()) throw HopprError.user(`not a file: ${input.file}`)
    const ext = extname(abs).toLowerCase()
    const raw_bytes = await readFile(abs)

    /**
     * Scrub a TEXT file before it is written, exactly as typed input is.
     *
     * `add --file .env` wrote the bytes verbatim into raw/, where they would be
     * indexed, embedded, committed to git — the precise failure redaction
     * exists to prevent, reached by the one path that skipped it. Binary is
     * left alone: it cannot be pattern-matched, and rewriting it would corrupt
     * the capture.
     */
    const textLike = TEXT_EXTS.has(ext) || (MEDIA_BY_EXT[ext] ?? '').startsWith('text/')
    const bytes = textLike
      ? redact(raw_bytes.toString('utf8'), {
          enabled: input.redaction?.enabled,
          entropy: input.redaction?.entropy,
          extraPatterns: input.redaction?.extraPatterns,
        }).text
      : raw_bytes

    return raw.append(l, {
      bytes,
      kind: 'file',
      source,
      mediaType: MEDIA_BY_EXT[ext] ?? 'application/octet-stream',
      ext: ext || '.bin',
      title: input.title ?? basename(abs),
      created: s.mtime,
      origin: { path: abs, tags: input.tags, project: input.project },
    })
  }

  if (input.url) {
    // Fetch by default: a stored URL is a bookmark, and a bookmark you cannot
    // search the contents of is the thing hoppr exists to fix.
    // The link, recorded. hoppr does not go to the network: the core is a
    // folder and an index over it, and fetching a page is a different tool's
    // job. See docs/FUTURE-SOURCES.md.
    const body = input.text ? `${input.url}\n\n${input.text}` : input.url
    return raw.append(l, {
      bytes: body,
      kind: 'url',
      source,
      mediaType: 'text/plain',
      ext: '.txt',
      title: input.title ?? input.url,
      externalId: `url:${input.url}`,
      origin: { url: input.url, tags: input.tags, project: input.project, fetched: false },
    })
  }

  const raw_text = (input.text ?? '').trim()
  if (!raw_text)
    throw HopprError.user('nothing to add — pass text, --file, or --url (or pipe stdin)')
  const text = redact(raw_text, {
    enabled: input.redaction?.enabled,
    entropy: input.redaction?.entropy,
    extraPatterns: input.redaction?.extraPatterns,
  }).text

  return raw.append(l, {
    bytes: text,
    kind: 'text',
    source,
    mediaType: 'text/markdown',
    ext: '.md',
    title: input.title ?? deriveTitle(text),
    origin: { tags: input.tags, project: input.project },
  })
}

/** First non-empty line, stripped of markdown heading syntax, capped. */
export function deriveTitle(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return 'Untitled'
  const clean = line.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '')
  return clean.length > 80 ? `${clean.slice(0, 77).trimEnd()}…` : clean
}
