import { z } from 'zod'
import type { Config } from '../config/schema.ts'
import { contentHash } from '../core/hash.ts'
import type { Db } from '../db/driver.ts'
import { type LlmProvider, recordCall } from '../llm/index.ts'
import { writeIfChanged } from '../store/atomic.ts'
import { buildPage, parsePage } from '../store/frontmatter.ts'
import type { Layout } from '../store/layout.ts'
import { loadPrompt, render } from '../store/prompts.ts'
import { listCases } from './cases.ts'
import {
  recordPrincipleUse,
  renderPrinciples,
  retrievePrinciples,
  seedPrinciples,
} from './principles.ts'
import { type SkillVerdict, verifySkill } from './replay.ts'
import { promotionGate } from './skillify.ts'
import { stampBody } from './skills.ts'

/**
 * Fix a skill the bench rejected, and stop as soon as it passes.
 *
 * The loop hoppr could not run before. `organize/revise.ts` bounds its edits
 * and remembers rejected ones, but it has never had anything to revise
 * *toward* — it gates a rewrite on the promotion gate and the refuter, both of
 * which read the prose. So a revision could only be checked for being
 * plausible, and plausible was the property already failing.
 *
 * Three things make this a loop rather than a retry.
 *
 *  - **Preservation constraints, derived rather than declared.** SkillRevise's
 *    diagnosis is (verification spec, failure attribution, preservation
 *    constraints), and the third was the piece hoppr had no way to produce.
 *    The bench answers it directly: the cases this version already passes are
 *    exactly what must not break.
 *  - **First passing candidate wins.** Not the best-scoring one. Selection is
 *    on verifier success before utility, so a later candidate that might have
 *    scored higher is never generated — which is the point, since scoring
 *    higher on a proxy is how a revision gets worse while looking better.
 *  - **Screen cheap, confirm expensive.** A round samples each case once,
 *    because three draws per case per round would triple an already costly
 *    loop to reject candidates that a single draw rejects just as well. The
 *    candidate that survives is then re-run at full samples before it is
 *    kept — a decision to SHIP has to meet the bar the bench actually sets.
 */
const RepairOut = z.object({
  body: z.string().min(20),
  changed: z.array(z.string()).default([]),
  principles: z.array(z.string()).default([]),
  abandon: z.boolean().default(false),
  reason: z.string().default(''),
})

export interface RepairResult {
  slug: string
  rounds: number
  outcome: 'kept' | 'unchanged' | 'abandoned' | 'no-diagnosis'
  before?: SkillVerdict
  after?: SkillVerdict
  changed: string[]
  detail: string
}

/** Rounds per episode. SkillRevise's default, and their ablations barely move it. */
const BUDGET = 3

