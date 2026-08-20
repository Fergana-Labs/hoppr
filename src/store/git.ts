import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * Git is the review layer for an autonomous agent: `git diff HEAD~1 curated/`
 * is how you see what the curator did last night, and `git revert` is an undo
 * that predates hoppr's own journal.
 *
 * We shell out rather than take a dependency — the surface we need is four
 * commands, and it keeps `npx hoppr` lean.
 */
export async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', root, ...args], {
    maxBuffer: 32 * 1024 * 1024,
  })
  return stdout.trim()
}

export function isRepo(root: string): boolean {
  return existsSync(join(root, '.git'))
}

export async function init(root: string): Promise<void> {
  if (isRepo(root)) return
  await git(root, ['init', '-q'])
  // A store is personal; don't inherit a global signing/identity failure.
  await git(root, ['config', 'user.name', 'hoppr']).catch(() => {})
  await git(root, ['config', 'user.email', 'hoppr@localhost']).catch(() => {})
  await git(root, ['config', 'commit.gpgsign', 'false']).catch(() => {})
}

/**
 * Stage the tracked tiers and commit. Returns the sha, or null when nothing
 * changed — which is the common case, and is why skip-if-identical writes
 * matter: a pass that inspects 2000 files and changes none must be a no-op.
 */
export async function commit(
  root: string,
  message: string,
  paths: string[] = ['raw', 'curated', 'hoppr.toml', 'CLAUDE.md'],
): Promise<string | null> {
  if (!isRepo(root)) return null
  const present = paths.filter((p) => existsSync(join(root, p)))
  if (present.length === 0) return null

  await git(root, ['add', '--', ...present])
  const staged = await git(root, ['diff', '--cached', '--name-only'])
  if (!staged) return null

  // The message may be multi-line (the curator's log entry). execFile passes
  // argv directly with no shell, so a newline-bearing -m argument is safe.
  await git(root, ['commit', '-q', '-m', message])
  return git(root, ['rev-parse', 'HEAD'])
}
