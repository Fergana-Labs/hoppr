# Example configurations

Each directory contains a complete configuration that can be copied into a store's
`.hoppr/` directory.

| example | for |
|---|---|
| [`notes-folder/`](notes-folder/) | notes or an Obsidian vault you want summarized and searchable |
| [`agent-logs/`](agent-logs/) | coding sessions, mined for reusable skills |
| [`archive-index-only/`](archive-index-only/) | Downloads or another large folder you want to search without model calls |
| [`research-graph/`](research-graph/) | papers and research notes with a typed entity graph |
| [`tables/`](tables/) | extraction table schemas |
| [`schemas/`](schemas/) | long schemas split out of `hoppr.toml` |

Schemas can live in their own files under `.hoppr/schemas/` — `graph.toml`,
`wiki.toml`, `skills.toml`. They merge into the matching section and win over it.
Separate schema files are useful when a graph vocabulary or wiki outline becomes large
enough to obscure the main store settings.

**Sections inside a schema file are relative.** In `schemas/wiki.toml` write `[[outline]]`,
not `[[wiki.outline]]` — the latter nests one level too deep and is silently ignored.

Every value in `hoppr.toml` is optional. The examples show the ones worth
setting; everything else falls back to the default, and the full annotated set
is in [`../../assets/hoppr.default.toml`](../../assets/hoppr.default.toml).

For a screenshots folder, start with `notes-folder/` and leave OCR enabled. For an
Obsidian vault, hoppr reads the existing Markdown and writes all generated files under
`.hoppr/`; it does not rewrite the vault's notes.
