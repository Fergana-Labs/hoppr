/**
 * Rendering a transcript into readable text.
 *
 * This is the extractor's job, not the connector's, and its output goes into
 * the index rather than back into `raw/`. That separation is what lets an
 * improved renderer re-derive better text from captures you already have,
 * without re-capturing anything.
 */
export interface Turn {
  role: 'user' | 'assistant' | 'tool' | 'system'
  text: string
  /** Tool name, when this turn is a tool call or result. */
  tool?: string
}

export interface RenderOptions {
  maxChars: number
  maxToolResultChars?: number
}

const DEFAULT_TOOL_RESULT = 500

/**
 * Prompts are the highest-signal content in any agent transcript — they are
 * the only part a human actually wrote. So when we run out of budget we
 * truncate assistant prose and tool output, and keep every user turn.
 */
export function renderTranscript(
  meta: Record<string, string | number | undefined>,
  turns: Turn[],
  o: RenderOptions,
): string {
  const head: string[] = ['## Session', '']
  for (const [k, v] of Object.entries(meta)) {
    if (v !== undefined && v !== '') head.push(`- ${k}: ${v}`)
  }

  const prompts = turns.filter((t) => t.role === 'user' && t.text.trim())
  const promptBlock =
    prompts.length > 0
      ? ['', '## Prompts', '', ...prompts.map((p) => `> ${p.text.trim().replace(/\n/g, '\n> ')}`)]
      : []

  const body: string[] = ['', '## Transcript', '']
  for (const t of turns) {
    if (t.role === 'user') body.push(`**user:** ${oneLine(t.text, 2000)}`)
    else if (t.role === 'assistant' && t.text.trim()) body.push(`**assistant:** ${t.text.trim()}`)
    else if (t.role === 'tool') {
      const cap = o.maxToolResultChars ?? DEFAULT_TOOL_RESULT
      body.push(`→ ${t.tool ?? 'tool'}: ${oneLine(t.text, cap)}`)
    }
  }

  const fixed = [...head, ...promptBlock].join('\n')
  const budget = Math.max(0, o.maxChars - fixed.length)
  return `${fixed}\n${truncateMiddle(body.join('\n'), budget)}`.trim()
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** Keep the beginning and the end: how a session started and how it resolved. */
export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s
  if (max < 200) return s.slice(0, Math.max(0, max))
  const head = Math.floor(max * 0.6)
  const tail = max - head - 40
  return `${s.slice(0, head)}\n\n… [${s.length - max} characters elided] …\n\n${s.slice(-tail)}`
}

/** Content blocks come as a string or an array of typed blocks; flatten both. */
export function blockText(content: unknown): { text: string; tools: string[] } {
  if (typeof content === 'string') return { text: content, tools: [] }
  if (!Array.isArray(content)) return { text: '', tools: [] }
  const parts: string[] = []
  const tools: string[] = []
  for (const b of content) {
    if (!b || typeof b !== 'object') continue
    const block = b as Record<string, unknown>
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'tool_use' && typeof block.name === 'string') tools.push(block.name)
    else if (block.type === 'thinking') continue
  }
  return { text: parts.join('\n'), tools }
}

export function summarizeToolInput(input: unknown, max = 120): string {
  if (input == null) return ''
  const s = typeof input === 'string' ? input : JSON.stringify(input)
  return s.length > max ? `${s.slice(0, max)}…` : s
}
