#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { Command } from 'commander'
import { defaults } from './config/schema.ts'
import { HopprError } from './core/errors.ts'
import { Hoppr } from './core/hoppr.ts'
import { c, human, printJson, relTime } from './core/out.ts'
import { curationFor } from './core/profiles.ts'
import { readStdin } from './intake/add.ts'
import { writeIfChanged } from './store/atomic.ts'
import { renderClaudeMd } from './store/claudemd.ts'
import * as gitmod from './store/git.ts'
import { initStore } from './store/init.ts'
import { Layout } from './store/layout.ts'
import * as rawStore from './store/raw.ts'

const program = new Command()

program
  .name('hoppr')
  .description('A local-first hopper for agent memory')
  .version('0.0.1')
  .option('-H, --hopper <name>', 'which hoppr to use (default: $HOPPR_HOPPER or "default")')
  .option('--store <path>', 'explicit store path, bypassing the hoppr registry')
  .option('--json', 'machine-readable output')

async function ctx(): Promise<Hoppr> {
  const opts = program.opts<{ store?: string; hopper?: string }>()
  return Hoppr.open({
    root: opts.store ? resolve(opts.store) : undefined,
    hopper: opts.hopper,
  })
}
const wantJson = () => program.opts<{ json?: boolean }>().json === true

// ── init ──────────────────────────────────────────────────────────
program
  .command('init')
  .description('create a hoppr here — like `git init`, but for what you know')
  .argument('[path]', 'store root (default: ./.hoppr)')
  .option('--global', `create it in ${'~/.hoppr'}/<name> instead of here`)
  .option('--name <name>', 'what to call it (default: this directory)')
  .option('-y, --yes', 'index and curate immediately, without asking')
  .action(async (path?: string, o: { global?: boolean; name?: string; yes?: boolean } = {}) => {
    // `git init` makes `.git` HERE. Anything else would be a different tool
    // wearing the same word: the whole point of a per-directory store is that
    // it moves, clones and deletes with the thing it describes.
    const explicit = path ?? (program.opts().store as string | undefined)
    const root = explicit
      ? Layout.resolveRoot(explicit)
      : o.global
        ? join(Layout.home(), o.name ?? basename(process.cwd()))
        : join(process.cwd(), '.hoppr')
    const r = await initStore(root, defaults())
    // Index it, so the daemon and `-H` can reach a store created anywhere.
    const { register } = await import('./store/manifest.ts')
    await register({
      name: o.name ?? (basename(root) === '.hoppr' ? basename(dirname(root)) : basename(root)),
      path: root,
      source: 'manual',
    })
    if (wantJson()) return printJson(r)
    console.log(
      r.created
        ? `${c.green('created')} store at ${c.bold(root)}`
        : `store already exists at ${c.bold(root)} ${c.dim('(refreshed skeleton)')}`,
    )
    if (r.gitInitialized) console.log(c.dim('  git repo initialized'))
    console.log(`
  ${c.dim('raw/')}      immutable captures      ${c.dim('never modified')}
  ${c.dim('curated/')}  wiki, tables, skills    ${c.dim('regenerable')}
  ${c.dim('.index/')}   search index            ${c.dim('disposable')}
`)

    console.log(`
Next: ${c.cyan('hoppr query "…"')}   ${c.dim('or')}   ${c.cyan('hoppr add "something worth remembering"')}`)
  })

// ── hoppers ───────────────────────────────────────────────────────
program
  .command('new')
  .description('create a hoppr pointed at a folder or at your agent logs')
  .argument('<name>')
  .option('--from <source>', 'dir:<path> | agents:<harness,...> | manual', 'manual')
  .option('--describe <text>', 'one line telling an agent when to use this hoppr')
  .option('--here', 'create the store in ./.hoppr instead of ~/.hoppr/<name>')
  .option('--curation <preset>', 'notes | papers | agents | index-only | minimal')
  .option('-y, --yes', 'index and curate immediately, without asking')
  .option('--copy', 'copy raw inputs into the store instead of referencing in place')
  .option('--exclude <glob...>', 'skip these paths (dir sources)')
  .action(async (name: string, o: Record<string, string | string[] | boolean>) => {
    const { createHopper } = await import('./store/registry.ts')
    const info = await createHopper({
      name,
      source: String(o.from ?? 'manual'),
      description: o.describe ? String(o.describe) : undefined,
      rawMode: o.copy ? 'copy' : undefined,
      exclude: o.exclude as string[] | undefined,
      root: o.here ? join(process.cwd(), '.hoppr') : undefined,
      curation: o.curation ? String(o.curation) : undefined,
    })
    // Build the skeleton with the hoppr's own config, so a reference-mode
    // hoppr never gets a raw/ directory it will not use.
    const h = await Hoppr.open({ root: info.root })
    await initStore(h.layout.root, h.config)

    if (wantJson()) return printJson(info)
    console.log(`${c.green('created')} ${c.bold(info.name)}  ${c.dim(info.root)}`)
    console.log(`  source   ${info.sourceLabel}`)
    console.log(
      `  profile  ${info.profile}${info.profile === 'agents' ? c.dim('  (mines skills)') : ''}`,
    )
    console.log(
      `  raw      ${info.rawMode}${
        info.rawMode === 'reference' ? c.dim('  (files stay where they are)') : ''
      }`,
    )
    // Offer the first pass here rather than making someone discover `sync` and
    // `curate` before the tool does anything at all. A store you cannot search
    // yet looks like a store that does not work.
    const { confirm } = await import('./onboard.ts')
    console.log()
    try {
      if (info.source !== 'manual' && (o.yes || (await confirm('  Index it now?')))) {
        const stats = await h.sync({})
        const n = stats.reduce((a, x) => a + x.captured + x.updated, 0)
        console.log(`${c.green('indexed')} ${n} item${n === 1 ? '' : 's'} — searchable now`)

        const llm = await h.llm('fast')
        if (!llm) {
          console.log(c.dim('  no model configured — keyword search works. `hoppr doctor`'))
        } else if (o.yes || (await confirm('  Curate them into pages? (costs model calls)'))) {
          const st = await h.curate({})
          console.log(`${c.green('curated')} ${st.logLine}`)
        }
        console.log(`\n  ${c.cyan(`hoppr -H ${name} query "…"`)}`)
      } else {
        console.log(
          `  ${c.cyan(`hoppr -H ${name} sync`)}   then   ${c.cyan(`hoppr -H ${name} curate`)}`,
        )
      }
    } finally {
      h.close()
    }
  })

program
  .command('hoppers')
  .description('list your hoppers')
  .action(async () => {
    const { listHoppers } = await import('./store/registry.ts')
    const rows = await listHoppers()
    if (wantJson()) return printJson(rows)
    if (rows.length === 0) {
      console.log(c.dim('no hoppers yet'))
      console.log(c.dim('  hoppr new work --from agents:claude-code,codex'))
      console.log(c.dim('  hoppr new papers --from dir:~/Downloads'))
      return
    }
    for (const r of rows) {
      console.log(`${c.bold(r.name.padEnd(16))} ${c.dim(r.profile.padEnd(8))} ${r.sourceLabel}`)
      if (r.description) console.log(`  ${c.dim(r.description)}`)
    }
  })

// ── add / ingest ──────────────────────────────────────────────────
const addCmd = (name: string) =>
  program
    .command(name)
    .description('throw something into the hopper (reads stdin when piped)')
    .argument('[text...]')
    .option('-t, --tag <tag...>', 'tags')
    .option('-p, --project <name>', 'project')
    .option('--title <title>', 'explicit title')
    .option('--file <path>', 'capture a file')
    .option('--url <url>', 'record a url')
    .action(async (text: string[] = [], o: Record<string, string | string[]>) => {
      const h = await ctx()
      h.requireStore()
      const piped = text.length === 0 && !o.file && !o.url ? await readStdin() : ''
      const rec = await h.add({
        text: text.join(' ') || piped,
        file: o.file as string | undefined,
        url: o.url as string | undefined,
        title: o.title as string | undefined,
        tags: o.tag as string[] | undefined,
        project: o.project as string | undefined,
      })
      if (wantJson()) return printJson(rec)
      console.log(
        `${c.green('+')} ${c.bold(rec.title ?? rec.id)}\n  ${c.dim(
          `${rec.id}  ${rec.kind}  ${human(rec.bytes)}  ${rec.path}`,
        )}`,
      )
    })
addCmd('add')
addCmd('ingest')

/** Which variable each provider authenticates with, for `doctor`. */
const ENV_KEYS: Record<string, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
}

/**
 * Only touch the OCR module if something already loaded it — importing it here
 * would spawn the very worker we are trying to avoid leaving behind.
 */
async function closeOcrIfLoaded(): Promise<void> {
  try {
    const m = await import('./intake/extract/ocr.ts')
    await m.closeOcr()
  } catch {
    /* never loaded, or already gone */
  }
}

interface RawListRow {
  id: string
  kind: string
  title: string | null
  captured: string
  partial: number
  external_path: string | null
}

