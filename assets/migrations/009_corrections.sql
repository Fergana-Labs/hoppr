-- ══════════════════════════════════════════════════════════════════
-- CORRECTIONS — the moments the agent got it wrong and you said so.
--
-- These were already being read, and thrown away. `lesson-extract` calls a
-- correction "the strongest signal in a transcript" and then uses it for one
-- narrow purpose: to infer a preference. Everything else about the moment is
-- discarded — what the agent actually did, how many turns it took to recover,
-- whether it had happened before.
--
-- That discard is why a new store's first output is a review queue. hoppr can
-- tell you what you prefer, but it cannot yet tell you what keeps going wrong,
-- which is the thing a person actually wants to know and the only thing in the
-- corpus that no README, repo, or config file already contains.
--
-- A correction is not a lesson. A lesson is a standing claim, superseded when
-- a newer one contradicts it, and there is one per subject. A correction is an
-- EVENT: it happened at a time, it cost something, and a second occurrence of
-- the same failure is more evidence rather than a replacement. Recurrence is
-- the whole point here, which is exactly the opposite of the ledger's rule.
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE corrections (
  id       TEXT PRIMARY KEY,            -- hash(raw_id, mode) — re-extraction is idempotent
  raw_id   TEXT NOT NULL,
  -- The failure MODE, normalized: a short kebab phrase naming the recurring
  -- shape, not this instance of it. 'claimed-done-without-running', not
  -- 'said the parser was fixed but never ran the parser'.
  mode     TEXT NOT NULL,
  headline TEXT NOT NULL,               -- what the agent did wrong, one sentence
  -- Verbatim, and it must be the PERSON's words. A correction the agent
  -- narrated about itself is the agent grading its own homework; the same
  -- attribution check the ledgers use applies here and for the same reason.
  quote    TEXT NOT NULL,
  -- Turns burned between the mistake and the recovery. This is the units of
  -- the whole feature: a failure mode is ranked by what it COST, not by how
  -- often a model felt confident about it. Estimated, and named as an
  -- estimate everywhere it is shown.
  turns    INTEGER NOT NULL DEFAULT 1,
  -- annoyance — you restated something and moved on
  -- rework    — work had to be redone
  -- damage    — something wrong was committed, shipped, or deleted
  severity TEXT NOT NULL DEFAULT 'annoyance',
  observed INTEGER NOT NULL,
  created  INTEGER NOT NULL
);
CREATE INDEX corrections_mode ON corrections(mode, observed DESC);
CREATE INDEX corrections_raw ON corrections(raw_id);

-- Once-ever per session, like lessons and usage: a transcript is immutable.
ALTER TABLE raw ADD COLUMN corrections_at INTEGER;
CREATE INDEX raw_corrections_todo ON raw(captured)
  WHERE kind = 'session' AND partial = 0 AND corrections_at IS NULL;

-- Which failure mode a skill was written to prevent.
--
-- Stored rather than inferred by joining on shared sessions. That join looks
-- equivalent and is not: a skill mined from a transcript that also contains a
-- correction has no causal relationship to it, and presenting one as "this
-- prevents that" would be the exact species of confident nonsense the rest of
-- this pipeline is built to refuse. A row here exists only when the skill was
-- mined FROM the mode, by `organize/guardrails.ts`.
ALTER TABLE skills ADD COLUMN prevents TEXT NOT NULL DEFAULT '';
