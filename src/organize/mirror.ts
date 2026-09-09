import type { Config } from '../config/schema.ts'
import { isoDate } from '../core/ids.ts'
import type { Db } from '../db/driver.ts'
import { writeIfChanged } from '../store/atomic.ts'
import type { Layout } from '../store/layout.ts'
import { correctionTotals, type FailureMode } from './corrections.ts'
import type { GuardrailResult } from './guardrails.ts'
import { currentLessons } from './lessons.ts'
import { resolveWants } from './wants.ts'

/**
 * The report a person reads first.
 *
 * Everything else hoppr builds is a queue: proposals to triage, pages to
 * browse, a table to query. All of it is work handed back to the person who
 * asked for help, and it is why a store's first minute is flat — you point the
 * tool at a year of your own history and it answers with chores.
 *
 * This is the other thing the corpus can produce, and only this corpus can:
 * a reading of how you and your agent actually work together, in your own
 * words. Two halves, and the order matters.
 *
 *   recognition — what hoppr now knows about you, quoted. The reaction being
 *                 aimed at is "how does it know that", and it is earned only
 *                 by citation: a paraphrase reads as a horoscope.
 *   prevention  — what keeps going wrong, ranked by what it cost, each with
 *                 the skill written to stop it and one command to install it.
 *
 * Deliberately NOT a personality profile. "You are a pragmatic backend
 * engineer who values directness" is unfalsifiable, unactionable, and would
 * spend the credibility the quoted half earns. Every line here traces to
 * something someone typed.
 */
export interface MirrorInput {
  modes: FailureMode[]
  guardrails: GuardrailResult[]
  /** Modes shown in the report. The rest are counted, not listed. */
  top?: number
}

export interface Mirror {
  markdown: string
  /** Store-relative path it was written to, when written. */
  path?: string
  /** Nothing to say yet — a new store with no session history. */
  empty: boolean
}

const TOP = 6

