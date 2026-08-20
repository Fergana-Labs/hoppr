# How to use this hoppr

You are querying a store that mixes **raw captures** (what was actually said or
written) with **curated pages** (what a model concluded from them). Those are
different kinds of evidence and combining them badly is the main way an agent
gets a confident wrong answer out of a good store.

## The path

`hoppr_index` → `hoppr_search` → `hoppr_get` → `hoppr_source`

Catalog, hit, page, ground truth. Do not stop at the search snippet: it is a
ranking artefact, not a quotation.

## Merging results

1. **A curated page and its own raw capture are one fact, not two.** Search
   already collapses them, but if you fetch both, do not treat the agreement as
   corroboration — the page was *written from* that capture.

2. **Two curated pages citing the same capture are also one fact.** Check
   `sources:` before counting support. Independent support means *different*
   `raw_id`s.

3. **Prefer the most recent capture when two conflict, and say that you did.**
   A superseded decision is still in the store; that is deliberate, because
   knowing something changed is often the answer. Report both and the dates.

4. **`confidence: low` on a page means the curator was unsure.** Carry that
   through to your answer rather than laundering it into a flat assertion.

5. **Quote from `hoppr_source`, never from a summary**, when the exact wording
   matters — a name, a number, an error string, a commitment someone made.

## Saying what is missing

The most useful thing you can report is often a gap. Before answering, ask:

- Is the newest relevant capture old? Say so with the date. "Nothing has been
  captured about this since March" changes how the answer should be used.
- Did every hit come from one source or one day? That is a narrow base, and
  the reader cannot tell from a confident paragraph.
- Did the search return nothing? Distinguish **"this store has nothing on that"**
  from **"this store does not cover that subject at all"** — check
  `hoppr_index` for what it *does* contain before concluding either.

## Scope

`scope: curated` is the default and is usually right. Widen to `all` when you
need exact wording, when the subject is recent enough that curation may not have
run, or when curated search came back empty.

Filter with `tag:`, `project:`, `kind:` and `since:` — they run inside each
search arm, before ranking, so they narrow rather than truncate.
