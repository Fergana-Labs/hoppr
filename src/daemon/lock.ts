import { existsSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { HopprError } from '../core/errors.ts'
import { writeAtomic } from '../store/atomic.ts'

export interface DaemonInfo {
  pid: number
  port: number
  token: string
  startedAt: number
  version: string
  root: string
}

/**
 * Single-instance lock.
 *
 * A pidfile alone goes stale after a crash and then blocks every future start,
 * which is worse than no lock at all — so we probe the recorded pid with
 * signal 0 and reclaim the file when nothing is listening.
 */
export async function acquire(path: string, info: Omit<DaemonInfo, 'pid'>): Promise<DaemonInfo> {
  const existing = await read(path)
  if (existing && isAlive(existing.pid)) {
    throw HopprError.user(
      `a hoppr daemon is already running (pid ${existing.pid}, port ${existing.port}). ` +
        'Use `hoppr daemon stop` first.',
    )
  }
  const next: DaemonInfo = { ...info, pid: process.pid }
  // 0600: the file carries the loopback API token.
  await writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`)
  const { chmod } = await import('node:fs/promises')
  await chmod(path, 0o600).catch(() => {})
  return next
}

/**
 * Update our own lockfile in place — e.g. to record the port once the socket
 * is bound. Distinct from acquire(), which would see this process's own pid
 * and refuse as if a second daemon were running.
 */
export async function update(path: string, patch: Partial<DaemonInfo>): Promise<void> {
  const cur = await read(path)
  if (!cur || cur.pid !== process.pid) return
  await writeAtomic(path, `${JSON.stringify({ ...cur, ...patch }, null, 2)}\n`)
}

export async function read(path: string): Promise<DaemonInfo | undefined> {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(await readFile(path, 'utf8')) as DaemonInfo
  } catch {
    return undefined
  }
}

export async function release(path: string): Promise<void> {
  await unlink(path).catch(() => {})
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Live only if the pidfile exists AND that process is actually running. */
export async function status(path: string): Promise<DaemonInfo | undefined> {
  const info = await read(path)
  return info && isAlive(info.pid) ? info : undefined
}
