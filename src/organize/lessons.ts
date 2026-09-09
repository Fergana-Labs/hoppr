import { z } from 'zod'
import type { Config } from '../config/schema.ts'
import { sha256 } from '../core/hash.ts'
import type { Db } from '../db/driver.ts'
import { type LlmProvider, recordCall } from '../llm/index.ts'
import type { Layout } from '../store/layout.ts'
import { clip, loadPrompt, render } from '../store/prompts.ts'
import { PROCEDURE, resolveWants } from './wants.ts'

/**
 * A lesson is one thing a session established that a future agent should know.
 *
 * This replaces clustering transcripts by their tool trace. That approach found
 * exactly one shape of skill — the tool-heavy debugging loop — because its
 * signature was built from tool names, shell commands, and error classes. Every
 * other shape produced an empty signature and stayed invisible no matter how
 * often it recurred:
 *
 *   "keep the copy plain, never the word delightful"    → no tools, no commands
 *   "contracts live in Drive under Legal, not the repo" → no tools, no commands
 *   "we call the nightly run the deep pass"             → no tools, no commands
 *
 * Extraction now happens a level up, per session, and clustering happens over
 * the extracted claims. That is the right grain: two sessions that each mention
 * deploying once share a lesson subject even when they share no tool calls.
 */
export type LessonKind = string

const LessonOut = z.object({
  session: z.string().default(''),
  // Open rather than an enum: the ledger kinds are declared in config now, so
  // the valid set is not knowable at compile time. Validated against the
  // resolved list below instead, which is the same check one layer later.
  kind: z.string().min(1),
  subject: z.string().min(1).max(120),
  statement: z.string().min(4),
  quote: z.string().default(''),
  strength: z.enum(['must', 'prefer']).default('prefer'),
  outcome: z.enum(['worked', 'failed', 'mixed', 'unknown']).default('unknown'),
  confidence: z.number().min(0).max(1).default(0.5),
})
const ExtractOut = z.object({ lessons: z.array(LessonOut).default([]) })

export interface LessonRow {
  id: string
  raw_id: string
  kind: LessonKind
  subject: string
  statement: string
  quote: string
  /** Graded bins only: is this a constraint or a default? */
  strength: 'must' | 'prefer'
  /** Procedures only: did the approach work in that session? */
  outcome: 'worked' | 'failed' | 'mixed' | 'unknown'
  confidence: number
  observed: number
}

export interface ExtractStats {
  sessionsRead: number
  lessons: number
  byKind: Record<string, number>
  failed: number
  /** Ledger claims whose quote was not found in anything the human wrote. */
  unattributed: number
}

/**
 * Sessions per LLM call. Batched because per-call overhead dominates a short
 * extraction, and an unbatched backfill over a year of history is slow enough
 * that people cancel it.
 */
const BATCH = 4

/**
 * Extract lessons from sessions never read for them.
 *
 * Once-ever per session rather than once-per-pass: a transcript is immutable,
 * so re-reading one can only spend tokens arriving at the same answer.
 */
