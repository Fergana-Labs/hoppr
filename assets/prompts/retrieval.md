# How to use this hoppr

You are querying a store that mixes **raw captures** (what was actually said or
written) with **curated pages** (what a model concluded from them). Those are
different kinds of evidence and combining them badly is the main way an agent
gets a confident wrong answer out of a good store.

## Start with the filesystem

The store is a directory, and you can read it directly. Use ordinary file tools
when the wiki already gives you enough structure:

- `curated/wiki/index.md` is the catalog.
- `curated/wiki/sources/` contains one page per curated source.
- `curated/wiki/concepts/` contains cross-source synthesis.
- `curated/graph/` contains the exported knowledge graph when graph extraction
  is enabled.

Use `find`, `rg`/`grep`, and `cat` to browse these files. MCP clients can use
`hoppr_vfs` for equivalent read-only browsing, including `find`, `grep`, and
`cat`.

Use `hoppr_search` when you want ranked retrieval across everything at once:
source material, wiki pages, table rows, skills, and content extracted from
PDFs, Office documents, and images. Then use `hoppr_get` for a complete indexed
artifact and `hoppr_source` when exact source wording matters.

Do not stop at a search snippet. It is a ranking artifact, not a quotation.

## Knowledge graph

For questions about named entities and their relationships, inspect
`curated/graph/nodes.jsonl` and `curated/graph/edges.jsonl`, or use
`hoppr_graph_search` followed by `hoppr_graph_show`. Every returned edge includes
its source capture and supporting evidence. Treat the edge as one claim from
that source, not as independent corroboration.

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
  from **"this store does not cover that subject at all"** — inspect
  `curated/wiki/index.md` to see what it contains before concluding either.

## Scope

`scope: all` is the default: source material and generated artifacts are searched
together. Use `scope: curated` when you only want the wiki, tables, and skills;
use `scope: raw` when you only want source material.

Filter with `tag:`, `project:`, `kind:` and `since:` — they run inside each
search arm, before ranking, so they narrow rather than truncate.
