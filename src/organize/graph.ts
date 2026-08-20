import { z } from 'zod'
import type { Config } from '../config/schema.ts'
import type { Db } from '../db/driver.ts'
import type { LlmProvider } from '../llm/provider.ts'
import type { Layout } from '../store/layout.ts'
import { loadPrompt } from '../store/prompts.ts'

const GraphOut = z.object({
  entities: z
    .array(
      z.object({
        type: z.string(),
        name: z.string(),
        summary: z.string().optional(),
      }),
    )
    .default([]),
  relations: z
    .array(
      z.object({
        from: z.string(),
        predicate: z.string(),
        to: z.string(),
        evidence: z.string().optional(),
      }),
    )
    .default([]),
})

export interface GraphStats {
  scanned: number
  nodes: number
  edges: number
  dropped: number
}

/** Same name, different capitalisation or spacing, is the same node. */
export function nodeKey(type: string, name: string): string {
  return `${type.toLowerCase()}:${name.trim().toLowerCase().replace(/\s+/g, ' ')}`
}

function typeName(t: string | { name: string; description?: string }): string {
  return typeof t === 'string' ? t : t.name
}

function describeTypes(cfg: Config): string {
  return cfg.graph.entity_types
    .map((t) =>
      typeof t === 'string' ? `- ${t}` : `- ${t.name}${t.description ? ` — ${t.description}` : ''}`,
    )
    .join('\n')
}

function describeRelations(cfg: Config): string {
  if (cfg.graph.relations.length === 0) {
    return '- (none defined — extract entities only, and return an empty `relations` array)'
  }
  return cfg.graph.relations
    .map((r) => {
      const from = r.from.length ? r.from.join('|') : 'any'
      const to = r.to.length ? r.to.join('|') : 'any'
      return `- ${r.name}: ${from} → ${to}${r.description ? ` — ${r.description}` : ''}`
    })
    .join('\n')
}

/**
 * Build the graph from captures that have not been through it yet.
 *
 * Incremental by `graph_seen`, and re-run when the prompt or schema changes —
 * the same staleness discipline as everything else, so editing a relation
 * description re-extracts rather than leaving a graph built under the old
 * definition.
 *
 * Every edge cites the capture AND quotes the sentence it came from. That is
 * the difference between a graph you can audit and a pile of assertions: when
 * an edge looks wrong you can read the line that produced it.
 */
