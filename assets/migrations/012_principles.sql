-- ══════════════════════════════════════════════════════════════════
-- PRINCIPLE MEMORY — how skills get fixed, kept separately from any skill.
--
-- hoppr already remembers the negative half of this. `skill_rejected_edits`
-- comes from SkillOpt, whose ablation is why it exists: removing the buffer
-- cost 1.6, 4.6 and 2.4 points across three benchmarks, because without it a
-- reviser re-proposes the same failed edit every pass. What hoppr has never
-- had is the positive half — a record of what WORKED, reusable on a skill
-- that has nothing else in common with the one it was learned from.
--
-- SkillRevise's decomposition is the reason to separate them at all:
-- diagnosis is task-specific and says what failed here, while a principle is
-- general and says what to do about that shape of failure. Mixing them
-- produces advice that only applies to the skill it came from, which is the
-- same overfitting the rejected-edit buffer exists to prevent in the other
-- direction.
--
-- Seeded rather than empty. An empty memory makes the first revision of every
-- store a cold start, and the defect classes worth seeding are already
-- measured — Task-Implementation Fault is 86 of 125 functional failures,
-- Excessive Verification 67 of 182 efficiency regressions.
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE principles (
  id        TEXT PRIMARY KEY,
  -- The defect this repairs, in the vocabulary the failure taxonomies use.
  defect    TEXT NOT NULL,
  -- When to reach for it. This is what retrieval matches against, so it
  -- describes the SYMPTOM rather than the cure.
  consider  TEXT NOT NULL,
  -- What to change in the skill, as an instruction to the reviser.
  repair    TEXT NOT NULL,
  -- What the edit should make the executor actually DO differently. An edit
  -- that changes the prose without changing behaviour is the failure mode
  -- SkillRevise's execution anchors exist to prevent.
  anchor    TEXT NOT NULL,
  -- Where it must NOT be applied. Every seeded principle has one; a principle
  -- that claims to apply everywhere is a slogan and will be applied everywhere.
  avoid     TEXT NOT NULL,
  -- 'seed' for shipped, 'learned' for absorbed from a revision that worked.
  origin    TEXT NOT NULL DEFAULT 'seed',
  -- Revisions where this principle was applied and the result passed / failed.
  used      INTEGER NOT NULL DEFAULT 0,
  worked    INTEGER NOT NULL DEFAULT 0,
  created   INTEGER NOT NULL
);

-- One row per bounded revision episode, so `skills why` can say what was
-- tried and what it cost rather than only what survived.
CREATE TABLE revisions (
  slug       TEXT NOT NULL REFERENCES skills(slug) ON DELETE CASCADE,
  round      INTEGER NOT NULL,
  at         INTEGER NOT NULL,
  -- The principles bound to this attempt, comma separated.
  principles TEXT NOT NULL DEFAULT '',
  -- 'kept' | 'rejected'. The first candidate that passes is kept and the
  -- episode stops; SkillRevise selects on verifier success before utility,
  -- so a later, better-scoring candidate is never generated.
  outcome    TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (slug, round, at)
);
CREATE INDEX revisions_slug ON revisions(slug, at DESC);
