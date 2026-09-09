import { z } from 'zod'
import { HopprError } from '../core/errors.ts'
import type { Hoppr } from '../core/hoppr.ts'
import { isoDate } from '../core/ids.ts'
import { buildsPage, curationFor } from '../core/profiles.ts'
import { docId, upsertDoc } from '../db/docs.ts'
import type { Db } from '../db/driver.ts'
import { recordCall, withinBudget } from '../llm/index.ts'
import { writeIfChanged } from '../store/atomic.ts'
import { clip, loadPrompt, render } from '../store/prompts.ts'
import {
  appendLog,
  listPages,
  pageKey,
  savePage,
  sourceHashOf,
  type WikiPage,
} from '../store/wiki.ts'
import * as journal from './journal.ts'
import { buildLedgers } from './ledger.ts'
import { extractLessons } from './lessons.ts'
import { mineSkills } from './skills.ts'
import { loadTaxonomy, recount, saveTaxonomy, type Taxonomy } from './taxonomy.ts'

const TaxOut = z.object({
  merges: z
    .array(z.object({ from: z.string(), to: z.string(), reason: z.string().default('') }))
    .default([]),
  describe: z.array(z.object({ tag: z.string(), description: z.string() })).default([]),
  retire: z.array(z.object({ tag: z.string(), reason: z.string().default('') })).default([]),
})

const ConceptOut = z.object({
  title: z.string(),
  summary: z.string(),
  body: z.string(),
  related: z.array(z.string()).default([]),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
})

const LintOut = z.object({
  findings: z
    .array(
      z.object({
        kind: z.string(),
        severity: z.enum(['high', 'medium', 'low']).default('medium'),
        pages: z.array(z.string()).default([]),
        detail: z.string(),
      }),
    )
    .default([]),
})

export interface DeepStats {
  passId: string
  merges: number
  concepts: number
  skillsProposed: number
  /** Typed claims extracted from sessions this pass. */
  lessons: number
  /** Moments the agent got it wrong and the person said so. */
  corrections: number
  /** Skills written to prevent a recurring failure. */
  guardrails: number
  /** Proposals that survived a replay against recorded failures. */
  benchPassed: number
  benchFailed: number
  lintFindings: number
  logLine: string
}

/**
 * The nightly pass.
 *
 * Each stage is independently failable: a taxonomy model call that goes wrong
 * must not cost you the concept pages or the skill proposals. The caller
 * advances the watermark only if the whole thing returns, so a partial night
 * is retried rather than silently dropped.
 */
