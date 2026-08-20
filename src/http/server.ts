import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import type { Hoppr } from '../core/hoppr.ts'
import { listPages } from '../store/wiki.ts'

export interface HttpHandle {
  port: number
  close: () => void
}

/**
 * The local API and the daemon control plane, on one loopback port.
 *
 * Bound to 127.0.0.1 and gated by a bearer token stored 0600 in
 * state/daemon.json. One transport rather than a unix socket: it works on
 * Windows, it is trivially testable with curl, and file permissions on a
 * socket are a weaker auth story than a token on macOS.
 */
/**
 * A resolver rather than a single store: one daemon serves every hoppr, and
 * each request names which one it wants. Isolation lives in the data, not in
 * the process.
 */
export interface HopperResolver {
  resolve: (name: string) => Promise<Hoppr | undefined>
  list: () => string[]
}

export function singleHopper(h: Hoppr): HopperResolver {
  return { resolve: async (n) => (n === h.name || !n ? h : undefined), list: () => [h.name] }
}

export async function startHttp(
  src: Hoppr | HopperResolver,
  o: { port: number; host: string; token: string },
): Promise<HttpHandle> {
  const app = buildApp(src, o.token)
  const { server, port } = await listen(app.fetch, o.host, o.port)
  return { port, close: () => server.close() }
}

/**
 * Bind, falling back to an ephemeral port if the preferred one is taken.
 *
 * With named hoppers, running a daemon per hoppr is ordinary — one watching a
 * folder, another watching your agent logs. A fixed default port made the
 * second one die at startup with nothing useful to say. The first daemon still
 * gets the well-known port; the rest get whatever is free and record it in
 * state/daemon.json, which is where clients look anyway.
 */
async function listen(
  fetch: (req: Request) => Response | Promise<Response>,
  hostname: string,
  preferred: number,
): Promise<{ server: ReturnType<typeof serve>; port: number }> {
  for (const candidate of preferred === 0 ? [0] : [preferred, 0]) {
    try {
      const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
        const s = serve({ fetch, hostname, port: candidate }, () => resolve(s))
        s.on('error', reject)
      })
      const addr = server.address()
      return { server, port: typeof addr === 'object' && addr ? addr.port : candidate }
    } catch (e) {
      if ((e as { code?: string }).code !== 'EADDRINUSE' || candidate === 0) throw e
    }
  }
  throw new Error('could not bind a port')
}

/**
 * The app, separate from the listener.
 *
 * Exposing the handler means the whole API can be exercised by calling
 * `app.fetch(new Request(...))` — no socket, no port allocation, no
 * flakiness in sandboxes that restrict loopback.
 */
export function buildApp(src: Hoppr | HopperResolver, token: string) {
  const o = { token }
  const resolver: HopperResolver =
    'resolve' in src ? (src as HopperResolver) : singleHopper(src as Hoppr)
  const app = new Hono()

  /** Which hoppr this request is for; the first managed one by default. */
  const pick = async (c: { req: { query: (k: string) => string | undefined } }) => {
    const name = c.req.query('hopper') ?? resolver.list()[0] ?? ''
    const h = await resolver.resolve(name)
    if (!h) throw new Error(`no hoppr named '${name}'`)
    return h
  }

  app.use('*', async (c, next) => {
    // /healthz is open so a client can discover a live daemon cheaply.
    if (c.req.path === '/healthz' || c.req.path === '/') return next()
    const auth = c.req.header('authorization')
    if (auth !== `Bearer ${o.token}`) return c.json({ ok: false, error: 'unauthorized' }, 401)
    return next()
  })

  const ok = (data: unknown, meta: Record<string, unknown> = {}) => ({ ok: true, data, meta })

  app.get('/healthz', (c) => c.json({ ok: true, hoppers: resolver.list(), version: '0.0.1' }))

  app.get('/hoppers', async (c) => {
    const { listHoppers } = await import('../store/registry.ts')
    const all = await listHoppers()
    const live = new Set(resolver.list())
    return c.json(ok(all.filter((x) => live.has(x.name)).map((x) => ({ ...x, managed: true }))))
  })

  // The dashboard carries the token inline. That is safe precisely because the
  // server is bound to loopback and the page is only reachable from this
  // machine — and it means the UI needs no login flow of its own.
  app.get('/', async (c) => {
    const { dashboardHtml } = await import('./ui.ts')
    return c.html(dashboardHtml(o.token))
  })

  app.get('/search', async (c) => {
    const h = await pick(c)
    const q = c.req.query('q') ?? ''
    const res = await h.search(q, {
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
      scope: c.req.query('scope') as 'curated' | 'raw' | 'all' | undefined,
    })
    return c.json(ok(res.hits, res.meta))
  })

  app.post('/add', async (c) => {
    const h = await pick(c)
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const rec = await h.add({
      text: typeof body.text === 'string' ? body.text : undefined,
      url: typeof body.url === 'string' ? body.url : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
      project: typeof body.project === 'string' ? body.project : undefined,
      source: 'http',
    })
    return c.json(ok(rec))
  })

  // Global: is the daemon alive, what does it manage, what has it been doing.
  app.get('/daemon', async (c) => {
    const { daemonHealth } = await import('./health.ts')
    return c.json(ok(await daemonHealth(resolver.list())))
  })

  // Per hoppr: curate queue, pass history, spend.
  app.get('/health', async (c) => {
    const h = await pick(c)
    const { hopprHealth } = await import('./health.ts')
    return c.json(ok(await hopprHealth(h)))
  })

  app.get('/stats', async (c) => {
    const h = await pick(c)
    return c.json(
      ok({
        ...(await h.stats()),
        hopper: h.name,
        root: h.layout.root,
        driver: h.driver,
        vector: h.vectorAvailable,
      }),
    )
  })

  app.get('/pages', async (c) => {
    const h = await pick(c)
    const pages = await listPages(h.layout)
    return c.json(
      ok(
        pages.map((p) => ({
          slug: p.slug,
          type: p.type,
          title: p.title,
          summary: p.summary,
          tags: p.tags,
          confidence: p.confidence,
          updated: p.updated,
        })),
      ),
    )
  })

  app.get('/page/:type/:slug', async (c) => {
    const h = await pick(c)
    const { readPage } = await import('../store/wiki.ts')
    const page = await readPage(h.layout, c.req.param('type') as never, c.req.param('slug'))
    return page ? c.json(ok(page)) : c.json({ ok: false, error: 'not found' }, 404)
  })

  app.get('/tags', async (c) => {
    const h = await pick(c)
    const { loadTaxonomy } = await import('../organize/taxonomy.ts')
    const tax = await loadTaxonomy(h.layout)
    return c.json(
      ok(
        Object.entries(tax.tags)
          .filter(([, e]) => !e.merged_into)
          .sort((a, b) => b[1].count - a[1].count)
          .map(([tag, e]) => ({ tag, count: e.count, description: e.description })),
      ),
    )
  })

  app.post('/sql', async (c) => {
    const h = await pick(c)
    const body = (await c.req.json().catch(() => ({}))) as { query?: string }
    try {
      return c.json(ok(await h.sql(String(body.query ?? ''))))
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 400)
    }
  })

  app.get('/skills', async (c) => {
    const h = await pick(c)
    const db = await h.db()
    return c.json(
      ok(
        db
          .prepare(
            'SELECT slug, name, description, state, evidence_count, confidence FROM skills ORDER BY confidence DESC',
          )
          .all(),
      ),
    )
  })

  return app
}