// ── ls ────────────────────────────────────────────────────────────
program
  .command('ls')
  .alias('recent')
  .description('list captures, newest first')
  .option('-n, --limit <n>', 'how many', '20')
  .option('--kind <kind>', 'filter by kind')
  .action(async (o: { limit: string; kind?: string }) => {
    const h = await ctx()
    // Read the index, not the raw/ directory: a reference-mode hoppr has no
    // raw/ at all, so a filesystem listing showed an empty store for every
    // folder hoppr — the one command whose whole job is "what is in here".
    const db = await h.db()
    const limit = Number(o.limit)
    const rows = db
      .prepare<RawListRow>(
        `SELECT id, kind, title, captured, partial, external_path
           FROM raw ${o.kind ? 'WHERE kind = :kind' : ''}
          ORDER BY captured DESC LIMIT :limit`,
      )
      .all(o.kind ? { kind: o.kind, limit } : { limit })
    const total = (
      db
        .prepare<{ n: number }>(`SELECT count(*) n FROM raw ${o.kind ? 'WHERE kind = :kind' : ''}`)
        .get(o.kind ? { kind: o.kind } : {}) ?? { n: 0 }
    ).n
    const all = { length: total }
    if (wantJson()) return printJson(rows, { total, shown: rows.length })
    if (rows.length === 0) {
      console.log(c.dim('nothing in the hopper yet'))
      return
    }
    for (const r of rows) {
      console.log(
        `${c.dim(r.id.slice(0, 12))}  ${c.dim(r.kind.padEnd(7))} ${(r.title ?? '(untitled)').slice(
          0,
          64,
        )}  ${c.dim(relTime(r.captured))}${r.partial ? c.yellow(' [live]') : ''}`,
      )
    }
    if (all.length > rows.length) console.log(c.dim(`… ${all.length - rows.length} more`))
  })

// ── get / source ──────────────────────────────────────────────────
program
  .command('get')
  .description('show a capture (id or id prefix)')
  .argument('<id>')
  .option('--meta', 'metadata only')
  .action(async (id: string, o: { meta?: boolean }) => {
    const h = await ctx()
    // Through the facade: a reference-mode capture has no file in the store,
    // and its bytes live at the original path.
    const rec = await h.resolveRaw(id)
    if (!rec) throw HopprError.notFound(`no capture matching '${id}'`)
    if (wantJson()) {
      const body = o.meta ? undefined : await h.readRawText(rec).catch(() => undefined)
      return printJson({ ...rec, body })
    }
    console.log(c.bold(rec.title ?? rec.id))
    console.log(
      c.dim(
        `${rec.id}  ${rec.kind}  ${rec.source}  ${human(rec.bytes)}  captured ${relTime(
          rec.captured,
        )}\n${rec.path}`,
      ),
    )
    if (!o.meta) {
      console.log()
      console.log(await h.readRawText(rec).catch(() => c.dim('(binary)')))
    }
  })

program
  .command('source')
  .description('print the original bytes of a capture')
  .argument('<id>')
  .action(async (id: string) => {
    const h = await ctx()
    const rec = await h.resolveRaw(id)
    if (!rec) throw HopprError.notFound(`no capture matching '${id}'`)
    process.stdout.write(await h.readRawText(rec))
  })