export async function deepPass(
  h: Hoppr,
  opts: { since?: number; onProgress?: (m: string) => void; dryRun?: boolean } = {},
): Promise<DeepStats> {
  const db = await h.db()
  // Synthesis, taxonomy convergence and skill mining run a few times a night
  // and compound across the corpus — the quality tier earns its cost here.
  const llm = await h.llm('quality')
  if (!llm) throw HopprError.user('the deep pass needs an LLM provider')

  const budget = withinBudget(db, h.config)
  if (!budget.ok) {
    throw HopprError.user(
      `daily LLM budget reached ($${budget.spent.toFixed(2)} of $${budget.cap.toFixed(2)})`,
    )
  }

  const passId = journal.newPassId()
  const st: DeepStats = {
    passId,
    merges: 0,
    concepts: 0,
    skillsProposed: 0,
    lessons: 0,
    corrections: 0,
    guardrails: 0,
    benchPassed: 0,
    benchFailed: 0,
    lintFindings: 0,
    logLine: '',
  }
  const notes: string[] = []

  // ── 1. taxonomy convergence ──────────────────────────────────
  try {
    opts.onProgress?.('taxonomy convergence')
    st.merges = await convergeTaxonomy(h, llm, passId, opts.dryRun)
    if (st.merges) notes.push(`${st.merges} tag merges`)
  } catch (e) {
    notes.push(`taxonomy stage failed: ${(e as Error).message.slice(0, 60)}`)
  }

  // ── 2. concept pages ─────────────────────────────────────────
  if (buildsPage(h.config, 'concept')) {
    try {
      opts.onProgress?.('building concept pages')
      st.concepts = await buildConcepts(h, llm, passId, opts.dryRun)
      if (st.concepts) notes.push(`${st.concepts} concept pages`)
    } catch (e) {
      notes.push(`concept stage failed: ${(e as Error).message.slice(0, 60)}`)
    }
  }

  // ── 3. skill mining ──────────────────────────────────────────
  // Only where procedures exist. A folder of papers has no workflow in it, and
  // mining one would invent a procedure out of prose — worse than mining none.
  if (curationFor(h.config).skills) {
    // 3a. Read each new session once for what it ESTABLISHED. Everything below
    //     works off these claims rather than off the transcripts, which is what
    //     lets a stated preference or a defined term become a skill at all.
    try {
      const lessons = await extractLessons(db, h.layout, h.config, llm, {
        onProgress: opts.onProgress,
      })
      st.lessons = lessons.lessons
      if (lessons.lessons)
        notes.push(`${lessons.lessons} lessons from ${lessons.sessionsRead} sessions`)
    } catch (e) {
      notes.push(`lesson stage failed: ${(e as Error).message.slice(0, 60)}`)
    }

    // 3a2. And read the same sessions for what went WRONG. Separate from the
    //      lessons pass because it is a different question with a different
    //      shape of answer: a lesson is a standing claim superseded by a newer
    //      one, a correction is an event whose recurrence is the whole point.
    try {
      const { extractCorrections } = await import('./corrections.ts')
      const cx = await extractCorrections(db, h.layout, h.config, llm, {
        onProgress: opts.onProgress,
      })
      st.corrections = cx.corrections
      if (cx.logLine) notes.push(cx.logLine)
    } catch (e) {
      notes.push(`correction stage failed: ${(e as Error).message.slice(0, 60)}`)
    }

    // 3b. The standing ledgers, assembled by code from those claims. No model
    //     call, so this is cheap enough to run every pass and its diff is
    //     exactly the set of things that changed.
    try {
      const led = await buildLedgers(db, h.layout, h.config)
      if (led.logLine) notes.push(led.logLine)
    } catch (e) {
      notes.push(`ledger stage failed: ${(e as Error).message.slice(0, 60)}`)
    }

    // 3c. Did the skills already shipped actually help? Judged from later
    //     sessions that loaded them, before mining adds more — a skill on its
    //     way to being archived should not also be revised this pass.
    try {
      const { judgeSkillUsage } = await import('./usage.ts')
      const used = await judgeSkillUsage(db, h.layout, h.config, llm, {
        onProgress: opts.onProgress,
      })
      if (used.logLine) notes.push(used.logLine)
    } catch (e) {
      notes.push(`usage stage failed: ${(e as Error).message.slice(0, 60)}`)
    }

    // 3d. Procedures, which still need the transcripts and the promotion gate.
    try {
      opts.onProgress?.('mining skills')
      const mined = await mineSkills(db, h.layout, h.config, llm, { onProgress: opts.onProgress })
      st.skillsProposed = mined.proposed
      if (mined.proposed) notes.push(`${mined.proposed} skill proposals`)
    } catch (e) {
      notes.push(`skill stage failed: ${(e as Error).message.slice(0, 60)}`)
    }

    // 3e. A guardrail for each failure mode that is actually costing something.
    //     Bounded per pass rather than run over every mode: writing one is a
    //     quality-tier call, and the modes below the top few are, by the
    //     ranking's own measure, not worth the money yet.
    try {
      const { failureModes } = await import('./corrections.ts')
      const { mineGuardrails } = await import('./guardrails.ts')
      const modes = failureModes(db).filter((m) => !hasGuardrail(db, m.mode))
      if (modes.length > 0) {
        const g = await mineGuardrails(db, h.layout, h.config, llm, modes.slice(0, 3), {
          onProgress: opts.onProgress,
        })
        st.guardrails = g.stats.proposed
        if (g.stats.logLine) notes.push(g.stats.logLine)
      }
    } catch (e) {
      notes.push(`guardrail stage failed: ${(e as Error).message.slice(0, 60)}`)
    }

    // 3e2. Score what was proposed against recorded failures.
    //
    //      This is the stage the pipeline never had. Everything above judges a
    //      skill as text — the gate reads its prose, the refuter re-reads its
    //      evidence — and a one-shot authored skill shipped on that basis is
    //      frequently worse than no skill at all. Cases are cut from
    //      corrections by string arithmetic, so building them is free; only
    //      the replay costs anything, and it is bounded per pass.
    try {
      const { buildCases } = await import('./cases.ts')
      const built = await buildCases(db, { config: h.config })
      if (built.logLine) notes.push(built.logLine)

      // Deliberately one skill per pass.
      //
      // A single skill costs cases × samples × 3 quality-tier calls, so
      // benching three of them would roughly double the whole nightly pass to
      // score work that is not going anywhere. One per night clears a backlog
      // over a week and keeps the pass's cost recognisable; `hoppr skills
      // verify` is there for anyone who wants an answer now.
      const { runBench } = await import('./replay.ts')
      const bench = await runBench(db, h.layout, h.config, llm, {
        onProgress: opts.onProgress,
        limit: 1,
        cases: 2,
      })
      st.benchPassed = bench.passed
      st.benchFailed = bench.failed
      if (bench.logLine) notes.push(bench.logLine)
    } catch (e) {
      notes.push(`bench stage failed: ${(e as Error).message.slice(0, 60)}`)
    }

    // 3f. The front door, rebuilt from whatever the pass ended up with. Last,
    //     so it reflects this pass rather than the previous one.
    try {
      const { buildFrontDoor } = await import('../store/frontdoor.ts')
      await buildFrontDoor(db, h.layout, h.config)
    } catch (e) {
      notes.push(`front door failed: ${(e as Error).message.slice(0, 60)}`)
    }
  }

  // ── 3a. the pages you asked for by name ──────────────────────
  if (h.config.wiki.outline.length > 0) {
    try {
      opts.onProgress?.('building the outline')
      const { buildOutline } = await import('./outline.ts')
      const o = await buildOutline(db, h.layout, h.config, llm, { onProgress: opts.onProgress })
      if (o.written) notes.push(`${o.written} outline pages`)
    } catch (e) {
      notes.push(`outline stage failed: ${(e as Error).message.slice(0, 60)}`)
    }
  }

  // ── 3b. knowledge graph ──────────────────────────────────────
  if (h.config.retrieval.graph) {
    try {
      opts.onProgress?.('building the graph')
      const { buildGraph } = await import('./graph.ts')
      const g = await buildGraph(db, h.layout, h.config, llm, { onProgress: opts.onProgress })
      if (g.nodes || g.edges) notes.push(`${g.nodes} entities, ${g.edges} relations`)
      if (g.dropped) notes.push(`${g.dropped} off-schema dropped`)
    } catch (e) {
      notes.push(`graph stage failed: ${(e as Error).message.slice(0, 60)}`)
    }
  }

  // ── 3c. extraction tables ────────────────────────────────────
  // Auto-tagging: a table is a standing instruction, so new captures flow into
  // it as they arrive rather than waiting for someone to run `tables rebuild`.
  try {
    opts.onProgress?.('filling tables')
    const { extractAllTables } = await import('../tables/extract.ts')
    const rows = await extractAllTables(db, h.layout, h.config, llm, {
      onProgress: opts.onProgress,
    })
    if (rows.written) notes.push(`${rows.written} table rows`)
  } catch (e) {
    notes.push(`table stage failed: ${(e as Error).message.slice(0, 60)}`)
  }

  // ── 4. lint ──────────────────────────────────────────────────
  try {
    opts.onProgress?.('linting')
    st.lintFindings = await lint(h, llm, opts.dryRun)
    if (st.lintFindings) notes.push(`${st.lintFindings} lint findings`)
  } catch (e) {
    notes.push(`lint stage failed: ${(e as Error).message.slice(0, 60)}`)
  }

  if (!opts.dryRun) await h.rebuildIndexPage()

  st.logLine = `deep pass — ${notes.length ? notes.join(', ') : 'nothing to do'}`
  if (!opts.dryRun) await appendLog(h.layout, st.logLine)
  return st
}

