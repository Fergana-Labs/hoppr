# Extraction tables

A table turns unstructured captures into rows you can query with SQL. You write
the schema; the curator fills it, and every cell traces back to the capture it
came from.

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

Rows are exported to `.hoppr/curated/tables/<name>.jsonl`, and **that file is
authoritative**. Edit a cell, add a line, delete a line — the next pass adopts
your version and **pins** the row, so extraction maintains everything around it
and never overwrites what you wrote. A row you delete stays deleted.

```jsonl
{"row_id":"2488588b","raw_id":"01M0GE…","date":"2026-03-11","outcome":"solved"}
{"date":"2026-03-18","attendees":["Sam"],"decision":"Added by hand","outcome":"solved"}
```

A hand-written row needs no `row_id`; one is derived from its contents.

## Changing the schema

Changing a column marks affected rows stale and the next pass backfills **just
that column** — adding a field does not re-extract what you already have.
