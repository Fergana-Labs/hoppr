import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { HopprError } from './errors.ts'

/**
 * What a hoppr is pointed at.
 *
 *  - `dir`    — a folder you own. Files stay EXACTLY where they are; hoppr
 *               records provenance and never copies or writes there.
 *  - `agents` — harness session logs. These we do copy, because the harness
 *               owns them and rotates them out from under us.
 *  - `manual` — only what you throw in by hand.
 */
export type SourceKindSpec = 'dir' | 'agents' | 'manual'

export interface SourceSpec {
  kind: SourceKindSpec
  /** Absolute path, for `dir`. */
  path?: string
  /** Harness ids, for `agents`. Empty means every detected harness. */
  harnesses?: string[]
  raw: string
}

/**
 * Whether hoppr keeps its own copy of the raw tier.
 *
 * `reference` is the stronger guarantee: the bytes are yours, in your folder,
 * and hoppr provably cannot damage them because it never opens them for
 * writing. `copy` exists only where the upstream owner may delete the
 * original — agent harnesses rotate their logs, so a reference there would
 * silently rot.
 */
export type RawMode = 'reference' | 'copy'

export function defaultRawMode(kind: SourceKindSpec): RawMode {
  return kind === 'dir' ? 'reference' : 'copy'
}

/** Which curation stages a hoppr runs. */
export type Profile = 'folder' | 'agents' | 'manual'

export function defaultProfile(kind: SourceKindSpec): Profile {
  return kind === 'dir' ? 'folder' : kind === 'agents' ? 'agents' : 'manual'
}

/**
 * Skill mining only makes sense where there are procedures to mine. A folder
 * of papers has no workflow in it, and mining one would invent a procedure
 * from prose — worse than mining nothing.
 */
export function minesSkills(profile: Profile): boolean {
  return profile === 'agents'
}

export function parseSource(input: string): SourceSpec {
  const raw = input.trim()
  if (!raw || raw === 'manual') return { kind: 'manual', raw: 'manual' }

  const colon = raw.indexOf(':')
  const scheme = colon > 0 ? raw.slice(0, colon) : ''
  const rest = colon > 0 ? raw.slice(colon + 1) : raw

  if (scheme === 'agents') {
    const harnesses = rest
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean)
    return { kind: 'agents', harnesses, raw }
  }

  if (
    scheme === 'dir' ||
    scheme === '' ||
    isAbsolute(raw) ||
    raw.startsWith('~') ||
    raw.startsWith('.')
  ) {
    const p = scheme === 'dir' ? rest : raw
    return { kind: 'dir', path: expand(p), raw: `dir:${expand(p)}` }
  }

  throw HopprError.user(
    `unrecognized source '${raw}'. Use dir:<path>, agents:<harness,…>, or manual.`,
  )
}

export function expand(p: string): string {
  const s = p.startsWith('~') ? p.replace(/^~/, homedir()) : p
  return resolve(s)
}

export function describeSource(s: SourceSpec): string {
  switch (s.kind) {
    case 'dir':
      return s.path ?? '(no path)'
    case 'agents':
      return s.harnesses?.length ? s.harnesses.join(', ') : 'all detected harnesses'
    default:
      return 'manual captures only'
  }
}