// ── search / query ────────────────────────────────────────────────
for (const name of ['search', 'query']) {
  program
    .command(name)
    .description('hybrid search across raw captures, wiki pages, tables and skills')
    .argument('<query...>')
    .option('-n, --limit <n>', 'how many hits')
    .option('--scope <scope>', 'curated | raw | all')
    .option('--mode <mode>', 'hybrid | fts | vec', 'hybrid')
    .option('--tag <tag...>', 'require these tags')
    .option('--project <name>')
    .option('--kind <kind>', 'source|concept|entity|comparison|digest|session|text|url|file')
    .option('--since <when>', '7d | 2026-07-01 | yesterday')
    .option('--explain', 'show per-arm ranks and boosts')
    .action(async (words: string[], o: Record<string, string | string[] | boolean>) => {
      const h = await ctx()
      // Flags are sugar for the inline DSL, so both forms take exactly one path.
      const extra: string[] = []
      for (const t of (o.tag as string[]) ?? []) extra.push(`tag:${t}`)
      if (o.project) extra.push(`project:${o.project as string}`)
      if (o.kind) extra.push(`kind:${o.kind as string}`)
      if (o.since) extra.push(`since:${o.since as string}`)

      const text = [...words, ...extra].join(' ')
      const opts = {
        limit: o.limit ? Number(o.limit) : undefined,
        scope: o.scope as 'curated' | 'raw' | 'all' | undefined,
        mode: o.mode as 'hybrid' | 'fts' | 'vec' | undefined,
      }
      let res = await h.search(text, opts)

      // Searching the default curated scope before anything has been curated
      // finds nothing, which reads as "hoppr lost my note" rather than "that
      // note has not been curated yet". Widen once and say so.
      let widened = false
      if (res.hits.length === 0 && !o.scope) {
        const all = await h.search(text, { ...opts, scope: 'all' })
        if (all.hits.length > 0) {
          res = all
          widened = true
        }
      }
      if (wantJson()) {
        return printJson(res.hits, { ...res.meta, filters: res.query.filters, widened })
      }
      if (widened) console.log(c.dim('nothing curated yet — showing raw captures'))

      if (res.hits.length === 0) {
        console.log(c.dim(`no hits${res.query.text ? ` for "${res.query.text}"` : ''}`))
        if (!h.vectorAvailable) {
          console.log(c.dim('note: vector search unavailable — keyword only'))
        }
        return
      }
      for (const hit of res.hits) {
        const badge = hit.tier === 'curated' ? c.cyan(hit.kind) : c.dim(hit.kind)
        console.log(`${c.bold(hit.title || '(untitled)')}  ${badge}`)
        console.log(
          `  ${c.dim(hit.id)}${hit.tags.length ? c.dim(`  #${hit.tags.join(' #')}`) : ''}${
            hit.matchedInSource ? c.dim('  [matched in source]') : ''
          }`,
        )
        if (hit.snippet) console.log(`  ${hit.snippet}`)
        if (o.explain) {
          console.log(
            c.dim(
              `  ranks=${JSON.stringify(hit.why.ranks)} base=${hit.why.base.toFixed(
                5,
              )} boosted=${hit.why.boosted.toFixed(5)}`,
            ),
          )
        }
        console.log()
      }
      console.log(
        c.dim(
          `${res.hits.length} of ${res.meta.candidates} candidates  ${res.meta.tookMs}ms  arms=[${res.meta.arms.join(
            ',',
          )}]`,
        ),
      )
    })
}

// ── reindex ───────────────────────────────────────────────────────
program
  .command('reindex')
  .description('rebuild the search index from raw/ and curated/')
  .option('--full', 'discard and rebuild the index (embeddings are carried across)')
  .option('--forget-embeddings', 'also discard cached vectors — they will be recomputed')
  .action(async (o: { full?: boolean; forgetEmbeddings?: boolean }) => {
    const h = await ctx()
    h.requireStore()
    const t0 = Date.now()
    const st = o.full
      ? await h.rebuildIndex({ forgetEmbeddings: o.forgetEmbeddings })
      : await h.reindex()
    if (wantJson()) return printJson(st, { tookMs: Date.now() - t0, driver: h.driver })
    console.log(
      `raw    ${st.raw.scanned} scanned  ${c.green(`${st.raw.inserted} new`)}  ${
        st.raw.updated
      } updated  ${c.dim(`${st.raw.unchanged} unchanged`)}`,
    )
    console.log(
      `wiki   ${st.wiki.scanned} scanned  ${c.green(`${st.wiki.inserted} new`)}  ${
        st.wiki.updated
      } updated  ${c.dim(`${st.wiki.unchanged} unchanged`)}`,
    )
    if (st.pruned) console.log(`pruned ${st.pruned} stale rows`)
    console.log(
      c.dim(`${Date.now() - t0}ms  driver=${h.driver}  vectors from cache: ${st.embedCacheHits}`),
    )
  })

// ── setup / embed ─────────────────────────────────────────────────
program
  .command('setup')
  .description('find your agent logs, offer a hoppr for each, and fetch the embedding model')
  .option('-y, --yes', 'assume yes — for scripts and CI')
  .option('--skip-agents', 'do not offer hoppers for detected agent logs')
  .action(async (o: { yes?: boolean; skipAgents?: boolean }) => {
    const { findHarnesses, describeFindings, confirm } = await import('./onboard.ts')

    if (!o.skipAgents) {
      const found = await findHarnesses()
      if (found.length === 0) {
        console.log(c.dim('no agent logs found (Claude Code, Codex, opencode, openclaw)'))
      } else {
        console.log(c.bold('Agent history found on this machine:'))
        for (const line of describeFindings(found)) console.log(`  ${line}`)
        console.log()
        // Say the cost before asking, not after. The default sync window is
        // 30 days precisely because these numbers are large.
        console.log(c.dim('  A hoppr indexes these locally. Curating them into pages costs model'))
        console.log(c.dim('  calls — the first sync covers 30 days; --full backfills the rest.'))
        console.log()

        const { listHoppers } = await import('./store/registry.ts')
        const existing = new Set((await listHoppers()).map((x) => x.source))
        for (const f of found) {
          const source = `agents:${f.id}`
          if (existing.has(source)) {
            console.log(`${c.dim('exists')}  ${f.id}`)
            continue
          }
          const ok = await confirm(`  Create a hoppr for ${c.bold(f.id)}?`, { yes: o.yes })
          if (!ok) continue
          const { createHopper } = await import('./store/registry.ts')
          const info = await createHopper({ name: f.id, source }).catch((e: Error) => {
            console.log(c.yellow(`  skipped ${f.id}: ${e.message}`))
            return undefined
          })
          if (!info) continue
          const hh = await Hoppr.open({ root: info.root })
          await initStore(info.root, hh.config)
          hh.close()
          console.log(`${c.green('created')} ${f.id}  ${c.dim(info.root)}`)
        }
        console.log()
      }
    }

    // The embedding model: ~200MB, and it must never download silently.
    const h = await ctx().catch(() => undefined)
    if (!h?.exists) {
      console.log(c.dim('no hoppr selected — skipping the embedding model'))
      console.log(c.dim('  hoppr init          create one here'))
      console.log(c.dim('  hoppr -H <name> setup   fetch the model for a named hoppr'))
      return
    }
    const e = await h.embedder()
    if (!e) {
      console.log(c.yellow('no embedding provider configured'))
      console.log(c.dim('  keyword search works; set [embed] provider to enable semantic search'))
      return
    }
    // A ~200MB model download should never surprise someone mid-`hoppr add`.
    console.log(`fetching ${c.bold(e.model)} (${e.dim} dims)…`)
    await e.warmup?.((msg) => process.stdout.write(`\r  ${c.dim(msg.padEnd(60))}`))
    process.stdout.write('\n')
    const t0 = Date.now()
    await e.embed(['warmup'])
    console.log(`${c.green('ready')}  first embedding in ${Date.now() - t0}ms`)

    const { mcpStatus } = await import('./mcp/status.ts')
    if ((await mcpStatus()).every((x) => !x.present)) {
      console.log()
      console.log(c.dim('Next: `hoppr mcp install` so your agents can reach this.'))
    }
  })

program
  .command('embed')
  .description('fill in missing embeddings (resumable, terminal-per-row on failure)')
  .option('-n, --limit <n>', 'stop after this many documents')
  .option('--batch <n>', 'documents per claim', '32')
  .action(async (o: { limit?: string; batch: string }) => {
    const h = await ctx()
    let last = 0
    const st = await h.embed({
      batch: Number(o.batch),
      limit: o.limit ? Number(o.limit) : undefined,
      onProgress: (s) => {
        const n = s.embedded + s.cached + s.failed
        if (n !== last && process.stdout.isTTY) {
          last = n
          process.stdout.write(`\r  ${c.dim(`${n} done  ${s.cached} from cache`)}   `)
        }
      },
    })
    if (process.stdout.isTTY) process.stdout.write('\r')
    if (wantJson()) return printJson(st)
    console.log(
      `${c.green(`${st.embedded} embedded`)}  ${c.dim(`${st.cached} from cache`)}${
        st.failed ? `  ${c.red(`${st.failed} failed`)}` : ''
      }  ${st.remaining} remaining`,
    )
  })

program
  .command('retry')
  .description('re-arm rows that hit the terminal failure cap')
  .option('--failed', 'reset failure counters', true)
  .action(async () => {
    const h = await ctx()
    const { resetFailures } = await import('./embed/reconcile.ts')
    const db = await h.db()
    const n = resetFailures(db)
    const r = db
      .prepare('UPDATE raw SET curate_fails = 0, curate_stale = 1 WHERE curate_fails >= 3')
      .run()
    if (wantJson()) return printJson({ embed: n, curate: r.changes })
    console.log(`re-armed ${n} embedding rows and ${r.changes} curate rows`)
  })

// ── stats ─────────────────────────────────────────────────────────
program
  .command('stats')
  .description('what is in the store')
  .action(async () => {
    const h = await ctx()
    h.requireStore()
    const s = await h.stats()
    if (wantJson()) return printJson(s, { driver: h.driver, vector: h.vectorAvailable })
    for (const [k, v] of Object.entries(s)) {
      console.log(`${k.padEnd(12)} ${String(v).padStart(6)}`)
    }
    console.log(c.dim(`\ndriver=${h.driver}  vectors=${h.vectorAvailable ? 'on' : 'off'}`))
  })

// ── curate ────────────────────────────────────────────────────────
program
  .command('curate')
  .description('run the curating agent over uncurated captures')
  .option('--fast', 'per-capture source pages (default)')
  .option('--rebuild', 'discard curated pages and regenerate them from raw')
  .option('-n, --limit <n>', 'stop after this many captures')
  .option('--dry-run', 'show what would happen without writing or committing')
  .action(async (o: { limit?: string; dryRun?: boolean; rebuild?: boolean }) => {
    const h = await ctx()
    const st = await h.curate({
      limit: o.limit ? Number(o.limit) : undefined,
      dryRun: o.dryRun,
      rebuild: o.rebuild,
      onProgress: (m) => {
        if (!wantJson() && process.stdout.isTTY) process.stdout.write(`\r  ${c.dim(m.padEnd(70))}`)
      },
    })
    if (process.stdout.isTTY && !wantJson()) process.stdout.write('\r')

    let sha: string | null = null
    if (!o.dryRun && h.config.git.mode === 'auto' && st.written > 0) {
      // Two single-purpose commits. Captures land first on their own, so the
      // curate commit contains ONLY curated/ — which is what makes
      // `git diff HEAD~1 curated/` a clean review of what the agent decided.
      await gitmod
        .commit(h.layout.root, `captured ${st.claimed} item${st.claimed === 1 ? '' : 's'}`, ['raw'])
        .catch(() => null)
      sha = await gitmod
        .commit(h.layout.root, st.logLine, ['curated', 'CLAUDE.md', 'hoppr.toml'])
        .catch(() => null)
    }
    if (wantJson()) return printJson({ ...st, commit: sha })

    if (st.claimed === 0) {
      console.log(c.dim('nothing to curate'))
      return
    }
    console.log(
      `${c.green(`${st.written} written`)}  ${c.dim(`${st.unchanged} unchanged`)}${
        st.skippedPinned ? `  ${c.dim(`${st.skippedPinned} pinned`)}` : ''
      }${st.failed ? `  ${c.red(`${st.failed} failed`)}` : ''}  ${c.dim(`(${st.batches} batches)`)}`,
    )
    if (st.coined.length) {
      console.log(c.dim(`  new tags: ${[...new Set(st.coined)].join(', ')}`))
    }
    console.log(c.dim(`  tag reuse: ${(st.reuseRate * 100).toFixed(0)}%   pass ${st.passId}`))
    if (sha) console.log(c.dim(`  committed ${sha.slice(0, 8)}`))
    if (o.dryRun) console.log(c.yellow('  dry run — nothing written'))
  })

// ── prompts ───────────────────────────────────────────────────────
const promptsCmd = program.command('prompts').description('the prompts that drive curation')
promptsCmd.command('list', { isDefault: true }).action(async () => {
  const h = await ctx()
  const { listPromptIds, loadPrompt } = await import('./store/prompts.ts')
  const rows = []
  for (const id of await listPromptIds(h.layout)) {
    const p = await loadPrompt(h.layout, id)
    rows.push({ id, tier: p.tier, source: p.source, hash: p.hash.slice(7, 15) })
  }
  if (wantJson()) return printJson(rows)
  for (const r of rows) {
    console.log(
      `${c.bold(r.id.padEnd(14))} ${r.tier.padEnd(8)} ${
        r.source === 'store' ? c.green('edited') : c.dim('default')
      }  ${c.dim(r.hash)}`,
    )
  }
  console.log(
    c.dim(`\nedit: ${h.layout.prompts}/<id>.md — changing one re-curates what it produced`),
  )
})
promptsCmd.command('show <id>').action(async (id: string) => {
  const h = await ctx()
  const { loadPrompt } = await import('./store/prompts.ts')
  const p = await loadPrompt(h.layout, id)
  if (wantJson()) return printJson(p)
  console.log(p.template)
})
promptsCmd
  .command('reset <id>')
  .description('restore the packaged default')
  .action(async (id: string) => {
    const h = await ctx()
    const { readAsset } = await import('./core/assets.ts')
    const r = await writeIfChanged(h.layout.promptFile(id), await readAsset('prompts', `${id}.md`))
    console.log(`${r}  ${h.layout.promptFile(id)}`)
  })

// ── journal / undo / log ──────────────────────────────────────────
program
  .command('journal')
  .description('recent curate passes')
  .action(async () => {
    const h = await ctx()
    const { listPasses } = await import('./organize/journal.ts')
    const passes = listPasses(await h.db())
    if (wantJson()) return printJson(passes)
    if (passes.length === 0) return console.log(c.dim('no passes recorded'))
    for (const p of passes) {
      console.log(
        `${c.dim(p.passId.slice(0, 12))}  ${relTime(new Date(p.ts).toISOString())}  ${
          p.entries
        } changes  ${c.dim(
          Object.entries(p.kinds)
            .map(([k, n]) => `${k}:${n}`)
            .join(' '),
        )}`,
      )
    }
  })

program
  .command('undo <passId>')
  .description('reverse a curate pass (curated/ only — raw/ is never touched)')
  .action(async (passId: string) => {
    const h = await ctx()
    const { listPasses, undoPass } = await import('./organize/journal.ts')
    const db = await h.db()
    const match = listPasses(db, 200).find((p) => p.passId.startsWith(passId))
    if (!match) throw HopprError.notFound(`no pass matching '${passId}'`)
    const r = await undoPass(db, h.layout, match.passId)
    await h.reindex()
    await h.rebuildIndexPage()
    if (wantJson()) return printJson(r)
    console.log(
      `restored ${r.restored}, removed ${r.deleted}${r.missing ? `, ${r.missing} missing` : ''}`,
    )
  })

program
  .command('log')
  .description("the curator's diary (curated/wiki/log.md)")
  .option('-n, --lines <n>', 'how many entries', '20')
  .action(async (o: { lines: string }) => {
    const h = await ctx()
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(h.layout.wikiLog, 'utf8').catch(() => '')
    const lines = text.split('\n').filter((x) => x.startsWith('- '))
    console.log(lines.slice(-Number(o.lines)).join('\n') || c.dim('(empty)'))
  })

program
  .command('related')
  .description('pages near this one')
  .argument('<id>')
  .option('-n, --limit <n>', '', '5')
  .action(async (id: string, o: { limit: string }) => {
    const h = await ctx()
    const hits = await h.related(id, Number(o.limit))
    if (wantJson()) return printJson(hits)
    if (hits.length === 0) return console.log(c.dim('nothing related'))
    for (const x of hits) {
      console.log(`${c.bold(x.title)}  ${c.dim(x.kind)}\n  ${c.dim(x.id)}`)
    }
  })

program
  .command('index')
  .description('the wiki catalog')
  .option('--rebuild', 'regenerate it')
  .action(async (o: { rebuild?: boolean }) => {
    const h = await ctx()
    if (o.rebuild) await h.rebuildIndexPage()
    const { readFile } = await import('node:fs/promises')
    console.log(await readFile(h.layout.wikiIndex, 'utf8').catch(() => ''))
  })

// ── mcp ───────────────────────────────────────────────────────────
program
  .command('curation')
  .description('what each curation preset builds')
  .action(async () => {
    const { PRESETS } = await import('./core/profiles.ts')
    if (wantJson()) return printJson(PRESETS)
    for (const [name, p] of Object.entries(PRESETS)) {
      console.log(`${c.bold(name.padEnd(12))} ${p.describe}`)
      console.log(
        c.dim(
          `  pages: ${p.pageTypes.length ? p.pageTypes.join(', ') : 'none'}` +
            `   skills: ${p.skills ? 'yes' : 'no'}   embeddings: ${p.embeddings ? 'yes' : 'no'}`,
        ),
      )
    }
    console.log()
    console.log(c.dim('  hoppr new <name> --from <src> --curation papers'))
    console.log(c.dim('  every switch stays overridable in hoppr.toml'))
  })

// ── graph ─────────────────────────────────────────────────────────
const graphCmd = program
  .command('graph')
  .description('typed entities and relations (enable with [retrieval] graph = true)')

graphCmd
  .command('list', { isDefault: true })
  .description('entities, most-mentioned first')
  .option('--type <type>')
  .option('-q, --query <text>', 'substring match on the name')
  .option('-n, --limit <n>', '', '40')
  .action(async (o: Record<string, string>) => {
    const h = await ctx()
    h.requireStore()
    const { findNodes } = await import('./organize/graph.ts')
    const rows = findNodes(await h.db(), o.query, o.type, Number(o.limit ?? 40))
    if (wantJson()) return printJson(rows)
    if (!rows.length) {
      console.log(c.dim('no entities yet'))
      console.log(c.dim('  set [retrieval] graph = true, then `hoppr deep`'))
      return
    }
    for (const r of rows) {
      console.log(
        `${c.dim(r.type.padEnd(10))} ${c.bold(r.name.padEnd(30))} ${c.dim(`${r.mentions}×`)}`,
      )
      if (r.summary) console.log(`  ${c.dim(r.summary.slice(0, 100))}`)
    }
  })

graphCmd
  .command('show <name>')
  .description('one entity and everything one step from it')
  .option('--type <type>')
  .action(async (name: string, o: { type?: string }) => {
    const h = await ctx()
    h.requireStore()
    const db = await h.db()
    const { findNodes, neighbours } = await import('./organize/graph.ts')
    const hit = findNodes(db, name, o.type, 1)[0]
    if (!hit) throw HopprError.notFound(`no entity matching '${name}'`)
    const near = neighbours(db, hit.id)
    if (wantJson()) return printJson({ node: hit, neighbours: near })
    console.log(`${c.bold(hit.name)}  ${c.dim(`${hit.type} · ${hit.mentions} mentions`)}`)
    if (hit.summary) console.log(c.dim(`  ${hit.summary}`))
    if (!near.length) return console.log(c.dim('  no relations'))
    console.log()
    for (const n of near) {
      const arrow = n.direction === 'out' ? '→' : '←'
      console.log(`  ${arrow} ${c.cyan(n.predicate.padEnd(16))} ${n.name}`)
      // Every edge quotes the line it was read from: that is what makes the
      // graph auditable rather than a pile of assertions.
      if (n.evidence) console.log(`      ${c.dim(`"${n.evidence.slice(0, 90)}"`)}`)
    }
  })

graphCmd
  .command('build')
  .description('extract now, without a full deep pass')
  .option('-n, --limit <n>', '', '50')
  .action(async (o: { limit?: string }) => {
    const h = await ctx()
    h.requireStore()
    if (!h.config.retrieval.graph) {
      throw HopprError.user('the graph is off — set [retrieval] graph = true')
    }
    const llm = await h.llm('fast')
    if (!llm) throw HopprError.user('graph extraction needs a model provider')
    const { buildGraph } = await import('./organize/graph.ts')
    const st = await buildGraph(await h.db(), h.layout, h.config, llm, {
      limit: Number(o.limit ?? 50),
      onProgress: (m) => process.stderr.write(`\r  ${c.dim(m.slice(0, 70).padEnd(72))}`),
    })
    process.stderr.write('\r')
    if (wantJson()) return printJson(st)
    console.log(
      `${c.green('built')} ${st.nodes} entities, ${st.edges} relations from ${st.scanned} captures` +
        (st.dropped ? c.dim(`  (${st.dropped} off-schema dropped)`) : ''),
    )
  })

const mcpCmd = program.command('mcp').description('serve the hopper to other agents')

mcpCmd
  .command('status')
  .description('which clients are wired up, and whether the server actually answers')
  .option('--probe', 'start the server and complete a real MCP handshake')
  .action(async (o: { probe?: boolean }) => {
    const { mcpStatus, mcpHandshake } = await import('./mcp/status.ts')
    const entries = await mcpStatus()
    // Probe the SAME hoppr this invocation selected. Without the selection the
    // server opens a store that may not exist and exits before answering,
    // which reads as "MCP is broken" when only the probe was wrong.
    const g = program.opts<{ store?: string; hopper?: string }>()
    const probe = o.probe
      ? await mcpHandshake([
          process.execPath,
          process.argv[1] ?? '',
          ...(g.store ? ['--store', g.store] : []),
          ...(g.hopper ? ['--hopper', g.hopper] : []),
          'mcp',
          'serve',
        ])
      : undefined

    if (wantJson()) return printJson({ clients: entries, probe })

    const wired = entries.filter((e) => e.present)
    if (wired.length === 0) {
      console.log(c.dim('no MCP client is wired up'))
      console.log(c.dim('  hoppr mcp install            every hoppr, selected per call'))
      console.log(c.dim('  hoppr -H <name> mcp install --pinned   just one'))
    }
    for (const e of wired) {
      console.log(
        `${c.green('registered')}  ${e.target}${e.pinnedTo ? c.dim(` → ${e.pinnedTo}`) : ''}`,
      )
      console.log(c.dim(`  ${e.command}`))
      if (!e.managedByHoppr) console.log(c.yellow('  hand-written — hoppr will not modify it'))
    }
    for (const e of entries.filter((x) => !x.present)) {
      console.log(`${c.dim('absent'.padEnd(10))}  ${c.dim(e.target)}`)
    }
    if (probe) {
      console.log()
      console.log(
        probe.ok
          ? `${c.green('handshake ok')}  ${probe.tools.length} tools: ${probe.tools.slice(0, 4).join(', ')}…`
          : `${c.red('handshake failed')}  ${probe.error ?? 'no reason given'}`,
      )
      if (!probe.ok) process.exitCode = 1
    }
  })
mcpCmd
  .command('serve')
  .description('run the MCP server on stdio')
  .option('--pinned', 'expose only this hoppr, hiding the selector entirely')
  .action(async (o: { pinned?: boolean }) => {
    const h = await ctx()
    h.requireStore()
    const { serveStdio } = await import('./mcp/server.ts')
    await serveStdio(h, { pinned: o.pinned })
  })
mcpCmd
  .command('install')
  .description('register hoppr with an MCP client (never clobbers an entry it did not create)')
  .option('--scope <scope>', 'project | user', 'project')
  .option('--target <file...>', 'explicit config files')
  .option('--pinned', 'register only the selected hoppr, not the whole registry')
  .option('--dry-run')
  .option('--force', 'replace a conflicting entry')
  .action(
    async (o: {
      scope: string
      target?: string[]
      pinned?: boolean
      dryRun?: boolean
      force?: boolean
    }) => {
      const h = await ctx()
      const { defaultTargets, installMcp } = await import('./mcp/install.ts')
      const targets = o.target ?? defaultTargets(o.scope === 'user' ? 'user' : 'project')
      const results = []
      for (const t of targets) {
        results.push(
          await installMcp(t, {
            storeRoot: h.layout.root,
            // Pinning at install time is the strong isolation boundary: a repo's
            // .mcp.json then exposes exactly one hoppr and cannot reach the others.
            hopper: o.pinned ? h.name : undefined,
            dryRun: o.dryRun,
            force: o.force,
          }),
        )
      }
      if (wantJson()) return printJson(results)
      for (const r of results) {
        const tag =
          r.outcome === 'installed'
            ? c.green('installed')
            : r.outcome === 'skipped'
              ? c.dim('skipped  ')
              : r.outcome === 'conflict'
                ? c.yellow('conflict ')
                : c.red('failed   ')
        console.log(`${tag} ${r.target}${r.detail ? `\n           ${c.dim(r.detail)}` : ''}`)
      }
      if (results.some((r) => r.outcome === 'conflict')) process.exitCode = 1
    },
  )
mcpCmd
  .command('uninstall')
  .option('--scope <scope>', 'project | user', 'project')
  .option('--target <file...>')
  .action(async (o: { scope: string; target?: string[] }) => {
    const { defaultTargets, uninstallMcp } = await import('./mcp/install.ts')
    const targets = o.target ?? defaultTargets(o.scope === 'user' ? 'user' : 'project')
    for (const t of targets) {
      const r = await uninstallMcp(t)
      console.log(`${r.outcome.padEnd(10)} ${r.target}${r.detail ? c.dim(`  ${r.detail}`) : ''}`)
    }
  })

// ── vfs ───────────────────────────────────────────────────────────
program
  .command('vfs')
  .description('read-only shell over the store (same one agents get over MCP)')
  .argument('<script...>')
  .action(async (words: string[]) => {
    const h = await ctx()
    const { runVfs } = await import('./mcp/vfs.ts')
    const r = await runVfs(h.layout, words.join(' '))
    process.stdout.write(r.stdout)
    process.exitCode = r.exitCode
  })

// ── connectors / sync ─────────────────────────────────────────────
program
  .command('sync')
  .description('pull sessions from Claude Code, Codex, opencode and openclaw')
  .option('--full', 'backfill all history (can be large — see the estimate first)')
  .option('--since <when>', 'window to pull, default 30d')
  .option('--dry-run')
  .action(async (o: { full?: boolean; since?: string; dryRun?: boolean }) => {
    const h = await ctx()
    h.requireStore()
    const { parseWhen } = await import('./search/query.ts')
    const stats = await h.sync({
      full: o.full,
      since: o.since ? parseWhen(o.since) : undefined,
      dryRun: o.dryRun,
      onProgress: (m) => {
        if (!wantJson() && process.stdout.isTTY)
          process.stdout.write(`\r  ${c.dim(m.slice(0, 76).padEnd(78))}`)
      },
    })
    if (process.stdout.isTTY && !wantJson()) process.stdout.write('\r')
    if (wantJson()) return printJson(stats)

    let outside = 0
    for (const s of stats) {
      if (!s.detected) {
        console.log(`${c.dim(s.connector.padEnd(13))} ${c.dim('not installed')}`)
        continue
      }
      outside += s.outsideWindow
      console.log(
        `${c.bold(s.connector.padEnd(13))} ${c.green(`${s.captured} new`)}  ${s.updated} updated  ` +
          `${c.dim(`${s.scanned}/${s.sources} sources`)}` +
          `${s.redacted ? `  ${c.yellow(`${s.redacted} redacted`)}` : ''}` +
          `${s.errors ? `  ${c.red(`${s.errors} errors`)}` : ''}`,
      )
    }
    if (outside && !o.full) {
      // Never let a bounded first sync look like a complete one.
      console.log(
        c.yellow(`\n${outside} older sessions were outside the window.`) +
          c.dim(
            `\n  \`hoppr sync --full\` backfills them (they will each cost an LLM call to curate).`,
          ),
      )
    }
  })

