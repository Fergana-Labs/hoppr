import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Cron } from 'croner'
import { Hoppr } from '../core/hoppr.ts'
import { embeddingsEnabled } from '../core/profiles.ts'
import { appendLine, ensureDir } from '../store/atomic.ts'
import * as gitmod from '../store/git.ts'
import { Layout } from '../store/layout.ts'
import { listHoppers } from '../store/registry.ts'
import * as lock from './lock.ts'
import {
  claimTick,
  getRun,
  hasWorkSince,
  highWaterMark,
  isOverdue,
  markFailure,
  markSuccess,
} from './scheduler.ts'

export interface DaemonOptions {
  foreground?: boolean
  onLog?: (msg: string) => void
  /** Limit to these hoppers. Default: every hoppr in the registry. */
  only?: string[]
}

/**
 * ONE process, MANY isolated hoppers.
 *
 * Each hoppr keeps its own store, index, vocabulary and schedule — the
 * isolation is the whole point — but they share a single daemon, a single
 * port, and a single lock. Running a process per hoppr would mean N pidfiles,
 * N ports to collide, and N copies of the same scheduler for no benefit.
 *
 * As before, nothing here is required: the CLI and MCP server open SQLite
 * directly, so a dead daemon degrades curation, never capture or search.
 */
export async function runDaemon(opts: DaemonOptions = {}): Promise<() => Promise<void>> {
  const home = Layout.home()
  await ensureDir(home)

  const log = (msg: string) => {
    const line = `${new Date().toISOString()} ${msg}`
    opts.onLog?.(line)
    void appendLine(Layout.daemonLogGlobal(), line)
  }

  const token = randomBytes(24).toString('hex')
  const stops: Array<() => void | Promise<void>> = []

  // Managed hoppers, keyed by name. Re-scanned periodically so `hoppr new`
  // is picked up without a restart.
  const managed = new Map<string, Managed>()

  // One serial lane for model work. Hoppers are isolated in their data, not in
  // their rate limit — five curations at once would just get throttled.
  let llmBusy = false
  const llmLane = async (fn: () => Promise<void>) => {
    if (llmBusy) return false
    llmBusy = true
    try {
      await fn()
    } finally {
      llmBusy = false
    }
    return true
  }

  await lock.acquire(Layout.daemonFileGlobal(), {
    port: 0,
    token,
    startedAt: Date.now(),
    version: '0.0.1',
    root: home,
  })

  const { startHttp } = await import('../http/server.ts')
  const http = await startHttp(
    { resolve: (n) => pick(n), list: () => [...managed.keys()] },
    {
      port: firstPort(managed),
      host: '127.0.0.1',
      token,
    },
  )
  stops.push(() => http.close())

  // Record the real port so clients (and the dashboard) can find us.
  await lock.update(Layout.daemonFileGlobal(), { port: http.port })
  log(`daemon started pid=${process.pid} http://127.0.0.1:${http.port}`)

  async function pick(name: string): Promise<Hoppr | undefined> {
    return managed.get(name)?.h
  }

  async function adopt(name: string): Promise<void> {
    if (managed.has(name)) return
    const h = await Hoppr.open({ hopper: name }).catch(() => undefined)
    if (!h) {
      log(`skipping '${name}': could not open`)
      return
    }
    const m: Managed = { h, stops: [], debounce: undefined, firstNudge: 0, busy: false }
    managed.set(name, m)
    await wire(name, m)
    log(`managing '${name}' (${h.config.hopper.profile}, ${h.config.hopper.source})`)
  }

  async function release(name: string): Promise<void> {
    const m = managed.get(name)
    if (!m) return
    managed.delete(name)
    if (m.debounce) clearTimeout(m.debounce)
    for (const stop of m.stops) {
      try {
        await stop()
      } catch {
        /* a watcher on a deleted directory may already have failed */
      }
    }
    try {
      m.h.close()
    } catch {
      // The database file may already be gone; that is the case we are here for.
    }
    log(`released '${name}' — store no longer present`)
  }

  async function wire(name: string, m: Managed): Promise<void> {
    const h = m.h
    const chokidar = await import('chokidar')

    const nudge = (why: string) => {
      if (!m.firstNudge) m.firstNudge = Date.now()
      if (m.debounce) clearTimeout(m.debounce)
      const waited = Date.now() - m.firstNudge
      const delay = Math.max(
        0,
        Math.min(h.config.intake.debounce_ms, h.config.intake.max_wait_ms - waited),
      )
      m.debounce = setTimeout(() => {
        m.firstNudge = 0
        void curate(why)
      }, delay)
    }
    m.nudge = nudge

    const curate = async (why: string) => {
      if (m.busy) return
      m.busy = true
      try {
        const ran = await llmLane(async () => {
          const st = await h.curate({})
          if (st.claimed > 0) log(`[${name}] fast pass (${why}): ${st.logLine}`)
          if (st.written > 0 && h.config.git.mode === 'auto') {
            // `raw` only exists in copy mode; commit() skips absent paths.
            await gitmod
              .commit(h.layout.root, `captured ${st.claimed} items`, ['raw'])
              .catch(() => null)
            await gitmod.commit(h.layout.root, st.logLine, ['curated']).catch(() => null)
          }
          if (embeddingsEnabled(h.config)) {
            const e = await h.embed({}).catch(() => undefined)
            if (e?.embedded) log(`[${name}] embedded ${e.embedded} (${e.cached} cached)`)
          }
        })
        if (!ran) setTimeout(() => void curate(why), 15_000) // lane busy; try later
      } catch (e) {
        log(`[${name}] fast pass failed: ${(e as Error).message}`)
      } finally {
        m.busy = false
      }
    }

    // Inbox: every hoppr has one, even a reference-mode folder hoppr — you can
    // still throw something in by hand.
    const inboxDir = join(h.layout.root, h.config.intake.inbox)
    await ensureDir(inboxDir)
    const inbox = chokidar.watch(inboxDir, {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
    })
    inbox.on('add', async (path: string) => {
      if (basename(path).startsWith('.')) return
      try {
        const rec = await h.add({ file: path, source: 'inbox' })
        await rename(path, join(h.layout.blobs, basename(path))).catch(async () => {
          const { unlink } = await import('node:fs/promises')
          await unlink(path).catch(() => {})
        })
        log(`[${name}] inbox: ${basename(path)} -> ${rec.id}`)
        nudge('inbox')
      } catch (e) {
        log(`[${name}] inbox: ${basename(path)} failed: ${(e as Error).message}`)
      }
    })
    m.stops.push(() => inbox.close())

    // Editing a prompt or a table definition re-stales what it produced.
    const defs = chokidar.watch([h.layout.prompts, h.layout.tables], { ignoreInitial: true })
    defs.on('change', async (path: string) => {
      log(`[${name}] definition changed: ${basename(path)} — marking rows stale`)
      const db = await h.db()
      db.prepare('UPDATE raw SET curate_stale = 1, curate_fails = 0 WHERE curate_fails < 3').run()
      nudge('prompt-edit')
    })
    m.stops.push(() => defs.close())

    // Connector polling, per hoppr, at its own cadence.
    const pollMs = Math.max(30_000, pollIntervalFor(h))
    const poll = setInterval(async () => {
      if (m.busy) return
      try {
        const stats = await h.sync({})
        const changed = stats.reduce((n, s) => n + s.captured + s.updated, 0)
        const gone = stats.reduce((n, s) => n + s.pruned, 0)
        if (changed || gone) {
          log(`[${name}] sync: ${changed} changed${gone ? `, ${gone} gone` : ''}`)
          nudge('sync')
        }
      } catch (e) {
        log(`[${name}] sync failed: ${(e as Error).message}`)
      }
    }, pollMs)
    m.stops.push(() => clearInterval(poll))

    // Nightly deep pass, on this hoppr's own cron.
    const deep = async (why: string) => {
      const db = await h.db()
      const DAY = 86_400_000
      if (!claimTick(db, 'deep', DAY / 2)) return
      const since = getRun(db, 'deep').curatedThrough
      if (!hasWorkSince(db, since)) {
        markSuccess(db, 'deep', highWaterMark(db))
        return
      }
      const water = highWaterMark(db)
      log(`[${name}] deep pass starting (${why})`)
      m.busy = true
      try {
        await llmLane(async () => {
          const { deepPass } = await import('../organize/deep.ts')
          const st = await deepPass(h, { since })
          markSuccess(db, 'deep', water)
          log(`[${name}] deep pass: ${st.logLine}`)
          if (h.config.git.mode === 'auto') {
            await gitmod.commit(h.layout.root, st.logLine, ['curated']).catch(() => null)
          }
        })
      } catch (e) {
        markFailure(db, 'deep')
        log(`[${name}] deep pass failed (watermark not advanced): ${(e as Error).message}`)
      } finally {
        m.busy = false
      }
    }

    const cron = new Cron(h.config.curate.deep_cron, { protect: true }, () => void deep('cron'))
    m.stops.push(() => cron.stop())
    const db = await h.db()
    if (isOverdue(db, 'deep', 86_400_000)) setTimeout(() => void deep('overdue'), 30_000)

    nudge('startup')
  }

  for (const info2 of await listHoppers()) {
    if (opts.only?.length && !opts.only.includes(info2.name)) continue
    await adopt(info2.name)
  }
  if (managed.size === 0) log('no hoppers to manage — create one with `hoppr new`')

  // Pick up hoppers created while we are running, and let go of ones that are
  // gone. Stores now live in project directories, so `rm -rf` on one is an
  // ordinary thing to do — without the release the daemon keeps a watcher, a
  // cron, and an open SQLite handle on a deleted directory forever, and logs a
  // failure every poll.
  const rescan = setInterval(async () => {
    const live = new Set<string>()
    for (const info2 of await listHoppers()) {
      if (opts.only?.length && !opts.only.includes(info2.name)) continue
      live.add(info2.name)
      await adopt(info2.name)
    }
    for (const name of [...managed.keys()]) {
      if (!live.has(name)) await release(name)
    }
  }, 60_000)
  stops.push(() => clearInterval(rescan))

  const shutdown = async () => {
    log('daemon stopping')
    for (const m of managed.values()) {
      if (m.debounce) clearTimeout(m.debounce)
      for (const s of m.stops) await s()
      m.h.close()
    }
    for (const s of stops) await s()
    await lock.release(Layout.daemonFileGlobal())
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      void shutdown().then(() => process.exit(0))
    })
  }
  return shutdown
}

interface Managed {
  h: Hoppr
  stops: Array<() => void | Promise<void>>
  debounce: NodeJS.Timeout | undefined
  firstNudge: number
  busy: boolean
  nudge?: (why: string) => void
}

function pollIntervalFor(h: Hoppr): number {
  const vals = Object.values(h.config.connectors).map((c) => (c.poll_seconds ?? 60) * 1000)
  return vals.length ? Math.min(...vals) : 60_000
}

function firstPort(_managed: Map<string, Managed>): number {
  return Number(process.env.HOPPR_PORT ?? 7717)
}

export async function daemonStatus() {
  return lock.status(Layout.daemonFileGlobal())
}

export async function stopDaemon(): Promise<boolean> {
  const info = await lock.status(Layout.daemonFileGlobal())
  if (!info) {
    if (existsSync(Layout.daemonFileGlobal())) await lock.release(Layout.daemonFileGlobal())
    return false
  }
  process.kill(info.pid, 'SIGTERM')
  for (let i = 0; i < 60; i++) {
    if (!lock.isAlive(info.pid)) break
    await new Promise((r) => setTimeout(r, 200))
  }
  await lock.release(Layout.daemonFileGlobal())
  return true
}
