-- ══════════════════════════════════════════════════════════════════
-- A failure mode is not always one failure.
--
-- Modes converge on purpose: each extraction batch is shown the modes already
-- in use and asked to reuse one before coining a new one, because without that
-- 25 corrections produced 25 singleton modes and a report built on recurrence
-- had nothing to stand on. That fix worked and it has a price, which the
-- routing bench is the first thing to have measured.
--
-- On this store, `built-before-clarifying` absorbed three unrelated jobs:
--
--     built the wrong config schema      (four types where two were asked for)
--     used the wrong line breaks         (a formatting complaint)
--     built UI without a reference       (an artwork rebuild)
--
-- A guardrail mined from that cluster has to pick one, and it picked the
-- third. The other two then cannot reach it — correctly, since it does not
-- address them — so the mode counts three occurrences of a failure the skill
-- prevents once. The recurrence that justified writing it was partly fictional.
--
-- So the mode stays the unit of COST, where aggregating across related
-- failures is right, and a finer `cluster` becomes the unit of SKILL, where it
-- is not. Both are assigned by code from the headline text, so splitting is
-- free, inspectable, and does not depend on a model being consistent.
-- ══════════════════════════════════════════════════════════════════

-- '' until the next pass computes it. Empty means "not yet split", which is
-- distinct from "split and found coherent" — the latter writes the mode name.
ALTER TABLE corrections ADD COLUMN cluster TEXT NOT NULL DEFAULT '';
CREATE INDEX corrections_cluster ON corrections(cluster);

-- Cases inherit it, so the bench and the routing fixtures both select the
-- cases a guardrail actually claims rather than everything filed under a mode
-- it only partly covers.
ALTER TABLE cases ADD COLUMN cluster TEXT NOT NULL DEFAULT '';
CREATE INDEX cases_cluster ON cases(cluster, split);