export async function extractLessons(
  db: Db,
  l: Layout,
  cfg: Config,
  llm: LlmProvider,
  opts: { limit?: number; onProgress?: (m: string) => void } = {},
): Promise<ExtractStats> {
  const st: ExtractStats = { sessionsRead: 0, lessons: 0, byKind: {}, failed: 0, unattributed: 0 }

  const pending = db
    .prepare<{ id: string; title: string; text: string; observed: number }>(
      `SELECT id, COALESCE(title,'') AS title, text,
              COALESCE(created, captured) AS observed
         FROM raw
        WHERE kind = 'session' AND partial = 0 AND text IS NOT NULL
          AND lessons_at IS NULL
        ORDER BY captured DESC LIMIT :n`,
    )
    .all({ n: opts.limit ?? 40 })
  if (pending.length === 0) return st

  const prompt = await loadPrompt(l, 'lesson-extract')
  const per = Math.max(2000, Math.floor(prompt.maxInputChars / BATCH))
  const wants = (await resolveWants(l, cfg)).ledgers
  const valid = new Set([...wants.map((w) => w.name.toLowerCase()), PROCEDURE])
  // The prompt defines every bin it knows; this store collects a subset. The
  // definitions stay in one readable place rather than being rendered in, and
  // the active list is named so the model does not spend effort on a bin whose
  // results would be thrown away by the `valid` check below.
  const active = [...wants.map((w) => w.name), PROCEDURE].map((n) => `\`${n}\``).join(', ')

  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH)
    opts.onProgress?.(`reading ${batch.length} sessions for lessons`)
    let out: z.infer<typeof ExtractOut>
    try {
      const res = await llm.completeJson({
        prompt: render(prompt.template, {
          active,
          kind_names: [...valid].join(' | '),
          sessions: batch
            .map((s) => `### session ${s.id}\n${s.title}\n\n${clip(s.text, per)}`)
            .join('\n\n---\n\n'),
        }),
        tier: prompt.tier,
        purpose: 'lessons.extract',
        schema: ExtractOut,
        maxTokens: 4096,
      })
      recordCall(db, llm.id, 'lessons.extract', prompt.tier, res.usage, true)
      out = res.value
    } catch (e) {
      st.failed += batch.length
      opts.onProgress?.(`lesson extraction failed: ${(e as Error).message.slice(0, 80)}`)
      // Leave lessons_at NULL so the next pass retries. A transient provider
      // failure must not permanently blind us to these sessions.
      continue
    }

    const byId = new Map(batch.map((s) => [s.id, s]))
    const speech = new Map(batch.map((s) => [s.id, userSpeech(s.text)]))
    for (const lsn of out.lessons) {
      // Same provenance discipline as skill mining: never trust the model's
      // echo of an id. Transcripts contain their own session UUIDs and models
      // reliably return those instead. A single-session batch has an
      // unambiguous answer; a multi-session batch with an unresolvable id is
      // dropped, because a citation pointing at the wrong session is worse
      // than no citation at all.
      const src = byId.get(lsn.session) ?? (batch.length === 1 ? batch[0] : undefined)
      if (!src) continue
      // A lesson without its quote was inferred rather than observed, and the
      // whole value of a ledger is that every line traces to something the
      // person actually said.
      if (!lsn.quote.trim()) continue

      // And for a ledger, "said" means SAID — by the human, not the agent.
      //
      // Measured on eight real transcripts: four of six extracted preferences
      // quoted hoppr's own curation prompts, which appear in the transcript as
      // ordinary text because an agent that reads a prompt file has that file
      // in its context. Left alone, the preferences ledger fills up with the
      // tool's own voice reflected back and cited as though the user had said
      // it. Attribution is checkable, so we check it rather than asking the
      // model to be careful.
      // Anything the config did not declare is dropped rather than stored: a
      // model that invents a fourth kind would create a ledger nobody asked
      // for and no prompt described.
      if (!valid.has(lsn.kind)) continue
      if (lsn.kind !== PROCEDURE && !quotedByUser(lsn.quote, speech.get(src.id) ?? '')) {
        st.unattributed++
        continue
      }

      const subject = normalizeSubject(lsn.subject)
      if (!subject) continue
      const id = sha256(`${src.id} ${lsn.kind} ${subject}`).slice(0, 24)
      db.prepare(
        `INSERT INTO lessons(id, raw_id, kind, subject, statement, quote, strength, outcome, confidence, observed, created)
         VALUES (:id,:raw,:kind,:subj,:stmt,:quote,:str,:out,:conf,:obs,:now)
         ON CONFLICT(id) DO UPDATE SET
           statement = :stmt, quote = :quote, strength = :str, outcome = :out, confidence = :conf`,
      ).run({
        id,
        raw: src.id,
        kind: lsn.kind,
        subj: subject,
        stmt: lsn.statement.trim(),
        quote: lsn.quote.trim().slice(0, 400),
        str: lsn.strength,
        out: lsn.outcome,
        conf: lsn.confidence,
        obs: src.observed || Date.now(),
        now: Date.now(),
      })
      st.lessons++
      st.byKind[lsn.kind] = (st.byKind[lsn.kind] ?? 0) + 1
    }

    for (const s of batch) {
      db.prepare('UPDATE raw SET lessons_at = :at WHERE id = :id').run({ at: Date.now(), id: s.id })
      st.sessionsRead++
    }
  }
  return st
}

/**
 * Lowercase, collapse whitespace, drop surrounding punctuation — so "Deep Pass"
 * and "deep pass." supersede each other instead of accumulating as two lines.
 */
export function normalizeSubject(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s_]+/g, ' ')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9)\]]+$/, '')
    .trim()
    .slice(0, 120)
}

/**
 * The current state of one kind: the newest statement per subject.
 *
 * Supersession is by `observed`, not insertion order, so backfilling March
 * after August cannot overwrite August's answer with a stale one. Superseded
 * rows stay in the table — `hoppr skills why` reads them — and the ledger file
 * is in git, so a reversal reads as a diff rather than a silent deletion.
 */
export function currentLessons(db: Db, kind: LessonKind): LessonRow[] {
  return db
    .prepare<LessonRow>(
      `SELECT l.* FROM lessons l
        WHERE l.kind = :k
          AND l.id = (
            SELECT l2.id FROM lessons l2
             WHERE l2.kind = l.kind AND l2.subject = l.subject
             ORDER BY l2.observed DESC, l2.id ASC LIMIT 1
          )
        ORDER BY l.subject`,
    )
    .all({ k: kind })
}

export interface ProcedureCluster {
  subject: string
  rawIds: string[]
  statements: string[]
  /** Captures where the approach worked — what a revision must preserve. */
  successIds: string[]
  /** Captures where it failed or went wrong first. These have priority: the
   *  pitfalls are here, and pitfalls are the reason to mine a transcript. */
  failureIds: string[]
}