async function convergeTaxonomy(
  h: Hoppr,
  llm: NonNullable<Awaited<ReturnType<Hoppr['llm']>>>,
  passId: string,
  dryRun?: boolean,
): Promise<number> {
  const db = await h.db()
  const tax = await loadTaxonomy(h.layout)
  const live = Object.entries(tax.tags).filter(([, e]) => !e.merged_into)
  if (live.length < 8) return 0

  const tagCfg = (h.config.tables.tags ?? {}) as Record<string, unknown>
  const pinned = new Set((tagCfg.pinned as string[]) ?? [])
  const prompt = await loadPrompt(h.layout, 'taxonomy')
  const MAX_MERGES = 15

  const res = await llm.completeJson({
    prompt: render(prompt.template, {
      vocabulary: live
        .sort((a, b) => b[1].count - a[1].count)
        .map(([t, e]) => `${t} (${e.count})${e.description ? ` — ${e.description}` : ''}`)
        .join('\n'),
      pinned: [...pinned].join(', ') || '(none)',
      max_merges: MAX_MERGES,
    }),
    tier: prompt.tier,
    purpose: 'curate.taxonomy',
    schema: TaxOut,
    maxTokens: 4096,
  })
  recordCall(db, llm.id, 'curate.taxonomy', prompt.tier, res.usage, true)

  let next: Taxonomy = { ...tax, tags: { ...tax.tags } }
  let applied = 0

  for (const m of res.value.merges.slice(0, MAX_MERGES)) {
    const from = m.from
    const to = m.to
    const a = next.tags[from]
    const b = next.tags[to]
    // Guardrails. Each one prevents a specific way an autonomous merge
    // destroys a vocabulary you cannot easily reconstruct.
    if (!a || !b || from === to) continue
    if (pinned.has(from) || a.pinned) continue
    if (a.count > 50 && b.count < 5) continue // never fold the heavy into the trivial
    if (a.merged_into || b.merged_into) continue

    next.tags[from] = { ...a, merged_into: to, count: a.count }
    next.tags[to] = { ...b, count: b.count + a.count }
    applied++

    // Rewrite the tag on every page carrying it, so the wiki and the
    // vocabulary never disagree.
    if (!dryRun) await retagPages(h, from, to, passId)
  }

  for (const d of res.value.describe) {
    const e = next.tags[d.tag]
    if (e && !e.merged_into) next.tags[d.tag] = { ...e, description: d.description }
  }

  if (!dryRun && (applied > 0 || res.value.describe.length > 0)) {
    const pages = await listPages(h.layout)
    next = recount(
      next,
      pages.map((p) => p.tags),
    )
    next.version = (next.version ?? 1) + 1
    await saveTaxonomy(h.layout, next)
    db.prepare(
      'INSERT OR REPLACE INTO taxonomy_versions(version, created_at, change_log) VALUES (:v,:t,:c)',
    ).run({
      v: next.version,
      t: Date.now(),
      c: JSON.stringify(res.value),
    })
  }
  return applied
}

