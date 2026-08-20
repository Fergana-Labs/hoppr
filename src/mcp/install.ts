import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeAtomic } from '../store/atomic.ts'

export type InstallOutcome = 'installed' | 'skipped' | 'conflict' | 'failed'

export interface InstallResult {
  target: string
  outcome: InstallOutcome
  detail?: string
}

/** The marker that makes an entry ours. Unknown keys are ignored by clients. */
const MARKER = 'hopprManagedServers'

export interface InstallOptions {
  storeRoot: string
  /** Pin the server to one hoppr, so this config cannot reach the others. */
  hopper?: string
  /** How the server gets launched. Defaults to the published package. */
  command?: string
  args?: string[]
  dryRun?: boolean
  force?: boolean
}

export function defaultTargets(scope: 'project' | 'user', cwd = process.cwd()): string[] {
  return scope === 'project'
    ? [join(cwd, '.mcp.json'), join(cwd, '.cursor', 'mcp.json')]
    : [join(homedir(), '.claude.json')]
}

/**
 * Ownership-marker merge into a config file we do not own.
 *
 * The rule that matters: an entry named `hoppr` that hoppr did not create is
 * NEVER overwritten. People wire servers by hand, and silently clobbering that
 * is the kind of bug that destroys trust in a tool permanently. We record what
 * we created in a sibling array, so a re-run can tell "mine, update it" from
 * "yours, leave it alone" — which also makes the whole operation idempotent
 * and safe to script.
 */
export async function installMcp(target: string, o: InstallOptions): Promise<InstallResult> {
  let config: Record<string, unknown> = {}
  if (existsSync(target)) {
    try {
      const raw = await readFile(target, 'utf8')
      config = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {}
    } catch (e) {
      return {
        target,
        outcome: 'failed',
        detail: `cannot parse: ${(e as Error).message}. Add the server by hand:\n${JSON.stringify(
          entryFor(o),
          null,
          2,
        )}`,
      }
    }
  }

  const servers = (config.mcpServers ?? {}) as Record<string, unknown>
  const managed = Array.isArray(config[MARKER]) ? (config[MARKER] as string[]) : []

  if (servers.hoppr && !managed.includes('hoppr') && !o.force) {
    return {
      target,
      outcome: 'conflict',
      detail:
        'an mcpServers entry named "hoppr" exists that hoppr did not create — ' +
        'refusing to overwrite it. Re-run with --force to replace it.',
    }
  }

  const next = { ...config, mcpServers: { ...servers, hoppr: entryFor(o) } } as Record<
    string,
    unknown
  >
  next[MARKER] = managed.includes('hoppr') ? managed : [...managed, 'hoppr']

  const serialized = `${JSON.stringify(next, null, 2)}\n`
  if (existsSync(target) && (await readFile(target, 'utf8')) === serialized) {
    return { target, outcome: 'skipped', detail: 'already up to date' }
  }
  if (o.dryRun) return { target, outcome: 'installed', detail: 'dry run — not written' }

  try {
    await writeAtomic(target, serialized)
  } catch (e) {
    return { target, outcome: 'failed', detail: (e as Error).message }
  }
  return { target, outcome: 'installed' }
}

export async function uninstallMcp(target: string): Promise<InstallResult> {
  if (!existsSync(target)) return { target, outcome: 'skipped', detail: 'no such file' }
  let config: Record<string, unknown>
  try {
    config = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>
  } catch (e) {
    return { target, outcome: 'failed', detail: (e as Error).message }
  }
  const managed = Array.isArray(config[MARKER]) ? (config[MARKER] as string[]) : []
  if (!managed.includes('hoppr')) {
    // Only ever remove what we put there.
    return { target, outcome: 'skipped', detail: 'not hoppr-managed' }
  }
  const servers = { ...((config.mcpServers ?? {}) as Record<string, unknown>) }
  delete servers.hoppr
  const next = { ...config, mcpServers: servers } as Record<string, unknown>
  const rest = managed.filter((m) => m !== 'hoppr')
  if (rest.length) next[MARKER] = rest
  else delete next[MARKER]
  await writeAtomic(target, `${JSON.stringify(next, null, 2)}\n`)
  return { target, outcome: 'installed', detail: 'removed' }
}

function entryFor(o: InstallOptions) {
  const args = o.args ?? [
    '-y',
    'hoppr',
    ...(o.hopper ? ['--hopper', o.hopper] : []),
    'mcp',
    'serve',
    ...(o.hopper ? ['--pinned'] : []),
  ]
  return {
    command: o.command ?? 'npx',
    args,
    // A pinned entry names the hoppr rather than a raw path, so moving the
    // registry does not break the config.
    env: o.hopper ? {} : { HOPPR_STORE: o.storeRoot },
  }
}
