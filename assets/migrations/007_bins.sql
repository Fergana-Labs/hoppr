-- ══════════════════════════════════════════════════════════════════
-- Two changes to what a lesson is.
--
-- 1. `vocabulary` and `locations` fold into one `glossary` bin.
--
--    They looked like two things because one answers "what does this mean"
--    and the other "where does this live", but both answer the same question
--    about the same kind of thing: given a noun from this person's world,
--    what is true about it? MSCE lands in the same place from the other
--    direction — its L3 layer holds entity facts, regularities, and
--    constraints together, separate from procedures.
--
--    Splitting them also split the retrieval win: a search for "contracts"
--    should expand through a known location the same way "sitrep" expands
--    through a definition, and with two bins only one fed the query expander.
--
-- 2. A preference line carries how binding it is.
--
--    The bin was mixing "never commit to main" with "prefer shorter
--    sentences". Lumping those together makes an agent treat both as law or
--    both as advice, and either reading is wrong half the time.
-- ══════════════════════════════════════════════════════════════════

UPDATE lessons SET kind = 'glossary' WHERE kind IN ('vocabulary', 'locations', 'location');
UPDATE lessons SET kind = 'preferences' WHERE kind = 'preference';

-- 'must' | 'prefer'. Only meaningful in a graded bin; 'prefer' is the safe
-- default because treating an unmarked line as binding is the worse error.
ALTER TABLE lessons ADD COLUMN strength TEXT NOT NULL DEFAULT 'prefer';

-- The two old ledger skills are superseded by `glossary`. Their rows are left
-- for audit but taken out of the dispatcher, since the file they point at is
-- about to stop being regenerated.
UPDATE skills SET lifecycle = 'archived'
 WHERE kind IN ('vocabulary', 'locations') OR slug IN ('vocabulary', 'locations');
