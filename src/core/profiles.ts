import type { Profile } from './source.ts'

/**
 * What a hoppr is FOR, as a named bundle of settings that already exist.
 *
 * The knobs are genuinely independent — you might want embeddings without a
 * wiki, or a wiki without skills — but nobody wants to set eight of them to
 * describe "a folder of papers". So a profile is a preset, not a new system:
 * it supplies defaults, and every value stays overridable in hoppr.toml.
 *
 * The alternative, a `curation_mode` enum, would have been a lie — the modes
 * are not mutually exclusive and people would immediately want the corners
 * between them.
 */
export interface CurationPreset {
  /**
   * Page types this hoppr may create. Empty ⇒ no wiki at all.
   * Currently implemented: `source` (one per capture) and `concept` (one per
   * recurring theme, built across captures).
   */
  pageTypes: string[]
  /** Distil recurring procedures into installable skills. */
  skills: boolean
  /** Vector search. Off ⇒ keyword only, and no embedding cost. */
  embeddings: boolean
  /** Per-capture summary pages. Off ⇒ index and tags only, no model per row. */
  sourcePages: boolean
  describe: string
}

export const PRESETS: Record<string, CurationPreset> = {
  /**
   * Everything hoppr can build. Prose folders where synthesis is the point.
   *
   * `entity`, `comparison` and `digest` pages are specified but NOT yet
   * implemented, so no preset claims them — advertising a page type that never
   * appears is worse than not offering it.
   */
  notes: {
    pageTypes: ['source', 'concept'],
    skills: false,
    embeddings: true,
    sourcePages: true,
    describe: 'a page per document, plus concept pages that accumulate across them',
  },
  /** A reference corpus: find the paper, do not theorise about it. */
  papers: {
    pageTypes: ['source'],
    skills: false,
    embeddings: true,
    sourcePages: true,
    describe: 'a page per document — summary, tags, entities. No cross-document synthesis',
  },
  /** Transcripts. The only place skill mining earns its cost. */
  agents: {
    pageTypes: ['source', 'concept'],
    skills: true,
    embeddings: true,
    sourcePages: true,
    describe: 'pages, concepts, and procedures distilled into installable skills',
  },
  /**
   * Search only, and no model call anywhere. The right mode for a large
   * archive you want to find things in but would not pay to summarise.
   *
   * Note this means no TAGS either: tags are produced by the same model call
   * that writes a page, and hang off the page rather than the capture. Calling
   * this "index-only" while quietly spending a call per item would be the
   * dishonest version.
   */
  'index-only': {
    pageTypes: [],
    skills: false,
    embeddings: true,
    sourcePages: false,
    describe: 'keyword + vector search, no model calls at all',
  },
  /** Nothing automatic: capture and keyword search. */
  minimal: {
    pageTypes: [],
    skills: false,
    embeddings: false,
    sourcePages: false,
    describe: 'keyword search only — no model, no embeddings, nothing to download',
  },
}

export const PRESET_NAMES = Object.keys(PRESETS)

/** The preset a source kind gets when nobody chose one. */
export function defaultPreset(profile: Profile): string {
  if (profile === 'agents') return 'agents'
  if (profile === 'folder') return 'notes'
  return 'notes'
}

export function presetFor(name: string | undefined, profile: Profile): CurationPreset {
  return PRESETS[name ?? ''] ?? PRESETS[defaultPreset(profile)]!
}

/**
 * The single place anything asks "what should this hoppr build?".
 *
 * An unknown preset name falls back to the profile's default rather than
 * throwing: a typo in a config file should not make a store unopenable.
 */
export function curationFor(cfg: {
  hopper: { curation?: string; profile: Profile }
}): CurationPreset {
  return presetFor(cfg.hopper.curation, cfg.hopper.profile)
}

export function buildsPage(cfg: Parameters<typeof curationFor>[0], type: string): boolean {
  return curationFor(cfg).pageTypes.includes(type)
}

/**
 * Vector search needs BOTH a preset that wants it and a provider that can do
 * it. Keeping it one predicate stops the two from drifting into "configured on
 * but silently off".
 */
export function embeddingsEnabled(cfg: {
  hopper: { curation?: string; profile: Profile }
  embed: { provider: string }
  retrieval?: { embeddings?: boolean }
}): boolean {
  // Three ways to say no, and any one of them wins: the preset, the explicit
  // retrieval switch, and "no provider". Keeping it one predicate is what stops
  // them from drifting into "configured on but silently off".
  if (cfg.retrieval?.embeddings === false) return false
  return curationFor(cfg).embeddings && cfg.embed.provider !== 'none'
}
