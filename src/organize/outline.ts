import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Config } from '../config/schema.ts'
import type { Db } from '../db/driver.ts'
import type { LlmProvider } from '../llm/provider.ts'
import { ensureDir, writeIfChanged } from '../store/atomic.ts'
import { parsePage } from '../store/frontmatter.ts'
import type { Layout } from '../store/layout.ts'

export interface OutlineStats {
  written: number
  skipped: number
  failed: number
}

/**
 * Build the pages you asked for by name.
 *
 * Everything else in the wiki is emergent — a concept page exists because
 * enough captures clustered around a tag. This is the other half: the two or
 * three pages you know you want before any data arrives, each with a standing
 * brief.
 *
 * A page is skipped if you have edited it (`pinned`) or if its `mode` is
 * `once` and it already exists. That is the difference between "keep this
 * current" and "start me off" — and both are things people want.
 */
export async function buildOutline(
  db: Db,
  l: Layout,
  cfg: Config,
  llm: LlmProvider,
  opts: { onProgress?: (m: string) => void } = {},
): Promise<OutlineStats> {
  const st: OutlineStats = { written: 0, skipped: 0, failed: 0 }
  if (cfg.wiki.outline.length === 0) return st

  for (const entry of cfg.wiki.outline) {
    // A trailing slash means "make the folder", which is how you reserve a
    // section of the wiki without dictating its pages.
    if (entry.path.endsWith('/')) {
      await ensureDir(join(l.wiki, entry.path))
      continue
    }

    const abs = join(l.wiki, entry.path)
    if (existsSync(abs)) {
      const existing = parsePage(await readFileSafe(abs))
      const d = existing.data as Record<string, unknown>
      const hoppr = (d.hoppr ?? {}) as Record<string, unknown>
      // Hand-edited, or write-once and already written.
      if (hoppr.pinned === true || entry.mode === 'once') {
        st.skipped++
        continue
      }
    }

    opts.onProgress?.(`outline: ${entry.path}`)
    // Give the model the corpus's own vocabulary rather than nothing: an
    // instruction with no material produces a page of confident generalities.
    const tags = db
      .prepare<{ tag: string; n: number }>(
        'SELECT tag, count(*) n FROM wiki_tags GROUP BY tag ORDER BY n DESC LIMIT 40',
      )
      .all()
      .map((r) => `${r.tag} (${r.n})`)
      .join(', ')
    const titles = db
      .prepare<{ title: string }>(
        "SELECT title FROM wiki WHERE page_type = 'source' ORDER BY updated DESC LIMIT 40",
      )
      .all()
      .map((r) => `- ${r.title}`)
      .join('\n')

    if (!titles) {
      // Nothing to write about yet. Writing the page anyway would fill it with
      // plausible nonsense that a later pass would have to unlearn.
      st.skipped++
      continue
    }

    try {
      const { text } = await llm.completeText({
        prompt: [
          `Write the markdown body of \`${entry.path}\` for this knowledge base.`,
          '',
          `## What this page is for`,
          entry.prompt || 'A useful overview of the material below.',
          '',
          `## What the corpus is`,
          cfg.wiki.orientation || cfg.hopper.description || '(not described)',
          '',
          `## Tags in use`,
          tags || '(none yet)',
          '',
          `## Recent pages`,
          titles,
          '',
          'Write only the body. No frontmatter, no title heading — both are added',
          'for you. Reference other pages as [[wikilinks]] using their slugs. Say',
          'plainly where the material is thin rather than padding.',
        ].join('\n'),
        tier: 'quality',
        purpose: 'wiki.outline',
        maxTokens: 2048,
      })

      const body = text.trim()
      if (!body) {
        st.failed++
        continue
      }
      const title = entry.path.replace(/\.md$/, '').split('/').pop() ?? entry.path
      const front = [
        '---',
        `title: ${JSON.stringify(humanise(title))}`,
        'type: outline',
        `updated: ${new Date().toISOString().slice(0, 10)}`,
        'hoppr:',
        '  managed: outline',
        '  pinned: false',
        '---',
        '',
      ].join('\n')
      await ensureDir(dirname(abs))
      await writeIfChanged(abs, `${front}${body}\n`)
      st.written++
    } catch {
      st.failed++
    }
  }
  return st
}

function humanise(slug: string): string {
  return slug.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

async function readFileSafe(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(path, 'utf8').catch(() => '')
}
