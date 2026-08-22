import type { Config } from '../config/schema.ts'
import { docId, upsertDoc } from '../db/docs.ts'
import type { Db } from '../db/driver.ts'
import { writeIfChanged } from '../store/atomic.ts'
import { buildPage } from '../store/frontmatter.ts'
import { Layout } from '../store/layout.ts'
import { isHandsOff } from './handsoff.ts'
import { currentLessons, type LessonRow } from './lessons.ts'
import { stampBody } from './skills.ts'
import { resolveWants, type Want } from './wants.ts'

/**
 * Ledger skills — vocabulary, preferences, locations.
 *
 * Three standing skills that accumulate rather than being mined one at a time,
 * because that is the shape of the knowledge. There is one answer to "what does
 * this person mean by hoppr" and one answer to "where do the contracts live",
 * and both belong in a single file an agent can read once.
 *
 * **Assembled by code, not by a model.** The statements were already written by
 * the extractor, one sentence each; grouping them by subject and taking the
 * newest is exactly the kind of work that code does perfectly and a nightly
 * model call does differently every time. hoppr already makes this call for
 * `wiki/index.md`, and the same three reasons apply: the diff stays legible,
 * the citations stay exact, and rebuilding costs nothing.
 *
 * Supersession is by observation time and the older row is not deleted, so a
 * reversed preference reads as a one-line diff in git with both dates visible
 * through `git log --follow`.
 */
export interface LedgerStats {
  written: number
  proposed: number
  entries: number
  /** Things that need saying: an auto-install that hit a conflict, say. */
  notes: string[]
  logLine: string
}

export async function buildLedgers(db: Db, l: Layout, cfg: Config): Promise<LedgerStats> {
  const st: LedgerStats = { written: 0, proposed: 0, entries: 0, notes: [], logLine: '' }
  if (!cfg.skills.enabled) return st

  // A ledger line is a verbatim quote of something this person typed,
  // assembled by code, superseded on change, and a one-line diff in git. A
  // mined procedure is a model's prose about how work gets done. Making
  // someone triage the first to reach the second is how a review queue stops
  // being read, so they get different defaults.
  const autoAccept = cfg.skills.approve !== 'review'

  for (const spec of (await resolveWants(l, cfg)).ledgers) {
    const kind = spec.name
    const rows = currentLessons(db, kind)
    // An empty ledger is not written at all. A skill whose body says "nothing
    // recorded yet" still costs every future session the tokens to read it.
    if (rows.length === 0) continue

    const existing = db
      .prepare<{ state: string }>('SELECT state FROM skills WHERE slug = :s')
      .get({ s: spec.name })

    // A rejected ledger stays rejected: the answer to "I do not want hoppr
    // tracking my preferences" has to survive the next nightly pass.
    if (existing?.state === 'rejected') continue
    // Hand-edited: keep the evidence links current, leave the prose alone.
    if (isHandsOff(cfg, l, `skills/${spec.name}/SKILL.md`)) {
      for (const r of rows) addLedgerEvidence(db, spec.name, r.raw_id)
      continue
    }

    const body = renderLedger(spec.heading, rows, spec.graded === true)
    const changed = await writeIfChanged(
      l.skillFile(spec.name),
      buildPage({ name: spec.name, description: spec.description }, body),
    )
    await writeIfChanged(
      l.skillMeta(spec.name),
      `${JSON.stringify(
        {
          slug: spec.name,
          managed_by: 'hoppr',
          kind,
          state: existing?.state ?? (autoAccept ? 'accepted' : 'proposed'),
          evidence_count: rows.length,
          confidence: 1,
          sources: [...new Set(rows.map((r) => r.raw_id))].map((raw_id) => ({
            raw_id,
            role: 'exemplar',
          })),
        },
        null,
        2,
      )}\n`,
    )

    db.prepare(
      `INSERT INTO skills(slug, name, description, path, state, kind,
                          evidence_count, confidence, created, updated, prompt_hash)
       VALUES (:slug,:name,:desc,:path,:state,:kind,:n,1.0,:now,:now,'')
       ON CONFLICT(slug) DO UPDATE SET
         name = :name, description = :desc, path = :path, kind = :kind,
         evidence_count = :n, updated = :now`,
    ).run({
      slug: spec.name,
      name: spec.name,
      desc: spec.description,
      path: l.rel(l.skillFile(spec.name)),
      kind,
      state: autoAccept ? 'accepted' : 'proposed',
      n: rows.length,
      now: Date.now(),
    })
    for (const r of rows) addLedgerEvidence(db, spec.name, r.raw_id)
    // Remember what we wrote, so a later hand-edit is detectable. Without this
    // a ledger could be edited and silently regenerated on the next pass.
    stampBody(db, spec.name, body)

    upsertDoc(
      db,
      {
        id: docId.skill(spec.name),
        tier: 'curated',
        kind: 'skill',
        refId: spec.name,
        title: spec.name,
        summary: spec.description,
        body,
        created: Date.now(),
        updated: Date.now(),
      },
      { maxChars: cfg.index.chunk_chars, overlap: cfg.index.chunk_overlap },
    )

    st.entries += rows.length
    if (changed !== 'unchanged') st.written++
    if (!existing) st.proposed++

    // Not being asked means it goes all the way. `approve` answers one
    // question — does a human gate this? — and a "no" that still leaves you a
    // second command to run is not a no, it is the same two-step gate wearing
    // a different name. `approve = "review"` is how you keep the gate.
    if (autoAccept && changed !== 'unchanged') {
      const { installSkill } = await import('./skills.ts')
      const r = await installSkill(l, db, spec.name, {
        target: Layout.expand(cfg.skills.default_target),
      }).catch(() => undefined)
      if (r && (r.outcome === 'conflict' || r.outcome === 'failed')) {
        st.notes.push(`${spec.name}: accepted but not installed — ${r.detail ?? r.outcome}`)
      }
    }
  }

  // Keep the dispatcher current even if the mining stage below fails.
  if (st.written || st.proposed) {
    const { listSkills } = await import('./skills.ts')
    const { writeResolver } = await import('./skillify.ts')
    await writeResolver(l, listSkills(db))
  }

  const bits: string[] = []
  if (st.written) bits.push(`${st.written} updated`)
  if (st.proposed) bits.push(`${st.proposed} new`)
  st.logLine = bits.length ? `ledgers — ${bits.join(', ')} (${st.entries} entries)` : ''
  return st
}

