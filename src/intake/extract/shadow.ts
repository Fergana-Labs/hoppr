import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { glob } from 'tinyglobby'
import { parsePage } from '../../store/frontmatter.ts'
import type { Layout } from '../../store/layout.ts'

/**
 * Read back the extractions hoppr already paid for.
 *
 * An image's text costs an OCR pass and, when configured, a vision-model call.
 * Writing that only into the database made the database the store of derived
 * content rather than an index of it — so `hoppr reindex`, which is supposed to
 * be free, silently re-ran every extraction. Proven by turning OCR off and
 * reindexing: the text came back as "Image extraction is disabled", because it
 * had never been read from disk at all.
 *
 * The shadow files under `raw/` are the durable copy. This finds them by the
 * `source:` they record, so a rebuild reads what is already there and only
 * extracts what is genuinely new.
 */
const cache = new Map<string, Map<string, string>>()

export async function shadowIndex(l: Layout): Promise<Map<string, string>> {
  const hit = cache.get(l.root)
  if (hit) return hit

  const bySource = new Map<string, string>()
  if (existsSync(l.raw)) {
    const files = await glob(['raw/**/*.extract.md'], { cwd: l.root, absolute: true })
    for (const f of files) {
      const { data, body } = parsePage(await readFile(f, 'utf8').catch(() => ''))
      const src = (data as { source?: string }).source
      if (src && body.trim()) bySource.set(src, body.trim())
    }
  }
  cache.set(l.root, bySource)
  return bySource
}

/** Drop the memo: a sweep that writes new shadows must see them next time. */
export function resetShadowIndex(root?: string): void {
  if (root) cache.delete(root)
  else cache.clear()
}