export async function repairSkill(
  db: Db,
  l: Layout,
  cfg: Config,
  llm: LlmProvider,
  slug: string,
  opts: { onProgress?: (m: string) => void; budget?: number; cases?: number } = {},
): Promise<RepairResult> {
  seedPrinciples(db)
  const { readFile } = await import('node:fs/promises')
  const original = await readFile(l.skillFile(slug), 'utf8').catch(() => '')
  if (!original) {
    const { HopprError } = await import('../core/errors.ts')
    throw HopprError.notFound(`no skill '${slug}'`)
  }
  const { data, body: startBody } = parsePage(original)

  const res: RepairResult = { slug, rounds: 0, outcome: 'unchanged', changed: [], detail: '' }
  const perSide = opts.cases ?? 4

  opts.onProgress?.(`scoring ${slug} before repair`)
  const before = await verifySkill(db, l, cfg, llm, slug, startBody, {
    onProgress: opts.onProgress,
    ownMode: perSide,
    offMode: perSide,
  })
  res.before = before
  if (before.pass) {
    res.detail = 'already passes the bench'
    return res
  }
  if (before.results.length === 0) {
    res.outcome = 'no-diagnosis'
    res.detail = before.why
    return res
  }
  // Repairing on an inconclusive failure is the expensive version of acting on
  // noise: the loop would spend a hundred model calls rewriting a skill that
  // the next run scores as passing. Measured here — the same skill scored
  // fail, then pass, on unchanged cases.
  if (!before.conclusive) {
    res.outcome = 'no-diagnosis'
    res.detail = before.why
    return res
  }

  const prompt = await loadPrompt(l, 'skill-repair')
  let current = startBody
  const budget = opts.budget ?? BUDGET

  for (let round = 1; round <= budget; round++) {
    res.rounds = round
    const scored =
      round === 1 ? before : await screen(db, l, cfg, llm, slug, current, perSide, opts)
    const failing = scored.results.filter(
      (r) => r.verdict === 'regression' || (scored.ownTested > 0 && r.verdict === 'both-fail'),
    )
    const preserved = scored.results.filter(
      (r) => r.verdict === 'prevents' || r.verdict === 'inert',
    )
    if (failing.length === 0 && scored.pass) break

    const diagnosis = failing.map((f) => `${f.verdict} on ${f.mode}: ${f.reason}`).join('\n')
    const principles = retrievePrinciples(db, diagnosis || scored.why)

    opts.onProgress?.(`repairing ${slug} (round ${round})`)
    const ctx = {
      skill: current,
      failures: renderCases(db, failing, scored) || '_the skill prevented nothing it claims to_',
      preserve: renderCases(db, preserved, scored) || '_nothing yet — no case is known to work_',
      principles: renderPrinciples(principles),
    }

    // A round exists to fix the FAILURES. Spending one on a formatting slip is
    // waste, and it was the common case: on the first real episode two of
    // three rounds died on "no boundary section", the reviser having dropped a
    // required heading the prompt had already asked for. So a gate complaint
    // goes straight back and is retried inside the round; only a second
    // failure costs the round.
    let out: z.infer<typeof RepairOut> | undefined
    let gate: ReturnType<typeof promotionGate> | undefined
    let complaint = ''
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await llm.completeJson({
          prompt: render(prompt.template, { ...ctx, retry: complaint }),
          tier: prompt.tier,
          purpose: 'skills.repair',
          schema: RepairOut,
          maxTokens: 4096,
        })
        recordCall(db, llm.id, 'skills.repair', prompt.tier, r.usage, true)
        out = r.value
      } catch (e) {
        res.detail = `repair call failed: ${(e as Error).message.slice(0, 80)}`
        out = undefined
        break
      }
      if (out.abandon) break

      gate = promotionGate({
        slug,
        description: String(data.description ?? ''),
        body: out.body,
        evidenceCount: 1,
        reusable: true,
        confidence: 1,
        minEvidence: 1,
        minConfidence: 0,
      })
      if (gate.pass) break
      complaint = [
        '## Your previous draft was rejected before it could be tested',
        '',
        'For reasons that have nothing to do with the failures above:',
        '',
        ...gate.failures.map((f) => `- ${f}`),
        '',
        'Fix exactly those and keep everything else about the draft. These are',
        'structural requirements, not judgements about the content.',
      ].join('\n')
      opts.onProgress?.(`round ${round}: ${gate.failures[0]}, retrying`)
    }
    if (!out) break

    // "This skill should not exist" is a real answer and the prompt asks for
    // it. A reviser with no exit narrows a skill until it stops firing, which
    // makes the failures disappear without fixing anything.
    if (out.abandon) {
      res.outcome = 'abandoned'
      res.detail = out.reason || 'the reviser judged the skill unsalvageable'
      note(db, slug, round, principles, 'rejected', res.detail)
      return res
    }

    if (gate && !gate.pass) {
      note(db, slug, round, principles, 'rejected', gate.failures[0] ?? 'failed the gate')
      opts.onProgress?.(`round ${round} rejected: ${gate.failures[0]}`)
      continue
    }

    const candidate = await screen(db, l, cfg, llm, slug, out.body, perSide, opts)
    if (!candidate.pass) {
      note(db, slug, round, principles, 'rejected', candidate.why)
      recordPrincipleUse(
        db,
        principles.map((p) => p.id),
        false,
      )
      opts.onProgress?.(`round ${round} did not clear the bench: ${candidate.why}`)
      // Keep it as the base anyway when it is strictly better — a partial
      // repair is a better starting point for the next round than the version
      // that failed everything.
      if (candidate.regressions === 0 && candidate.prevents > scored.prevents) current = out.body
      continue
    }

    // Screened at one draw. Confirm at the bar the bench actually sets before
    // shipping — a decision to keep has to meet the standard, not the screen.
    opts.onProgress?.(`confirming round ${round}`)
    const confirmed = await verifySkill(db, l, cfg, llm, slug, out.body, {
      onProgress: opts.onProgress,
      ownMode: perSide,
      offMode: perSide,
    })
    if (!confirmed.pass) {
      note(
        db,
        slug,
        round,
        principles,
        'rejected',
        `screened clean, failed confirmation: ${confirmed.why}`,
      )
      recordPrincipleUse(
        db,
        principles.map((p) => p.id),
        false,
      )
      continue
    }

    await writeIfChanged(l.skillFile(slug), buildPage(data as Record<string, unknown>, out.body))
    stampBody(db, slug, out.body)
    db.prepare('UPDATE skills SET updated = :now, prompt_hash = :ph WHERE slug = :s').run({
      now: Date.now(),
      ph: contentHash(out.body),
      s: slug,
    })
    recordPrincipleUse(
      db,
      principles.map((p) => p.id),
      true,
    )
    note(db, slug, round, principles, 'kept', confirmed.why)
    res.outcome = 'kept'
    res.after = confirmed
    res.changed = out.changed
    res.detail = confirmed.why
    return res
  }

  res.detail = res.detail || `no candidate cleared the bench in ${res.rounds} round(s)`
  return res
}

