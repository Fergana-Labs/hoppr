# Example configurations

Working files, not fragments. Each one is a complete config you can copy into a
store's `.hoppr/` and run.

| example | for |
|---|---|
| [`notes-folder/`](notes-folder/) | a folder of prose you want summarised and searchable |
| [`agent-logs/`](agent-logs/) | coding sessions, mined for reusable skills |
| [`archive-index-only/`](archive-index-only/) | a large corpus you want to find things in, cheaply |
| [`research-graph/`](research-graph/) | papers and meeting notes with a typed entity graph |
| [`tables/`](tables/) | extraction table schemas |
| [`schemas/`](schemas/) | long schemas split out of `hoppr.toml` |

Schemas can live in their own files under `.hoppr/schemas/` — `graph.toml`,
`wiki.toml`, `skills.toml`. They merge into the matching section and win over it.
Split them out when they grow: a graph vocabulary with a sentence of guidance per type,
or a wiki outline with a brief per page, buries the settings you actually tweak.

**Sections inside a schema file are relative.** In `schemas/wiki.toml` write `[[outline]]`,
not `[[wiki.outline]]` — the latter nests one level too deep and is silently ignored.

Every value in `hoppr.toml` is optional. The examples show the ones worth
setting; everything else falls back to the default, and the full annotated set
is in [`../../assets/hoppr.default.toml`](../../assets/hoppr.default.toml).
