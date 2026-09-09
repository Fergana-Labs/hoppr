import { z } from 'zod'
import type { Config } from '../config/schema.ts'
import { contentHash } from '../core/hash.ts'
import { slugify } from '../core/ids.ts'
import type { Db } from '../db/driver.ts'
import { type LlmProvider, recordCall } from '../llm/index.ts'
import { writeIfChanged } from '../store/atomic.ts'
import { buildPage } from '../store/frontmatter.ts'
import type { Layout } from '../store/layout.ts'
import { clip, loadPrompt, render } from '../store/prompts.ts'
import type { FailureMode } from './corrections.ts'
import { promotionGate } from './skillify.ts'
import { stampBody } from './skills.ts'

/**
 * Write a skill that prevents one recurring failure.
 *
 * Mining a procedure asks "how does this job get done here". A guardrail asks
 * the opposite question — "what keeps going wrong" — and the two need different
 * evidence, different prompts, and different claims made about them.
 *
 * The important property is that the link between a failure mode and the skill
 * that addresses it is **causal by construction**. hoppr could have inferred it
 * instead, by noting that a mined skill and a correction came from the same
 * transcript, and that inference would have been wrong in the ordinary case: a
 * session usually contains one mistake and several unrelated pieces of work.
 * Presenting a coincidence as "this prevents that" is exactly the confident
 * nonsense the promotion gate, the refuter and the attribution check all exist
 * to refuse, and it would be a poor place to start making an exception.
 *
 * So a guardrail is mined FROM the mode, and `skills.prevents` records which
 * one. Nothing else writes that column.
 */
const GuardrailOut = z.object({
  slug: z.string().min(2),
  name: z.string().min(2),
  description: z.string().min(10),
  body: z.string().min(20),
  reusable: z.boolean().default(true),
  confidence: z.number().min(0).max(1).default(0.5),
  problem: z.string().default(''),
})

export interface GuardrailStats {
  modes: number
  proposed: number
  /** Modes the miner itself declined — not a repeatable mistake with a fix. */
  declined: number
  /** Drafts that failed the promotion gate. */
  weak: number
  logLine: string
}

export interface GuardrailResult {
  slug: string
  mode: string
  description: string
  body: string
  turns: number
  sessions: number
}

/**
 * How many of the person's own quotes go into the prompt.
 *
 * Enough that the model can see the shape repeat, few enough that they do not
 * crowd out the transcript excerpts. Eight is roughly where a mode stops
 * looking like an anecdote and starts looking like a habit.
 */
const MAX_QUOTES = 8
/** Sessions shown in full-ish. The mode is already the summary. */
const MAX_SESSIONS = 4

export async function mineGuardrails(
  db: Db,
  l: Layout,
  cfg: Config,
  llm: LlmProvider,
  modes: FailureMode[],
  opts: { onProgress?: (m: string) => void } = {},
): Promise<{ stats: GuardrailStats; results: GuardrailResult[] }> {
  const stats: GuardrailStats = {
    modes: modes.length,
    proposed: 0,
    declined: 0,
    weak: 0,
    logLine: '',
  }
  const results: GuardrailResult[] = []
  const prompt = await loadPrompt(l, 'guardrail-mine')

  for (const m of modes) {
    opts.onProgress?.(`writing a guardrail for ${m.mode}`)
    let draft: z.infer<typeof GuardrailOut>
    try {
      const res = await llm.completeJson({
        prompt: render(prompt.template, {
          mode: m.mode,
          headline: m.headline,
          sessions: m.rawIds.length,
          turns: m.turns,
          severity: m.severity,
          quotes: m.quotes
            .slice(0, MAX_QUOTES)
            .map((q) => `> ${q}`)
            .join('\n>\n'),
          evidence: renderEvidence(db, m),
        }),
        tier: prompt.tier,
        purpose: 'guardrails.mine',
        schema: GuardrailOut,
        maxTokens: 3072,
      })
      recordCall(db, llm.id, 'guardrails.mine', prompt.tier, res.usage, true)
      draft = res.value
    } catch (e) {
      opts.onProgress?.(`guardrail failed for ${m.mode}: ${(e as Error).message.slice(0, 60)}`)
      continue
    }

    // The miner declining is a real answer and the prompt asks for it. A mode
    // can cluster tokens without being one failure, and a guardrail about
    // nothing is worse than a gap: it loads into every session and matches
    // everything.
    if (!draft.reusable) {
      stats.declined++
      opts.onProgress?.(`declined ${m.mode}: ${draft.problem.slice(0, 80)}`)
      continue
    }

    const slug = slugify(draft.slug).slice(0, 48)
    if (!slug) continue

    // The same gate procedures face. A guardrail clears the pitfalls check by
    // construction — the failure is the reason it exists — but it still has to
    // name a real trigger and carry real steps, which is where a model asked
    // for a "rule" most often returns a slogan.
    const gate = promotionGate({
      slug,
      description: draft.description,
      body: draft.body,
      evidenceCount: m.rawIds.length,
      reusable: draft.reusable,
      confidence: draft.confidence,
      minEvidence: cfg.skills.min_evidence,
      minConfidence: cfg.skills.min_confidence,
    })
    if (!gate.pass) {
      stats.weak++
      opts.onProgress?.(`weak ${slug}: ${gate.failures[0]}`)
      continue
    }

    await writeGuardrail(db, l, slug, draft, m, prompt.hash)
    stats.proposed++
    results.push({
      slug,
      mode: m.mode,
      description: draft.description,
      body: draft.body,
      turns: m.turns,
      sessions: m.rawIds.length,
    })
  }

  stats.logLine = stats.proposed ? `${stats.proposed} guardrails` : ''
  return { stats, results }
}

