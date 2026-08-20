/** How a capture arrived. `connector:<id>` for harness sync. */
/** Where a capture came IN through — not what it is. `import` is a bulk load
 *  from an export file (browser bookmarks, a platform data archive). */
export type SourceKind = 'cli' | 'inbox' | 'mcp' | 'http' | 'import' | `connector:${string}`

/** What a raw capture IS. */
export type RawKind = 'text' | 'url' | 'file' | 'session'

/**
 * Wiki page types, per the LLM-wiki spec. `digest` is a hoppr addition:
 * the spec assumes deliberately curated documents; hoppr ingests a stream,
 * so time-boxed rollups matter.
 */
export type PageType = 'source' | 'concept' | 'entity' | 'comparison' | 'digest'

export type Confidence = 'high' | 'medium' | 'low'

/** Provenance sidecar written next to every raw artifact. */
export interface RawMeta {
  id: string
  kind: RawKind
  source: SourceKind
  /** Stable identity within a connector — the dedup key. */
  external_id?: string
  media_type: string
  /** When the underlying thing was created (session start, article date). */
  created: string
  /** When hoppr captured it. */
  captured: string
  bytes: number
  hash: string
  title?: string
  origin?: Record<string, unknown>
  /** True while a session is still being appended to. Not curated until false. */
  partial?: boolean
}

/** Human-owned frontmatter on a wiki page, per the LLM-wiki schema. */
export interface PageFrontmatter {
  title: string
  type: PageType
  /** Always relative paths into raw/ — the spec's rule. */
  sources: string[]
  /** [[wikilinks]] */
  related: string[]
  created: string
  updated: string
  confidence: Confidence
  tags: string[]
  project?: string
  /** User-defined schema fields land at the top level. */
  [key: string]: unknown
  /** Machine-owned namespace. Everything outside it is the human's. */
  hoppr: PageMachineMeta
}

export interface PageMachineMeta {
  id: string
  raw_ids: string[]
  pass?: string
  source_hash?: string
  prompt_hash?: string
  /** Set the moment a human edits the page; the curator then leaves prose alone. */
  pinned: boolean
}

export interface RawRecord extends RawMeta {
  /** Path relative to the store root, e.g. raw/2026/08/17/01JX.jsonl */
  path: string
}