/** A cheap pass: one draw per case, enough to reject a candidate. */
function screen(
  db: Db,
  l: Layout,
  cfg: Config,
  llm: LlmProvider,
  slug: string,
  body: string,
  perSide: number,
  opts: { onProgress?: (m: string) => void },
): Promise<SkillVerdict> {
  return verifySkill(db, l, cfg, llm, slug, body, {
    onProgress: opts.onProgress,
    ownMode: perSide,
    offMode: perSide,
    samples: 1,
  })
}

function renderCases(db: Db, results: SkillVerdict['results'], _v: SkillVerdict): string {
  if (results.length === 0) return ''
  const byId = new Map(listCases(db, { limit: 400 }).map((c) => [c.id, c]))
  return results
    .map((r) => {
      const c = byId.get(r.caseId)
      if (!c) return `- **${r.mode}** — ${r.reason}`
      return [
        `### ${r.mode} · ${r.verdict}`,
        `The agent was about to: ${c.wrong_move.slice(0, 300)}`,
        `The person said: "${c.correction.slice(0, 200)}"`,
        `The bench found: ${r.reason.slice(0, 300)}`,
      ].join('\n')
    })
    .join('\n\n')
}

function note(
  db: Db,
  slug: string,
  round: number,
  principles: Array<{ id: string; defect: string }>,
  outcome: 'kept' | 'rejected',
  detail: string,
): void {
  db.prepare(
    `INSERT INTO revisions(slug, round, at, principles, outcome, detail)
     VALUES (:s,:r,:at,:p,:o,:d)`,
  ).run({
    s: slug,
    r: round,
    at: Date.now(),
    p: principles.map((p) => p.defect).join(','),
    o: outcome,
    d: detail.slice(0, 300),
  })
}

export function revisionHistory(
  db: Db,
  slug: string,
): Array<{ round: number; at: number; principles: string; outcome: string; detail: string }> {
  return db
    .prepare<{ round: number; at: number; principles: string; outcome: string; detail: string }>(
      'SELECT round, at, principles, outcome, detail FROM revisions WHERE slug = :s ORDER BY at DESC',
    )
    .all({ s: slug })
}
