import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { writeIfChanged } from './store/atomic.ts'

/**
 * Tell the agent files in this project that a hoppr exists.
 *
 * A store nobody knows about gets used by nobody. CLAUDE.md and AGENTS.md are
 * already the place a coding agent looks for standing instructions, so a few
 * lines there are worth more than any amount of MCP tooling — an agent that
 * reads "search here before answering" will, and one that has to discover a
 * tool through introspection mostly will not.
 *
 * Written with the same discipline as the MCP installer: a marked block, never
 * a rewrite. A file we did not create is appended to and never restructured,
 * and a second run replaces our block rather than adding another.
 */
const BEGIN = '<!-- hoppr:begin -->'
const END = '<!-- hoppr:end -->'

/** The agent-facing files worth writing into, nearest first. */
export function agentFilesNear(dir: string, depth = 3): string[] {
  const names = ['CLAUDE.md', 'AGENTS.md']
  const out: string[] = []
  let cur = dir
  for (let i = 0; i <= depth; i++) {
    for (const n of names) {
      const p = join(cur, n)
      if (existsSync(p)) out.push(p)
    }
    const up = dirname(cur)
    if (up === cur) break
    cur = up
  }
  return out
}

export function hopprBlock(name: string, storeDir: string, description: string): string {
  return [
    BEGIN,
    `## Searchable context: \`${name}\``,
    '',
    description || `A hoppr index over ${basename(dirname(storeDir))}.`,
    '',
    'Before answering from memory, search it — it holds material this repository does not:',
    '',
    '```bash',
    `hoppr -H ${name} search "<what you are looking for>"`,
    `hoppr -H ${name} get <id>        # the full page`,
    `hoppr -H ${name} source <id>     # the original capture, verbatim`,
    '```',
    '',
    'Results mix curated pages with the raw captures they were written from. Two pages',
    'citing the same capture are one fact, not two. Quote from `source`, never from a',
    'summary, when exact wording matters.',
    END,
  ].join('\n')
}

export interface AnnotateResult {
  path: string
  outcome: 'added' | 'updated' | 'unchanged'
}

/** Append or refresh our block. Everything outside it is left exactly as it was. */
export async function annotateAgentFile(path: string, block: string): Promise<AnnotateResult> {
  const existing = existsSync(path) ? await readFile(path, 'utf8') : ''
  const start = existing.indexOf(BEGIN)
  const end = existing.indexOf(END)

  let next: string
  let outcome: AnnotateResult['outcome']
  if (start >= 0 && end > start) {
    next = existing.slice(0, start) + block + existing.slice(end + END.length)
    outcome = next === existing ? 'unchanged' : 'updated'
  } else {
    const sep = existing.trim() ? '\n\n' : ''
    next = `${existing.trimEnd()}${sep}${block}\n`
    outcome = 'added'
  }
  if (outcome !== 'unchanged') await writeIfChanged(path, next)
  return { path, outcome }
}
