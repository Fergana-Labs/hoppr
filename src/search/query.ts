export interface QueryFilters {
  tags: string[]
  notTags: string[]
  project?: string
  kinds: string[]
  sources: string[]
  scope?: 'curated' | 'raw' | 'all'
  confidence?: string
  since?: number
  until?: number
  pinned?: boolean
}

export interface ParsedQuery {
  text: string
  filters: QueryFilters
}

const FILTER = /(-?)(tag|project|kind|type|source|scope|confidence|since|until|is):("[^"]*"|\S+)/g

/**
 * Inline filter DSL, so a single string works identically from the shell, an
 * MCP tool call, and the web UI:
 *
 *   rrf fusion tag:search project:hoppr since:7d kind:concept -tag:draft
 *
 * Filters are stripped out; whatever remains is the free-text query. An empty
 * remainder means a pure filter listing — no FTS, no vectors, no LLM.
 */
export function parseQuery(input: string, defaults: Partial<QueryFilters> = {}): ParsedQuery {
  const filters: QueryFilters = {
    tags: [],
    notTags: [],
    kinds: [],
    sources: [],
    ...defaults,
  }

  const text = input
    .replace(FILTER, (_m, neg: string, key: string, rawVal: string) => {
      const v = rawVal.replace(/^"|"$/g, '')
      switch (key) {
        case 'tag':
          ;(neg ? filters.notTags : filters.tags).push(v.toLowerCase())
          break
        case 'project':
          filters.project = v
          break
        case 'kind':
        case 'type':
          filters.kinds.push(
            ...v
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          )
          break
        case 'source':
          filters.sources.push(
            ...v
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          )
          break
        case 'scope':
          if (v === 'curated' || v === 'raw' || v === 'all') filters.scope = v
          break
        case 'confidence':
          filters.confidence = v
          break
        case 'since':
          filters.since = parseWhen(v, 'since')
          break
        case 'until':
          filters.until = parseWhen(v, 'until')
          break
        case 'is':
          if (v === 'pinned') filters.pinned = true
          break
      }
      return ' '
    })
    .replace(/\s+/g, ' ')
    .trim()

  return { text, filters }
}

const UNITS: Record<string, number> = {
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  m: 2_592_000_000, // 30d
  y: 31_536_000_000,
}

/** Accepts `7d`, `2026-07-01`, `yesterday`, `today`. Returns epoch ms. */
export function parseWhen(v: string, edge: 'since' | 'until' = 'since'): number | undefined {
  const now = Date.now()
  const rel = /^(\d+)\s*([hdwmy])$/i.exec(v.trim())
  if (rel) return now - Number(rel[1]) * UNITS[rel[2]!.toLowerCase()]!

  const word = v.trim().toLowerCase()
  if (word === 'today') return startOfDay(now)
  if (word === 'yesterday') return startOfDay(now) - UNITS.d!
  if (word === 'week' || word === 'last-week') return now - UNITS.w!

  const t = Date.parse(v)
  if (Number.isNaN(t)) return undefined
  // A bare date as an upper bound means end-of-day, or `until:2026-07-01`
  // would silently exclude everything captured on the 1st.
  return edge === 'until' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? t + UNITS.d! - 1 : t
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * FTS5 treats bare punctuation as syntax. A user typing `foo-bar` or `what's
 * this?` should get results, not a "malformed MATCH" error — so we quote each
 * term and let the tokenizer do the work. A trailing `*` is preserved for
 * prefix search.
 */
export function toMatchExpression(text: string): string {
  const terms = text
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
  if (terms.length === 0) return ''
  return terms
    .map((t) => {
      const prefix = t.endsWith('*')
      const core = (prefix ? t.slice(0, -1) : t).replace(/"/g, '')
      if (!core) return ''
      return prefix ? `"${core}"*` : `"${core}"`
    })
    .filter(Boolean)
    .join(' OR ')
}
