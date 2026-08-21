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

/**
 * Agent files in THIS folder, and nowhere else.
 *
 * This walked up three directories, which meant running `hoppr init` in
 * ~/Downloads could offer to edit ~/CLAUDE.md — a person's global agent
 * memory, which is a different thing from a project file and not something a
 * folder-indexing command should reach for.
 *
 * Predictable beats clever: the folder you ran it in. If you want the note in
 * a repository root or your global memory, paste it there deliberately.
 */
export function agentFilesNear(dir: string): string[] {
  return ['CLAUDE.md', 'AGENTS.md'].map((n) => join(dir, n)).filter((p) => existsSync(p))
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

/**
 * The machine-wide agent memory, if the person keeps one.
 *
 * Deliberately separate from `agentFilesNear`, and only offered the FIRST time
 * a hoppr is created here. A per-folder note says "this store holds X"; a
 * global note has to say something different — that hoppers exist at all, and
 * how to find the right one — because it will be read in projects that have
 * nothing to do with any of them.
 */
export function globalAgentFiles(home: string): string[] {
  return [join(home, '.claude', 'CLAUDE.md'), join(home, '.codex', 'AGENTS.md')].filter((p) =>
    existsSync(p),
  )
}

export function globalHopprBlock(): string {
  return [
    BEGIN,
    '## hoppr — local searchable context',
    '',
    'This machine has one or more hoppers: local indexes over folders of documents or',
    'past agent sessions. They hold material that is not in any repository.',
    '',
    '```bash',
    'hoppr hoppers                       # what exists, and what each is for',
    'hoppr -H <name> search "<query>"    # search one',
    'hoppr -H <name> source <id>         # the original capture, verbatim',
    '```',
    '',
    'Read `hoppr hoppers` before searching: each carries a one-line description of what',
    'it covers, and searching the wrong one looks the same as there being no answer.',
    END,
  ].join('\n')
}