export async function buildGraph(
  db: Db,
  l: Layout,
  cfg: Config,
  llm: LlmProvider,
  opts: { limit?: number; onProgress?: (m: string) => void } = {},
): Promise<GraphStats> {
  const st: GraphStats = { scanned: 0, nodes: 0, edges: 0, dropped: 0 }
  if (!cfg.retrieval.graph) return st

  const prompt = await loadPrompt(l, 'graph')
  const allowedTypes = new Set(cfg.graph.entity_types.map(typeName).map((t) => t.toLowerCase()))
  const allowedRels = new Set(cfg.graph.relations.map((r) => r.name.toLowerCase()))

  const todo = db
    .prepare<{ id: string; title: string | null; text: string }>(
      `SELECT r.id, r.title, r.text FROM raw r
        LEFT JOIN graph_seen g ON g.raw_id = r.id AND g.prompt_hash = :ph
        WHERE r.text IS NOT NULL AND length(r.text) > 0 AND r.partial = 0
          AND g.raw_id IS NULL
        ORDER BY r.captured DESC LIMIT :n`,
    )
    .all({ ph: prompt.hash, n: opts.limit ?? 50 })

  for (const row of todo) {
    st.scanned++
    opts.onProgress?.(`graph: ${row.title ?? row.id}`)
    const body = prompt.template
      .replace('{{ENTITY_TYPES}}', describeTypes(cfg))
      .replace('{{RELATIONS}}', describeRelations(cfg))
      .replace('{{TITLE}}', row.title ?? '')
      .replace('{{TEXT}}', row.text.slice(0, prompt.maxInputChars))

    let out: z.infer<typeof GraphOut>
    try {
      const r = await llm.completeJson({
        prompt: body,
        system: prompt.system,
        schema: GraphOut,
        tier: prompt.tier,
        purpose: 'graph.extract',
      })
      out = r.value
    } catch {
      // One unreadable capture must not stop the sweep.
      continue
    }

    const now = Date.now()
    const idByName = new Map<string, string>()
    for (const e of out.entities) {
      // Enforce the schema in CODE. A model told to use five types will
      // occasionally invent a sixth, and a graph whose vocabulary drifts is
      // exactly the thing the schema exists to prevent.
      if (!allowedTypes.has(e.type.toLowerCase())) {
        st.dropped++
        continue
      }
      const key = e.name.trim().toLowerCase().replace(/\s+/g, ' ')
      if (!key) continue
      const id = `${e.type.toLowerCase()}:${key}`
      db.prepare(
        `INSERT INTO graph_nodes (id, type, key, name, summary, mentions, first_seen, last_seen)
         VALUES (:id, :type, :key, :name, :summary, 1, :now, :now)
         ON CONFLICT(id) DO UPDATE SET
           mentions = mentions + 1,
           last_seen = :now,
           summary = COALESCE(graph_nodes.summary, :summary)`,
      ).run({
        id,
        type: e.type.toLowerCase(),
        key,
        name: e.name.trim(),
        summary: e.summary ?? null,
        now,
      })
      idByName.set(e.name.trim().toLowerCase(), id)
      st.nodes++
    }

    for (const rel of out.relations) {
      const from = idByName.get(rel.from.trim().toLowerCase())
      const to = idByName.get(rel.to.trim().toLowerCase())
      // An edge to an entity the model did not declare is a dangling
      // assertion; there is nothing to attach it to and no way to check it.
      if (!from || !to || from === to) {
        st.dropped++
        continue
      }
      if (allowedRels.size > 0 && !allowedRels.has(rel.predicate.toLowerCase())) {
        st.dropped++
        continue
      }
      db.prepare(
        `INSERT OR IGNORE INTO graph_edges (from_id, predicate, to_id, raw_id, evidence, at)
         VALUES (:f, :p, :t, :raw, :ev, :now)`,
      ).run({
        f: from,
        p: rel.predicate.toLowerCase(),
        t: to,
        raw: row.id,
        ev: rel.evidence?.slice(0, 400) ?? null,
        now,
      })
      st.edges++
    }

    db.prepare(
      'INSERT OR REPLACE INTO graph_seen (raw_id, prompt_hash, at) VALUES (:id, :ph, :now)',
    ).run({ id: row.id, ph: prompt.hash, now })
  }

  // A hapax is noise — but an entity named in a STATED relation is evidenced by
  // that relation, and pruning it silently destroys the edge too. So the
  // threshold only removes nodes nothing points at. Without this, "Dana
  // works_on search rewrite" vanished because the project happened to be
  // mentioned once.
  if (cfg.graph.min_mentions > 1) {
    db.prepare(
      `DELETE FROM graph_nodes
        WHERE mentions < :m
          AND id NOT IN (SELECT from_id FROM graph_edges)
          AND id NOT IN (SELECT to_id FROM graph_edges)`,
    ).run({ m: cfg.graph.min_mentions })
  }
  return st
}

export interface Neighbour {
  predicate: string
  direction: 'out' | 'in'
  id: string
  name: string
  type: string
  evidence: string | null
  raw_id: string
}

/** Everything one step from a node, in both directions. */
export function neighbours(db: Db, id: string, limit = 50): Neighbour[] {
  return db
    .prepare<Neighbour>(
      `SELECT e.predicate, 'out' AS direction, n.id, n.name, n.type, e.evidence, e.raw_id
         FROM graph_edges e JOIN graph_nodes n ON n.id = e.to_id
        WHERE e.from_id = :id
       UNION ALL
       SELECT e.predicate, 'in' AS direction, n.id, n.name, n.type, e.evidence, e.raw_id
         FROM graph_edges e JOIN graph_nodes n ON n.id = e.from_id
        WHERE e.to_id = :id
       LIMIT :n`,
    )
    .all({ id, n: limit })
}

export interface GraphNode {
  id: string
  type: string
  name: string
  summary: string | null
  mentions: number
}

export function findNodes(db: Db, q?: string, type?: string, limit = 40): GraphNode[] {
  const where: string[] = []
  if (q) where.push('key LIKE :q')
  if (type) where.push('type = :type')
  return db
    .prepare<GraphNode>(
      `SELECT id, type, name, summary, mentions FROM graph_nodes
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY mentions DESC, name LIMIT :n`,
    )
    .all({ q: q ? `%${q.toLowerCase()}%` : undefined, type, n: limit })
}
