import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { Config } from '../config/schema.ts'
import { HopprError } from '../core/errors.ts'
import { contentHash } from '../core/hash.ts'
import { slugify } from '../core/ids.ts'
import { docId, upsertDoc } from '../db/docs.ts'
import type { Db } from '../db/driver.ts'
import { type LlmProvider, recordCall } from '../llm/index.ts'
import { writeIfChanged } from '../store/atomic.ts'
import { buildPage, parsePage } from '../store/frontmatter.ts'
import { Layout } from '../store/layout.ts'
import { clip, loadPrompt, render } from '../store/prompts.ts'
import { checkGrounding } from './grounding.ts'
import { isHandsOff, markHandsOff } from './handsoff.ts'
import {
  clusterProcedures,
  currentLessons,
  matchesTarget,
  type ProcedureCluster,
} from './lessons.ts'
import { recordOutcome, refreshLifecycles } from './reliability.ts'
import { applyEdits, editDigest, ReviseOut, rejectedEdits, rememberRejection } from './revise.ts'
import { promotionGate, writeResolver } from './skillify.ts'
import { resolveWants } from './wants.ts'

const SkillOut = z.object({
  slug: z.string().min(2),
  name: z.string().min(2),
  description: z.string().min(10),
  body: z.string().min(20),
  evidence: z.array(z.string()).default([]),
  /**
   * Would this apply to a DIFFERENT instance of the same job?
   *
   * This replaced "did it happen three times". Recurrence was a crude proxy
   * for generalizability, and a bad one in both directions: it discarded a
   * clearly reusable procedure seen once, and admitted a one-off that merely
   * happened to repeat. A model reading the transcript can answer the real
   * question directly, so it is asked directly.
   */
  reusable: z.boolean().default(false),
  confidence: z.number().min(0).max(1).default(0.5),
})
const MineOut = z.object({ skills: z.array(SkillOut) })
const VerifyOut = z.object({
  supported: z.boolean(),
  problem: z.string().default(''),
  notes: z.array(z.string()).default([]),
})

/** `weak` = mined but failed the promotion gate; kept for audit, never proposed. */
export type SkillState = 'proposed' | 'accepted' | 'installed' | 'rejected' | 'weak'

export interface SkillRow {
  slug: string
  name: string
  description: string
  path: string | null
  state: SkillState
  /** 'procedure' for mined skills; a ledger kind for the standing ones. */
  kind: string
  /** probationary | active | archived — see `organize/reliability.ts`. */
  lifecycle: string
  /** Hash of the body hoppr last wrote; a mismatch on disk is a hand-edit. */
  body_hash: string
  evidence_count: number
  confidence: number
}

export interface MineStats {
  candidates: number
  proposed: number
  updated: number
  rejectedAgain: number
  /** Mined but gated out — did not earn a place in every future session. */
  weak: number
  /** Drafts a verification pass could not support from their own evidence. */
  refuted: number
  /** Existing skills changed by bounded edits rather than rewritten. */
  revised: number
  logLine: string
}

/**
 * Mine procedure skills out of past agent sessions.
 *
 * This is the feature that closes the loop: session history stops being
 * exhaust and becomes capability. Three constraints keep it honest.
 *
 *  - **Clustered on what a session established, not on its tool trace.**
 *    Sessions arrive here already reduced to typed claims by
 *    `extractLessons`, grouped by the task they are about. The earlier version
 *    clustered raw transcripts on shared tool and error vocabulary, which
 *    found flaky-test debugging and nothing else — "how we deploy" and "how we
 *    answer inbound sales" have no tool vocabulary to share.
 *  - **The failures are the payload.** A transcript where someone tried A,
 *    hit B, and landed on C encodes the wrong turn — which is the only part
 *    the existing README does not already have.
 *  - **Proposed, never auto-installed.** A skill changes how every future
 *    agent session behaves. That earns thirty seconds of human attention, and
 *    it is the one place in hoppr that is deliberately not automatic.
 */
