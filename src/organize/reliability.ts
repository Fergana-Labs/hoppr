import type { Db } from '../db/driver.ts'

/**
 * Per-skill reliability and lifecycle.
 *
 * MSCE tracks a smoothed success rate η = (n_pass + 1)/(n_trial + 2) and moves
 * skills through probationary → active → archived, noting that "user
 * correction or rejection decreases η". hoppr has no benchmark and no scalar
 * reward, so it cannot observe whether a skill made a task go better.
 *
 * Two kinds of evidence feed it. The weaker kind is a human intervening —
 * rejecting, hand-editing, uninstalling — which is a CORRECTION signal: a skill
 * nobody has touched looks fine because nothing went visibly wrong, not because
 * anything went right. The stronger kind comes from `organize/usage.ts`, which
 * finds a later session that actually loaded the skill and judges whether the
 * work that followed came out correct. That one is about outcomes.
 *
 * `skills why` shows the source of every outcome, so a score built only from
 * corrections is never mistaken for one built from use.
 *
 * Laplace smoothing is what makes it usable from the first observation. With
 * n_pass = n_trial = 0 it reads 0.5 — no opinion — rather than 0/0, and a
 * single bad outcome moves it to 0.33 rather than to 0.
 */
export type Outcome = 'pass' | 'fail'
export type OutcomeSource =
  | 'accepted'
  | 'rejected'
  | 'edited'
  | 'uninstalled'
  | 'marked'
  /** Judged from a later session that actually loaded the skill. */
  | 'used'
export type Lifecycle = 'probationary' | 'active' | 'archived'

/** Default floor below which a skill stops being dispatched. `[skills] archive_below`. */
export const ARCHIVE_FLOOR = 0.4
/** At or above this, with enough observations, a skill is trusted. */
export const ACTIVE_FLOOR = 0.6
/** Observations before probation can end. Two corrections is not a trend. */
export const MIN_TRIALS = 3

/**
 * Record one observed outcome.
 *
 * Deliberately does NOT recompute the lifecycle: the archive threshold is
 * configurable, and half the callers here (a state change, a reconcile) have
 * no config in scope. Having them fall back to a default constant would mean
 * two thresholds in play and a lifecycle that depends on which code path
 * happened to touch the skill last. `refreshLifecycles` does it in one place,
 * from the configured value.
 */
export function recordOutcome(
  db: Db,
  slug: string,
  signal: Outcome,
  source: OutcomeSource,
  detail = '',
): void {
  db.prepare(
    'INSERT INTO skill_outcomes(slug, at, signal, source, detail) VALUES (:s,:at,:sig,:src,:d)',
  ).run({ s: slug, at: Date.now(), sig: signal, src: source, d: detail })
}

/** Recompute every skill's lifecycle from the configured floor. */
export function refreshLifecycles(db: Db, archiveBelow: number): number {
  let changed = 0
  for (const r of db
    .prepare<{ slug: string; lifecycle: string }>('SELECT slug, lifecycle FROM skills')
    .all()) {
    if (updateLifecycle(db, r.slug, archiveBelow) !== r.lifecycle) changed++
  }
  return changed
}

export interface Reliability {
  eta: number
  passes: number
  trials: number
  lifecycle: Lifecycle
}

export function reliability(db: Db, slug: string): Reliability {
  const row = db
    .prepare<{ passes: number; trials: number }>(
      `SELECT COALESCE(SUM(signal = 'pass'), 0) AS passes, COUNT(*) AS trials
         FROM skill_outcomes WHERE slug = :s`,
    )
    .get({ s: slug })
  const passes = row?.passes ?? 0
  const trials = row?.trials ?? 0
  const current = db
    .prepare<{ lifecycle: Lifecycle }>('SELECT lifecycle FROM skills WHERE slug = :s')
    .get({ s: slug })
  return {
    eta: (passes + 1) / (trials + 2),
    passes,
    trials,
    lifecycle: current?.lifecycle ?? 'probationary',
  }
}

/**
 * Move a skill between lifecycle states.
 *
 * Archiving is reversible and never deletes: the skill stays on disk and in
 * the index, out of the resolver. hoppr's whole recovery story is that nothing
 * curated is destroyed, and a skill that fell out of favour is exactly the
 * thing someone will want to read later to understand why.
 */
export function updateLifecycle(db: Db, slug: string, archiveBelow = ARCHIVE_FLOOR): Lifecycle {
  const { eta, trials } = reliability(db, slug)
  // Probation is about evidence, not score. A skill with one recorded outcome
  // has an η that swings by 0.2 on the next observation, and dispatching or
  // archiving on that is noise.
  const next: Lifecycle =
    trials < MIN_TRIALS
      ? 'probationary'
      : archiveBelow > 0 && eta < archiveBelow
        ? 'archived'
        : eta >= ACTIVE_FLOOR
          ? 'active'
          : 'probationary'
  db.prepare('UPDATE skills SET lifecycle = :l, updated = :now WHERE slug = :s').run({
    l: next,
    s: slug,
    now: Date.now(),
  })
  return next
}

export interface OutcomeRow {
  at: number
  signal: Outcome
  source: OutcomeSource
  detail: string
}

/** The outcome history, newest first — what `skills why` shows for a procedure. */
export function outcomeHistory(db: Db, slug: string): OutcomeRow[] {
  return db
    .prepare<OutcomeRow>(
      'SELECT at, signal, source, detail FROM skill_outcomes WHERE slug = :s ORDER BY at DESC',
    )
    .all({ s: slug })
}
