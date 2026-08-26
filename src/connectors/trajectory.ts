import type { ToolCall, Turn } from './render.ts'

/**
 * Normalize a native transcript into Letta's `trajectory` format.
 *
 * hoppr hand-rolled a parser per harness, and each one quietly threw content
 * away — tool results were cut to 400 characters at parse time, and the link
 * between a tool CALL and its RESULT was lost the moment both became prose.
 * That link is what makes a transcript a trajectory rather than a chat log,
 * and it is the thing skill mining needs.
 *
 * `trajectory` is a published schema covering fourteen harnesses, including
 * all four hoppr reads and ten it does not yet. Adopting it means the parsing
 * problem stops being ours.
 *
 * Its defaults truncate tool results to 2,500 characters. We override that:
 * this is the DURABLE tier, and a limit applied here is permanent. Curation
 * truncates at read time, where it costs tokens rather than data.
 */
const UNBOUNDED = {
  toolArguments: { maxCharacters: 10_000_000 },
  toolResults: { maxCharacters: 10_000_000, strategy: 'head-tail' as const },
}

/** The harnesses hoppr reads, mapped to trajectory's source names. */
export const TRAJECTORY_SOURCES: Record<string, string> = {
  'claude-code': 'claude-code',
  codex: 'codex',
  openclaw: 'openclaw',
  opencode: 'opencode',
}

export interface TrajectoryResult {
  /** trajectory-v1 records, one per line — the durable artifact. */
  jsonl: string
  /** Flattened turns, for the markdown hoppr indexes and shows. */
  turns: Turn[]
  meta: Record<string, string | number | undefined>
  truncated: number
}

interface Rec {
  role: string
  content?: string
  text?: string
  toolName?: string
  toolCallId?: string
  arguments?: unknown
  result?: unknown
  [k: string]: unknown
}

/**
 * Returns undefined when the package is absent or the harness is unsupported,
 * so the caller falls back to hoppr's own parser rather than losing the
 * session.
 */
export async function toTrajectory(
  source: string,
  transcript: string,
  toolCalls?: Map<string, ToolCall>,
): Promise<TrajectoryResult | undefined> {
  const src = TRAJECTORY_SOURCES[source]
  if (!src) return undefined

  let normalize: (i: unknown) => {
    records?: Rec[]
    diagnostics?: Array<{ code: string; count?: number }>
  }
  try {
    const mod = await import('@letta-ai/trajectory')
    normalize = mod.normalizeTranscript as never
  } catch {
    return undefined
  }

  let out: ReturnType<typeof normalize>
  try {
    out = normalize({ source: src, transcript, bounds: UNBOUNDED })
  } catch {
    // A transcript it refuses is one our own parser may still handle.
    return undefined
  }

  const records = out.records ?? []
  if (records.length === 0) return undefined

  const meta: Record<string, string | number | undefined> = {}
  const turns: Turn[] = []
  for (const r of records) {
    if (r.role === 'meta') {
      for (const [k, v] of Object.entries(r)) {
        if (k !== 'role' && (typeof v === 'string' || typeof v === 'number')) meta[k] = v
      }
      continue
    }
    const text = pickText(r)
    if (!text) continue
    if (r.role === 'user') turns.push({ role: 'user', text })
    else if (r.role === 'assistant' || r.role === 'reasoning') {
      // Reasoning is kept. It is where an agent says what it thought was wrong,
      // which is exactly the material a mined skill's pitfalls come from.
      turns.push({ role: 'assistant', text: r.role === 'reasoning' ? `(thinking) ${text}` : text })
    } else if (r.role === 'tool') {
      // The normalizer keeps the RESULT and drops the call, so the name has to
      // come back from the connector's own parse, joined on the harness's id.
      // Without this every tool line renders as a bare `→ tool`: no name, no
      // arguments, and no way to tell which skill a session actually loaded.
      const call = toolCalls?.get(String((r as { tool_call_id?: string }).tool_call_id ?? ''))
      if (call) {
        turns.push({ role: 'tool', tool: call.name, text: call.input })
        if (text) turns.push({ role: 'tool', tool: 'result', text })
      } else {
        turns.push({ role: 'tool', tool: String(r.toolName ?? 'tool'), text })
      }
    }
  }

  const truncated = (out.diagnostics ?? [])
    .filter((d) => d.code === 'tool_result_truncated')
    .reduce((a, d) => a + (d.count ?? 1), 0)

  return {
    jsonl: records.map((r) => JSON.stringify(r)).join('\n'),
    turns,
    meta,
    truncated,
  }
}

function pickText(r: Rec): string {
  for (const key of ['content', 'text', 'result', 'arguments']) {
    const v = r[key]
    if (typeof v === 'string' && v.trim()) return v
    if (v && typeof v === 'object') return JSON.stringify(v)
  }
  return ''
}