export async function mineSkills(
  db: Db,
  l: Layout,
  cfg: Config,
  llm: LlmProvider,
  opts: { limit?: number; onProgress?: (m: string) => void } = {},
): Promise<MineStats> {
  const st: MineStats = {
    candidates: 0,
    proposed: 0,
    updated: 0,
    rejectedAgain: 0,
    weak: 0,
    refuted: 0,
    revised: 0,
    logLine: '',
  }
  if (!cfg.skills.enabled) {
    st.logLine = 'skill mining disabled'
    return st
  }

  // `off` stops procedure mining without stopping the ledgers, which is a
  // distinction worth having: the ledgers are assembled by code from claims
  // already extracted, so they cost nothing, while mining is a quality-tier
  // call per cluster with genuinely uncertain precision.
  if (cfg.skills.mine === 'off') {
    st.logLine = 'skill mining off — ledgers still build'
    return st
  }

  const all = clusterProcedures(db, cfg.skills.min_evidence)
  // `targeted` mines only the subjects you named. Auto-mining a corpus you
  // know well mostly re-proposes what you already do; naming the gaps is more
  // useful than being told your own habits.
  const wanted = (await resolveWants(l, cfg)).find
  const clusters =
    cfg.skills.mine === 'targeted' ? all.filter((c) => matchesTarget(c.subject, wanted)) : all
  st.candidates = clusters.length
  if (clusters.length === 0) {
    if (cfg.skills.mine === 'targeted') {
      st.logLine = wanted.length
        ? `skill mining — nothing matched ${wanted.length} wanted subject(s) in ${all.length} clusters`
        : 'skill mining — `mine = "targeted"` with nothing in `[skills] find`'
      return st
    }
    const seen = db
      .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM lessons WHERE kind = 'procedure'")
      .get()?.n
    st.logLine = seen
      ? `skill mining — ${seen} procedures seen, none in ${cfg.skills.min_evidence} sessions yet`
      : 'skill mining — no procedures extracted yet'
    return st
  }

  const prompt = await loadPrompt(l, 'skill-mine')
  const rejected = new Set(
    db
      .prepare<{ slug: string }>("SELECT slug FROM skills WHERE state = 'rejected'")
      .all()
      .map((r) => r.slug),
  )

  for (const group of clusters.slice(0, 5)) {
    const cluster = sessionsFor(db, group)
    if (cluster.length < cfg.skills.min_evidence) continue
    opts.onProgress?.(`mining '${group.subject}' from ${cluster.length} sessions`)
    let out: z.infer<typeof MineOut>
    try {
      const res = await llm.completeJson({
        prompt: render(prompt.template, {
          subject: group.subject,
          statements: group.statements.map((x) => `- ${x}`).join('\n'),
          // Successes and failures go in separately. Pooling them and asking
          // for a pitfalls section at the end is a weaker version of the same
          // idea: a failure buried among four successes reads as an anecdote,
          // while a block of failures exposes the error that recurs.
          successes: renderSessions(cluster.filter((c) => group.successIds.includes(c.id))),
          failures: renderSessions(cluster.filter((c) => group.failureIds.includes(c.id))),
          sessions: renderSessions(cluster),
          // The ledgers as context, not as content. A procedure written
          // without them says "deploy to the usual place"; written with them
          // it uses the person's own word for the thing and the location they
          // already told us about.
          context: ledgerContext(db, group),
        }),
        tier: prompt.tier,
        purpose: 'skills.mine',
        schema: MineOut,
        maxTokens: 8192,
      })
      recordCall(db, llm.id, 'skills.mine', prompt.tier, res.usage, true)
      out = res.value
    } catch (e) {
      opts.onProgress?.(`mining failed: ${(e as Error).message.slice(0, 80)}`)
      continue
    }

    for (const s of out.skills) {
      const slug = slugify(s.slug)
      if (rejected.has(slug)) {
        // A rejection is remembered: re-proposing what a human already
        // declined would make the review queue useless.
        st.rejectedAgain++
        continue
      }

      // Never trust the model's echo of an id. Transcripts contain their own
      // session UUIDs, and models reliably return those instead of the ids we
      // handed them — which silently breaks the provenance chain that makes a
      // mined skill auditable. We KNOW which captures went into this call, so
      // resolve against the cluster and fall back to the whole cluster.
      const known = new Set(cluster.map((c) => c.id))
      const valid = s.evidence.filter((e) => known.has(e))
      // NONE valid means the model echoed ids it read inside the transcripts;
      // fall back to the cluster, whose membership we know. SOME valid but too
      // few is a real signal that the skill is thin — respect it and drop.
      const sources = valid.length === 0 ? cluster.map((c) => c.id) : valid

      // The promotion gate. An installed skill is loaded into EVERY future
      // session, so the bar is "does this earn that", not "is this true".
      const gate = promotionGate({
        slug,
        description: s.description,
        body: s.body,
        evidenceCount: sources.length,
        reusable: s.reusable,
        confidence: s.confidence,
        minEvidence: cfg.skills.min_evidence,
        minConfidence: cfg.skills.min_confidence,
      })
      if (!gate.pass) {
        st.weak++
        opts.onProgress?.(`gated out ${slug}: ${gate.failures[0]}`)
        db.prepare(
          `INSERT INTO skills(slug,name,description,path,state,kind,evidence_count,confidence,created,updated,prompt_hash)
           VALUES (:slug,:name,:desc,NULL,'weak','procedure',:n,:conf,:now,:now,:ph)
           ON CONFLICT(slug) DO UPDATE SET
             description=:desc, evidence_count=:n, confidence=:conf, updated=:now,
             state = CASE WHEN skills.state IN ('proposed','weak') THEN 'weak' ELSE skills.state END`,
        ).run({
          slug,
          name: s.name,
          desc: s.description,
          n: sources.length,
          conf: s.confidence,
          now: Date.now(),
          ph: prompt.hash,
        })
        continue
      }

      // Evidence grounding. The promotion gate asks whether a draft READS
      // like a skill, and every one of its checks passes on a confident
      // invention. This asks whether the commands it tells a future agent to
      // run were ever actually run. A skill instructing `npm run deploy:prod`
      // when no transcript ever did is a hallucination wearing a citation.
      const evidenceText = cluster
        .filter((c) => sources.includes(c.id))
        .map((c) => c.text)
        .join('\n')
      // The last check, and the only one that reads the evidence: an agent
      // misreading what happened and writing it down as fact. Every cheap
      // check above passes on that — the prose is confident, the structure is
      // right, the steps are plausible, and the sessions simply do not say it.
      const verdict = await verifyDraft(db, l, llm, s, cluster, sources, evidenceText, opts)
      if (!verdict.supported) {
        st.refuted++
        opts.onProgress?.(`refuted ${slug}: ${verdict.problem.slice(0, 60)}`)
        recordWeak(db, slug, s, sources.length, prompt.hash)
        continue
      }

      const existing = db.prepare<SkillRow>('SELECT * FROM skills WHERE slug = :s').get({ s: slug })
      const handsOff = existing ? isHandsOff(cfg, l, `skills/${slug}/SKILL.md`) : false

      // An existing skill is REVISED, not rewritten. Regenerating it whole
      // every time its evidence grows erases rules that were earned and
      // overfits the result to whatever went wrong most recently.
      if (existing && !handsOff && existing.state !== 'proposed') {
        const r = await reviseExisting(
          db,
          l,
          cfg,
          llm,
          existing,
          group,
          cluster,
          evidenceText,
          opts,
        )
        if (r === 'revised') st.revised++
        for (const raw of sources) addEvidence(db, slug, raw)
        continue
      }

      if (handsOff) {
        // Hand-edited: keep accruing evidence, leave the prose alone.
        for (const raw of cluster.map((c) => c.id)) addEvidence(db, slug, raw)
        st.updated++
        continue
      }

      await writeSkillFiles(db, l, slug, s, sources)
      db.prepare(
        `INSERT INTO skills(slug,name,description,path,state,kind,evidence_count,confidence,created,updated,prompt_hash)
         VALUES (:slug,:name,:desc,:path,:state,'procedure',:n,:conf,:now,:now,:ph)
         ON CONFLICT(slug) DO UPDATE SET
           name=:name, description=:desc, path=:path, evidence_count=:n,
           confidence=:conf, updated=:now, prompt_hash=:ph,
           state = CASE WHEN skills.state = 'rejected' THEN 'rejected' ELSE skills.state END`,
      ).run({
        slug,
        name: s.name,
        desc: s.description,
        path: l.rel(l.skillFile(slug)),
        // Only `auto` skips review for a mined procedure. `ledgers` covers the
        // three code-assembled lists, whose lines are quotes; a procedure is a
        // model's prose about how work gets done and is a different risk.
        state: cfg.skills.approve === 'auto' ? 'accepted' : 'proposed',
        n: sources.length,
        conf: s.confidence,
        now: Date.now(),
        ph: prompt.hash,
      })
      for (const raw of sources) addEvidence(db, slug, raw)

      upsertDoc(
        db,
        {
          id: docId.skill(slug),
          tier: 'curated',
          kind: 'skill',
          refId: slug,
          title: s.name,
          summary: s.description,
          body: s.body,
          created: Date.now(),
          updated: Date.now(),
        },
        { maxChars: cfg.index.chunk_chars, overlap: cfg.index.chunk_overlap },
      )

      if (existing) st.updated++
      else st.proposed++
    }
  }

  // Lifecycle before the resolver: an archived skill must not be dispatched,
  // and the floor is configurable, so it is applied here where config exists.
  refreshLifecycles(db, cfg.skills.archive_below)
  // Keep the dispatcher current so an agent never has to load every skill.
  await writeResolver(l, listSkills(db))

  const bits: string[] = []
  if (st.proposed) bits.push(`${st.proposed} proposed`)
  if (st.updated) bits.push(`${st.updated} updated`)
  if (st.revised) bits.push(`${st.revised} revised`)
  if (st.weak) bits.push(`${st.weak} gated out`)
  if (st.refuted) bits.push(`${st.refuted} refuted`)
  st.logLine = bits.length
    ? `skill mining — ${bits.join(', ')}${st.proposed ? ' (review with `hoppr skills review`)' : ''}`
    : 'skill mining — nothing new'
  return st
}

