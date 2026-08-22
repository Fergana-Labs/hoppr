import { z } from 'zod'
import { sha256 } from '../core/hash.ts'
import type { Db } from '../db/driver.ts'

/**
 * Bounded revision of an existing skill.
 *
 * The alternative hoppr shipped with was rewrite-or-freeze: an unpinned skill
 * got regenerated whole every time its evidence grew, a pinned one was never
 * touched again. Both are wrong for the same reason. SkillOpt's ablation puts
 * numbers on it — removing the edit budget and letting the optimizer rewrite
 * freely cost 2.5, 1.8 and 4.0 points across three benchmarks, because
 * "unbounded rewrites can erase useful rules, introduce incompatible
 * instructions, or overfit to a local failure".
 *
 * So: at most N localized edits per pass, each naming its section, gated by the
 * checks hoppr can actually run. Rejected edits are remembered — that buffer is
 * worth 1.6, 4.6 and 2.4 points on the same three benchmarks, and without it a
 * reviser proposes the same failed edit every night forever.
 */
export const EditOut = z.object({
  op: z.enum(['append', 'replace', 'delete']),
  section: z.string().min(1),
  text: z.string().default(''),
  why: z.string().default(''),
})
export const ReviseOut = z.object({ edits: z.array(EditOut).default([]) })
export type SkillEdit = z.infer<typeof EditOut>

/**
 * A stable identity for an edit, so a rejected one is recognizable when the
 * model proposes it again in slightly different words. Keyed on what the edit
 * DOES — operation, target section, and the shape of the new text — not on its
 * justification, which varies every time.
 */
export function editDigest(e: SkillEdit): string {
  const norm = e.text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300)
  return sha256(`${e.op}|${e.section.toLowerCase().trim()}|${norm}`).slice(0, 20)
}

export function rejectedEdits(db: Db, slug: string): Array<{ digest: string; reason: string }> {
  return db
    .prepare<{ digest: string; reason: string }>(
      'SELECT digest, reason FROM skill_rejected_edits WHERE slug = :s ORDER BY at DESC LIMIT 40',
    )
    .all({ s: slug })
}

export function rememberRejection(db: Db, slug: string, e: SkillEdit, reason: string): void {
  db.prepare(
    `INSERT INTO skill_rejected_edits(slug, digest, at, reason) VALUES (:s,:d,:at,:r)
     ON CONFLICT(slug, digest) DO UPDATE SET at = :at, reason = :r`,
  ).run({ s: slug, d: editDigest(e), at: Date.now(), r: reason.slice(0, 300) })
}

interface Section {
  heading: string
  level: string
  lines: string[]
}

/**
 * Split a body into `## heading` sections, keeping any preamble under ''.
 *
 * Section-addressed edits rather than line- or diff-addressed ones because a
 * heading is the only anchor that survives the model reformatting around it.
 * A line number from a previous pass is stale the moment anything above it
 * changes, and a unified diff fails to apply for whitespace reasons that are
 * invisible in a review.
 */
function split(body: string): Section[] {
  const out: Section[] = [{ heading: '', level: '', lines: [] }]
  for (const line of body.split('\n')) {
    const m = /^(#{2,4})\s+(.+?)\s*$/.exec(line)
    if (m) out.push({ heading: m[2]!, level: m[1]!, lines: [] })
    else out[out.length - 1]!.lines.push(line)
  }
  return out
}

function join(sections: Section[]): string {
  const parts: string[] = []
  for (const s of sections) {
    if (s.heading) parts.push(`${s.level} ${s.heading}`)
    parts.push(
      s.lines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\s+$/, ''),
    )
  }
  return `${parts.filter((p) => p !== '').join('\n\n')}\n`
}

function match(sections: Section[], heading: string): Section | undefined {
  const want = heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return sections.find(
    (s) =>
      s.heading
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim() === want,
  )
}

export interface ApplyResult {
  body: string
  applied: SkillEdit[]
  skipped: Array<{ edit: SkillEdit; reason: string }>
}

/**
 * Apply edits in order, capped at `budget`.
 *
 * An edit naming a section that does not exist is APPENDED as a new section
 * rather than dropped: the common case is a skill with no pitfalls section yet
 * and a failure worth recording, and refusing that edit would block the single
 * most valuable revision this can make. A `delete` for a missing section is
 * skipped, since there is nothing to remove and inventing one would be strange.
 */
export function applyEdits(body: string, edits: SkillEdit[], budget: number): ApplyResult {
  const sections = split(body)
  const applied: SkillEdit[] = []
  const skipped: Array<{ edit: SkillEdit; reason: string }> = []

  for (const e of edits) {
    if (applied.length >= budget) {
      skipped.push({ edit: e, reason: `over the ${budget}-edit budget` })
      continue
    }
    const target = match(sections, e.section)
    if (!target) {
      if (e.op === 'delete') {
        skipped.push({ edit: e, reason: 'no such section to delete' })
        continue
      }
      if (!e.text.trim()) {
        skipped.push({ edit: e, reason: 'no text for a new section' })
        continue
      }
      sections.push({ heading: e.section, level: '##', lines: ['', e.text.trim()] })
      applied.push(e)
      continue
    }
    if (e.op === 'delete') {
      target.lines = []
      target.heading = ''
      target.level = ''
      applied.push(e)
    } else if (e.op === 'replace') {
      if (!e.text.trim()) {
        skipped.push({ edit: e, reason: 'replace with no text is a delete; say so' })
        continue
      }
      target.lines = ['', e.text.trim()]
      applied.push(e)
    } else {
      if (!e.text.trim()) {
        skipped.push({ edit: e, reason: 'nothing to append' })
        continue
      }
      target.lines.push('', e.text.trim())
      applied.push(e)
    }
  }
  return {
    body: join(sections.filter((s) => s.heading || s.lines.join('').trim())),
    applied,
    skipped,
  }
}
