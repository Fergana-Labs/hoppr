import type { Db } from '../db/driver.ts'

/**
 * Expand a query using the vocabulary ledger.
 *
 * The failure this fixes: you search for a word you use and the documents do
 * not. "sitrep" matches only documents containing the literal string, so a
 * folder full of the cross-branch status reports you call sitreps returns
 * nothing. The vocabulary ledger already holds the definition — it was just
 * written into a SKILL.md that only an agent loading the file ever reads, and
 * hoppr's own search could not see it.
 *
 * MSCE describes the same link in the other direction: retrieved L3
 * environmental facts "provide environmental priors that instantiate
 * parameters without overwriting the skill procedure". The ledger is context
 * applied at retrieval time, not content merged into the thing it modifies.
 *
 * Conservative by construction. Expansion only fires when a ledger subject
 * appears in the query as a whole phrase, and the added terms are OR'd
 * alongside the originals — so this can only add candidates. BM25's IDF
 * weighting keeps a document matching the words you actually typed above one
 * matching only an expansion.
 */
export interface Expansion {
  /** Extra terms to OR into the keyword arm. */
  terms: string[]
  /** Which ledger subjects fired, for `--explain`. */
  from: string[]
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
  'that',
  'is',
  'are',
  'was',
  'were',
  'it',
  'its',
  'we',
  'our',
  'their',
  'they',
  'them',
  'when',
  'what',
  'which',
  'across',
  'from',
  'into',
  'not',
  'but',
  'you',
  'your',
])

export function glossaryExpand(db: Db, text: string, max = 8): Expansion {
  const query = ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `
  if (query.trim().length === 0) return { terms: [], from: [] }

  let rows: Array<{ subject: string; statement: string }>
  try {
    rows = db
      .prepare<{ subject: string; statement: string }>(
        `SELECT l.subject, l.statement FROM lessons l
          WHERE l.kind = 'vocabulary'
            AND l.id = (
              SELECT l2.id FROM lessons l2
               WHERE l2.kind = l.kind AND l2.subject = l.subject
               ORDER BY l2.observed DESC, l2.id ASC LIMIT 1
            )`,
      )
      .all()
  } catch {
    // A store predating the lessons table still searches. Retrieval must never
    // depend on a curation feature having run.
    return { terms: [], from: [] }
  }

  const already = new Set(query.trim().split(' '))
  const terms = new Set<string>()
  const from: string[] = []

  for (const r of rows) {
    const subject = r.subject
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
    if (!subject) continue
    // Whole-phrase match only. Matching on any shared word would fire the
    // entire glossary on a two-word query and bury what was asked for.
    if (!query.includes(` ${subject} `)) continue
    from.push(r.subject)
    for (const w of r.statement.toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length < 4 || STOP.has(w) || already.has(w)) continue
      terms.add(w)
      if (terms.size >= max) break
    }
    if (terms.size >= max) break
  }
  return { terms: [...terms], from }
}
