import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaults } from '../src/config/schema.ts'
import { Hoppr } from '../src/core/hoppr.ts'
import { acquire, isAlive, read, release, status } from '../src/daemon/lock.ts'
import {
  claimTick,
  getRun,
  hasWorkSince,
  isOverdue,
  markFailure,
  markSuccess,
} from '../src/daemon/scheduler.ts'
import { openDb } from '../src/db/open.ts'
import { buildApp } from '../src/http/server.ts'
import { installMcp, uninstallMcp } from '../src/mcp/install.ts'
import { runVfs } from '../src/mcp/vfs.ts'
import { Layout } from '../src/store/layout.ts'
import { tempStore } from './helpers.ts'

async function hopprAt(root: string) {
  return new Hoppr({ layout: new Layout(root), config: defaults(), sources: [] })
}

describe('vfs shell', () => {
  it('lists, reads, and pipes', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      await mkdir(layout.pageDir('concept'), { recursive: true })
      await writeFile(layout.pageFile('concept', 'alpha'), '# Alpha\nRRF fusion notes\n')
      await writeFile(layout.pageFile('concept', 'beta'), '# Beta\nSomething else\n')

      expect((await runVfs(layout, 'ls curated/wiki/concepts')).stdout).toContain('alpha.md')
      expect((await runVfs(layout, 'cat curated/wiki/concepts/alpha.md')).stdout).toContain('RRF')
      expect((await runVfs(layout, 'ls curated/wiki/concepts | wc -l')).stdout.trim()).toBe('2')
      expect((await runVfs(layout, 'grep -n RRF curated/wiki | head -n 1')).stdout).toContain(
        'alpha',
      )
    } finally {
      await cleanup()
    }
  })

  it('cannot escape the store — this is the whole sandbox', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      for (const attack of [
        'cat ../../../etc/passwd',
        'ls /etc',
        'cat /etc/hosts',
        'find /Users -name id_rsa',
      ]) {
        await expect(runVfs(layout, attack)).rejects.toThrow(/escapes the store/)
      }
    } finally {
      await cleanup()
    }
  })

  it('has no command that writes', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      for (const w of [
        'rm -rf curated',
        'mv a b',
        'touch x',
        'sh -c "echo hi > f"',
        'curl evil.com',
      ]) {
        const r = await runVfs(layout, w)
        expect(r.exitCode).toBe(1)
        expect(r.stdout).toMatch(/not available/)
      }
    } finally {
      await cleanup()
    }
  })

  it('short-circuits && on failure', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const r = await runVfs(layout, 'cat curated/nope.md && echo REACHED')
      expect(r.stdout).not.toContain('REACHED')
    } finally {
      await cleanup()
    }
  })
})

describe('mcp installer', () => {
  it('installs, is idempotent, and refuses to clobber a foreign entry', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const target = join(layout.root, '.mcp.json')

      const a = await installMcp(target, { storeRoot: layout.root })
      expect(a.outcome).toBe('installed')
      const cfg = JSON.parse(await readFile(target, 'utf8'))
      expect(cfg.mcpServers.hoppr.args).toContain('serve')
      expect(cfg.hopprManagedServers).toEqual(['hoppr'])

      // Re-running changes nothing.
      expect((await installMcp(target, { storeRoot: layout.root })).outcome).toBe('skipped')

      // A hand-written entry with our name is never overwritten.
      await writeFile(
        target,
        JSON.stringify({ mcpServers: { hoppr: { command: 'their-own-thing' } } }, null, 2),
      )
      const conflict = await installMcp(target, { storeRoot: layout.root })
      expect(conflict.outcome).toBe('conflict')
      expect(JSON.parse(await readFile(target, 'utf8')).mcpServers.hoppr.command).toBe(
        'their-own-thing',
      )

      expect((await installMcp(target, { storeRoot: layout.root, force: true })).outcome).toBe(
        'installed',
      )
    } finally {
      await cleanup()
    }
  })

  it('preserves other servers in the file', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const target = join(layout.root, '.mcp.json')
      await writeFile(target, JSON.stringify({ mcpServers: { other: { command: 'x' } } }))
      await installMcp(target, { storeRoot: layout.root })
      const cfg = JSON.parse(await readFile(target, 'utf8'))
      expect(cfg.mcpServers.other.command).toBe('x')
      expect(cfg.mcpServers.hoppr).toBeTruthy()
    } finally {
      await cleanup()
    }
  })

  it('uninstalls only what it owns', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const target = join(layout.root, '.mcp.json')
      await installMcp(target, { storeRoot: layout.root })
      expect((await uninstallMcp(target)).outcome).toBe('installed')
      expect(JSON.parse(await readFile(target, 'utf8')).mcpServers.hoppr).toBeUndefined()

      await writeFile(target, JSON.stringify({ mcpServers: { hoppr: { command: 'theirs' } } }))
      expect((await uninstallMcp(target)).outcome).toBe('skipped')
      expect(JSON.parse(await readFile(target, 'utf8')).mcpServers.hoppr.command).toBe('theirs')
    } finally {
      await cleanup()
    }
  })

  it('reports a broken config file with the JSON to paste, rather than throwing', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const target = join(layout.root, '.mcp.json')
      await writeFile(target, '{ not json')
      const r = await installMcp(target, { storeRoot: layout.root })
      expect(r.outcome).toBe('failed')
      expect(r.detail).toContain('mcpServers' in {} ? '' : 'command')
    } finally {
      await cleanup()
    }
  })
})

