# hoppr

hoppr is a local-first knowledge store for notes, files, and coding-agent transcripts.
It indexes raw material, curates it into a linked Markdown wiki, and can extract tables
and reusable agent skills. You can access a store through the CLI, MCP, a read-only
filesystem interface, or a local HTTP API.

```bash
cd ~/code/myproject
npx hoppr init
npx hoppr add "we chose RRF because BM25 and cosine scores use different scales"
cd src/deep
npx hoppr query "why rank fusion"   # finds the store by walking up the directory tree
```

A hoppr belongs to a directory, much like a Git repository. It can also reference an
existing folder or import local transcripts from Claude Code, Codex, opencode, and
openclaw:

```bash
npx hoppr new papers --from dir:~/Downloads
npx hoppr new work --from agents:claude-code,codex
```

Folder sources remain in place. Agent transcripts are copied because their original
logs may be rotated. hoppr does not scrape websites or connect to external accounts;
planned external sources are documented in
[`docs/FUTURE-SOURCES.md`](docs/FUTURE-SOURCES.md).

## Storage model

Each hoppr keeps three layers:

```text
raw input  ──curate──>  curated/  ──index──>  .index/
source files             wiki, tables,          search database
or copied logs           and skills
```

| layer | contents | handling |
|---|---|---|
| raw | referenced files or immutable copies in `raw/` | never rewritten by hoppr |
| curated | wiki pages, tables, prompts, and skills | Git-tracked and rebuildable |
| index | keyword and vector indexes | ignored by Git and rebuildable |

`~/.hoppr/hoppers.json` records the location of every store. This lets `-H <name>`, the
MCP server, and a single daemon reach stores in different directories.

### Git-backed review

A store is a Git repository. By default, hoppr commits each curation pass, so generated
changes can be reviewed or reverted with ordinary Git commands. Set `[git] mode = "off"`
to disable automatic commits.

```bash
git -C <store> diff HEAD~1 curated/
git -C <store> revert <sha>
```

Writes are skipped when their content has not changed, keeping each commit limited to
the files affected by that pass.

## Search and curation

All captures, wiki pages, table rows, and skills share one keyword index and, when
enabled, one vector index. Hybrid search combines BM25 and vector ranks with reciprocal
rank fusion (RRF).

```bash
hoppr query "rrf fusion tag:search project:hoppr since:7d"
hoppr query "the meeting where we dropped the rewrite" --scope all --explain
```

Filters are applied before ranking. Curated pages receive a ranking boost, and a raw
capture collapses into its curated page when both match.

Choose a curation preset when creating a store:

| preset | output |
|---|---|
| `notes` | source pages and cross-document concept pages |
| `papers` | one summarized page per document |
| `agents` | pages, concepts, and proposed skills |
| `index-only` | keyword and vector search; no model calls |
| `minimal` | keyword search only |

Presets provide defaults. Their individual settings remain configurable in
`hoppr.toml`.

### Wiki

