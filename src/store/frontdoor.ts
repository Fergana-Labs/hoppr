import type { Config } from '../config/schema.ts'
import type { Db } from '../db/driver.ts'
import { failureModes } from '../organize/corrections.ts'
import { currentLessons } from '../organize/lessons.ts'
import { listSkills, stampBody } from '../organize/skills.ts'
import { resolveWants } from '../organize/wants.ts'
import { writeIfChanged } from './atomic.ts'
import { buildPage } from './frontmatter.ts'
import type { Layout } from './layout.ts'

/**
 * One skill that carries everything an agent should know before it starts.
 *
 * Accepting skills used to mean scattering N directories into a harness's
 * skills folder, one per finding, each loaded only when its description
 * happens to match. That works for a procedure — "how we cut a release" is
 * situational and should stay out of the way until the situation arrives — and
 * it is exactly wrong for standing context.
 *
 * A preference has to be known BEFORE the work, not looked up during it. By
 * the time an agent notices it is writing a status update, it has already
 * chosen a register; by the time it wonders whether to ask or decide, it has
 * already asked. A dispatch table that says "consult preferences when
 * relevant" is a table nobody consults, because relevance is only visible
 * afterwards.
 *
 * So the front door inlines the standing halves — what your words mean, how
 * you want work done, what keeps going wrong — and routes to the situational
 * ones. It is one install, and the change is visible in the very next session,
 * which is the second thing this branch is trying to buy: a person who runs
 * one command and then watches their agent already know something.
 *
 * Size is the constraint that shapes everything here. This file is read at the
 * top of a task, so every line displaces attention from the task. Ledgers are
 * capped and truncation points at the full file rather than dropping silently.
 */
export const FRONT_DOOR = 'hoppr'

/** Ledger lines inlined before the rest is left to the file it came from. */
const MAX_LEDGER_LINES = 14
/** Failure modes named in the standing warning. */
const MAX_MODES = 5

export interface FrontDoorResult {
  slug: string
  /** Nothing learned yet — no file written. */
  empty: boolean
  ledgers: number
  guardrails: number
  procedures: number
  /** Skills read off the project rather than observed. */
  starters: number
}