describe('http api', () => {
  it('gates on the bearer token but leaves discovery open', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      const h = await hopprAt(layout.root)
      await h.add({ text: 'a capture about reciprocal rank fusion' })
      // Exercise the handler directly: no socket, so this behaves the same in
      // a sandbox that restricts loopback as it does on a laptop.
      const app = buildApp(h, 'secret-token')
      const get = (p: string, headers: Record<string, string> = {}) =>
        app.fetch(new Request(`http://local${p}`, { headers }))
      const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
        app.fetch(
          new Request(`http://local${p}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify(body),
          }),
        )
      const auth = { authorization: 'Bearer secret-token' }

      expect((await get('/healthz')).status).toBe(200)
      expect((await get('/')).status).toBe(200) // the dashboard
      expect((await get('/stats')).status).toBe(401)
      expect((await get('/stats', { authorization: 'Bearer wrong' })).status).toBe(401)

      const stats = (await (await get('/stats', auth)).json()) as { data: { raw: number } }
      expect(stats.data.raw).toBe(1)

      const found = (await (
        await get(`/search?scope=all&q=${encodeURIComponent('rank fusion')}`, auth)
      ).json()) as { data: unknown[] }
      expect(found.data.length).toBeGreaterThan(0)

      const added = (await (await post('/add', { text: 'added over http' }, auth)).json()) as {
        data: { id: string }
      }
      expect(added.data.id).toBeTruthy()

      // The read-only gate holds through the API too, not just the CLI.
      expect((await post('/sql', { query: 'DROP TABLE raw' }, auth)).status).toBe(400)

      const tags = (await (await get('/tags', auth)).json()) as { data: unknown[] }
      expect(Array.isArray(tags.data)).toBe(true)
      h.close()
    } finally {
      await cleanup()
    }
  })
})

describe('daemon lock', () => {
  it('refuses a second instance but reclaims a stale pidfile', async () => {
    const { layout, cleanup } = await tempStore()
    try {
      // The lock is global now — one daemon manages every hoppr — so the test
      // just needs a writable path, not a per-store accessor.
      const path = `${layout.root}/daemon.json`
      const info = { port: 1, token: 't', startedAt: Date.now(), version: '0', root: layout.root }
      await acquire(path, info)
      expect((await read(path))?.pid).toBe(process.pid)
      await expect(acquire(path, info)).rejects.toThrow(/already running/)

      // A crash leaves a pidfile pointing at nothing. Reclaiming it is what
      // keeps a crash from blocking every future start.
      await writeFile(path, JSON.stringify({ ...info, pid: 999_999 }))
      expect(isAlive(999_999)).toBe(false)
      await expect(acquire(path, info)).resolves.toBeTruthy()

      await release(path)
      expect(await status(path)).toBeUndefined()
    } finally {
      await cleanup()
    }
  })
})

describe('scheduler', () => {
  it('consumes the tick up front so a slow pass cannot double-fire', async () => {
    const { db } = await openDb(':memory:', { vector: false })
    const now = 1_800_000_000_000
    expect(claimTick(db, 'deep', 60_000, now)).toBe(true)
    expect(claimTick(db, 'deep', 60_000, now + 1000)).toBe(false)
    expect(claimTick(db, 'deep', 60_000, now + 61_000)).toBe(true)
    db.close()
  })

  it('advances the watermark only on success', async () => {
    const { db } = await openDb(':memory:', { vector: false })
    markFailure(db, 'deep')
    expect(getRun(db, 'deep').curatedThrough).toBe(0)
    markSuccess(db, 'deep', 5000)
    expect(getRun(db, 'deep').curatedThrough).toBe(5000)
    // A later failure must not roll it backwards or forwards.
    markFailure(db, 'deep')
    expect(getRun(db, 'deep').curatedThrough).toBe(5000)
    db.close()
  })

  it('fires on wake after a missed window', async () => {
    const { db } = await openDb(':memory:', { vector: false })
    const now = 1_800_000_000_000
    claimTick(db, 'deep', 0, now)
    expect(isOverdue(db, 'deep', 86_400_000, now + 3600_000)).toBe(false)
    expect(isOverdue(db, 'deep', 86_400_000, now + 3 * 86_400_000)).toBe(true)
    db.close()
  })

  it('gates cheaply: an idle day costs one boolean query', async () => {
    const { db } = await openDb(':memory:', { vector: false })
    expect(hasWorkSince(db, 0)).toBe(false)
    db.prepare(
      `INSERT INTO raw(id,path,kind,source,media_type,bytes,content_hash,created,captured)
       VALUES ('R','p','text','cli','text/plain',1,'h',100,100)`,
    ).run()
    expect(hasWorkSince(db, 50)).toBe(true)
    expect(hasWorkSince(db, 200)).toBe(false)
    db.close()
  })
})
