import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { commandsIn } from './grounding.ts'

/**
 * Check a proposed move against the project it would run in.
 *
 * This is Phase 5's safe half, and the distinction is worth naming rather than
 * blurring. The blind spot is real: replay is a model judging a model against
 * a text stub, so it cannot see Environment Mismatch (13 of 125 confirmed
 * functional failures) or Artifact Misplacement (24) — a skill directing an
 * agent to run something this project does not have, or to write somewhere the
 * task never named. Those are the two classes no amount of transcript reading
 * reaches.
 *
 * Closing them completely means executing what the arm proposed. That means
 * running model-generated shell commands against a real checkout, which is not
 * a thing to build without someone asking for it explicitly, and it is not
 * what a store scoring its own skills at 3am should be doing.
 *
 * So: the move is checked, not run. An arm already produces a concrete next
 * action; this reads the project's manifests and filesystem and asks whether
 * that action could work here. It catches a skill telling an agent to
 * `pnpm install` in an npm project, or to run a script that does not exist, or
 * to write into a directory that is not there — statically, with no side
 * effects, in milliseconds.
 *
 * What it does NOT catch is anything that only appears at runtime: a script
 * that exists and fails, a path that exists and is wrong, a version skew. Those
 * still need real execution, and `hoppr skills verify` says so rather than
 * implying its pass means more than it does.
 */
export interface Violation {
  kind: 'missing-script' | 'wrong-package-manager' | 'missing-path' | 'missing-tool'
  what: string
  detail: string
}

export interface ProjectFacts {
  dir: string
  /** Script names this project defines, for whichever manifest it has. */
  scripts: Set<string>
  /** The package manager its lockfile implies. */
  manager?: string
  /** Runners that plainly are not this project's. */
  foreign: Set<string>
}

const MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const

export async function projectFacts(dir: string): Promise<ProjectFacts> {
  const facts: ProjectFacts = { dir, scripts: new Set(), foreign: new Set() }

  const pkgPath = join(dir, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as {
        scripts?: Record<string, string>
      }
      for (const name of Object.keys(pkg.scripts ?? {})) facts.scripts.add(name)
    } catch {
      // A manifest we cannot parse tells us nothing; it must not be reported
      // as a project with no scripts, which would fail every command named.
      return facts
    }
    facts.manager = existsSync(join(dir, 'pnpm-lock.yaml'))
      ? 'pnpm'
      : existsSync(join(dir, 'yarn.lock'))
        ? 'yarn'
        : existsSync(join(dir, 'bun.lockb'))
          ? 'bun'
          : existsSync(join(dir, 'package-lock.json'))
            ? 'npm'
            : undefined
    // Only when a lockfile actually settled it. Without one, any manager is a
    // defensible choice and calling one foreign would be inventing a rule.
    if (facts.manager) {
      for (const m of MANAGERS) if (m !== facts.manager) facts.foreign.add(m)
    }
  }
  return facts
}

/**
 * Everything in a proposed move that could not work in this project.
 *
 * Deliberately narrow, for the reason `grounding.ts` gives about its own
 * checks: a false positive discards a real skill, and the alternative to a
 * mined skill is no skill. So it fires only where the project has told us
 * something definite — a manifest that parses, a lockfile that names a
 * manager, a path the move quotes explicitly.
 */
export function checkMove(move: string, facts: ProjectFacts): Violation[] {
  const out: Violation[] = []

  for (const cmd of commandsIn(move)) {
    const [runner, sub, target] = cmd.split(' ')
    if (!runner) continue

    if (facts.foreign.has(runner)) {
      out.push({
        kind: 'wrong-package-manager',
        what: runner,
        detail: `this project uses ${facts.manager}`,
      })
      continue
    }
    // `npm run <script>` resolves one token deeper, which is the level the
    // manifest can actually answer.
    if (MANAGERS.includes(runner as (typeof MANAGERS)[number]) && sub === 'run' && target) {
      if (facts.scripts.size > 0 && !facts.scripts.has(target)) {
        out.push({
          kind: 'missing-script',
          what: `${runner} run ${target}`,
          detail: 'no such script in package.json',
        })
      }
    }
  }

  for (const p of quotedPaths(move)) {
    if (!existsSync(join(facts.dir, p))) {
      out.push({ kind: 'missing-path', what: p, detail: 'no such file or directory here' })
    }
  }
  return out
}

/**
 * Paths a move names in backticks, and only those.
 *
 * Prose mentions directories constantly — "put it in the source directory" —
 * and treating that as a path assertion fires on ordinary English. A
 * backticked `src/organize/replay.ts` is a claim about the filesystem; the
 * sentence around it is not.
 */
function quotedPaths(move: string): string[] {
  const out = new Set<string>()
  for (const m of move.matchAll(/`([^`\s]+\/[^`\s]*)`/g)) {
    const p = (m[1] ?? '').replace(/^\.\//, '')
    // Absolute paths, URLs and globs are not this project's tree.
    if (!p || p.startsWith('/') || p.includes('://') || p.includes('*')) continue
    // A path with an extension or an existing-looking prefix is an assertion;
    // `foo/bar` with neither is usually a placeholder in prose.
    if (!/\.[a-z0-9]+$/i.test(p) && !p.endsWith('/')) continue
    out.add(p)
  }
  return [...out]
}

export function renderViolations(v: Violation[]): string {
  return v.map((x) => `${x.kind}: \`${x.what}\` — ${x.detail}`).join('; ')
}
