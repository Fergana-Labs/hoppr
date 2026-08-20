import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface IgnoreRule {
  re: RegExp
  negated: boolean
  dirOnly: boolean
}

/**
 * `.hopprignore`, with `.gitignore` syntax and `.gitignore` itself honoured.
 *
 * Pointing a hoppr at a folder you already work in means pointing it at a
 * folder that already declares what is noise — build output, vendored
 * dependencies, fixtures. Asking people to restate that in a second syntax
 * would be busywork, so `.gitignore` is read by default and `.hopprignore`
 * layers on top for things git tracks but you do not want indexed: a private
 * journal, a directory of licensed PDFs, meeting notes with someone else's
 * name in them.
 *
 * `.hopprignore` is read AFTER `.gitignore`, so a `!` line in it can re-include
 * something git ignores — the case that actually comes up is wanting a
 * generated `docs/` or a gitignored `notes/` in the index.
 */
export interface IgnoreSets {
  /** Never indexed. hoppr does not know the file exists. */
  skip: IgnoreRule[]
  /** Indexed and searchable, but never sent to a model. */
  noCurate: IgnoreRule[]
}

/**
 * One file, two sections.
 *
 * Both decisions are "which paths get how much attention", so splitting them
 * across a dotfile and a TOML key made one concept look like two. They differ
 * only in degree: skipped files are invisible, no-curate files are fully
 * searchable but never cost a token — indexing is pure SQL, so that tier is
 * free rather than merely cheap.
 */
export function parseIgnoreSets(text: string): IgnoreSets {
  const out: IgnoreSets = { skip: [], noCurate: [] }
  let current: IgnoreRule[] = out.skip
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (/^\[no-curate\]$/i.test(line)) {
      current = out.noCurate
      continue
    }
    if (/^\[index\]$/i.test(line)) {
      current = out.skip
      continue
    }
    current.push(...parseIgnore(line))
  }
  return out
}

export function parseIgnore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of text.split('\n')) {
    let line = raw.trim()
    if (!line || line.startsWith('#')) continue
    // Section headers belong to parseIgnoreSets; ignore them here so a single
    // pattern list is never polluted by one.
    if (/^\[[a-z-]+\]$/i.test(line)) continue
    const negated = line.startsWith('!')
    if (negated) line = line.slice(1)
    // A trailing space is only literal when escaped, per gitignore.
    line = line.replace(/(?<!\\)\s+$/, '')
    if (!line) continue

    const dirOnly = line.endsWith('/')
    if (dirOnly) line = line.slice(0, -1)

    // A pattern containing a slash anywhere but the end is anchored to the
    // root; otherwise it matches a basename at any depth. That asymmetry is
    // the part of gitignore people rely on without knowing it.
    const anchored = line.includes('/')
    if (line.startsWith('/')) line = line.slice(1)

    rules.push({ re: toRegExp(line, anchored), negated, dirOnly })
  }
  return rules
}

function toRegExp(pattern: string, anchored: boolean): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++
        if (pattern[i + 1] === '/') {
          i++
          out += '(?:.*/)?' // `**/` — zero or more directories
        } else if (i + 1 >= pattern.length) {
          // A TRAILING `**` means everything below, so it must be able to
          // match path segments, not just an optional directory boundary.
          out += '.*'
        } else {
          out += '(?:.*/)?'
        }
      } else {
        out += '[^/]*' // a single * stops at one segment
      }
    } else if (ch === '?') out += '[^/]'
    else if (ch === '[') {
      const close = pattern.indexOf(']', i)
      if (close < 0) out += '\\['
      else {
        out += pattern.slice(i, close + 1).replace(/^\[!/, '[^')
        i = close
      }
    } else out += ch.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  // Matching a directory must also match everything under it.
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${out}(?:/.*)?$`)
}

/** True when this repo-relative path should be skipped. */
export function isIgnored(relPath: string, rules: IgnoreRule[]): boolean {
  let ignored = false
  // Last matching rule wins, which is what makes `!` re-inclusion work.
  for (const r of rules) {
    if (r.re.test(relPath)) ignored = !r.negated
  }
  return ignored
}

/**
 * Collect rules for a folder source. Missing files are simply no rules — an
 * absent .gitignore is the common case, not an error.
 */
export function loadIgnoreRules(dirs: string[], useGitignore = true): IgnoreSets {
  const out: IgnoreSets = { skip: [], noCurate: [] }
  for (const dir of dirs) {
    // .gitignore first so a .hopprignore `!` line can re-include from it.
    const files = useGitignore ? ['.gitignore', '.hopprignore'] : ['.hopprignore']
    for (const name of files) {
      const path = join(dir, name)
      if (!existsSync(path)) continue
      try {
        const text = readFileSync(path, 'utf8')
        // .gitignore has no sections; everything in it is a skip rule.
        if (name === '.gitignore') out.skip.push(...parseIgnore(text))
        else {
          const sets = parseIgnoreSets(text)
          out.skip.push(...sets.skip)
          out.noCurate.push(...sets.noCurate)
        }
      } catch {
        /* unreadable ignore file: index everything rather than nothing */
      }
    }
  }
  return out
}