const connCmd = program.command('connectors').description('harness connectors')
connCmd.command('list', { isDefault: true }).action(async () => {
  const h = await ctx()
  const { CONNECTORS } = await import('./connectors/registry.ts')
  const db = await h.db().catch(() => undefined)
  const rows = []
  for (const cn of CONNECTORS) {
    const conf = (h.config.connectors[cn.id] ??
      h.config.connectors[cn.id.replace(/-/g, '_')] ??
      {}) as Record<string, unknown>
    const detected = await cn.detect(conf).catch(() => false)
    const sources = detected ? (await cn.discover(conf).catch(() => [])).length : 0
    const captured = db
      ? (db
          .prepare<{ n: number }>('SELECT COUNT(*) n FROM raw WHERE source = :s')
          .get({ s: `connector:${cn.id}` })?.n ?? 0)
      : 0
    rows.push({
      id: cn.id,
      label: cn.label,
      enabled: conf.enabled !== false,
      detected,
      sources,
      captured,
    })
  }
  if (wantJson()) return printJson(rows)
  for (const r of rows) {
    const status = !r.detected
      ? c.dim('not installed')
      : !r.enabled
        ? c.yellow('disabled')
        : c.green('ready')
    console.log(
      `${c.bold(r.id.padEnd(13))} ${status.padEnd(22)} ${c.dim(`${r.sources} sources, ${r.captured} captured`)}`,
    )
  }
})

