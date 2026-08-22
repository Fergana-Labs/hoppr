-- ══════════════════════════════════════════════════════════════════
-- SKILL GOVERNANCE — reliability, lifecycle, and a rejected-edit buffer.
--
-- Until now a skill was written once, gated on five TEXT heuristics, and then
-- never measured again. SkillOpt's finding is the argument against that:
-- "plausible textual diagnoses can still hurt the actual target model", and
-- across six benchmarks a one-shot generated skill scored the same as a
-- hand-written one (SpreadsheetBench under a Claude Code harness: 37.1 for
-- both) while an iteratively revised one reached 80.4 against a 22.1 no-skill
-- baseline. A skill that is never revised and never scored is the weakest
-- measured category of skill.
--
-- hoppr has no benchmark and cannot manufacture a reward, so it cannot run
-- SkillOpt's loop. What it does have is the other signal MSCE uses: the human.
-- Rejection, correction, and uninstall are all outcomes, and hoppr was
-- already observing every one of them and throwing the information away.
-- ══════════════════════════════════════════════════════════════════

-- One row per observed outcome, rather than a running counter, so that
-- `skills why` can say WHEN a skill started going wrong and what happened —
-- a bare ratio cannot distinguish "wrong from the start" from "drifted".
CREATE TABLE skill_outcomes (
  slug   TEXT NOT NULL REFERENCES skills(slug) ON DELETE CASCADE,
  at     INTEGER NOT NULL,
  -- 'pass' | 'fail'. What hoppr can observe is whether a human had to
  -- intervene, so this is a CORRECTION rate, not a task success rate. Naming
  -- it a success rate would be claiming a measurement we never made.
  signal TEXT NOT NULL,
  source TEXT NOT NULL,   -- accepted | rejected | edited | uninstalled | marked
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX skill_outcomes_slug ON skill_outcomes(slug, at DESC);

-- probationary — installed but not yet earned trust; still dispatched.
-- active      — reliability above the floor.
-- archived    — dropped below the floor; kept for audit, out of the resolver.
ALTER TABLE skills ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'probationary';

-- SkillOpt's rejected-edit buffer. Its ablation is the reason this is a table
-- and not a comment: removing the buffer cost 1.6, 4.6 and 2.4 points on
-- SearchQA, SpreadsheetBench and LiveMath. Without it a reviser re-proposes
-- the same failed edit every pass, and the reason it failed is exactly the
-- kind of thing that does not survive in a prompt.
CREATE TABLE skill_rejected_edits (
  slug   TEXT NOT NULL REFERENCES skills(slug) ON DELETE CASCADE,
  digest TEXT NOT NULL,   -- hash of the normalized edit, so it is recognizable again
  at     INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (slug, digest)
);

-- Did the procedure this lesson describes actually WORK in that session?
--
-- SkillOpt separates failure minibatches from success minibatches and merges
-- them with priority on failure corrections, because "single trajectories
-- often produce anecdotal fixes, while minibatches expose reusable errors".
-- hoppr was pooling both into one prompt and asking for a pitfalls section at
-- the end, which is a weaker version of the same idea.
ALTER TABLE lessons ADD COLUMN outcome TEXT NOT NULL DEFAULT 'unknown';

-- Hash of the body hoppr last WROTE, so a hand-edit is detectable.
--
-- A person editing an installed skill is the single most informative signal
-- available without a benchmark: they read it, used it, and had to correct it.
-- MSCE counts exactly this ("user correction or rejection decreases eta").
-- Without a stored hash there is no way to tell a hand-edit from a file hoppr
-- wrote itself, and the signal is lost.
ALTER TABLE skills ADD COLUMN body_hash TEXT NOT NULL DEFAULT '';
