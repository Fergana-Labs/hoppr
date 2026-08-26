import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { Config } from '../config/schema.ts'
import type { Db } from '../db/driver.ts'
import { type LlmProvider, recordCall } from '../llm/index.ts'
import type { Layout } from '../store/layout.ts'
import { loadPrompt, render } from '../store/prompts.ts'
import { recordOutcome, refreshLifecycles } from './reliability.ts'
import { listSkills } from './skills.ts'

/**
 * Did the skill actually help?
 *
 * Reliability was built from rejections, hand-edits, uninstalls and `skills
 * mark` — every one of them a record of a human INTERVENING. That makes it a
 * correction rate: a skill nobody has touched scores well because nothing went
 * visibly wrong, not because anything went right.
 *
 * The real signal was in the transcripts the whole time. An installed skill is
 * invoked in a later session, and what happened next is right there. hivemind
 * gets at this by hooking the invocation live and judging immediately; hoppr
 * already ingests every session, so it can ask the same question one pass
 * later without a hook, a daemon, or a server.
 *
 * The judge is deliberately biased toward `succeeded`, which is the opposite of
 * the refuter's bias, and for the opposite reason. Refusing a NEW skill costs
 * one rediscovery. Demoting a WORKING one destroys something earned — so a
 * judge that guesses on thin evidence would quietly retire skills for being
 * hard to read rather than for being wrong.
 */
const JudgeOut = z.object({
  succeeded: z.boolean(),
  confidence: z.number().min(0).max(1).default(0.5),
  reason: z.string().default(''),
})

export interface UsageStats {
  sessionsRead: number
  invocations: number
  failures: number
  logLine: string
}

/** How much of what followed an invocation the judge is shown. */
const WINDOW_CHARS = 9000
/** And a little of what came before, so the judge knows what was being asked. */
const LEAD_CHARS = 1200

/**
 * Every point in a transcript where one of these skills was loaded.
 *
 * Matches the rendered tool line — `→ Skill: {"command":"deploy-hoppr"}` — which
 * is why the connector captures a tool call's input and not just its name. A
 * bare `→ Skill` records that a skill was used and not which one, leaving the
 * only question worth asking unanswerable.
 *
 * The slug must appear as a whole word: `deploy` must not match `deploy-hoppr`,
 * or one skill collects another's verdicts.
 */
export function findInvocations(
  text: string,
  slugs: string[],
): Array<{ slug: string; at: number }> {
  const hits: Array<{ slug: string; at: number }> = []
  for (const m of text.matchAll(/^→\s+Skill:?\s*(.*)$/gim)) {
    const arg = m[1] ?? ''
    for (const slug of slugs) {
      if (new RegExp(`(^|[^\\w-])${escapeRe(slug)}([^\\w-]|$)`).test(arg)) {
        hits.push({ slug, at: (m.index ?? 0) + m[0].length })
      }
    }
  }
  return hits
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The work that followed an invocation, with enough lead-in to see the ask. */
export function windowAround(text: string, at: number): string {
  return text.slice(Math.max(0, at - LEAD_CHARS), at + WINDOW_CHARS)
}

/**
 * Judge every installed skill's use in sessions not yet looked at.
 *
 * Only `installed` skills are judged. A proposal has never been in anyone's
 * context, so a session cannot contain its use — and an accepted-but-uninstalled
 * skill is only reachable by an agent reading the store directly, which leaves
 * no invocation to find.
 */
export async function judgeSkillUsage(
  db: Db,
  l: Layout,
  cfg: Config,
  llm: LlmProvider,
  opts: { limit?: number; onProgress?: (m: string) => void } = {},
): Promise<UsageStats> {
  const st: UsageStats = { sessionsRead: 0, invocations: 0, failures: 0, logLine: '' }
  if (!cfg.skills.enabled) return st

  const installed = listSkills(db).filter((s) => s.state === 'installed')
  if (installed.length === 0) {
    // Nothing has shipped, so nothing can have been used. Sessions are left
    // unmarked rather than burned through: the first installed skill should be
    // judged against the history that already exists.
    st.logLine = ''
    return st
  }
  const slugs = installed.map((s) => s.slug)

  const pending = db
    .prepare<{ id: string; text: string }>(
      `SELECT id, text FROM raw
        WHERE kind = 'session' AND partial = 0 AND text IS NOT NULL AND usage_at IS NULL
        ORDER BY captured DESC LIMIT :n`,
    )
    .all({ n: opts.limit ?? 40 })
  if (pending.length === 0) return st

  const prompt = await loadPrompt(l, 'skill-judge')
  const bodies = new Map<string, string>()

  for (const session of pending) {
    // One verdict per skill per session. A skill invoked four times in one
    // session is one piece of evidence about that session, not four — the same
    // reason clustering counts distinct sessions rather than mentions.
    const seen = new Set<string>()
    for (const hit of findInvocations(session.text, slugs)) {
      if (seen.has(hit.slug)) continue
      seen.add(hit.slug)

      if (!bodies.has(hit.slug)) {
        bodies.set(hit.slug, await readFile(l.skillFile(hit.slug), 'utf8').catch(() => ''))
      }
      const body = bodies.get(hit.slug) ?? ''
      if (!body) continue

      let verdict: z.infer<typeof JudgeOut>
      try {
        const res = await llm.completeJson({
          prompt: render(prompt.template, {
            skill: body.slice(0, 3000),
            window: windowAround(session.text, hit.at),
          }),
          tier: prompt.tier,
          purpose: 'skills.judge',
          schema: JudgeOut,
          maxTokens: 1024,
        })
        recordCall(db, llm.id, 'skills.judge', prompt.tier, res.usage, true)
        verdict = res.value
      } catch {
        // A judge that cannot run must not count against the skill. Unlike the
        // refuter, silence here means "no evidence", not "no confidence".
        continue
      }

      st.invocations++
      if (!verdict.succeeded) st.failures++
      recordOutcome(
        db,
        hit.slug,
        verdict.succeeded ? 'pass' : 'fail',
        'used',
        verdict.reason.slice(0, 200),
      )
    }
    db.prepare('UPDATE raw SET usage_at = :at WHERE id = :id').run({
      at: Date.now(),
      id: session.id,
    })
    st.sessionsRead++
  }

  if (st.invocations > 0) refreshLifecycles(db, cfg.skills.archive_below)
  st.logLine = st.invocations
    ? `skill use — ${st.invocations} judged, ${st.failures} did not land`
    : ''
  return st
}