export async function buildFrontDoor(db: Db, l: Layout, cfg: Config): Promise<FrontDoorResult> {
  const wants = (await resolveWants(l, cfg)).ledgers
  const ledgerNames = new Set(wants.map((w) => w.name))
  const ledgers = wants
    .map((w) => ({ want: w, rows: currentLessons(db, w.name) }))
    .filter((x) => x.rows.length > 0)

  const live = listSkills(db).filter(
    (s) =>
      (s.state === 'accepted' || s.state === 'installed') &&
      s.lifecycle !== 'archived' &&
      s.slug !== FRONT_DOOR,
  )
  const guardrails = live.filter((s) => s.kind === 'guardrail')
  const starters = live.filter((s) => s.kind === 'bootstrap')
  // Everything not otherwise classified is situational: mined procedures, and
  // the packaged files hoppr ships. Listing by exclusion rather than by
  // `kind === 'procedure'` is deliberate — a skill whose kind this does not
  // recognize should be routed to, not silently dropped, which is what the
  // narrower test did to every bootstrap skill.
  const procedures = live.filter(
    (s) => !['guardrail', 'bootstrap', 'frontdoor'].includes(s.kind) && !ledgerNames.has(s.slug),
  )

  const result: FrontDoorResult = {
    slug: FRONT_DOOR,
    empty: ledgers.length === 0 && live.length === 0,
    ledgers: ledgers.reduce((n, x) => n + x.rows.length, 0),
    guardrails: guardrails.length,
    procedures: procedures.length,
    starters: starters.length,
  }
  // An empty front door still costs every session the tokens to read it, and
  // says nothing. Better absent than present and blank.
  if (result.empty) return result

  // The preamble describes what is actually below it.
  //
  // A fixed "assembled from their own past sessions, every line traces to
  // something they typed" was the first thing this file said, and on a new
  // store — no ledgers yet, only skills read off the project — it was simply
  // untrue. The one file an agent reads before every task is the worst
  // possible place for a claim that is right most of the time.
  const body: string[] = ['Standing context for working with this person.', '']
  if (ledgers.length > 0) {
    body.push(
      'The lists below are assembled from their own past sessions; every line traces',
      'to something they typed.',
      '',
    )
  }
  if (starters.length > 0 && ledgers.length === 0) {
    body.push(
      'Nothing has been learned from their sessions yet — what follows was read off',
      'the project itself, and is a hypothesis rather than an observation.',
      '',
    )
  }
  body.push('Read this before choosing an approach, not after.', '')

  for (const { want, rows } of ledgers) {
    body.push(`## ${want.heading}`, '')
    // MUST before PREFER, so a scan that stops early stops on the binding half.
    const ordered = want.graded
      ? [...rows].sort((a, b) => Number(b.strength === 'must') - Number(a.strength === 'must'))
      : rows
    for (const r of ordered.slice(0, MAX_LEDGER_LINES)) {
      const mark = want.graded ? `**${r.strength.toUpperCase()}** ` : ''
      body.push(`- ${mark}**${r.subject}** — ${r.statement}`)
    }
    if (rows.length > MAX_LEDGER_LINES) {
      body.push(
        '',
        `_${rows.length - MAX_LEDGER_LINES} more in \`${l.rel(l.skillFile(want.name))}\` — ` +
          'read it when this list does not cover the case._',
      )
    }
    body.push('')
  }

  if (guardrails.length > 0) {
    const modes = new Map(failureModes(db).map((m) => [m.mode, m]))
    body.push(
      '## What goes wrong here',
      '',
      'These are mistakes that already happened in past sessions, with the cost they',
      'carried. Each has a skill; load it when its situation applies.',
      '',
      '| Watch for | Cost so far | Skill |',
      '|---|---|---|',
    )
    for (const s of guardrails.slice(0, MAX_MODES)) {
      const m = modes.get(s.prevents)
      const cost = m ? `~${m.turns} turns × ${m.rawIds.length}` : '—'
      body.push(`| ${cell(s.description)} | ${cost} | \`${s.slug}\` |`)
    }
    body.push('')
  }

  if (starters.length > 0) {
    body.push(
      '## Read off this project',
      '',
      'Not observed — detected from what is on disk here (its verify commands, its',
      'layout, its history). Treat as a hypothesis that the code can contradict.',
      '',
      '| When | Skill |',
      '|---|---|',
      ...starters.map((s) => `| ${cell(s.description)} | \`${s.slug}\` |`),
      '',
    )
  }

  if (procedures.length > 0) {
    body.push(
      '## How recurring work gets done',
      '',
      'Match the situation, then read that ONE skill. Do not load them all.',
      '',
      '| When | Skill |',
      '|---|---|',
      ...procedures.map((s) => `| ${cell(s.description)} | \`${s.slug}\` |`),
      '',
    )
  }

  // Same rule as the preamble: the footer names only what is actually here.
  // "Generated from past sessions" under a file containing nothing but
  // project detection is the overclaim moved to the bottom of the page.
  body.push(
    '## Where the rest is',
    '',
    'This file is a summary. The store it came from holds the captures behind it.',
    '',
    '```bash',
    `hoppr -H ${cfg.hopper.name} search "<what you are looking for>"`,
    ...(ledgers.length > 0
      ? ['hoppr skills why preferences   # per line: who said it, in what words']
      : []),
    '```',
    '',
    ledgers.length > 0
      ? '_Generated by hoppr. Do not hand-edit — edit the ledgers it summarizes instead._'
      : '_Generated by hoppr. Do not hand-edit — edit the skills it links to instead._',
  )

  const text = body.join('\n')
  const description =
    'Standing context about this person: what their words mean, how they want work ' +
    'done, and the mistakes that have already cost them time. Use at the START of ' +
    'any task, before choosing an approach or a tone.'

  await writeIfChanged(l.skillFile(FRONT_DOOR), buildPage({ name: FRONT_DOOR, description }, text))
  await writeIfChanged(
    l.skillMeta(FRONT_DOOR),
    `${JSON.stringify(
      { slug: FRONT_DOOR, managed_by: 'hoppr', kind: 'frontdoor', state: 'accepted' },
      null,
      2,
    )}\n`,
  )

  const now = Date.now()
  db.prepare(
    `INSERT INTO skills(slug,name,description,path,state,kind,evidence_count,confidence,created,updated)
     VALUES (:slug,:slug,:desc,NULL,'accepted','frontdoor',:n,1,:now,:now)
     ON CONFLICT(slug) DO UPDATE SET
       description=:desc, evidence_count=:n, updated=:now,
       -- Never resurrect a front door someone rejected or uninstalled.
       state = CASE WHEN skills.state IN ('rejected','accepted') THEN skills.state
                    ELSE skills.state END`,
  ).run({ slug: FRONT_DOOR, desc: description, n: result.ledgers, now })
  stampBody(db, FRONT_DOOR, text)

  return result
}

/** One table cell: single line, pipes escaped, and truncated at a word. */
function cell(s: string): string {
  const flat = s.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()
  if (flat.length <= MAX_CELL) return flat
  const cut = flat.slice(0, MAX_CELL)
  return `${cut.slice(0, cut.lastIndexOf(' ')) || cut}…`
}

const MAX_CELL = 200
