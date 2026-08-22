-- ══════════════════════════════════════════════════════════════════
-- LESSONS — what a session established that a future agent should know.
--
-- Skill mining used to cluster sessions by their TOOL TRACE: which tools
-- fired, which commands ran, which error classes appeared. That finds exactly
-- one shape of skill — the tool-heavy debugging loop — and is structurally
-- blind to every other. "The user wants plain copy, never the word
-- delightful", "contracts live in Drive under Legal, not the repo", "we call
-- the nightly run the deep pass" all produce an EMPTY tool signature, so no
-- amount of recurrence would ever surface them.
--
-- So extraction moved up a level. A lesson is one normative claim, typed,
-- carrying the verbatim quote that established it. Clustering then happens
-- over lessons rather than over transcripts, which is the right grain: two
-- sessions that each mention deploying once share a lesson key even though
-- they share almost no tool calls.
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE lessons (
  id         TEXT PRIMARY KEY,     -- hash(raw_id, kind, key) — re-extraction is idempotent
  raw_id     TEXT NOT NULL,
  kind       TEXT NOT NULL,        -- vocabulary | preference | location | procedure
  subject    TEXT NOT NULL,        -- normalized thing this is about: a term, a topic, a task
  statement  TEXT NOT NULL,        -- the claim itself, one sentence
  quote      TEXT NOT NULL DEFAULT '',   -- verbatim evidence from the transcript
  confidence REAL NOT NULL DEFAULT 0.5,
  -- Supersession is by observation time, not insertion time: a backfill that
  -- ingests March after August must not overwrite August's answer.
  observed   INTEGER NOT NULL,
  created    INTEGER NOT NULL
);
CREATE INDEX lessons_kind_subject ON lessons(kind, subject, observed DESC);
CREATE INDEX lessons_raw ON lessons(raw_id);

-- Extraction is once-ever per session, not once-per-pass: transcripts are
-- immutable, so re-reading one can only cost tokens to reach the same answer.
ALTER TABLE raw ADD COLUMN lessons_at INTEGER;
CREATE INDEX raw_lessons_todo ON raw(captured)
  WHERE kind = 'session' AND partial = 0 AND lessons_at IS NULL;

-- 'procedure' is the mined-from-clusters kind that existed before this.
-- The ledger kinds are assembled deterministically from lessons instead.
ALTER TABLE skills ADD COLUMN kind TEXT NOT NULL DEFAULT 'procedure';