// ── tables / sql ──────────────────────────────────────────────────
const tablesCmd = program.command('tables').description('structured extraction from captures')
tablesCmd.command('list', { isDefault: true }).action(async () => {
  const h = await ctx()
  const { listTables } = await import('./tables/def.ts')
  const defs = await listTables(h.layout)
  const db = await h.db()
  const rows = defs.map((t) => ({
    name: t.def.name,
    columns: Object.keys(t.def.columns).length,
    match: t.def.match,
    rows:
      db
        .prepare<{ n: number }>('SELECT COUNT(*) n FROM tbl_rows WHERE table_name = :t')
        .get({ t: t.def.name })?.n ?? 0,
  }))
  if (wantJson()) return printJson(rows)
  if (rows.length === 0) {
    console.log(c.dim('no tables defined — `hoppr tables new <name>` to create one'))
    return
  }
  for (const r of rows) {
    console.log(
      `${c.bold(r.name.padEnd(16))} ${String(r.rows).padStart(5)} rows  ${r.columns} cols  ${c.dim(r.match)}`,
    )
  }
})
tablesCmd
  .command('new <name>')
  .description('create a table definition (a starter you then edit)')
  .option('--match <filter>', 'which captures feed it — scope:raw reads the original', 'scope:raw')
  .action(async (name: string, o: { match: string }) => {
    const h = await ctx()
    const { saveTable } = await import('./tables/def.ts')
    const path = await saveTable(h.layout, {
      name,
      description: `Rows extracted for ${name}.`,
      match: o.match,
      grain: 'one-per-source',
      columns: {
        date: { type: 'date', required: false, converging: false },
        summary: { type: 'string', required: true, converging: false },
        topics: { type: 'list[string]', required: false, converging: false },
      },
    })
    console.log(
      `${c.green('created')} ${path}\n${c.dim(`  edit the columns, then: hoppr tables rebuild ${name}`)}`,
    )
  })
tablesCmd
  .command('rebuild [name]')
  .description('re-extract rows')
  .option('-n, --limit <n>')
  .action(async (name: string | undefined, o: { limit?: string }) => {
    const h = await ctx()
    // Hand edits in <table>.jsonl are the truth; adopt them before extracting.
    const { adoptRowEdits } = await import('./tables/extract.ts')
    const { listTables } = await import('./tables/def.ts')
    for (const t of await listTables(h.layout)) {
      await adoptRowEdits(await h.db(), h.layout, t.def.name).catch(() => 0)
    }
    const stats = await h.extractTables({
      name,
      rebuild: true,
      limit: o.limit ? Number(o.limit) : undefined,
      onProgress: (m) => {
        if (!wantJson() && process.stdout.isTTY) process.stdout.write(`\r  ${c.dim(m.padEnd(60))}`)
      },
    })
    if (process.stdout.isTTY && !wantJson()) process.stdout.write('\r')
    if (wantJson()) return printJson(stats)
    for (const s of stats) {
      console.log(
        `${c.bold(s.table.padEnd(16))} ${c.green(`${s.extracted} rows`)}  ${c.dim(`${s.unchanged} unchanged`)}${
          s.failed ? `  ${c.red(`${s.failed} failed`)}` : ''
        }`,
      )
      for (const [col, vals] of Object.entries(s.newEnumValues)) {
        console.log(c.dim(`  ${col}: new values ${vals.join(', ')}`))
      }
    }
  })