/**
 * The transcript around each correction, not the whole session.
 *
 * A guardrail is written from moments, and a moment is a few hundred lines wide.
 * Handing over four entire sessions would bury the five spans that matter under
 * everything else those afternoons contained.
 */
function renderEvidence(db: Db, m: FailureMode): string {
  const rows = m.rows.slice(0, MAX_SESSIONS)
  const out: string[] = []
  for (const r of rows) {
    const s = db
      .prepare<{ title: string; text: string }>(
        "SELECT COALESCE(title,'') AS title, text FROM raw WHERE id = :id",
      )
      .get({ id: r.raw_id })
    if (!s?.text) continue
    out.push(`### session ${r.raw_id} — ${s.title}\n\n${around(s.text, r.quote)}`)
  }
  return out.length ? out.join('\n\n---\n\n') : '_transcripts unavailable_'
}

/**
 * The span containing the quote, with room either side to see what led there.
 *
 * Searched from `## Transcript` onward. A rendered session repeats every user
 * turn in a `## Prompts` block above the body, so a whole-document search
 * finds the quote there first — and windows around a list of other prompts,
 * which is the one piece of context that says nothing about what the agent
 * did. The body is where the pairing lives.
 */
function around(text: string, quote: string, width = 3000): string {
  const from = Math.max(0, text.indexOf('\n## Transcript'))
  const needle = quote.slice(0, 40).toLowerCase()
  const at = needle ? text.toLowerCase().indexOf(needle, from) : -1
  if (at < 0) return clip(text, width)
  return text.slice(Math.max(from, at - width), at + Math.floor(width / 2))
}

async function writeGuardrail(
  db: Db,
  l: Layout,
  slug: string,
  draft: z.infer<typeof GuardrailOut>,
  m: FailureMode,
  promptHash: string,
): Promise<void> {
  const now = Date.now()
  db.prepare(
    // `path` is set, which is what enrols this in the hand-edit check in
    // `reconcileSkills`. Editing a guardrail is the same signal as editing a
    // mined procedure — someone read it, used it, and had to correct it — and
    // a row with a NULL path is skipped by that scan entirely.
    `INSERT INTO skills(slug,name,description,path,state,kind,prevents,evidence_count,confidence,created,updated,prompt_hash,body_hash)
     VALUES (:slug,:name,:desc,:path,'proposed','guardrail',:mode,:n,:conf,:now,:now,:ph,:bh)
     ON CONFLICT(slug) DO UPDATE SET
       name=:name, description=:desc, path=:path, prevents=:mode, evidence_count=:n,
       confidence=:conf, updated=:now, prompt_hash=:ph, body_hash=:bh,
       state = CASE WHEN skills.state = 'rejected' THEN 'rejected' ELSE skills.state END`,
  ).run({
    slug,
    path: l.rel(l.skillFile(slug)),
    name: draft.name,
    desc: draft.description,
    mode: m.mode,
    n: m.rawIds.length,
    conf: draft.confidence,
    now,
    ph: promptHash,
    bh: contentHash(draft.body),
  })
  for (const raw of m.rawIds) {
    db.prepare(
      "INSERT OR IGNORE INTO skill_sources(slug, raw_id, role) VALUES (:s,:r,'failure')",
    ).run({ s: slug, r: raw })
  }
  stampBody(db, slug, draft.body)

  await writeIfChanged(
    l.skillFile(slug),
    buildPage({ name: slug, description: draft.description }, draft.body),
  )
  await writeIfChanged(
    l.skillMeta(slug),
    `${JSON.stringify(
      {
        slug,
        managed_by: 'hoppr',
        kind: 'guardrail',
        state: 'proposed',
        prevents: m.mode,
        evidence_count: m.rawIds.length,
        confidence: draft.confidence,
        sources: m.rawIds.map((raw_id) => ({ raw_id, role: 'failure' })),
      },
      null,
      2,
    )}\n`,
  )
}