/**
 * Group procedure lessons by what they are about.
 *
 * Exact subject match first, then a token-overlap merge so "deploy hoppr" and
 * "deploying the hoppr package" land together. Deliberately not embeddings:
 * subjects are three-word verb phrases the extractor already normalized, the
 * embedding provider is an optional dependency, and a cluster that needs a
 * 384-dimension vector to notice two phrases share "deploy" is not one anyone
 * would defend in review.
 */
export function clusterProcedures(db: Db, minSize: number): ProcedureCluster[] {
  const rows = db
    .prepare<LessonRow>(
      "SELECT * FROM lessons WHERE kind = 'procedure' ORDER BY observed DESC LIMIT 400",
    )
    .all()

  const groups: Array<{ subject: string; tokens: Set<string>; rows: LessonRow[] }> = []
  for (const r of rows) {
    const tokens = contentTokens(r.subject)
    const hit = groups.find(
      (g) => g.subject === r.subject || (tokens.size > 0 && jaccard(g.tokens, tokens) >= 0.5),
    )
    if (hit) {
      hit.rows.push(r)
      for (const t of tokens) hit.tokens.add(t)
    } else {
      groups.push({ subject: r.subject, tokens, rows: [r] })
    }
  }

  return groups
    .map((g) => ({
      subject: g.subject,
      // Distinct SESSIONS, not distinct lessons: one session that mentions a
      // task three times is one piece of evidence, not three.
      rawIds: [...new Set(g.rows.map((r) => r.raw_id))],
      statements: [...new Set(g.rows.map((r) => r.statement))],
      successIds: [...new Set(g.rows.filter((r) => r.outcome === 'worked').map((r) => r.raw_id))],
      failureIds: [
        ...new Set(
          g.rows
            .filter((r) => r.outcome === 'failed' || r.outcome === 'mixed')
            .map((r) => r.raw_id),
        ),
      ],
    }))
    .filter((g) => g.rawIds.length >= minSize)
    .sort((a, b) => b.rawIds.length - a.rawIds.length)
}

const STOP = new Set([
  'the',
  'a',
  'an',
  'to',
  'for',
  'of',
  'and',
  'in',
  'on',
  'with',
  'this',
  'our',
  'my',
  'how',
])

export function contentTokens(s: string): Set<string> {
  const out = new Set<string>()
  for (const w of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP.has(w)) continue
    // Crude stem so "deploy" and "deploying" match. Real stemming would mean a
    // dependency to resolve a handful of gerunds.
    out.add(w.replace(/(ing|ed|es|s)$/, ''))
  }
  return out
}

/**
 * Does this cluster subject match one of the subjects a person asked for?
 *
 * Containment rather than similarity: a target is a short phrase like "cutting
 * a release", and the cluster subject that should match it is "cut a release
 * for the cli" — longer, more specific, and scoring poorly on any symmetric
 * measure. What matters is that every content word of the target appears.
 */
export function matchesTarget(subject: string, targets: string[]): boolean {
  const subj = contentTokens(subject)
  return targets.some((t) => {
    const want = contentTokens(t)
    if (want.size === 0) return false
    for (const w of want) if (!subj.has(w)) return false
    return true
  })
}

/** Shared with `organize/corrections.ts`, which clusters failure modes the same way. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const x of a) if (b.has(x)) shared++
  return shared / (a.size + b.size - shared)
}

/**
 * Everything in a transcript the human actually typed.
 *
 * Two markers, both written by `renderTranscript` for every connector: the
 * `## Prompts` block, which keeps user turns verbatim and uncapped, and the
 * `**user:**` lines in the body. Assistant prose, tool output, and any file
 * the agent happened to read are all outside both.
 */
export function userSpeech(sessionText: string): string {
  // Harness injections arrive inside user-role messages and therefore inside
  // the Prompts block — reminders, memory recalls, skill listings, CLAUDE.md
  // content. They are normative prose in the second person, which is the exact
  // shape of a preference, and 59 of 346 real sessions here contain one. The
  // person did not type any of it.
  const text = sessionText.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
  const parts: string[] = []
  const prompts = /\n## Prompts\n([\s\S]*?)(?=\n## |$)/.exec(text)
  if (prompts?.[1]) parts.push(prompts[1].replace(/^> ?/gm, ''))
  for (const m of text.matchAll(/^\*\*user:\*\*[ \t]?(.*)$/gm)) parts.push(m[1] ?? '')
  return matchable(parts.join('\n'))
}

/** Lowercase, collapse whitespace, drop the quote marks models normalize away. */
function matchable(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d`'"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function quotedByUser(quote: string, speech: string): boolean {
  const q = matchable(quote)
  // Too short to attribute: "no" appears in every transcript ever written.
  if (q.length < 12 || speech.length === 0) return false
  if (speech.includes(q)) return true
  // Models trim a span or join it across lines. A long verbatim prefix is
  // still attribution; a paraphrase will not survive 40 characters.
  return speech.includes(q.slice(0, 40))
}