/**
 * Adversarial verification: try to refute the draft against its own evidence.
 *
 * Framed as refutation rather than review, and defaulting to refuted under
 * uncertainty, because the costs are not close. A skill that should exist and
 * does not costs one session's rediscovery. A confident wrong one is loaded
 * into every session from now on, and is believed precisely because it arrives
 * with citations.
 *
 * The unsupported-command list goes in as a signal rather than a verdict — a
 * transcript can be truncated, or record a command as prose rather than a
 * shell line, but a skill telling a future agent to run something nobody ever
 * ran is the clearest form of the failure being hunted.
 */
async function verifyDraft(
  db: Db,
  l: Layout,
  llm: LlmProvider,
  draft: z.infer<typeof SkillOut>,
  cluster: SessionLike[],
  sources: string[],
  evidenceText: string,
  opts: { onProgress?: (m: string) => void },
): Promise<z.infer<typeof VerifyOut>> {
  const ground = checkGrounding(draft.body, evidenceText)
  const prompt = await loadPrompt(l, 'skill-verify')
  try {
    const res = await llm.completeJson({
      prompt: render(prompt.template, {
        unsupported: ground.invented.length
          ? ground.invented.map((c) => `- \`${c}\``).join('\n')
          : '_none — every command it names was actually run_',
        skill: `# ${draft.name}\n\n${draft.description}\n\n${draft.body}`,
        sessions: renderSessions(cluster.filter((c) => sources.includes(c.id))),
      }),
      tier: prompt.tier,
      purpose: 'skills.verify',
      schema: VerifyOut,
      maxTokens: 2048,
    })
    recordCall(db, llm.id, 'skills.verify', prompt.tier, res.usage, true)
    return res.value
  } catch (e) {
    // A verifier that cannot run does not get to wave things through. The
    // whole point is that unverified is the same as unsupported here.
    opts.onProgress?.(`verify failed: ${(e as Error).message.slice(0, 60)}`)
    return { supported: false, problem: 'verification did not run', notes: [] }
  }
}