async function retagPages(h: Hoppr, from: string, to: string, passId: string): Promise<void> {
  const db = await h.db()
  for (const page of await listPages(h.layout)) {
    if (!page.tags.includes(from)) continue
    const before = await journal.snapshot(
      h.layout,
      h.layout.rel(h.layout.pageFile(page.type, page.slug)),
    )
    const next: WikiPage = {
      ...page,
      tags: [...new Set(page.tags.map((t) => (t === from ? to : t)))],
      updated: isoDate(new Date()),
    }
    const saved = await savePage(h.layout, next)
    if (saved.result !== 'unchanged') {
      journal.record(db, {
        passId,
        targetKind: 'wiki',
        targetId: saved.path,
        op: 'update',
        before,
      })
      db.prepare('DELETE FROM wiki_tags WHERE page_id = :p').run({ p: page.id })
      const ins = db.prepare(
        'INSERT OR IGNORE INTO wiki_tags(page_id,tag,origin) VALUES (:p,:t,:o)',
      )
      for (const t of next.tags) ins.run({ p: page.id, t, o: 'agent' })
    }
  }
}

/**
 * A tag earns a concept page once enough source pages carry it. Below that
 * threshold a page would be a stub restating one source, which adds a node to
 * the graph and no knowledge.
 */
async function buildConcepts(
  h: Hoppr,
  llm: NonNullable<Awaited<ReturnType<Hoppr['llm']>>>,
  passId: string,
  dryRun?: boolean,
): Promise<number> {
  const db = await h.db()
  const min = h.config.wiki.concept_min_sources
  const candidates = db
    .prepare<{ tag: string; n: number }>(
      `SELECT wt.tag AS tag, COUNT(*) AS n
         FROM wiki_tags wt JOIN wiki w ON w.id = wt.page_id
        WHERE w.page_type = 'source'
        GROUP BY wt.tag HAVING n >= :min
        ORDER BY n DESC LIMIT 8`,
    )
    .all({ min })

  const prompt = await loadPrompt(h.layout, 'concept')
  const allPages = await listPages(h.layout)
  const slugs = new Set(allPages.map((p) => p.slug))
  let built = 0

  for (const cand of candidates) {
    const sources = allPages.filter((p) => p.type === 'source' && p.tags.includes(cand.tag))
    if (sources.length < min) continue
    const slug = cand.tag
    const existing = allPages.find((p) => p.type === 'concept' && p.slug === slug)
    if (existing?.pinned) continue

    const sourceHash = sourceHashOf(sources.map((s) => `${s.slug}:${s.summary ?? ''}`))
    if (existing?.sourceHash === sourceHash && existing.promptHash === prompt.hash) continue

    const res = await llm.completeJson({
      prompt: render(prompt.template, {
        existing: existing ? clip(existing.body, 4000) : '(none yet — this is a new page)',
        sources: sources
          .map((s) => `### [[${s.slug}]]\n${s.title}\n${s.summary ?? ''}\n\n${clip(s.body, 1500)}`)
          .join('\n\n'),
      }),
      tier: prompt.tier,
      purpose: 'curate.concept',
      schema: ConceptOut,
      maxTokens: 4096,
    })
    recordCall(db, llm.id, 'curate.concept', prompt.tier, res.usage, true)
    if (dryRun) {
      built++
      continue
    }

    const page: WikiPage = {
      id: pageKey('concept', slug),
      type: 'concept',
      slug,
      title: res.value.title,
      summary: res.value.summary,
      body: res.value.body,
      sources: [],
      rawIds: [],
      // Only keep links that actually resolve; a dangling link is a lint
      // finding, and emitting them by the dozen would drown the real ones.
      related: [...new Set([...res.value.related, ...sources.map((s) => s.slug)])].filter((r) =>
        slugs.has(r),
      ),
      tags: [cand.tag],
      confidence: res.value.confidence,
      fields: {},
      created: existing?.created ?? isoDate(new Date()),
      updated: isoDate(new Date()),
      pinned: false,
      passId,
      sourceHash,
      promptHash: prompt.hash,
    }

    const before = await journal.snapshot(
      h.layout,
      h.layout.rel(h.layout.pageFile('concept', slug)),
    )
    const saved = await savePage(h.layout, page)
    if (saved.result !== 'unchanged') {
      journal.record(db, {
        passId,
        targetKind: 'wiki',
        targetId: saved.path,
        op: before === undefined ? 'create' : 'update',
        before,
      })
      built++
    }

    db.prepare(
      `INSERT INTO wiki(id,path,slug,page_type,title,summary,body,confidence,fields,created,updated,pass_id,source_hash,prompt_hash,pinned)
       VALUES (:id,:path,:slug,'concept',:title,:summary,:body,:conf,'{}',:created,:updated,:pass,:sh,:ph,0)
       ON CONFLICT(id) DO UPDATE SET title=:title, summary=:summary, body=:body,
         confidence=:conf, updated=:updated, pass_id=:pass, source_hash=:sh, prompt_hash=:ph`,
    ).run({
      id: page.id,
      path: saved.path,
      slug,
      title: page.title,
      summary: page.summary ?? null,
      body: page.body,
      conf: page.confidence,
      created: Date.parse(page.created) || Date.now(),
      updated: Date.now(),
      pass: passId,
      sh: sourceHash,
      ph: prompt.hash,
    })
    upsertDoc(
      db,
      {
        id: docId.wiki('concept', slug),
        tier: 'curated',
        kind: 'concept',
        refId: page.id,
        title: page.title,
        summary: page.summary,
        body: page.body,
        tags: page.tags,
        confidence: page.confidence,
        created: Date.now(),
        updated: Date.now(),
      },
      { maxChars: h.config.index.chunk_chars, overlap: h.config.index.chunk_overlap },
    )
  }
  return built
}