tablesCmd.command('drop <name>').action(async (name: string) => {
  const h = await ctx()
  const db = await h.db()
  const { dropView } = await import('./tables/sql.ts')
  const n = db.prepare('DELETE FROM tbl_rows WHERE table_name = :t').run({ t: name }).changes
  db.prepare('DELETE FROM tbl_defs WHERE name = :t').run({ t: name })
  dropView(db, name)
  console.log(`dropped ${n} rows (the definition file is left for you to delete)`)
})

program
  .command('table')
  .description('show a table')
  .argument('<name>')
  .option('--trace', 'show the capture each row came from')
  .option('--csv')
  .action(async (name: string, o: { trace?: boolean; csv?: boolean }) => {
    const h = await ctx()
    const res = await h.sql(`SELECT * FROM v_${name}`)
    if (wantJson()) return printJson(res.rows, { columns: res.columns })
    if (res.rows.length === 0) return console.log(c.dim('no rows'))
    const cols = res.columns.filter(
      (x) => o.trace || (x !== 'raw_id' && x !== 'page_id' && x !== 'row_id'),
    )
    if (o.csv) {
      console.log(cols.join(','))
      for (const r of res.rows) console.log(cols.map((k) => csvCell(r[k])).join(','))
      return
    }
    console.log(c.dim(cols.join('  |  ')))
    for (const r of res.rows) console.log(cols.map((k) => String(r[k] ?? '')).join('  |  '))
  })

program
  .command('sql')
  .description('read-only SQL over the generated table views')
  .argument('<query...>')
  .option('-n, --max-rows <n>', 'row cap', '1000')
  .action(async (words: string[], o: { maxRows: string }) => {
    const h = await ctx()
    const res = await h.sql(words.join(' '), Number(o.maxRows))
    if (wantJson()) return printJson(res.rows, { columns: res.columns, truncated: res.truncated })
    if (res.rows.length === 0) return console.log(c.dim('(no rows)'))
    console.log(c.dim(res.columns.join('  |  ')))
    for (const r of res.rows) console.log(res.columns.map((k) => String(r[k] ?? '')).join('  |  '))
    if (res.truncated) console.log(c.yellow(`… truncated at ${o.maxRows} rows`))
  })

/**
 * Serve every hoppr from one process, resolving each lazily. The dashboard and
 * the API then switch between them the same way the MCP tools do.
 */
async function allHoppers(fallback: Hoppr) {
  const { listHoppers } = await import('./store/registry.ts')
  const names = (await listHoppers()).map((x) => x.name)
  const cache = new Map<string, Hoppr>([[fallback.name, fallback]])
  const ordered = names.includes(fallback.name)
    ? [fallback.name, ...names.filter((n) => n !== fallback.name)]
    : [fallback.name, ...names]
  return {
    list: () => ordered,
    resolve: async (name: string) => {
      if (!name) return fallback
      const hit = cache.get(name)
      if (hit) return hit
      if (!names.includes(name)) return undefined
      const opened = await Hoppr.open({ hopper: name })
      cache.set(name, opened)
      return opened
    },
  }
}

