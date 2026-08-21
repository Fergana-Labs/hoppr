import { readFile } from 'node:fs/promises'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { Hoppr } from '../core/hoppr.ts'
import { VERSION } from '../core/version.ts'
import { loadPrompt } from '../store/prompts.ts'
import { listPages } from '../store/wiki.ts'
import { runVfs } from './vfs.ts'

const json = (v: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }],
})
const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })

/**
 * The MCP surface.
 *
 * Every tool here is a thin adapter over the same `Hoppr` facade the CLI uses:
 * parse input, call core, format. There is deliberately no logic in this file,
 * because a second implementation is a second thing to keep correct.
 *
 * The store's files are the primary interface. These tools add ranked search
 * and graph traversal when that is more convenient than rg/grep.
 */
export async function buildServer(defaultHoppr: Hoppr, opts: { pinned?: boolean } = {}) {
  // Resolve a hoppr per call, cached. `pinned` means this server was installed
  // for exactly one hoppr, so tool calls always target it. This is routing,
  // not a filesystem security boundary: agents can inspect stores directly.
  const cache = new Map<string, Hoppr>([[defaultHoppr.name, defaultHoppr]])
  const pinned = opts.pinned === true

  const pick = async (name?: string): Promise<Hoppr> => {
    if (pinned || !name || name === defaultHoppr.name) return defaultHoppr
    const hit = cache.get(name)
    if (hit) return hit
    const { hopperExists } = await import('../store/registry.ts')
    if (!hopperExists(name)) {
      throw new Error(`no hoppr named '${name}'. Call hoppr_list to see what exists.`)
    }
    const opened = await Hoppr.open({ hopper: name })
    cache.set(name, opened)
    return opened
  }

  // Keep the field shape constant so every tool's argument type is inferable;
  // when pinned, `pick` ignores the value and the description says so.
  const hopperArg = {
    hopper: z
      .string()
      .optional()
      .describe(
        pinned
          ? `Ignored — these tools always target the '${defaultHoppr.name}' hoppr.`
          : 'Which hoppr to use. Each hoppr is a separate store with its own ' +
              'subject. Call hoppr_list first if you do not know which one applies. ' +
              `Defaults to '${defaultHoppr.name}'.`,
      ),
  }

  // The retrieval guide goes in `instructions`, which a client reads ONCE on
  // connect rather than on every call. Telling an agent how to merge raw and
  // curated evidence is the difference between a good store and a confident
  // wrong answer out of one — and it is editable, at curated/prompts/retrieval.md.
  const guide = await loadPrompt(defaultHoppr.layout, 'retrieval')
    .then((p) => p.template)
    .catch(() => '')

  const orientation =
    defaultHoppr.config.wiki.orientation || defaultHoppr.config.hopper.description || ''

  const header = pinned
    ? `hoppr '${defaultHoppr.name}'${orientation ? `: ${orientation}` : ''}. Its store is ` +
      `${defaultHoppr.layout.root}; agents may inspect its files directly.`
    : "hoppr holds one or more isolated knowledge stores ('hoppers'), each pointed at a " +
      'different source folder. Agents may inspect every store directly on the filesystem. ' +
      'Call hoppr_list FIRST to see their paths and subjects, then pass the relevant name ' +
      'to indexed tools when useful.'

  const server = new McpServer(
    { name: `hoppr${pinned ? `:${defaultHoppr.name}` : ''}`, version: VERSION },
    { instructions: [header, guide].filter(Boolean).join('\n\n') },
  )

  if (!pinned) {
    server.registerTool(
      'hoppr_list',
      {
        title: 'List the available hoppers',
        description:
          'Every hoppr is a separate knowledge store with its own subject and its own index — ' +
          'a folder of documents, or past coding sessions, or hand-captured notes. ' +
          'Call this FIRST when you do not already know which hoppr holds what you need; ' +
          'each entry says when to use it. Passing a hoppr name that does not exist returns ' +
          'nothing useful, so check here rather than guessing.',
        inputSchema: {},
      },
      async () => {
        const { listHoppers } = await import('../store/registry.ts')
        const rows = await listHoppers()
        return json(
          rows.map((r) => ({
            hopper: r.name,
            root: r.root,
            when_to_use: r.description || `Contents of ${r.sourceLabel}`,
            holds: r.sourceLabel,
            profile: r.profile,
          })),
        )
      },
    )
  }

  server.registerTool(
    'hoppr_search',
    {
      title: 'Search the hopper',
      description:
        "Hybrid keyword + semantic search over everything in the user's hopper: curated wiki " +
        'pages, raw captures, extracted table rows, and skills. You do NOT need exact wording — ' +
        'prefer a natural-language question ("how did we decide on rank fusion") over keyword soup. ' +
        'Filters are AND-ed. Results are ranked snippets, not full documents: follow up with ' +
        'hoppr_get for the whole page, or hoppr_source for the original transcript. ' +
        'If you do not know what tags exist, call hoppr_tags first — filtering on a tag that ' +
        'does not exist returns zero results with no error.',
      inputSchema: {
        ...hopperArg,
        query: z.string().describe('Natural-language question or keywords'),
        scope: z
          .enum(['curated', 'raw', 'all'])
          .optional()
          .describe(
            'all (default) = source and curated; curated = generated artifacts; raw = source material',
          ),
        kind: z
          .string()
          .optional()
          .describe('source|concept|entity|comparison|digest|session|skill'),
        tags: z.array(z.string()).optional(),
        project: z.string().optional(),
        since: z.string().optional().describe('7d, 2026-07-01, yesterday'),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async (a) => {
      const extra = [
        ...(a.tags ?? []).map((t) => `tag:${t}`),
        a.project ? `project:${a.project}` : '',
        a.kind ? `kind:${a.kind}` : '',
        a.since ? `since:${a.since}` : '',
      ].filter(Boolean)
      const hp = await pick(a.hopper)
      const res = await hp.search([a.query, ...extra].join(' '), {
        scope: a.scope,
        limit: a.limit,
      })
      return json({
        hits: res.hits.map((x) => ({
          id: x.id,
          title: x.title,
          kind: x.kind,
          tier: x.tier,
          tags: x.tags,
          confidence: x.confidence,
          snippet: x.snippet,
          matched_in_source: x.matchedInSource,
        })),
        has_more: res.meta.candidates > res.hits.length,
        note:
          res.meta.candidates > res.hits.length
            ? 'More matched than were returned — raise limit to see them.'
            : undefined,
      })
    },
  )

  server.registerTool(
    'hoppr_get',
    {
      title: 'Read one page or capture',
      description:
        'Fetch the full content of one result from hoppr_search, by its id. Wiki ids look like ' +
        '"wiki:concept/rrf-fusion"; capture ids look like "raw:01JX…". Returns the page body ' +
        'plus its sources, so you can trace a claim back to the capture it came from.',
      inputSchema: { ...hopperArg, id: z.string(), max_chars: z.number().int().optional() },
    },
    async (a) => {
      const hp = await pick(a.hopper)
      const db = await hp.db()
      const doc = db
        .prepare<Record<string, unknown>>('SELECT * FROM docs WHERE id = :id')
        .get({ id: a.id })
      if (!doc) return text(`no such id: ${a.id}. Use hoppr_search to find valid ids.`)
      const cap = a.max_chars ?? 20_000
      const body = String(doc.body ?? '')
      const sources = db
        .prepare<{ raw_id: string }>('SELECT raw_id FROM wiki_sources WHERE page_id = :p')
        .all({ p: String(doc.ref_id) })
        .map((r) => r.raw_id)
      return json({
        id: doc.id,
        title: doc.title,
        kind: doc.kind,
        tier: doc.tier,
        confidence: doc.confidence,
        tags: String(doc.tags_text ?? '')
          .split(' ')
          .filter(Boolean),
        summary: doc.summary,
        body: body.length > cap ? `${body.slice(0, cap)}\n… [truncated]` : body,
        sources,
        hint: sources.length
          ? 'Call hoppr_source with a source id for the original capture.'
          : undefined,
      })
    },
  )

  server.registerTool(
    'hoppr_source',
    {
      title: 'Read the original capture',
      description:
        'Read the raw, uncurated capture behind a page — a normalized session snapshot, ' +
        'article, or note. ' +
        'Use when a summary is not enough and you need ground truth. Capture ids come from ' +
        'hoppr_get (its "sources") or from a "raw:" id in search results.',
      inputSchema: { ...hopperArg, raw_id: z.string(), max_chars: z.number().int().optional() },
    },
    async (a) => {
      const hp = await pick(a.hopper)
      const rec = await hp.resolveRaw(a.raw_id.replace(/^raw:/, ''))
      if (!rec) return text(`no capture matching '${a.raw_id}'`)
      const body = await hp.readRawText(rec).catch(() => '(binary capture)')
      const cap = a.max_chars ?? 40_000
      return json({
        id: rec.id,
        kind: rec.kind,
        source: rec.source,
        captured: rec.captured,
        path: rec.path,
        bytes: rec.bytes,
        content: body.length > cap ? `${body.slice(0, cap)}\n… [truncated]` : body,
      })
    },
  )

  server.registerTool(
    'hoppr_add',
    {
      title: 'Throw something into the hopper',
      description:
        'Save a finding, decision, or note into the hopper so future sessions can retrieve it. ' +
        'Write it as something useful to a stranger in six months: state what was decided or ' +
        'learned, not what was discussed. The capture is durable immediately; curation into a ' +
        'wiki page happens later in the background.',
      inputSchema: {
        ...hopperArg,
        content: z.string().optional(),
        url: z.string().optional(),
        title: z.string().optional(),
        tags: z.array(z.string()).optional(),
        project: z.string().optional(),
      },
    },
    async (a) => {
      const hp = await pick(a.hopper)
      const rec = await hp.add({
        text: a.content,
        url: a.url,
        title: a.title,
        tags: a.tags,
        project: a.project,
        source: 'mcp',
      })
      return json({ id: rec.id, path: rec.path, title: rec.title })
    },
  )

  server.registerTool(
    'hoppr_index',
    {
      title: 'The wiki catalog',
      description:
        'The catalog of every curated page, grouped by type, with one-line summaries. ' +
        'Read this FIRST when orienting in an unfamiliar hopper — it is cheaper than searching ' +
        'blind and shows you what vocabulary and topics exist.',
      inputSchema: { ...hopperArg },
    },
    async (a) => {
      const hp = await pick(a.hopper)
      return text(await readFile(hp.layout.wikiIndex, 'utf8').catch(() => '(no index yet)'))
    },
  )

  server.registerTool(
    'hoppr_tags',
    {
      title: 'The tag vocabulary',
      description:
        'List tags with usage counts. Call this before filtering by tag: hoppr_search returns ' +
        'zero results for a tag that does not exist, with no error to tell you why.',
      inputSchema: {
        ...hopperArg,
        prefix: z.string().optional(),
        min_count: z.number().int().optional(),
      },
    },
    async (a) => {
      const hp = await pick(a.hopper)
      const { loadTaxonomy } = await import('../organize/taxonomy.ts')
      const tax = await loadTaxonomy(hp.layout)
      const rows = Object.entries(tax.tags)
        .filter(([t, e]) => !e.merged_into && (!a.prefix || t.startsWith(a.prefix)))
        .filter(([, e]) => e.count >= (a.min_count ?? 0))
        .sort((x, y) => y[1].count - x[1].count)
        .map(([tag, e]) => ({ tag, count: e.count, description: e.description }))
      return json(rows)
    },
  )

  server.registerTool(
    'hoppr_related',
    {
      title: 'Find related pages',
      description:
        'Pages semantically near a given one. Use to widen an investigation after hoppr_search ' +
        'gives you one good hit.',
      inputSchema: { ...hopperArg, id: z.string(), limit: z.number().int().optional() },
    },
    async (a) => {
      const hp = await pick(a.hopper)
      const db = await hp.db()
      const doc = db
        .prepare<{ title: string; summary: string }>(
          'SELECT title, summary FROM docs WHERE id = :id',
        )
        .get({ id: a.id })
      if (!doc) return text(`no such id: ${a.id}`)
      const res = await hp.search(`${doc.title} ${doc.summary}`, {
        scope: 'all',
        limit: (a.limit ?? 5) + 1,
      })
      return json(
        res.hits
          .filter((x) => x.id !== a.id)
          .slice(0, a.limit ?? 5)
          .map((x) => ({ id: x.id, title: x.title, kind: x.kind, snippet: x.snippet })),
      )
    },
  )

  server.registerTool(
    'hoppr_graph_search',
    {
      title: 'Search graph entities',
      description:
        'Find typed entities in the optional knowledge graph by name and/or type. The same ' +
        'data is available as curated/graph/nodes.jsonl for direct rg/grep. Use ' +
        'hoppr_graph_show after selecting a node to traverse its cited relationships.',
      inputSchema: {
        ...hopperArg,
        query: z.string().optional().describe('Partial entity name; omit to list top entities'),
        type: z.string().optional().describe('Configured entity type'),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (a) => {
      const hp = await pick(a.hopper)
      if (!hp.config.retrieval.graph) {
        return json({
          enabled: false,
          note: 'The graph is off. Set [retrieval] graph = true, then run hoppr graph build.',
        })
      }
      const { findNodes } = await import('../organize/graph.ts')
      const db = await hp.db()
      return json({
        enabled: true,
        root: hp.layout.graph,
        entity_types: hp.config.graph.entity_types,
        relations: hp.config.graph.relations,
        nodes: findNodes(db, a.query, a.type?.toLowerCase(), a.limit ?? 40),
      })
    },
  )

  server.registerTool(
    'hoppr_graph_show',
    {
      title: 'Traverse one graph entity',
      description:
        'Resolve an entity by name and return every relationship one hop away, including the ' +
        'evidence quote and source id. Use hoppr_source on raw_id to inspect the source.',
      inputSchema: {
        ...hopperArg,
        name: z.string().describe('Entity name or graph node id'),
        type: z.string().optional().describe('Configured entity type, useful for ambiguous names'),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (a) => {
      const hp = await pick(a.hopper)
      if (!hp.config.retrieval.graph) {
        return json({
          enabled: false,
          note: 'The graph is off. Set [retrieval] graph = true, then run hoppr graph build.',
        })
      }
      const { findNodes, neighbours } = await import('../organize/graph.ts')
      const db = await hp.db()
      const candidates = findNodes(db, a.name, a.type?.toLowerCase(), 20)
      const exact = candidates.find(
        (node) =>
          node.id === a.name ||
          (node.name.toLowerCase() === a.name.toLowerCase() &&
            (!a.type || node.type === a.type.toLowerCase())),
      )
      const node = exact ?? (candidates.length === 1 ? candidates[0] : undefined)
      if (!node) {
        return json({
          found: false,
          candidates,
          note: candidates.length
            ? 'More than one entity matched; retry with its exact name and type.'
            : 'No graph entity matched. Try hoppr_graph_search or grep curated/graph/nodes.jsonl.',
        })
      }
      return json({
        found: true,
        node,
        neighbours: neighbours(db, node.id, a.limit ?? 50),
        hint: 'Each relationship includes raw_id; use hoppr_source to verify it.',
      })
    },
  )

  server.registerTool(
    'hoppr_recent',
    {
      title: 'What landed lately',
      description:
        'The newest captures and pages, newest first. Cheap — no search, no embeddings. ' +
        'Use to catch up on what has happened since you last looked.',
      inputSchema: {
        ...hopperArg,
        limit: z.number().int().optional(),
        project: z.string().optional(),
        kind: z.string().optional(),
      },
    },
    async (a) => {
      const hp = await pick(a.hopper)
      const db = await hp.db()
      const rows = db
        .prepare<Record<string, unknown>>(
          `SELECT id, title, kind, tier, created FROM docs
            WHERE (:project IS NULL OR project = :project)
              AND (:kind IS NULL OR kind = :kind)
            ORDER BY created DESC LIMIT :n`,
        )
        .all({ project: a.project ?? null, kind: a.kind ?? null, n: a.limit ?? 20 })
      return json(rows)
    },
  )

  server.registerTool(
    'hoppr_vfs',
    {
      title: 'Read-only shell over the store',
      description:
        'Run a read-only shell command over the hopper on disk. Supports ls, cat, find, tree, ' +
        'grep, head, tail, wc, sort, uniq, echo, pwd, with | ; and &&. Nothing writes. ' +
        'Useful when you want to browse structure rather than search — e.g. ' +
        '`ls curated/wiki/concepts` or `grep -n "RRF" curated/wiki`. Paths are relative to ' +
        'the store root and cannot escape it.',
      inputSchema: { ...hopperArg, script: z.string(), cwd: z.string().optional() },
    },
    async (a) => {
      const hp = await pick(a.hopper)
      const r = await runVfs(hp.layout, a.script, a.cwd ?? '.')
      return text(r.stdout || `(no output, exit ${r.exitCode})`)
    },
  )

  server.registerTool(
    'hoppr_status',
    {
      title: 'Store health',
      description:
        'Counts, provider availability, and how much is waiting to be curated or embedded. ' +
        'Use when a search returns less than expected, to check whether content is simply ' +
        'not indexed yet.',
      inputSchema: { ...hopperArg },
    },
    async (a) => {
      const hp = await pick(a.hopper)
      const s = await hp.stats()
      const pages = await listPages(hp.layout).catch(() => [])
      const db = await hp.db()
      const graph = db
        .prepare<{ nodes: number; edges: number }>(
          `SELECT (SELECT count(*) FROM graph_nodes) AS nodes,
                  (SELECT count(*) FROM graph_edges) AS edges`,
        )
        .get()
      return json({
        hopper: hp.name,
        root: hp.layout.root,
        ...s,
        wiki_pages: pages.length,
        graph: { enabled: hp.config.retrieval.graph, ...graph, path: hp.layout.graph },
        driver: hp.driver,
        vector_search: hp.vectorAvailable,
        llm: (await hp.llm())?.id ?? 'none',
      })
    },
  )

  return server
}

export async function serveStdio(h: Hoppr, opts: { pinned?: boolean } = {}): Promise<void> {
  const server = await buildServer(h, opts)
  await server.connect(new StdioServerTransport())
}