/**
 * Mechanical findings first — orphans and dangling links are detected exactly,
 * so we neither pay a model for them nor risk it hallucinating them. The model
 * is asked only for the judgement calls it is actually better at.
 */
async function lint(
  h: Hoppr,
  llm: NonNullable<Awaited<ReturnType<Hoppr['llm']>>>,
  dryRun?: boolean,
): Promise<number> {
  const db = await h.db()
  const mechanical: string[] = []

  const dangling = db
    .prepare<{ from_id: string; to_slug: string }>(
      'SELECT from_id, to_slug FROM wiki_links WHERE resolved = 0 LIMIT 50',
    )
    .all()
  for (const d of dangling)
    mechanical.push(`- dangling link: \`[[${d.to_slug}]]\` from ${d.from_id}`)

  const orphans = db
    .prepare<{ slug: string }>(
      `SELECT w.slug FROM wiki w
        WHERE w.page_type IN ('concept','entity','comparison')
          AND NOT EXISTS (SELECT 1 FROM wiki_links wl WHERE wl.to_slug = w.slug)
        LIMIT 50`,
    )
    .all()
  for (const o of orphans) mechanical.push(`- orphan page (nothing links to it): [[${o.slug}]]`)

  const stuck = db
    .prepare<{ id: string; curate_error: string }>(
      `SELECT id, COALESCE(curate_error,'') AS curate_error FROM raw WHERE curate_fails >= 3 LIMIT 20`,
    )
    .all()
  for (const s of stuck) {
    mechanical.push(`- capture gave up after 3 attempts: ${s.id} — ${s.curate_error.slice(0, 120)}`)
  }

  const pages = await listPages(h.layout)
  let modelFindings: z.infer<typeof LintOut> = { findings: [] }
  if (pages.length >= 4) {
    const prompt = await loadPrompt(h.layout, 'lint')
    try {
      const res = await llm.completeJson({
        prompt: render(prompt.template, {
          wiki: pages
            .map((p) => `### [[${p.slug}]] (${p.type}, ${p.confidence})\n${p.summary ?? p.title}`)
            .join('\n\n'),
        }),
        tier: prompt.tier,
        purpose: 'curate.lint',
        schema: LintOut,
        maxTokens: 4096,
      })
      recordCall(db, llm.id, 'curate.lint', prompt.tier, res.usage, true)
      modelFindings = res.value
    } catch {
      // A failed lint model call must not lose the mechanical findings.
    }
  }

  const total = mechanical.length + modelFindings.findings.length
  if (dryRun || total === 0) return total

  const day = isoDate(new Date())
  const body = [
    `# Lint — ${day}`,
    '',
    `${pages.length} pages, ${total} findings.`,
    '',
    ...(modelFindings.findings.length
      ? [
          '## Judgement',
          '',
          ...modelFindings.findings.map(
            (f) =>
              `- **${f.severity}** ${f.kind}${f.pages.length ? ` (${f.pages.map((p) => `[[${p}]]`).join(', ')})` : ''} — ${f.detail}`,
          ),
          '',
        ]
      : []),
    ...(mechanical.length ? ['## Mechanical', '', ...mechanical, ''] : []),
  ].join('\n')

  await writeIfChanged(h.layout.lintReport(day), body)
  return total
}

/**
 * Has a guardrail already been written for this mode?
 *
 * Including a rejected one. Re-proposing a guardrail someone turned down, on
 * the next pass, for a failure mode that by definition keeps recurring, is the
 * fastest way to make the review queue feel like spam.
 */
function hasGuardrail(db: Db, mode: string): boolean {
  return !!db
    .prepare<{ slug: string }>('SELECT slug FROM skills WHERE prevents = :m LIMIT 1')
    .get({ m: mode })
}