function addLedgerEvidence(db: Db, slug: string, rawId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO skill_sources(slug, raw_id, role) VALUES (:s,:r,'exemplar')",
  ).run({ s: slug, r: rawId })
}

/**
 * One line per subject, each carrying the capture that established it.
 *
 * The citation is what separates this from a model's impression of how someone
 * likes to work: `hoppr skills why <slug>` walks every line back to a real
 * session, and a line nobody can trace is a line to delete.
 */
export function renderLedger(heading: string, rows: LessonRow[], graded = false): string {
  // In a graded bin the constraints go first and are labelled. An agent
  // scanning this needs to know which lines it may trade off against a good
  // reason and which it may not, and burying a MUST in a list of tastes is
  // how a constraint gets treated as advice.
  const ordered = graded
    ? [...rows].sort((a, b) => Number(b.strength === 'must') - Number(a.strength === 'must'))
    : rows
  const lines = ordered.map((r) => {
    const mark = graded ? `${r.strength === 'must' ? '**MUST** ' : ''}` : ''
    return `- ${mark}**${r.subject}** — ${r.statement} \`[${day(r.observed)} · ${short(r.raw_id)}]\``
  })
  const legend = graded
    ? [
        '',
        'Lines marked **MUST** are constraints. The rest are defaults you may',
        'override with a stated reason.',
      ]
    : []
  return [
    `## ${heading}`,
    '',
    ...lines,
    ...legend,
    '',
    '## Maintaining this skill',
    '',
    'hoppr assembles this file from statements found in past sessions. Every line',
    'cites the capture it came from; `hoppr skills why` resolves the citations.',
    '',
    'A newer statement about the same subject replaces the older one rather than',
    'sitting alongside it — `git log --follow` on this file is the history.',
    '',
    'Edit this file by hand and hoppr stops rewriting it, but keeps its evidence',
    'links current.',
    '',
  ].join('\n')
}

function day(ms: number): string {
  return new Date(ms || Date.now()).toISOString().slice(0, 10)
}

/** Enough of the id to find the capture, short enough not to wreck the line. */
function short(id: string): string {
  return id.slice(0, 10)
}

/** Which ledger a slug is, if it is one. Slug and kind are the same name now. */
export async function ledgerFor(l: Layout, cfg: Config, slug: string): Promise<Want | undefined> {
  return (await resolveWants(l, cfg)).ledgers.find((w) => w.name === slug)
}

export interface LedgerEntry extends LessonRow {
  /** A later statement about the same subject replaced this one. */
  superseded: boolean
}

/**
 * Every statement behind a ledger, superseded ones included.
 *
 * `skills why` on a mined procedure lists the sessions it came from. That is
 * the wrong answer for a ledger, where the interesting question is per LINE:
 * who said this, in what words, and what did it replace. Keeping the older
 * rows is what makes the second half answerable.
 */
export function ledgerHistory(db: Db, kind: string): LedgerEntry[] {
  const rows = db
    .prepare<LessonRow>(
      'SELECT * FROM lessons WHERE kind = :k ORDER BY subject ASC, observed DESC, id ASC',
    )
    .all({ k: kind })
  const seen = new Set<string>()
  return rows.map((r) => {
    const superseded = seen.has(r.subject)
    seen.add(r.subject)
    return { ...r, superseded }
  })
}
