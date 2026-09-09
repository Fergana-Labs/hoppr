-- ══════════════════════════════════════════════════════════════════
-- CASES — the verifier hoppr already had and was not using.
--
-- Every quality mechanism here evaluates a skill as TEXT, before it has
-- been used: the promotion gate reads its prose, the refuter re-reads its
-- evidence, the grounding check looks for commands nobody ran. None of them
-- has watched the skill do anything, and that is the one thing the
-- literature says does not work — a one-shot authored skill, installed
-- without execution feedback, is frequently worse than no skill at all
-- (−12.86pp for Opus-4.7 on SWE-Skills-Hard), while three bounded rounds
-- against a verifier are worth +25.58pp.
--
-- `organize/revise.ts` says why hoppr stopped there: "hoppr has no benchmark
-- and no scalar reward, so it gates on the two checks it CAN run." That is
-- no longer true. A correction is a recorded instance of an agent going
-- wrong and a human saying so, which is a test case with its own oracle
-- attached — the situation, the move, and the answer, in the person's words.
--
-- What is replayed is the DECISION, not the environment. Nobody can re-run
-- a container from six weeks ago; anyone can ask what an agent would do next
-- given the same lead-in, once with the candidate skill and once without.
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE cases (
  id            TEXT PRIMARY KEY,
  correction_id TEXT NOT NULL,
  raw_id        TEXT NOT NULL,
  mode          TEXT NOT NULL,
  -- The transcript up to, and NOT including, the moment the person objected.
  --
  -- The exclusion is the whole correctness property of the bench. A lead-in
  -- carrying the correction hands both arms the answer, every skill scores
  -- perfectly, and the number means nothing.
  lead_in       TEXT NOT NULL,
  -- What the agent actually did, as text where the transcript has it and as
  -- the extractor's one-line headline where it does not.
  wrong_move    TEXT NOT NULL,
  -- The person's own words. The rubric — shown to the judge, never to an arm.
  correction    TEXT NOT NULL,
  severity      TEXT NOT NULL DEFAULT 'annoyance',
  -- 'train' | 'holdout', assigned by hashing the id so it is stable across
  -- runs. A split that moved between passes would let a skill drift into
  -- passing by being re-scored until the easy cases landed on the right side.
  split         TEXT NOT NULL,
  created       INTEGER NOT NULL
);
CREATE INDEX cases_mode ON cases(mode, split);
CREATE UNIQUE INDEX cases_correction ON cases(correction_id);

-- The no-skill arm, cached, one row per sample.
--
-- Two reasons for the cache and they are different. The cheap one: the
-- baseline does not depend on the candidate, so recomputing it per skill pays
-- again for an answer already on disk. The load-bearing one: every skill is
-- then scored against the SAME baselines, so a difference between two skills
-- is a difference between the skills rather than between two draws of the
-- control.
--
-- Sampled rather than singular because a single draw is not stable. Measured
-- on this store's own corrections, one case moved from `regression` to
-- `prevents` between two runs of the same skill — so a bench that draws once
-- reports which way the coin landed, and a verdict that disqualifies a skill
-- has to be more than that.
CREATE TABLE case_baselines (
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  idx     INTEGER NOT NULL,
  move    TEXT NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (case_id, idx)
);

-- One row per (skill, case). The verdict is a COMPARISON, not a score for
-- the skill arm alone: a skill that "passes" a case says nothing unless the
-- baseline failed it, because the case may simply be easy.
CREATE TABLE replays (
  slug              TEXT NOT NULL REFERENCES skills(slug) ON DELETE CASCADE,
  case_id           TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  at                INTEGER NOT NULL,
  -- prevents   — baseline reproduced the failure, the skill arm did not
  -- regression — the skill arm reproduced it and the baseline did not
  -- inert      — both arms agree
  -- both-fail  — both reproduced it; the skill did not help, but did no harm
  verdict           TEXT NOT NULL,
  baseline_recurred INTEGER NOT NULL,
  skill_recurred    INTEGER NOT NULL,
  -- How many of the samples agreed with the verdict recorded here. A verdict
  -- carried 2-of-3 is a different fact from one carried 3-of-3, and hiding
  -- that behind a single label is how a noisy instrument reads as a precise one.
  agreement         INTEGER NOT NULL DEFAULT 1,
  samples           INTEGER NOT NULL DEFAULT 1,
  reason            TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (slug, case_id)
);
CREATE INDEX replays_slug ON replays(slug, at DESC);

-- Whether a skill has ever been through the bench, and how it did.
--
-- Nullable rather than defaulted: "not yet replayed" and "replayed and
-- prevented nothing" are different states, and collapsing them would let an
-- unverified skill read as a verified failure or the reverse.
ALTER TABLE skills ADD COLUMN verified_at INTEGER;
ALTER TABLE skills ADD COLUMN prevents_n  INTEGER;
ALTER TABLE skills ADD COLUMN regress_n   INTEGER;
