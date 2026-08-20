import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, relative } from 'node:path'
import { glob } from 'tinyglobby'
import { contentHash } from '../core/hash.ts'
import { IMAGE_EXTS } from '../intake/extract/image.ts'
import { LEGACY_OFFICE_EXTS, OFFICE_EXTS } from '../intake/extract/office.ts'
import { isIgnored, loadIgnoreRules } from './ignore.ts'
import type {
  Connector,
  ConnectorContext,
  ConnectorSource,
  IngestCandidate,
  PullResult,
} from './types.ts'

/**
 * Index a folder you own, WITHOUT copying it.
 *
 * This is the reference-mode source: the bytes stay exactly where they are —
 * in ~/Downloads, in a papers archive, wherever — and hoppr records only
 * provenance (path, size, mtime, hash) plus extracted text in its own index
 * under ~/.hoppr/<name>.
 *
 * That is a stronger tier-1 guarantee than owning a copy would be. hoppr never
 * opens these files for writing, so it provably cannot damage them, and there
 * is no second copy of a 2GB corpus to keep in sync. The cost is that the
 * source can change or vanish underneath us, which the cursor's mtime/size
 * check turns into an ordinary re-index rather than silent staleness.
 *
 * Deliberately NOT an AST tool. For code structure, use something that parses
 * it properly; a folder hoppr is for prose — papers, docs, notes, PDFs —
 * where summarizing and tagging is the whole job.
 */
export const dirConnector: Connector = {
  id: 'dir',
  label: 'Folder',
  defaultIntervalMs: 300_000,

  async detect(cfg) {
    const root = String(cfg.path ?? '')
    return Boolean(root) && existsSync(root)
  },

  async discover(cfg) {
    const root = String(cfg.path ?? '')
    if (!root || !existsSync(root)) return []

    const exclude = [...DEFAULT_EXCLUDES, ...((cfg.exclude as string[]) ?? [])]
    const maxBytes = Number(cfg.max_file_mb ?? 20) * 1024 * 1024

    const files = await glob(
      INDEXABLE.map((e) => `**/*${e}`),
      { cwd: root, ignore: exclude, absolute: true, dot: false },
    )

    // The source folder's own .gitignore, plus .hopprignore on top. The store
    // is also consulted, so a source with no folder of its own (agent logs)
    // can still be scoped.
    const dirs = [root, ...((cfg.ignore_dirs as string[]) ?? [])]
    const rules = loadIgnoreRules(dirs, cfg.use_gitignore !== false)

    const out: ConnectorSource[] = []
    for (const f of files) {
      const rel = relative(root, f)
      if (rules.skip.length && isIgnored(rel, rules.skip)) continue
      const s = await stat(f).catch(() => undefined)
      if (!s?.isFile() || s.size > maxBytes || s.size === 0) continue
      out.push({ key: f, label: rel, mtimeMs: s.mtimeMs, size: s.size })
    }
    return out
  },

  async pull(source, ctx): Promise<PullResult> {
    const cursor = (ctx.cursor ?? undefined) as { mtimeMs?: number; size?: number } | undefined
    const s = await stat(source.key).catch(() => undefined)
    if (!s) {
      // The file was deleted. Report nothing; the reconciler prunes it.
      return { items: [], cursor: { mtimeMs: 0, size: 0 }, done: true }
    }
    // Unchanged since the last look: skip without reading a byte.
    if (cursor && cursor.mtimeMs === s.mtimeMs && cursor.size === s.size) {
      return { items: [], cursor, done: true }
    }

    const text = await extractFileText(source.key, ctx)
    if (!text.trim()) return { items: [], cursor: { mtimeMs: s.mtimeMs, size: s.size }, done: true }

    const root = String(ctx.config.path ?? '')
    const rel = root ? relative(root, source.key) : basename(source.key)

    const item: IngestCandidate = {
      // The path IS the identity: editing a file updates its record rather
      // than creating a second one.
      externalId: `dir:${source.key}`,
      kind: 'file',
      title: basename(source.key, extname(source.key)),
      body: text,
      createdAt: new Date(s.birthtimeMs || s.mtimeMs),
      updatedAt: new Date(s.mtimeMs),
      project: root ? basename(root) : undefined,
      origin: {
        connector: 'dir',
        // The pointer back to the real file. Nothing is copied.
        external_path: source.key,
        relative_path: rel,
        bytes: s.size,
        mtime_ms: s.mtimeMs,
        content_hash: contentHash(text),
      },
      partial: false,
    }
    return { items: [item], cursor: { mtimeMs: s.mtimeMs, size: s.size }, done: true }
  },
}

