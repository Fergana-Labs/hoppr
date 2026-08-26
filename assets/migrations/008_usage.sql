-- ══════════════════════════════════════════════════════════════════
-- Did the skill actually help?
--
-- Reliability was built from the only signals hoppr could see: rejections,
-- hand-edits, uninstalls, and `skills mark`. Every one of them is a record of
-- a human INTERVENING, which makes it a correction rate — a skill nobody has
-- touched scores well because nothing went visibly wrong, not because anything
-- went right.
--
-- The missing signal was in the transcripts the whole time. An installed skill
-- gets invoked in a later session; what happened next is right there. hivemind
-- reaches this by hooking the invocation live; hoppr already ingests every
-- session, so it can ask the same question one pass later at no new cost.
-- ══════════════════════════════════════════════════════════════════

-- Judged once per session, like lesson extraction: a transcript is immutable,
-- so re-reading one can only spend tokens reaching the same verdict.
ALTER TABLE raw ADD COLUMN usage_at INTEGER;
CREATE INDEX raw_usage_todo ON raw(captured)
  WHERE kind = 'session' AND partial = 0 AND usage_at IS NULL;