export async function buildMirror(
  db: Db,
  l: Layout,
  cfg: Config,
  input: MirrorInput,
): Promise<Mirror> {
  const corpus = corpusStats(db)
  const totals = correctionTotals(db)
  const top = input.top ?? TOP
  const modes = input.modes.slice(0, top)
  const byMode = new Map(input.guardrails.map((g) => [g.mode, g]))

  const out: string[] = []
  out.push(`# What your sessions say`, '')

  if (corpus.sessions === 0) {
    return {
      markdown: `${out.join('\n')}\n_No agent sessions indexed yet._\n`,
      empty: true,
    }
  }

  out.push(
    `Read from **${corpus.read} of ${corpus.sessions} sessions**` +
      `${corpus.span ? ` spanning ${corpus.span}` : ''}` +
      `${corpus.sources.length ? `, captured from ${corpus.sources.join(', ')}` : ''}.`,
    '',
    'Every line below quotes something you typed. Nothing here is inferred from',
    'style, tone, or what the assistant said about you.',
    '',
  )
  // Say how much of the corpus this actually covers.
  //
  // The header used to name the store's total, which is a different number:
  // reading is watermarked per session, so a store with 346 captures and one
  // pass behind it produced a report over 48 of them under a headline claiming
  // all 346. On a page whose whole argument is that every line is sourced,
  // that is the one sentence that must not be approximately true.
  if (corpus.read < corpus.sessions) {
    out.push(
      `_${corpus.sessions - corpus.read} sessions have not been read for corrections yet — ` +
        'run `hoppr deep` (or `hoppr skills mine`) to cover them._',
      '',
    )
  }

  // ── half one: recognition ───────────────────────────────────
  const wants = (await resolveWants(l, cfg)).ledgers
  const ledgerBlocks: string[] = []
  for (const w of wants) {
    const rows = currentLessons(db, w.name)
    if (rows.length === 0) continue
    ledgerBlocks.push(
      `### ${w.heading} — ${rows.length}`,
      '',
      ...rows
        .slice(0, 6)
        .map((r) => `- **${r.subject}** — ${r.statement}\n  > ${oneLine(r.quote)}`),
      rows.length > 6 ? `\n_…and ${rows.length - 6} more in \`skills/${w.name}/SKILL.md\`._` : '',
      '',
    )
  }
  if (ledgerBlocks.length) {
    out.push('## What hoppr now knows', '', ...ledgerBlocks)
  }

  // ── half two: prevention ────────────────────────────────────
  if (modes.length === 0) {
    out.push(
      '## Where the agent failed you',
      '',
      // "These sessions ran clean" is a finding. Saying it about sessions
      // nobody has read is the report making up the one thing it is for.
      corpus.read === 0
        ? 'Not read yet — run `hoppr deep` (or `hoppr skills mine`) and come back.'
        : 'Nothing recurring found. Either those sessions ran clean, or there are not\nenough of them yet for a pattern to separate from noise.',
      '',
    )
  } else {
    out.push(
      '## Where the agent failed you',
      '',
      `In those sessions you corrected the agent **${totals.corrections} times** across`,
      `${totals.sessions} sessions, costing roughly **${totals.turns} turns** of rework.`,
      'Turn counts are estimates read off the transcripts, not measurements.',
      '',
      'Ranked by what each cost you, not by how often it happened. Turns burned,',
      'weighted by severity — a mistake that shipped or deleted something counts for',
      'far more than one you caught in a turn, and that weighting is a judgement',
      'rather than a measurement.',
      '',
    )
    modes.forEach((m, i) => {
      const g = byMode.get(m.mode)
      out.push(
        `### ${i + 1}. ${m.headline}`,
        '',
        `\`${m.mode}\` · **~${m.turns} turns** across ${m.rawIds.length} ` +
          `session${m.rawIds.length === 1 ? '' : 's'} · severity \`${m.severity}\``,
        '',
        'You said:',
        '',
        ...m.quotes.slice(0, 3).map((q) => `> ${oneLine(q)}`),
        '',
      )
      if (g) {
        out.push(
          `**The fix — \`${g.slug}\`**`,
          '',
          `${g.description}`,
          '',
          '```bash',
          `hoppr skills show ${g.slug}      # read it first`,
          `hoppr skills install ${g.slug}   # into ~/.claude/skills`,
          '```',
          '',
        )
      } else {
        out.push(
          '_No guardrail written for this one — the miner did not find a repeatable fix._',
          '',
        )
      }
    })
    if (input.modes.length > modes.length) {
      out.push(
        `_${input.modes.length - modes.length} further failure modes were found and are ` +
          'in `corrections`; they cost less than the ones above._',
        '',
      )
    }
  }

  out.push(
    '## Next',
    '',
    '```bash',
    'hoppr skills review          # everything proposed, costliest first',
    'hoppr skills install hoppr   # the front door: standing context, one file',
    'hoppr mirror                 # rebuild this report',
    '```',
    '',
    '_Generated by hoppr. Regenerate freely — it is derived, not authored._',
  )

  const markdown = `${out.join('\n')}\n`
  const path = `${l.outputs}/mirror-${isoDate(new Date())}.md`
  await writeIfChanged(path, markdown)
  return { markdown, path: l.rel(path), empty: false }
}

interface CorpusStats {
  sessions: number
  /** Of those, the ones actually read for corrections. */
  read: number
  span: string
  sources: string[]
}

function corpusStats(db: Db): CorpusStats {
  const r = db
    .prepare<{ n: number; read: number; first: number; last: number }>(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(corrections_at IS NOT NULL), 0) AS read,
              MIN(COALESCE(created, captured)) AS first,
              MAX(COALESCE(created, captured)) AS last
         FROM raw WHERE kind = 'session' AND partial = 0`,
    )
    .get()
  const sources = db
    .prepare<{ source: string }>(
      "SELECT DISTINCT source FROM raw WHERE kind = 'session' AND source IS NOT NULL",
    )
    .all()
    .map((s) => s.source.replace(/^connector:/, ''))
    .sort()

  const days = r?.first && r?.last ? Math.max(1, Math.round((r.last - r.first) / 86_400_000)) : 0
  return {
    sessions: r?.n ?? 0,
    read: r?.read ?? 0,
    span: days >= 60 ? `${Math.round(days / 30)} months` : days ? `${days} days` : '',
    sources,
  }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 220)
}