function renderSessions(rows: SessionLike[]): string {
  if (rows.length === 0) return '_none_'
  return rows
    .map((s) => `### session ${s.id}\n${s.title}\n\n${clip(s.text, 8000)}`)
    .join('\n\n---\n\n')
}

/**
 * The ledgers, filtered to what this procedure plausibly touches.
 *
 * MSCE's L3 environmental cognition "provides environmental priors that
 * instantiate parameters without overwriting the skill procedure" — their
 * example is a dependency-install skill choosing apt, apk or brew from what L3
 * says the environment is. The ledger is context for writing the procedure,
 * never content to copy into it, which is why this goes in a separate block
 * the prompt is told not to restate.
 *
 * Filtered rather than dumped whole: a vocabulary of two hundred terms would
 * crowd out the transcripts, which are the thing actually being mined.
 */
function ledgerContext(db: Db, group: ProcedureCluster): string {
  const words = new Set(
    `${group.subject} ${group.statements.join(' ')}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  )
  const lines: string[] = []
  for (const kind of ['vocabulary', 'location'] as const) {
    for (const row of currentLessons(db, kind)) {
      const subj = row.subject
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
      if (subj.some((w) => words.has(w))) {
        lines.push(`- (${kind}) **${row.subject}** — ${row.statement}`)
      }
    }
  }
  // Preferences are unfiltered: there are few of them, they are short, and a
  // preference about how work is described applies to every procedure written.
  for (const row of currentLessons(db, 'preference')) {
    lines.push(`- (preference) **${row.subject}** — ${row.statement}`)
  }
  return lines.length ? lines.slice(0, 25).join('\n') : '_nothing recorded yet_'
}

function recordWeak(
  db: Db,
  slug: string,
  s: z.infer<typeof SkillOut>,
  n: number,
  promptHash: string,
): void {
  db.prepare(
    `INSERT INTO skills(slug,name,description,path,state,kind,evidence_count,confidence,created,updated,prompt_hash)
     VALUES (:slug,:name,:desc,NULL,'weak','procedure',:n,:conf,:now,:now,:ph)
     ON CONFLICT(slug) DO UPDATE SET
       description=:desc, evidence_count=:n, confidence=:conf, updated=:now,
       state = CASE WHEN skills.state IN ('proposed','weak') THEN 'weak' ELSE skills.state END`,
  ).run({
    slug,
    name: s.name,
    desc: s.description,
    n,
    conf: s.confidence,
    now: Date.now(),
    ph: promptHash,
  })
}

/**
 * Revise an accepted skill with at most `edit_budget` localized edits.
 *
 * The acceptance test is the honest analogue of SkillOpt's held-out validation
 * gate. They score a candidate skill on a selection split and keep it only if
 * it beats the current one; hoppr has no benchmark and no scalar reward, so it
 * gates on the two checks it CAN run — the revised body must still be grounded
 * in the evidence, and must still clear the promotion gate. That is weaker
 * than a measured score and it is not pretending otherwise. What it does buy
 * is the property their gate exists for: a revision that makes the skill worse
 * by these measures is discarded rather than shipped, because "plausible
 * textual diagnoses can still hurt the actual target model".
 *
 * Rejected edits are remembered so the next pass does not propose them again.
 */
async function reviseExisting(
  db: Db,
  l: Layout,
  cfg: Config,
  llm: LlmProvider,
  existing: SkillRow,
  group: ProcedureCluster,
  cluster: SessionLike[],
  evidenceText: string,
  opts: { onProgress?: (m: string) => void },
): Promise<'revised' | 'unchanged'> {
  const budget = cfg.skills.edit_budget
  if (budget <= 0) return 'unchanged'

  const current = await readFile(l.skillFile(existing.slug), 'utf8').catch(() => '')
  if (!current) return 'unchanged'
  const { data, body } = parsePage(current)

  const prompt = await loadPrompt(l, 'skill-revise')
  const priorRejections = rejectedEdits(db, existing.slug)
  let out: z.infer<typeof ReviseOut>
  try {
    const res = await llm.completeJson({
      prompt: render(prompt.template, {
        budget,
        current: body,
        rejected: priorRejections.length
          ? priorRejections.map((r) => `- ${r.reason}`).join('\n')
          : '_none yet_',
        successes: renderSessions(cluster.filter((c) => group.successIds.includes(c.id))),
        failures: renderSessions(cluster.filter((c) => group.failureIds.includes(c.id))),
      }),
      tier: prompt.tier,
      purpose: 'skills.revise',
      schema: ReviseOut,
      maxTokens: 6000,
    })
    recordCall(db, llm.id, 'skills.revise', prompt.tier, res.usage, true)
    out = res.value
  } catch (e) {
    opts.onProgress?.(`revise failed: ${(e as Error).message.slice(0, 60)}`)
    return 'unchanged'
  }

  const seen = new Set(priorRejections.map((r) => r.digest))
  const fresh = out.edits.filter((e) => !seen.has(editDigest(e)))
  if (fresh.length === 0) return 'unchanged'

  const { body: revised, applied } = applyEdits(body, fresh, budget)
  if (applied.length === 0) return 'unchanged'

  const reject = (why: string) => {
    for (const e of applied) rememberRejection(db, existing.slug, e, why)
    opts.onProgress?.(`revision rejected for ${existing.slug}: ${why}`)
    return 'unchanged' as const
  }

  const gate = promotionGate({
    slug: existing.slug,
    description: existing.description,
    body: revised,
    evidenceCount: group.rawIds.length,
    reusable: true, // already established when the skill was first promoted
    confidence: existing.confidence,
    minEvidence: cfg.skills.min_evidence,
    minConfidence: cfg.skills.min_confidence,
  })
  if (!gate.pass) return reject(gate.failures[0] ?? 'failed the promotion gate')

  // Same refutation pass a new draft faces. A revision is the likeliest place
  // for a misreading to enter: it is written from newer sessions the original
  // author never saw, and the edits land inside prose that already reads as
  // established fact.
  const verdict = await verifyDraft(
    db,
    l,
    llm,
    { ...existing, body: revised, evidence: group.rawIds, reusable: true },
    cluster,
    group.rawIds,
    evidenceText,
    opts,
  )
  if (!verdict.supported) return reject(verdict.problem || 'not supported by the evidence')

  await writeIfChanged(
    l.skillFile(existing.slug),
    buildPage(data as Record<string, unknown>, revised),
  )
  stampBody(db, existing.slug, revised)
  db.prepare('UPDATE skills SET updated = :now WHERE slug = :s').run({
    now: Date.now(),
    s: existing.slug,
  })
  opts.onProgress?.(`revised ${existing.slug} (${applied.length} edits)`)
  return 'revised'
}

/**
 * Remember the body hoppr wrote, so the next reconcile can tell a hand-edit
 * from its own output. Without this there is no difference on disk between
 * "hoppr generated this" and "a person rewrote it", and the correction signal
 * — the most informative one available without a benchmark — is simply lost.
 */
export function stampBody(db: Db, slug: string, body: string): void {
  db.prepare('UPDATE skills SET body_hash = :h WHERE slug = :s').run({
    h: contentHash(body),
    s: slug,
  })
}

function addEvidence(db: Db, slug: string, rawId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO skill_sources(slug, raw_id, role) VALUES (:s,:r,'exemplar')",
  ).run({ s: slug, r: rawId })
}

async function writeSkillFiles(
  db: Db,
  l: Layout,
  slug: string,
  s: z.infer<typeof SkillOut>,
  sources: string[],
) {
  stampBody(db, slug, s.body)
  // The frontmatter contract is Claude Code's SKILL.md: name + description.
  // Several other harnesses read the same shape, so one mined skill serves
  // more than one agent.
  await writeIfChanged(
    l.skillFile(slug),
    buildPage({ name: slug, description: s.description }, s.body),
  )
  await writeIfChanged(
    l.skillMeta(slug),
    `${JSON.stringify(
      {
        slug,
        managed_by: 'hoppr',
        state: 'proposed',
        evidence_count: sources.length,
        confidence: s.confidence,
        sources: sources.map((raw_id) => ({ raw_id, role: 'exemplar' })),
      },
      null,
      2,
    )}\n`,
  )
}

interface SessionLike {
  id: string
  title: string
  text: string
}

/**
 * The transcripts behind one procedure cluster.
 *
 * Clustering runs over lessons — one sentence each — because that is what makes
 * "how we deploy" and "how we handle inbound" cluster at all. Mining still
 * needs the full transcripts: the steps and the pitfalls are in the failures,
 * and a one-sentence statement of the approach has neither.
 */
function sessionsFor(db: Db, cluster: ProcedureCluster): SessionLike[] {
  if (cluster.rawIds.length === 0) return []
  const holes = cluster.rawIds.map((_, i) => `:i${i}`).join(',')
  const params: Record<string, string> = {}
  cluster.rawIds.forEach((id, i) => {
    params[`i${i}`] = id
  })
  return db
    .prepare<SessionLike>(
      `SELECT id, COALESCE(title,'') AS title, text FROM raw
        WHERE id IN (${holes}) AND text IS NOT NULL
        ORDER BY captured DESC`,
    )
    .all(params)
}

// ── review + install ────────────────────────────────────────────

/**
 * Adopt SKILL.md files that exist on disk with no index row.
 *
 * Two ways that happens and both are legitimate: the seed skills written at
 * init, and a skill directory a person dropped in by hand. Either way the file
 * is the truth and the row is bookkeeping, so the row gets created rather than
 * the file being ignored.
 *
 * Adopted skills land `accepted`, not `proposed` — nobody needs to review a
 * file they put there themselves — and marked hands-off in `.hopprignore`, so
 * curation maintains their evidence links without rewriting the prose.
 */
export async function reconcileSkills(db: Db, l: Layout, cfg: Config): Promise<number> {
  const { readdir, readFile } = await import('node:fs/promises')
  const { existsSync } = await import('node:fs')
  if (!existsSync(l.skills)) return 0

  const known = new Set(
    db
      .prepare<{ slug: string }>('SELECT slug FROM skills')
      .all()
      .map((r) => r.slug),
  )
  // A skill whose body no longer matches what hoppr wrote was edited by hand.
  // That is a person reading a skill, using it, and having to correct it —
  // the most informative signal available without a benchmark, and one hoppr
  // was already able to observe and was discarding. It pins the skill (hoppr
  // stops rewriting the prose) and records a correction against it.
  let corrected = 0
  for (const row of db
    .prepare<SkillRow>("SELECT * FROM skills WHERE body_hash <> '' AND path IS NOT NULL")
    .all()) {
    const file = `${l.skills}/${row.slug}/SKILL.md`
    if (!existsSync(file)) continue
    if (isHandsOff(cfg, l, `skills/${row.slug}/SKILL.md`)) continue
    const { body } = parsePage(await readFile(file, 'utf8').catch(() => ''))
    if (!body.trim() || contentHash(body) === row.body_hash) continue
    // Written to `.hopprignore` rather than a hidden column, so the state is
    // greppable, lands in git, and is undone by deleting the line.
    await markHandsOff(
      cfg,
      l,
      `skills/${row.slug}/**`,
      `hand-edited ${new Date().toISOString().slice(0, 10)}`,
    )
    db.prepare('UPDATE skills SET body_hash = :h WHERE slug = :s').run({
      h: contentHash(body),
      s: row.slug,
    })
    recordOutcome(db, row.slug, 'fail', 'edited', 'hand-edited after generation')
    corrected++
  }

  let adopted = 0
  for (const entry of await readdir(l.skills, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || known.has(entry.name)) continue
    const path = `${l.skills}/${entry.name}/SKILL.md`
    if (!existsSync(path)) continue
    const { data } = parsePage(await readFile(path, 'utf8').catch(() => ''))
    const d = data as Record<string, unknown>
    db.prepare(
      `INSERT OR IGNORE INTO skills
         (slug, name, description, path, state, evidence_count, confidence,
          created, updated, pass_id, prompt_hash)
       VALUES (:slug, :name, :desc, :path, 'accepted', 0, 1.0, :now, :now, 'seed', '')`,
    ).run({
      slug: entry.name,
      name: String(d.name ?? entry.name),
      desc: String(d.description ?? '')
        .replace(/\s+/g, ' ')
        .trim(),
      path: l.rel(path),
      now: Date.now(),
    })
    // A directory hoppr did not write is somebody's own file. Marking it here
    // is also what makes a RENAMED hand-edited skill keep its protection: the
    // old glob stops matching, and the new directory arrives as an unknown one.
    await markHandsOff(cfg, l, `skills/${entry.name}/**`, 'hand-written')
    adopted++
  }
  return adopted + corrected
}

export function listSkills(db: Db, state?: SkillState): SkillRow[] {
  return db
    .prepare<SkillRow>(
      state
        ? 'SELECT * FROM skills WHERE state = :s ORDER BY confidence DESC'
        : 'SELECT * FROM skills ORDER BY confidence DESC',
    )
    .all(state ? { s: state } : undefined)
}

export function setSkillState(db: Db, slug: string, state: SkillState): void {
  const r = db
    .prepare('UPDATE skills SET state = :st, updated = :now WHERE slug = :s')
    .run({ s: slug, st: state, now: Date.now() })
  if (r.changes === 0) throw HopprError.notFound(`no skill '${slug}'`)

  // A review decision IS an outcome. hoppr was already asking a human whether
  // each skill deserves to exist and then throwing the answer away once the
  // state column was set.
  if (state === 'accepted') recordOutcome(db, slug, 'pass', 'accepted')
  else if (state === 'rejected') recordOutcome(db, slug, 'fail', 'rejected')
}

export function skillEvidence(db: Db, slug: string): Array<{ raw_id: string; role: string }> {
  return db
    .prepare<{ raw_id: string; role: string }>(
      'SELECT raw_id, role FROM skill_sources WHERE slug = :s',
    )
    .all({ s: slug })
}

/**
 * Accept a skill, which means install it.
 *
 * These used to be two decisions and it was one decision too many. "Yes, this
 * is a real skill" and "yes, put it where my agent will read it" are the same
 * intent, and a queue that asks twice is a queue people stop working through —
 * the second yes gets deferred and the skill sits accepted-but-unused forever,
 * which is indistinguishable from having rejected it.
 *
 * `install` remains as its own command for the cases that genuinely differ:
 * a non-default target, `--project` scope, or re-installing after a conflict.
 */
export async function acceptSkill(
  db: Db,
  l: Layout,
  cfg: Config,
  slug: string,
  target?: string,
): Promise<SkillInstallResult> {
  setSkillState(db, slug, 'accepted')
  return installSkill(l, db, slug, {
    target: target ?? Layout.expand(cfg.skills.default_target),
  })
}

/**
 * Where each harness reads skills from.
 *
 * `SKILL.md` is Claude Code's shape and several harnesses read it, but hoppr
 * knew exactly one destination — so installing anywhere else meant knowing the
 * path yourself, for harnesses hoppr already has connectors for and can see
 * on disk. Naming them is the difference between "supported" and "possible".
 *
 * A harness missing from this list is not unsupported: `--target <dir>` writes
 * anywhere, and that stays the escape hatch for anything not listed here.
 */
export const HARNESS_TARGETS: Record<string, string> = {
  'claude-code': '~/.claude/skills',
  openclaw: '~/.openclaw/skills',
  codex: '~/.codex/skills',
  opencode: '~/.config/opencode/skills',
}

/** The harnesses that actually exist on this machine, by their config dir. */
export function detectedHarnesses(): string[] {
  return Object.keys(HARNESS_TARGETS).filter((h) => {
    const root = Layout.expand(HARNESS_TARGETS[h]!).replace(/\/skills$/, '')
    return existsSync(root)
  })
}

export type InstallOutcome = 'installed' | 'skipped' | 'conflict' | 'failed'

export interface SkillInstallResult {
  slug: string
  target: string
  outcome: InstallOutcome
  detail?: string
}

/**
 * Install into a harness's skills directory.
 *
 * Same ownership discipline as the MCP installer: the `.hoppr.json` marker is
 * what makes a directory ours. A skill directory that exists WITHOUT it is
 * never overwritten — people hand-write skills, and silently replacing one
 * would be unforgivable.
 */
export async function installSkill(
  l: Layout,
  db: Db,
  slug: string,
  o: { target?: string; force?: boolean } = {},
): Promise<SkillInstallResult> {
  const row = db.prepare<SkillRow>('SELECT * FROM skills WHERE slug = :s').get({ s: slug })
  if (!row) throw HopprError.notFound(`no skill '${slug}'`)
  if (row.state === 'proposed' && !o.force) {
    throw HopprError.user(
      `'${slug}' is still a proposal — run \`hoppr skills review\` (or pass --force) first.\n` +
        'A skill changes how every future agent session behaves, so it gets a human gate.',
    )
  }

  const targetRoot = o.target ?? join(homedir(), '.claude', 'skills')
  const dir = join(targetRoot, slug)
  const marker = join(dir, '.hoppr.json')

  if (existsSync(dir) && !existsSync(marker) && !o.force) {
    return {
      slug,
      target: dir,
      outcome: 'conflict',
      detail: 'a skill directory exists here that hoppr did not create — refusing to overwrite',
    }
  }

  try {
    const body = await readFile(l.skillFile(slug), 'utf8')
    const meta = await readFile(l.skillMeta(slug), 'utf8').catch(() => '{}')
    const a = await writeIfChanged(join(dir, 'SKILL.md'), body)
    await writeIfChanged(marker, meta)
    // Ship the dispatcher next to the skills so the harness can route without
    // loading every SKILL.md into the turn.
    await writeIfChanged(
      join(targetRoot, 'RESOLVER.md'),
      await readFile(join(l.skills, 'RESOLVER.md'), 'utf8').catch(() => ''),
    )
    db.prepare(
      'INSERT OR REPLACE INTO skill_installs(slug, target, installed_at) VALUES (:s,:t,:at)',
    ).run({ s: slug, t: dir, at: Date.now() })
    setSkillState(db, slug, 'installed')
    return { slug, target: dir, outcome: a === 'unchanged' ? 'skipped' : 'installed' }
  } catch (e) {
    return { slug, target: dir, outcome: 'failed', detail: (e as Error).message }
  }
}

export async function uninstallSkill(
  db: Db,
  slug: string,
  target?: string,
): Promise<SkillInstallResult> {
  const dir = target ?? join(homedir(), '.claude', 'skills', slug)
  if (!existsSync(join(dir, '.hoppr.json'))) {
    return { slug, target: dir, outcome: 'skipped', detail: 'not hoppr-managed' }
  }
  const { rm } = await import('node:fs/promises')
  await rm(dir, { recursive: true, force: true })
  db.prepare('DELETE FROM skill_installs WHERE slug = :s AND target = :t').run({ s: slug, t: dir })
  // Deliberately before the state change, so the accept below does not read as
  // a fresh endorsement of a skill someone just removed.
  recordOutcome(db, slug, 'fail', 'uninstalled')
  setSkillState(db, slug, 'accepted')
  return { slug, target: dir, outcome: 'installed', detail: 'removed' }
}
