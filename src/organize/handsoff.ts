import { existsSync, readFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from '../config/schema.ts'
import { type IgnoreRule, isIgnored, parseIgnore } from '../connectors/ignore.ts'
import type { Layout } from '../store/layout.ts'

/**
 * What hoppr generated and must now leave alone.
 *
 * Two rule sets, two files, because they are about two different people's
 * files and sharing one made that split invisible:
 *
 *   .hopprignore   beside YOUR data. What hoppr must not index, and what it
 *                  may index but must never send to a model.
 *   <store>/LOCKED what HOPPR generated and you have since taken over.
 *
 * This is the second one. It replaced four spellings of the same idea: a
 * `pinned` column in SQLite, a `pinned:` frontmatter field, `[curate] protect`
 * in hoppr.toml, and no way to see any of them. The column was the worst — a
 * hand-edit set an invisible flag you needed a CLI command to discover or undo.
 *
 * A line in a file instead: greppable, in git, removed by deleting it.
 *
 * It lives inside the store, not beside your data, because hoppr writes only
 * inside `.hoppr/` for an ordinary folder source and a lock marker is not a
 * reason to break that.
 */
export function handsOffFile(l: Layout): string {
  return join(l.root, 'LOCKED')
}

const cache = new Map<string, { key: string; rules: IgnoreRule[] }>()

function rulesFor(l: Layout): IgnoreRule[] {
  const path = handsOffFile(l)
  let text = ''
  if (existsSync(path)) {
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      /* unreadable: manage everything rather than freeze everything */
    }
  }
  const hit = cache.get(path)
  if (hit?.key === text) return hit.rules
  const rules = parseIgnore(text)
  cache.set(path, { key: text, rules })
  return rules
}

/** `relPath` is store-relative, e.g. `curated/skills/deploy/SKILL.md`. */
export function isHandsOff(_cfg: Config, l: Layout, relPath: string): boolean {
  const rules = rulesFor(l)
  if (rules.length === 0) return false
  // Globs are written relative to curated/, which is the part a person thinks
  // in — `skills/**`, not `curated/skills/**`.
  return isIgnored(relPath.replace(/^curated\//, ''), rules)
}

/**
 * Record that something is hands off, with the reason inline.
 *
 * Appended rather than rewritten so a hand-maintained file keeps its comments
 * and its order. Idempotent: the same pattern is never added twice.
 */
export async function markHandsOff(
  cfg: Config,
  l: Layout,
  relPath: string,
  reason: string,
): Promise<boolean> {
  const pattern = relPath.replace(/^curated\//, '')
  if (isHandsOff(cfg, l, relPath)) return false

  const path = handsOffFile(l)
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const header = existing
    ? ''
    : [
        '# Things hoppr generated that it must now leave alone.',
        '#',
        '# Globs are relative to curated/, the only place hoppr writes. hoppr adds a',
        '# line here the first time you hand-edit something it made. Delete the line',
        '# to hand that file back.',
        '#',
        '# Your OWN files are governed by .hopprignore instead, beside your data.',
        '',
      ].join('\n')
  const lead = existing && !existing.endsWith('\n') ? '\n' : ''
  // The reason goes on its OWN line. This is gitignore syntax, where `#` only
  // starts a comment at the beginning of a line — a trailing one becomes part
  // of the pattern, which then matches nothing and locks nothing.
  await appendFile(path, `${lead}${header}\n# ${reason}\n${pattern}\n`, 'utf8')
  cache.delete(path)
  return true
}
