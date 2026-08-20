# Extraction tables

A table extracts structured rows from matching captures. Define the schema, run
curation, and query the result with SQL. Each generated cell retains its source
reference.

```bash
hoppr tables new meetings           # a starter you then edit
$EDITOR .hoppr/curated/tables/meetings.table.toml
hoppr tables rebuild meetings

hoppr table meetings                # the viewer
hoppr table meetings --trace        # …with the source capture per row
hoppr table meetings --csv
hoppr sql "select outcome, count(*) n from v_meetings group by outcome"
```

## Editing rows by hand

Rows are exported to `.hoppr/curated/tables/<name>.jsonl`, which is the authoritative
copy. Editing, adding, or deleting a row is picked up by the next pass. Edited rows are
pinned and are not overwritten by later extraction.

```jsonl
{"row_id":"2488588b","raw_id":"01M0GE…","date":"2026-03-11","outcome":"solved"}
{"date":"2026-03-18","attendees":["Sam"],"decision":"Added by hand","outcome":"solved"}
```

A hand-written row needs no `row_id`; one is derived from its contents.

## Changing the schema

Changing a column marks affected rows stale. The next pass backfills that column without
re-extracting unchanged fields.