The curated wiki follows
[Karpathy's LLM wiki specification](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f):

```text
curated/wiki/
  index.md
  log.md
  sources/
  concepts/
  entities/
  comparisons/
  digests/
```

Source and concept pages are currently generated. The other page types are reserved by
the schema. `hoppr init` also writes a `CLAUDE.md` that describes the store contract for
agents that access it without MCP. The wiki can be opened directly in Obsidian.

### Files and exclusions

hoppr reads prose, HTML, structured text, PDF, Word, Excel, PowerPoint, and common image
formats. Images use local OCR for text and, when configured, a vision model for visual
description. Scanned PDFs use OCR on the first five pages. Extraction failures fall back
to indexing the file name and path.

Use `.hopprignore` to separate files that should not be indexed from files that should be
searchable but never sent to a model:

```gitignore
secret/
*.zip

[no-curate]
archive/**
*.csv
```

The file uses Gitignore syntax, and the source folder's `.gitignore` is also honored.
See [`docs/FILE-TYPES.md`](docs/FILE-TYPES.md) for supported formats, optional extractors,
default exclusions, and redaction behavior.

## Structured output

### Tables

A table definition is a standing extraction rule. New matching captures are added on
the next curation pass, and every generated cell retains its source reference.

```toml
# .hoppr/curated/tables/meetings.table.toml
match = "scope:raw"

[columns]
date = { type = "date", required = true }
attendees = { type = "list[string]" }
outcome = { type = "enum", values = ["solved", "partial", "abandoned"], converging = true }
```

```bash
hoppr table meetings --trace
hoppr sql "select outcome, count(*) from v_meetings group by outcome"
```

Rows are exported to `<table>.jsonl`. Manual edits pin a row, so later extraction leaves
the edited values intact. A converging column reuses existing values as preferred
vocabulary.

### Wiki outlines

Use an outline for pages that should exist independently of discovered concepts:

```toml
# .hoppr/schemas/wiki.toml
[[outline]]
path = "open-questions.md"
mode = "maintain"
prompt = """
List unresolved questions in the corpus. Link each item to its source.
Do not add an item unless the corpus supports it.
"""
```

`maintain` updates the page during deep passes; `once` writes it once. Manually editing a
generated page pins it. A path ending in `/` reserves a directory instead of a page.

### Knowledge graph

The graph is disabled by default. Enable it and define the entity and relation types that
fit the corpus:

```toml
[retrieval]
graph = true

[[graph.entity_types]]
name = "person"
description = "A named participant, not an author cited in passing."

[[graph.relations]]
name = "works_on"
from = ["person"]
to = ["project"]
description = "Sustained involvement in a project."
```

Each edge stores the source sentence. Types and relations outside the configured schema
are discarded.

### Skills

The deep pass can identify repeated procedures in agent transcripts and propose them as
`SKILL.md` files:

```bash
hoppr deep
hoppr skills review
hoppr skills why debug-flaky-vitest
hoppr skills install debug-flaky-vitest
```

Skills require explicit acceptance and installation. Rejected proposals are remembered.

## Install and configure

```bash
npm install -g hoppr   # or use npx hoppr
cd ~/notes
hoppr init
hoppr setup
```

hoppr requires Node 20.11 or later. Keyword search works without optional dependencies;
PDF extraction, OCR, richer Word extraction, and local embeddings use optional packages.

Configure a model with an API key or use Ollama locally:

```bash
export OPENROUTER_API_KEY=...
```

```toml
[llm]
fast_provider = "openrouter"    # tagging and extraction
quality_provider = "anthropic"  # synthesis and skill mining
```

Model defaults are resolved per provider. Set `[llm.models] fast` or `quality` only when
you need to override those defaults. `[llm] provider = "ollama"` keeps model requests on
the machine.

Configuration precedence is:

```text
defaults < ~/.hoppr/hoppr.toml < <store>/hoppr.toml < HOPPR_* environment < CLI flags
```

| setting | location |
|---|---|
| provider, model, embedder, Git mode | `~/.hoppr/hoppr.toml` |
| API keys | environment, `~/.hoppr/.env`, or `<store>/.env` |
| source and curation preset | `<store>/hoppr.toml` |
| indexed paths | `.hopprignore` beside the source data |
| prompts and schemas | files under `curated/` and `.hoppr/schemas/` |

Keep keys out of `hoppr.toml` because stores may be committed. Environment variables
override `.env` files. `hoppr doctor` reports which provider, model, and key source each
tier uses.

## Agent access and background service

```bash
hoppr mcp install
hoppr -H work mcp install --pinned
hoppr mcp status --probe
```

The MCP server is a stdio process started by the client. It opens SQLite directly and
does not require the daemon. A pinned installation exposes one selected store; an
unpinned installation lets the agent select from the registry.

```bash
hoppr daemon start
hoppr daemon status
hoppr web
```

One daemon watches all registered stores while keeping their indexes, schedules, keys,
and curation state separate. Model calls share a serial queue. If the daemon stops,
background curation pauses, but capture and search continue through the CLI and MCP.

## Security

hoppr redacts recognized credentials before extracted text is indexed, embedded,
committed, or sent to a model. It covers common vendor tokens, private keys, bearer
tokens, JWTs, credentials in URLs, suspicious assignments, and an entropy-based fallback.
The original source file is not modified.

Redaction reduces accidental exposure but cannot make an untrusted corpus safe to
publish. Disable it with `[intake] redact = false` only when that tradeoff is understood.
Use a local model if extracted content must not leave the machine.

## Documentation

- [`docs/COMMANDS.md`](docs/COMMANDS.md) — commands, flags, and configuration
- [`docs/FILE-TYPES.md`](docs/FILE-TYPES.md) — supported inputs and extraction behavior
- [`docs/examples/`](docs/examples/) — complete configuration examples
- [`docs/FUTURE-SOURCES.md`](docs/FUTURE-SOURCES.md) — designs for external sources not in core

## Development

```bash
npm install
npm run check
npm run e2e
npm run hoppr -- --help
```

## License

MIT
