import type { RawKind } from '../core/types.ts'

export interface ConnectorSource {
  /** Stable identity of one sync unit — usually a file path or a table. */
  key: string
  label: string
  mtimeMs?: number
  size?: number
}

export interface IngestCandidate {
  /** Stable across polls; the dedup key. e.g. `claude-code:<sessionId>` */
  externalId: string
  kind: RawKind
  title?: string
  /** Rendered, human-readable body stored as the durable capture. */
  body: string
  /**
   * Structured form of the same session, stored ALONGSIDE the readable body.
   *
   * The markdown is what gets indexed and what a person reads. It is also
   * flat: rendering to prose throws away tool-call ids, per-record timestamps
   * and role typing — the exact structure the trajectory format exists to
   * preserve, and the structure that says WHICH result came from WHICH call.
   *
   * Measured across 25 random sessions: native JSONL 2.57 MB → trajectory
   * 0.65 MB → markdown 0.09 MB. Keeping the middle step costs 7x the markdown
   * and is still 4x smaller than the original, which is a cheap price for not
   * having to re-parse a harness format that may no longer exist.
   */
  structured?: { format: string; content: string }
  createdAt: Date
  updatedAt: Date
  project?: string
  origin: Record<string, unknown>
  /**
   * The session is still being appended to. It is captured and searchable, but
   * curation waits: spending a model call on a half-written transcript is waste,
   * and the next pass will see the finished thing.
   */
  partial: boolean
}

export interface ConnectorContext {
  cursor: unknown
  config: Record<string, unknown>
  /** Only pull sessions touched since this instant. */
  since?: number
  log: (msg: string) => void
  /**
   * Resolved lazily, and only when a connector actually needs it — images are
   * the one input whose TEXT cannot be read without a model. Undefined when no
   * provider is configured, which downgrades those files to name-only rather
   * than failing the sync.
   */
  llm?: () => Promise<import('../llm/provider.ts').LlmProvider | undefined>
}

export interface PullResult {
  items: IngestCandidate[]
  cursor: unknown
  /** false ⇒ call again immediately; there is more in this source. */
  done: boolean
}

export interface Connector {
  readonly id: string
  readonly label: string
  readonly defaultIntervalMs: number
  /** Cheap: does this harness appear installed? No I/O beyond a stat. */
  detect(cfg: Record<string, unknown>): Promise<boolean>
  /** Enumerate sync units. Must stay stat-only — it runs on every poll. */
  discover(cfg: Record<string, unknown>): Promise<ConnectorSource[]>
  /** Incremental, resumable from `ctx.cursor`. */
  pull(source: ConnectorSource, ctx: ConnectorContext): Promise<PullResult>
}

/** Byte-offset cursor for the append-only JSONL logs three harnesses use. */
export interface TailCursor {
  offset: number
  size: number
  mtimeMs: number
  /** Content hash of the last emitted body — suppresses no-op re-emits. */
  emittedHash?: string
}

export const LIVE_WINDOW_MS = 120_000

export function isLive(lastEventMs: number, now = Date.now()): boolean {
  return now - lastEventMs < LIVE_WINDOW_MS
}
