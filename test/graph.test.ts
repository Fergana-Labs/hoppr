import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db/open.ts'
import { exportGraphFiles, nodeKey, restoreGraphFiles } from '../src/organize/graph.ts'
import { Layout } from '../src/store/layout.ts'

describe('graph node identity', () => {
  it('collapses the same name written differently', () => {
    // The same person mentioned three ways must be one node, or the graph
    // counts a single relationship as three unconnected ones.
    expect(nodeKey('person', 'Dana Whitfield')).toBe(nodeKey('person', '  dana   whitfield '))
    expect(nodeKey('Person', 'Dana')).toBe(nodeKey('person', 'dana'))
  })

  it('keeps different types apart', () => {
    // "hoppr" the project and "hoppr" the tool are different nodes.
    expect(nodeKey('project', 'hoppr')).not.toBe(nodeKey('tool', 'hoppr'))
  })
})

describe('min_mentions pruning', () => {
  it('keeps a once-mentioned entity that a relation points at', async () => {
    const { openDb } = await import('../src/db/open.ts')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { db } = await openDb(join(mkdtempSync(join(tmpdir(), 'hoppr-graph-')), 'g.db'))

    const now = Date.now()
    for (const [id, name, mentions] of [
      ['person:dana', 'Dana', 3],
      ['project:search rewrite', 'search rewrite', 1],
      ['tool:noise', 'noise', 1],
    ] as const) {
      db.prepare(
        `INSERT INTO graph_nodes (id,type,key,name,mentions,first_seen,last_seen)
         VALUES (:id,'x',:name,:name,:m,:now,:now)`,
      ).run({ id, name, m: mentions, now })
    }
    db.prepare(
      `INSERT INTO graph_edges (from_id,predicate,to_id,raw_id,evidence,at)
       VALUES ('person:dana','works_on','project:search rewrite','r1','q',:now)`,
    ).run({ now })

    // The prune: only nodes nothing points at. An entity named in a stated
    // relation is evidenced BY that relation, and dropping it silently
    // destroys the edge as well.
    db.prepare(
      `DELETE FROM graph_nodes
        WHERE mentions < 2
          AND id NOT IN (SELECT from_id FROM graph_edges)
          AND id NOT IN (SELECT to_id FROM graph_edges)`,
    ).run()

    const left = db
      .prepare<{ id: string }>('SELECT id FROM graph_nodes ORDER BY id')
      .all()
      .map((r) => r.id)
    expect(left).toContain('project:search rewrite') // 1 mention, but cited
    expect(left).not.toContain('tool:noise') // 1 mention, cited by nothing
    expect(db.prepare<{ n: number }>('SELECT count(*) n FROM graph_edges').get()?.n).toBe(1)
    db.close()
  })
})

describe('filesystem graph projection', () => {
  it('exports deterministic JSONL and restores the disposable index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hoppr-graph-files-'))
    const layout = new Layout(root)
    const first = await openDb(join(root, 'first.db'))
    const now = Date.now()
    for (const [id, type, key, name] of [
      ['person:dana', 'person', 'dana', 'Dana'],
      ['project:hoppr', 'project', 'hoppr', 'hoppr'],
    ] as const) {
      first.db
        .prepare(
          `INSERT INTO graph_nodes (id,type,key,name,mentions,first_seen,last_seen)
           VALUES (:id,:type,:key,:name,1,:now,:now)`,
        )
        .run({ id, type, key, name, now })
    }
    first.db
      .prepare(
        `INSERT INTO graph_edges (from_id,predicate,to_id,raw_id,evidence,at)
         VALUES ('person:dana','works_on','project:hoppr','r1','Dana works on hoppr.',:now)`,
      )
      .run({ now })
    first.db
      .prepare(`INSERT INTO graph_seen (raw_id,prompt_hash,at) VALUES ('r1','sha256:x',:now)`)
      .run({ now })

    await exportGraphFiles(first.db, layout)
    first.db.close()

    const second = await openDb(join(root, 'second.db'))
    expect(await restoreGraphFiles(second.db, layout)).toBe(true)
    expect(second.db.prepare<{ n: number }>('SELECT count(*) n FROM graph_nodes').get()?.n).toBe(2)
    expect(second.db.prepare<{ n: number }>('SELECT count(*) n FROM graph_edges').get()?.n).toBe(1)
    expect(
      second.db.prepare<{ evidence: string }>('SELECT evidence FROM graph_edges').get()?.evidence,
    ).toBe('Dana works on hoppr.')
    second.db.close()
  })
})