/** Prose, data, documents, and images. No source files: hoppr is not an AST tool. */
const INDEXABLE = [
  ...IMAGE_EXTS,
  ...OFFICE_EXTS,
  ...LEGACY_OFFICE_EXTS,
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.rst',
  '.org',
  '.pdf',
  '.html',
  '.htm',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.toml',
  '.csv',
  '.tsv',
]

const DEFAULT_EXCLUDES = [
  // A `--here` hoppr sits inside the folder it indexes. Dotfiles are already
  // skipped, but never index your own store even if that changes.
  '**/.hoppr/**',
  '**/node_modules/**',
  '**/.git/**',
  '**/.venv/**',
  '**/venv/**',
  '**/dist/**',
  '**/build/**',
  '**/target/**',
  '**/__pycache__/**',
  '**/.next/**',
  '**/coverage/**',
  '**/*.lock',
  '**/package-lock.json',
]

/**
 * Extract indexable text.
 *
 * Every branch degrades to "recorded by name" rather than throwing: a folder
 * you point hoppr at will contain a corrupt PDF, a binary with a .txt
 * extension, and a file you lack permission to read. None of those should
 * cost you the other 900 files.
 */
export async function extractFileText(path: string, ctx?: ConnectorContext): Promise<string> {
  const ext = extname(path).toLowerCase()
  if (IMAGE_EXTS.includes(ext)) {
    const { describeImage } = await import('../intake/extract/image.ts')
    const r = await describeImage(path, await ctx?.llm?.())
    // Name-only beats dropping it: you can still find the file by filename,
    // and a later sync with a provider configured fills in the rest.
    return r.described
      ? r.text
      : `[image: ${basename(path)}]\n\nNo vision-capable model configured — indexed by name and path only.`
  }
  if (OFFICE_EXTS.includes(ext)) {
    const { extractOfficeText } = await import('../intake/extract/office.ts')
    const text = await extractOfficeText(path)
    if (text.trim().length >= 20) return text
    return `[${ext.slice(1)}: ${basename(path)}]\n\nNo extractable text — empty, corrupt, or password-protected. Indexed by name and path.`
  }
  if (LEGACY_OFFICE_EXTS.includes(ext)) {
    // Binary OLE formats, not ZIP+XML. Recognised so the reason is visible
    // rather than the file just never appearing.
    return `[${ext.slice(1)}: ${basename(path)}]\n\nPre-2007 binary Office format — not extractable. Re-save as ${ext}x to index its text.`
  }
  if (ext === '.pdf') {
    const { extractPdfText } = await import('../intake/extract/pdf.ts')
    const text = await extractPdfText(path)
    if (text.length >= 40) return text
    // No text layer means a scan: the file is text to a human and opaque to
    // every extractor. Rasterise and OCR it rather than indexing a filename.
    const { ocrPdf } = await import('../intake/extract/ocr.ts')
    const scanned = await ocrPdf(path)
    if (scanned.length >= 40) return scanned
    return `[PDF: ${basename(path)}]\n\nNo extractable text layer and OCR found nothing. Indexed by name and path.`
  }
  if (ext === '.html' || ext === '.htm') {
    const raw = await readFile(path, 'utf8').catch(() => '')
    return stripHtml(raw)
  }
  return readFile(path, 'utf8').catch(() => '')
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