function csvCell(v: unknown): string {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// ── daemon ────────────────────────────────────────────────────────
const daemonCmd = program.command('daemon').description('background curation for every hoppr')
daemonCmd
  .command('start', { isDefault: true })
  .description('one daemon manages all hoppers; each stays isolated')
  .option('--foreground', 'run in this terminal')
  .option('--only <name...>', 'manage just these hoppers')
  .action(async (o: { foreground?: boolean; only?: string[] }) => {
    const { daemonStatus, runDaemon } = await import('./daemon/main.ts')
    if (!o.foreground) {
      const { spawn } = await import('node:child_process')
      const args = [process.argv[1]!, 'daemon', 'start', '--foreground']
      if (o.only?.length) args.push('--only', ...o.only)
      const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' })
      child.unref()
      await new Promise((r) => setTimeout(r, 1200))
      const info = await daemonStatus()
      if (info) {
        console.log(
          `${c.green('started')} pid ${info.pid}  http://127.0.0.1:${info.port}\n${c.dim(
            `  logs: ${Layout.daemonLogGlobal()}`,
          )}`,
        )
        return
      }
      // Say WHY. A detached process that dies silently is the worst failure mode.
      const { readFile } = await import('node:fs/promises')
      const log = await readFile(Layout.daemonLogGlobal(), 'utf8').catch(() => '')
      const last = log.trim().split('\n').slice(-3).join('\n')
      console.error(c.red('daemon failed to start'))
      if (last) console.error(c.dim(last))
      console.error(c.dim('  run `hoppr daemon start --foreground` to see the full error'))
      process.exitCode = 1
      return
    }
    await runDaemon({ foreground: true, only: o.only, onLog: (m) => console.log(m) })
    await new Promise(() => {})
  })
daemonCmd.command('stop').action(async () => {
  const { stopDaemon } = await import('./daemon/main.ts')
  console.log((await stopDaemon()) ? c.green('stopped') : c.dim('not running'))
})
daemonCmd.command('status').action(async () => {
  const { daemonStatus } = await import('./daemon/main.ts')
  const info = await daemonStatus()
  if (wantJson()) return printJson(info ?? null)
  if (!info) return console.log(c.dim('not running'))
  console.log(
    `${c.green('running')} pid ${info.pid}  port ${info.port}  up ${relTime(
      new Date(info.startedAt).toISOString(),
    )}`,
  )
  const { listHoppers } = await import('./store/registry.ts')
  for (const x of await listHoppers()) {
    console.log(`  ${c.dim('·')} ${x.name.padEnd(16)} ${c.dim(`${x.profile}  ${x.sourceLabel}`)}`)
  }
})
daemonCmd
  .command('logs')
  .option('-n, --lines <n>', '', '40')
  .action(async (o: { lines: string }) => {
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(Layout.daemonLogGlobal(), 'utf8').catch(() => '')
    console.log(text.split('\n').slice(-Number(o.lines)).join('\n') || c.dim('(no logs)'))
  })

program
  .command('serve')
  .description('run just the HTTP API in the foreground')
  .option('--port <n>')
  .action(async (o: { port?: string }) => {
    const h = await ctx()
    h.requireStore()
    const { randomBytes } = await import('node:crypto')
    const token = randomBytes(24).toString('hex')
    const { startHttp } = await import('./http/server.ts')
    const s = await startHttp(await allHoppers(h), {
      port: o.port ? Number(o.port) : h.config.daemon.port,
      host: h.config.daemon.host,
      token,
    })
    console.log(`listening on http://127.0.0.1:${s.port}\ntoken: ${token}`)
    await new Promise(() => {})
  })

// ── deep pass ─────────────────────────────────────────────────────
program
  .command('deep')
  .description('run the nightly pass now: taxonomy, concepts, skills, lint')
  .option('--dry-run')
  .action(async (o: { dryRun?: boolean }) => {
    const h = await ctx()
    h.requireStore()
    const { deepPass } = await import('./organize/deep.ts')
    const st = await deepPass(h, {
      dryRun: o.dryRun,
      onProgress: (m) => {
        if (!wantJson() && process.stdout.isTTY) process.stdout.write(`\r  ${c.dim(m.padEnd(60))}`)
      },
    })
    if (process.stdout.isTTY && !wantJson()) process.stdout.write('\r')
    if (wantJson()) return printJson(st)
    console.log(st.logLine)
    if (!o.dryRun && h.config.git.mode === 'auto') {
      const sha = await gitmod.commit(h.layout.root, st.logLine, ['curated']).catch(() => null)
      if (sha) console.log(c.dim(`  committed ${sha.slice(0, 8)}`))
    }
    if (st.skillsProposed) {
      console.log(
        c.cyan(`  ${st.skillsProposed} skill proposals — review with \`hoppr skills review\``),
      )
    }
  })

// ── skills ────────────────────────────────────────────────────────
const skillsCmd = program.command('skills').description('procedures distilled from past sessions')
skillsCmd
  .command('list', { isDefault: true })
  .option('--state <state>')
  .action(async (o: { state?: string }) => {
    const h = await ctx()
    const { listSkills, reconcileSkills } = await import('./organize/skills.ts')
    const db = await h.db()
    // Files on disk are the truth; the index row is bookkeeping. Adopt any
    // SKILL.md that has no row — seeds written at init, or one dropped in by hand.
    await reconcileSkills(db, h.layout)
    const rows = listSkills(db, o.state as never)
    if (wantJson()) return printJson(rows)
    if (rows.length === 0) return console.log(c.dim('no skills yet — `hoppr deep` mines them'))
    for (const r of rows) {
      const tag =
        r.state === 'installed'
          ? c.green('installed')
          : r.state === 'accepted'
            ? c.cyan('accepted ')
            : r.state === 'rejected'
              ? c.dim('rejected ')
              : c.yellow('proposed ')
      console.log(
        `${tag} ${c.bold(r.slug.padEnd(28))} ${c.dim(`${r.evidence_count} sessions, conf ${r.confidence.toFixed(2)}`)}`,
      )
      console.log(`  ${c.dim(r.description.slice(0, 100))}`)
    }
  })
skillsCmd.command('show <slug>').action(async (slug: string) => {
  const h = await ctx()
  const { readFile } = await import('node:fs/promises')
  console.log(await readFile(h.layout.skillFile(slug), 'utf8').catch(() => c.dim('(not found)')))
})
skillsCmd
  .command('why <slug>')
  .description('the sessions this was mined from')
  .action(async (slug: string) => {
    const h = await ctx()
    const { skillEvidence } = await import('./organize/skills.ts')
    const db = await h.db()
    const rows = skillEvidence(db, slug)
    if (wantJson()) return printJson(rows)
    if (rows.length === 0) return console.log(c.dim('no recorded evidence'))
    for (const e of rows) {
      const r = db
        .prepare<{ title: string; path: string }>('SELECT title, path FROM raw WHERE id = :i')
        .get({ i: e.raw_id })
      console.log(`${c.dim(e.role.padEnd(9))} ${e.raw_id}  ${r?.title ?? c.dim('(missing)')}`)
      if (r) console.log(c.dim(`          ${r.path}`))
    }
  })
skillsCmd
  .command('accept <slug...>')
  .description('promote proposals to accepted, without the interactive prompt')
  .action(async (slugs: string[]) => {
    const h = await ctx()
    const { listSkills, setSkillState } = await import('./organize/skills.ts')
    const { writeResolver } = await import('./organize/skillify.ts')
    const db = await h.db()
    for (const slug of slugs) setSkillState(db, slug, 'accepted')
    await writeResolver(h.layout, listSkills(db))
    console.log(`${c.green('accepted')} ${slugs.join(', ')}`)
  })

skillsCmd
  .command('reject <slug...>')
  .description('decline proposals; they will not be proposed again')
  .action(async (slugs: string[]) => {
    const h = await ctx()
    const { listSkills, setSkillState } = await import('./organize/skills.ts')
    const { writeResolver } = await import('./organize/skillify.ts')
    const db = await h.db()
    for (const slug of slugs) setSkillState(db, slug, 'rejected')
    await writeResolver(h.layout, listSkills(db))
    console.log(`${c.dim('rejected')} ${slugs.join(', ')}`)
  })

skillsCmd
  .command('review')
  .description('accept or reject proposals, one at a time')
  .action(async () => {
    const h = await ctx()
    const { listSkills, setSkillState } = await import('./organize/skills.ts')
    const { writeResolver } = await import('./organize/skillify.ts')
    const db = await h.db()
    const pending = listSkills(db, 'proposed')
    if (pending.length === 0) return console.log(c.dim('nothing to review'))

    // Without a terminal there is nobody to ask. Crashing on a closed stdin
    // (which is what a pipe or a CI runner gives you) is a worse answer than
    // pointing at the scriptable commands.
    if (!process.stdin.isTTY) {
      console.log(`${pending.length} proposal(s) awaiting review:\n`)
      for (const s of pending) {
        console.log(`  ${c.bold(s.slug)}  ${c.dim(`${s.evidence_count} sessions`)}`)
        console.log(`    ${c.dim(s.description.slice(0, 100))}`)
      }
      console.log(
        c.dim(
          `\nNo terminal attached. Use \`hoppr skills accept <slug>\` or ` +
            `\`hoppr skills reject <slug>\`, or \`hoppr skills show <slug>\` to read one first.`,
        ),
      )
      return
    }

    const { createInterface } = await import('node:readline/promises')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    let closed = false
    rl.on('close', () => {
      closed = true
    })
    try {
      const { readFile } = await import('node:fs/promises')
      for (const s of pending) {
        if (closed) break
        console.log(
          `\n${c.bold(s.slug)}  ${c.dim(`${s.evidence_count} sessions · confidence ${s.confidence.toFixed(2)}`)}`,
        )
        console.log(c.dim(s.description))
        console.log(c.dim('─'.repeat(60)))
        console.log(
          (await readFile(h.layout.skillFile(s.slug), 'utf8').catch(() => '')).slice(0, 1400),
        )
        const ans = await rl
          .question(
            `${c.cyan('[a]')}ccept  ${c.cyan('[r]')}eject  ${c.cyan('[s]')}kip  ${c.cyan('[q]')}uit: `,
          )
          .catch(() => 'q')
        const choice = ans.trim().toLowerCase()
        if (choice === 'q') break
        if (choice === 'a') {
          setSkillState(db, s.slug, 'accepted')
          console.log(c.green('accepted'))
        } else if (choice === 'r') {
          setSkillState(db, s.slug, 'rejected')
          console.log(c.dim('rejected — it will not be proposed again'))
        }
      }
    } finally {
      rl.close()
      await writeResolver(h.layout, listSkills(db))
    }
  })

skillsCmd
  .command('install <slug>')
  .option('--project', 'install into ./.claude/skills')
  .option('--target <dir>')
  .option('--force')
  .action(async (slug: string, o: { project?: boolean; target?: string; force?: boolean }) => {
    const h = await ctx()
    const { installSkill } = await import('./organize/skills.ts')
    const { join } = await import('node:path')
    const target = o.target ?? (o.project ? join(process.cwd(), '.claude', 'skills') : undefined)
    const r = await installSkill(h.layout, await h.db(), slug, { target, force: o.force })
    if (wantJson()) return printJson(r)
    const tag =
      r.outcome === 'conflict'
        ? c.yellow('conflict')
        : r.outcome === 'failed'
          ? c.red('failed')
          : c.green(r.outcome)
    console.log(`${tag} ${r.target}${r.detail ? `\n  ${c.dim(r.detail)}` : ''}`)
    if (r.outcome === 'conflict') process.exitCode = 1
  })
skillsCmd
  .command('uninstall <slug>')
  .option('--target <dir>')
  .action(async (slug: string, o: { target?: string }) => {
    const h = await ctx()
    const { uninstallSkill } = await import('./organize/skills.ts')
    const r = await uninstallSkill(await h.db(), slug, o.target)
    console.log(`${r.outcome} ${r.target}${r.detail ? c.dim(`  ${r.detail}`) : ''}`)
  })
skillsCmd
  .command('audit')
  .description('score every skill against the promotion gate')
  .action(async () => {
    const h = await ctx()
    const { listSkills } = await import('./organize/skills.ts')
    const { auditSkills } = await import('./organize/skillify.ts')
    const { readFile } = await import('node:fs/promises')
    const db = await h.db()
    const rows = listSkills(db)
    const bodies = new Map<string, string>()
    for (const r of rows) {
      bodies.set(r.slug, await readFile(h.layout.skillFile(r.slug), 'utf8').catch(() => ''))
    }
    const audit = auditSkills(db, rows, bodies, {
      minEvidence: h.config.skills.min_evidence,
      minConfidence: h.config.skills.min_confidence,
    })
    if (wantJson()) return printJson(audit)
    if (audit.length === 0) return console.log(c.dim('no skills yet'))
    for (const a of audit) {
      const tag = a.result.pass ? c.green('pass') : c.yellow('gated')
      console.log(
        `${tag} ${c.bold(a.slug.padEnd(34))} ${c.dim(`${(a.result.score * 100).toFixed(0)}%  ${a.state}`)}`,
      )
      for (const f of a.result.failures) console.log(`     ${c.dim(`✗ ${f}`)}`)
    }
  })

skillsCmd
  .command('resolver')
  .description('regenerate the skill dispatcher')
  .action(async () => {
    const h = await ctx()
    const { listSkills } = await import('./organize/skills.ts')
    const { writeResolver } = await import('./organize/skillify.ts')
    const p = await writeResolver(h.layout, listSkills(await h.db()))
    console.log(`${c.green('wrote')} ${p}`)
  })

skillsCmd
  .command('mine')
  .description('mine now without a full deep pass')
  .action(async () => {
    const h = await ctx()
    const { minesSkills } = await import('./core/source.ts')
    if (!curationFor(h.config).skills) {
      throw HopprError.user(
        `'${h.name}' is a ${h.config.hopper.profile} hoppr — there are no procedures in it to mine.\n` +
          '  Skill mining applies to hoppers pointed at agent sessions (profile = agents).',
      )
    }
    const llm = await h.llm('quality')
    if (!llm) throw HopprError.user('skill mining needs an LLM provider')
    const { mineSkills } = await import('./organize/skills.ts')
    const st = await mineSkills(await h.db(), h.layout, h.config, llm, {
      onProgress: (m) => {
        if (process.stdout.isTTY) process.stdout.write(`\r  ${c.dim(m.padEnd(60))}`)
      },
    })
    if (process.stdout.isTTY) process.stdout.write('\r')
    console.log(st.logLine)
  })

// ── web / browse ──────────────────────────────────────────────────
program
  .command('web')
  .description('open the dashboard')
  .option('--port <n>')
  .option('--no-open', 'print the url instead of opening a browser')
  .action(async (o: { port?: string; open?: boolean }) => {
    const h = await ctx()
    h.requireStore()
    const { randomBytes } = await import('node:crypto')
    const token = randomBytes(24).toString('hex')
    const { startHttp } = await import('./http/server.ts')
    // Port 0 lets the OS pick, so `hoppr web` never collides with a running daemon.
    const s = await startHttp(await allHoppers(h), {
      port: o.port ? Number(o.port) : 0,
      host: '127.0.0.1',
      token,
    })
    const url = `http://127.0.0.1:${s.port}/`
    console.log(`${c.green('dashboard')} ${url}\n${c.dim('  ctrl-c to stop')}`)
    if (o.open !== false) {
      const { spawn } = await import('node:child_process')
      const cmd =
        process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
      spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref()
    }
    await new Promise(() => {})
  })

program
  .command('browse')
  .description('interactive terminal browser')
  .action(async () => {
    const h = await ctx()
    h.requireStore()
    const { browse } = await import('./tui/browse.ts')
    await browse(h)
  })

// ── config / schema ───────────────────────────────────────────────
const cfgCmd = program.command('config').description('inspect configuration')
cfgCmd.command('show', { isDefault: true }).action(async () => {
  const { config, sources, layout } = await ctx()
  if (wantJson()) return printJson(config, { sources, root: layout.root })
  console.log(c.dim(`# root:    ${layout.root}`))
  console.log(c.dim(`# sources: ${sources.join(', ') || '(defaults only)'}`))
  console.log(JSON.stringify(config, null, 2))
})
cfgCmd.command('path').action(async () => {
  const { layout } = await ctx()
  console.log(layout.configFile)
})

program
  .command('schema')
  .description('regenerate CLAUDE.md so the store describes itself')
  .argument('[action]', 'sync', 'sync')
  .action(async () => {
    const { config, layout } = await ctx()
    const r = await writeIfChanged(layout.claudeMd, renderClaudeMd(config))
    if (wantJson()) return printJson({ path: layout.claudeMd, result: r })
    console.log(`${r === 'unchanged' ? c.dim('unchanged') : c.green(r)}  ${layout.claudeMd}`)
  })

// ── doctor ────────────────────────────────────────────────────────
program
  .command('doctor')
  .description('check the store for problems')
  .action(async () => {
    const h = await ctx()
    const { layout, config } = h
    const findings: Array<{ level: 'ok' | 'warn' | 'error'; msg: string }> = []
    const push = (level: 'ok' | 'warn' | 'error', msg: string) => findings.push({ level, msg })

    existsSync(layout.configFile)
      ? push('ok', `store at ${layout.root}`)
      : push('error', `no store at ${layout.root} — run \`hoppr init\``)

    gitmod.isRepo(layout.root)
      ? push('ok', 'git repo present (review layer available)')
      : push(
          config.git.mode === 'off' ? 'ok' : 'warn',
          'not a git repo — `git diff` review and `git revert` undo are unavailable',
        )

    const raws = await rawStore.list(layout).catch(() => [])
    push('ok', `${raws.length} capture${raws.length === 1 ? '' : 's'} in raw/`)
    const partial = raws.filter((r) => r.partial).length
    if (partial) push('ok', `${partial} still live (not curated until quiet)`)

    existsSync(layout.claudeMd)
      ? push('ok', 'CLAUDE.md present (store is self-describing)')
      : push('warn', 'CLAUDE.md missing — run `hoppr schema sync`')

    // A misspelt preset falls back rather than refusing to open the store —
    // a typo must not lock you out of your own notes. But silence is the wrong
    // amount of feedback, because the fallback behaves plausibly and you would
    // never find out.
    const { PRESET_NAMES } = await import('./core/profiles.ts')
    const chosen = h.config.hopper.curation
    if (chosen && !PRESET_NAMES.includes(chosen)) {
      push(
        'warn',
        `[hopper] curation = "${chosen}" is not a known preset — using the default. ` +
          `Try one of: ${PRESET_NAMES.join(', ')}`,
      )
    }

    // A secrets file readable by anyone on the machine defeats the point of
    // keeping keys out of the tracked config.
    for (const dir of [Layout.home(), h.layout.root]) {
      const envFile = join(dir, '.env')
      if (!existsSync(envFile)) continue
      const mode = statSync(envFile).mode & 0o777
      if (mode & 0o077) {
        push('warn', `${envFile} is mode ${mode.toString(8)} — run \`chmod 600 ${envFile}\``)
      }
    }

    // "Is the daemon up" and "can an agent reach hoppr" are different
    // questions: the MCP server is spawned by the client and needs no daemon.
    const { daemonStatus } = await import('./daemon/main.ts')
    const d = await daemonStatus()
    push(
      d ? 'ok' : 'warn',
      d
        ? `daemon running (pid ${d.pid}, port ${d.port}) — curation is automatic`
        : 'daemon not running — capture and search work; curation waits. `hoppr daemon start`',
    )

    const { mcpStatus } = await import('./mcp/status.ts')
    const wired = (await mcpStatus()).filter((e) => e.present)
    if (wired.length === 0) {
      push('warn', 'no MCP client is wired up — `hoppr mcp install` so agents can reach this')
    } else {
      for (const e of wired) {
        push(
          'ok',
          `MCP registered in ${e.target}${e.pinnedTo ? ` (pinned to '${e.pinnedTo}')` : ''}` +
            `${e.managedByHoppr ? '' : ' — hand-written entry, hoppr will not modify it'}`,
        )
      }
    }

    const { isSubprocessProvider } = await import('./llm/index.ts')
    const { modelsFor, modelFor, modelMismatch } = await import('./llm/provider.ts')
    const { loadDotEnv, envOrigin } = await import('./config/env.ts')
    // Re-read rather than plumbing through: this is one small file, read once,
    // and only so doctor can name the file to edit.
    // Empty env: we want to know which file DECLARES each key, not which one
    // won a race against a variable this same process already applied.
    const { sources: envSources } = loadDotEnv([Layout.home(), h.layout.root], {})
    for (const tier of ['fast', 'quality'] as const) {
      const p = await h.llm(tier)
      // Name the model, not just the provider — a valid provider paired with a
      // model id it has never heard of fails at the first call, not here.
      const model = p ? modelFor(tier, modelsFor(p.id, h.config.llm.models)) : ''
      if (!p) {
        push('warn', `${tier} tier: no provider — capture and search work, curation does not`)
      } else if (modelMismatch(p.id, model)) {
        push(
          'error',
          `${tier} tier: ${modelMismatch(p.id, model)} — unset [llm.models] to use the default`,
        )
      } else if (tier === 'fast' && isSubprocessProvider(p.id)) {
        push(
          'warn',
          `fast tier: ${p.id} · ${model} (subprocess, ~30s/batch) — set OPENROUTER_API_KEY, ` +
            'ANTHROPIC_API_KEY or OPENAI_API_KEY to tag over a raw API instead',
        )
      } else {
        const key = ENV_KEYS[p.id]
        const origin = key ? c.dim(`  (${envOrigin(key, envSources)})`) : ''
        const bad = modelMismatch(p.id, model)
        if (bad) push('error', `${tier} tier: ${bad} — unset [llm.models] to use the default`)
        else push('ok', `${tier} tier: ${p.id} · ${model}${origin}`)
      }
    }

    if (wantJson()) return printJson(findings)
    for (const f of findings) {
      const tag =
        f.level === 'ok' ? c.green('ok  ') : f.level === 'warn' ? c.yellow('warn') : c.red('err ')
      console.log(`${tag}  ${f.msg}`)
    }
    if (findings.some((f) => f.level === 'error')) process.exitCode = 1
  })

// ── error handling ────────────────────────────────────────────────
async function main() {
  try {
    await program.parseAsync(process.argv)
    // The OCR worker is a live child process; leaving it open holds the event
    // loop and the command never exits. The work finishes in under a second
    // and then hangs forever, which reads as "OCR is impossibly slow".
    await closeOcrIfLoaded()
  } catch (e) {
    await closeOcrIfLoaded()
    if (e instanceof HopprError) {
      if (wantJson()) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: { kind: e.kind, message: e.message } })}\n`,
        )
      } else {
        console.error(`${c.red('error')} ${e.message}`)
      }
      process.exit(e.kind === 'user' || e.kind === 'notfound' ? 1 : 2)
    }
    console.error(`${c.red('internal error')} ${(e as Error).message}`)
    if (process.env.HOPPR_LOG === 'debug') console.error(e)
    process.exit(2)
  }
}

void main()
