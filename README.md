# hoppr

[![CI](https://github.com/Fergana-Labs/hoppr/actions/workflows/ci.yml/badge.svg)](https://github.com/Fergana-Labs/hoppr/actions/workflows/ci.yml)
[![Node 20+](https://img.shields.io/badge/node-20%2B-339933?logo=nodedotjs&logoColor=white)](package.json)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Turn any folder into queryable, structured context your agents can understand.** Run hoppr in a directory of
papers, notes, screenshots, downloads, or agent transcripts. It leaves the original
files alone and adds hybrid search, an LLM wiki, structured tables, a knowledge graph, or skills.

A folder is already a useful boundary: it contains material about a project, subject, or
part of your life. hoppr makes that material searchable and gives agents
a structured way to work with it and build a compounding asset.

```bash
cd ~/Downloads
npx hoppr init
```

Like `git init`, `hoppr init` creates a hidden directory in the folder where you run it.
Your files stay where they are and are never edited or written to.

![hoppr wiki built from a mixed folder](docs/02-wiki.png)

> Your folder remains the source of truth. `.hoppr/` contains the search index and
> generated structure. No hosted database or always-on service is required.

## Use it on the folders you already have

| folder | what hoppr adds |
|---|---|
| research papers | searchable PDF text, summaries, recurring concepts, and a typed graph |
| `~/Downloads` | OCR and text extraction across mixed files, with one search interface |
| screenshots | local OCR, optional visual descriptions, and search over text inside images |
| an Obsidian vault | hybrid search and generated concept pages alongside the existing Markdown graph |
| coding-agent history | durable memory and compounding skills across Claude Code, Codex, opencode, and openclaw sessions |

```bash
cd ~/research/my-field && hoppr init --curation papers
cd ~/Downloads && hoppr init --curation index-only
cd ~/Desktop/Screenshots && hoppr init
cd ~/vault && hoppr init --curation notes

# Agent memory is another source, not a separate product:
hoppr init --from agents:claude-code,codex --global --name work
```

## What you get

```text
my-folder/               the folder is the raw tier; your files stay put
├── meeting-notes.md
├── paper.pdf
├── screenshot.png
└── .hoppr/
    ├── curated/
    │   ├── wiki/        source pages + concepts + wikilinks
    │   ├── tables/      structured JSONL with source traces
    │   ├── graph/       typed entities + cited edges as grep-friendly JSONL
    │   ├── skills/      glossary, preferences, and mined procedures
    │   └── prompts/     editable curation instructions
    ├── schemas/         graph / wiki / skills, when they outgrow one file
    ├── .index/          BM25 + vector search
    ├── .env             API keys, gitignored
    ├── CLAUDE.md        the store contract for filesystem agents
    └── hoppr.toml       source and curation settings
```

For a directory source, the folder itself is the raw tier; there is no duplicate `raw/`
directory. `.hoppr/raw/` is used for durable captures from connector-owned sources such
as coding-agent session histories.

- **Search everything together.** BM25 and local vector search are fused with RRF. Results
  can mix original files, wiki pages, table rows, and skills; `--scope curated` and
  `--scope raw` narrow the search when you need them.
- **Build a wiki from a folder.** Fast passes write source pages; deep passes merge
  recurring ideas into concepts and converge the tag vocabulary.
- **Extract rows, not just summaries.** Define a table once and new matching captures
  populate it on later passes. Every cell retains its source.
- **Review every generated change.** Curated output is Markdown and JSONL in Git. hoppr
  commits each curation pass so you can diff or revert it.
- **Configure the whole pipeline.** Choose what is indexed, what can be sent to a model,
  which artifacts are generated, their schemas and prompts, and which models do the work.
- **Keep the source folder untouched.** hoppr writes only inside `.hoppr/` for ordinary
  directory sources.

## Try it in 60 seconds

Requires Node 20.11 or later.

```bash
npm install -g hoppr       # or prefix commands with npx

cd ~/research/my-field
hoppr init -y
hoppr search "papers that challenge retrieval-augmented generation"
```

A hoppr works like a Git repository: commands run in nested directories find the nearest
`.hoppr/` by walking up the tree.

Keep adding supported files to the folder as usual. `hoppr sync` picks them up on demand;
the optional daemon watches for changes and indexes them in the background. There is no
separate import directory for ordinary folder sources.

Or point a globally registered hoppr at material elsewhere:

```bash
hoppr init --global --name papers --from dir:~/research --curation papers
hoppr init --global --name archive --from dir:~/Archive --curation index-only
hoppr init --global --name work --from agents:claude-code,codex
```

Folder sources stay in place. Agent connectors instead store a redacted, normalized
Markdown snapshot of each session because harness-owned logs may later change or disappear.

## Search the folder, not the file names

```bash
hoppr search "papers that disagree about scaling laws"
hoppr search "the receipt for the monitor"       # source + generated artifacts by default
hoppr search "whiteboard photo about onboarding" --since 30d
hoppr search "the flaky test fix involving fake timers" --explain
```

All artifact types share one keyword index and, when enabled, one vector index. Filters
run before ranking. If a raw capture has a curated page, the two collapse into one result
instead of competing.

Connect it to an agent:

```bash
hoppr mcp install                    # agent can select any registered hoppr
hoppr -H work mcp install --pinned  # expose only the work store
hoppr mcp status --probe
```

The MCP server is a stdio process launched by the client. It opens SQLite directly, so it
does not depend on the daemon.

Agents do not need MCP to use a hoppr. The store is a normal directory: they can `rg`
the Markdown wiki, read source paths, or inspect `curated/graph/*.jsonl` directly. MCP
adds ranked search and graph traversal; it is not a filesystem abstraction or security
boundary.

## Start with a preset, then change anything

| preset | builds | model calls |
|---|---|---|
| `notes` | source pages and cross-document concepts | yes |
| `papers` | one summarized page per document | yes |
| `agents` | pages, concepts, and proposed skills | yes |
| `index-only` | keyword and vector search | no |
| `minimal` | keyword search only | no |

Presets are starting points, not locked modes. The individual layers remain configurable:

- `hoppr.toml` controls retrieval, extraction, curation, scheduling, models, and Git.
- `.hopprignore` separates files to skip from files to index without model access.
- `.hoppr/curated/tables/` contains standing table schemas.
- `.hoppr/schemas/` defines wiki outlines, entity types, relationships, and skill settings.
- `.hoppr/curated/prompts/` contains the editable prompts used during curation.
- Hand-edited generated files are recorded in `<store>/LOCKED` and never overwritten.

```toml
[retrieval]
embeddings = true
graph = true

[retrieval.extract]
ocr = true
image_llm = false
pdf = true
pdf_ocr = true
office = true

[llm]
fast_provider = "openrouter"
quality_provider = "ollama"
```

The wiki follows
[Karpathy's LLM wiki specification](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f),
including Markdown pages, frontmatter, `[[wikilinks]]`, a generated catalog, and an
append-only operation log. Open `curated/wiki/` directly in Obsidian or let an agent
navigate it as files.

The optional knowledge graph follows the same rule. `hoppr graph build` writes typed
entities to `curated/graph/nodes.jsonl` and cited relationships to
`curated/graph/edges.jsonl`. Search those files with `rg`, use `hoppr graph show <name>`
for one-hop traversal, or let an MCP agent call `hoppr_graph_search` and
`hoppr_graph_show`. Every edge carries an evidence quote and source id.

<details>
<summary><strong>See the wiki, tags, tables, and status dashboard</strong></summary>

### Wiki

![hoppr wiki](docs/02-wiki.png)

### Tags

![hoppr tag vocabulary](docs/03-tags.png)

### Tables

![hoppr extraction tables](docs/05-tables.png)

### Status

![hoppr status dashboard](docs/04-status.png)

</details>

## Structured extraction

Define a standing table schema:

```toml
# .hoppr/curated/tables/meetings.table.toml
match = "scope:raw"

[columns]
date = { type = "date", required = true }
attendees = { type = "list[string]" }
outcome = { type = "enum", values = ["solved", "partial", "abandoned"], converging = true }
```

Then query it:

```bash
hoppr tables rebuild meetings
hoppr table meetings --trace
hoppr sql "select outcome, count(*) from v_meetings group by outcome"
```

Rows are exported as JSONL. Manual edits pin the row, so later extraction preserves your
changes. `converging = true` reuses existing values as preferred vocabulary.

## Optional: turn agent history into reusable skills

The deep pass reads each new session once for what it *established* — not what it was
about — as typed claims, each carrying the quote that established it. Those claims become
four kinds of skill, all in the `SKILL.md` format harnesses already load.

| skill | holds | how it is made |
|---|---|---|
| `hoppr` | the front door — standing context inlined, everything else routed to | assembled by code |
| `glossary` | what the nouns in your world mean and where they live | a list, built by code from your sessions |
| `preferences` | rules and tastes, each marked MUST or PREFER | the same |
| guardrails | one recurring failure each, and how to stop it | mined from your corrections |
| procedures | how a recurring job gets done, and what goes wrong | mined per cluster, then verified |

The two lists accumulate, assembled from the claims **by code rather than by a model**, so
every line cites a real capture and rebuilding costs nothing. A newer statement about the
same subject replaces the older one; `git log --follow` on the file is the history.

**A preference stated once is binding.** Requiring three repetitions would mean the only
preferences hoppr learns are the ones you have already had to repeat three times.

Procedures still need the transcripts — the steps and the failures are in there. They are
mined per cluster, scored against a gate that requires a real trigger, concrete steps and
a pitfalls section, and then handed to a second pass whose job is to **refute** them
against their own evidence. Whether a procedure recurred is corroboration; whether it
generalizes is judged, not counted.

```bash
hoppr deep
hoppr skills review                   # costliest proposals first
hoppr skills why preferences          # per line: who said it, in what words, what it replaced
hoppr skills install hoppr            # the front door — one file, read at the start of a task
hoppr skills install debug-flaky-vitest
hoppr skills mark debug-flaky-vitest --wrong   # it was stale; hoppr counts that
```

Installing the front door is one action and the change shows up in the next session: it
inlines what your words mean and how you want work done, and routes to the situational
skills instead of inlining those. Standing context has to be known *before* the work — by
the time an agent notices it is writing a status update it has already picked a register.

A skill that stops working stops being dispatched. When a later session loads an installed
skill, hoppr judges the work that followed — did the task actually come out right — and a
skill that keeps not landing is archived out of the dispatcher without being deleted.
Rejections, hand-edits and `mark` count too.

Only quotes from you count toward the three ledgers. A transcript also contains assistant
prose, tool output, and any file the agent read, all of which read like confident claims
about how things should be done; hoppr checks the quote against what you actually typed
rather than asking the model to be careful.

Before a proposal reaches you, hoppr **replays** it: recorded corrections become test
cases, and the skill is scored on cases it was not mined from, once with it loaded and
once without. A skill that changes nothing is inert; a skill that breaks a case the agent
already handled is rejected outright.

```bash
hoppr skills verify run-before-reporting
# fail  1 regression(s) — broke a case the baseline handled
#   prevents  2/3  ignored-a-stated-preference
#   regression 3/3 asked-what-was-readable
```

Three draws per case, because one is not stable — the same skill on the same case moved
from `regression` to `prevents` between two runs here, and the bench retires skills. It is
a model judging a model against a text stub, so it cannot see environment or path
failures; a pass means "did no visible harm on recorded failures", not "verified".

hoppr never auto-installs a skill. Proposals require explicit acceptance and installation,
and rejected proposals are remembered.

## What your sessions say about your agent

```bash
hoppr mirror          # read it
hoppr mirror --mine   # and write a skill for each thing that keeps going wrong
```

Everything above hands you a queue. This is the other thing the corpus can produce, and
the only thing in it that no repository, README or config file already contains.

The deep pass reads every session a second time for **corrections** — the moments the
agent got it wrong and you said so. A correction is not a lesson. A lesson is a standing
claim, superseded when a newer one contradicts it. A correction is an *event*: it happened
at a time, it cost turns, and a second occurrence is more evidence rather than a
replacement.

```
In 340 sessions you corrected the agent 87 times, costing roughly 210 turns of rework.

  1. Reported the fix as working without running anything
     claimed-done-without-running · ~40 turns across 14 sessions · rework

     You said:
     > did you actually run the tests or are you just guessing again

     The fix — run-before-reporting
     hoppr skills install run-before-reporting
```

Ranked by cost, not by count. A count answers "what happens most", which you can usually
guess. Cost answers "what is this costing me", which you cannot.

Cost is turns burned weighted by severity, because turns alone measure how long you argued
rather than what the mistake cost. The most expensive correction found on a real corpus —
an agent indexing 1Password credentials off the filesystem — took one turn to stop. Both
the weights and the turn estimates are named as estimates wherever they are shown.

Failure modes converge instead of accumulating: each batch is shown the modes already in
use and reuses one before coining a new one, the same way the tag vocabulary converges.

`--mine` writes a **guardrail** per mode: a short skill whose only job is to stop that one
failure, quoting your own words back in its `## What goes wrong` section. It faces the same
promotion gate as any mined skill, and the miner answering "this is not one repeatable
mistake" is expected. The link between a mode and its guardrail is causal by construction —
the guardrail is mined *from* the mode, never inferred from a shared transcript.

Only your own words count here, checked against what you typed. An assistant apologizing
for itself is the most quotable prose in any transcript, and without that check the top of
every report becomes whatever the model most likes to apologize for.

## Starter skills, before anything is mined

A store's first day has nothing to cluster, which is exactly when someone is deciding
whether installing this was worth it. What *is* available on day one is the project:

```bash
cd ~/code/my-app && hoppr init
# wrote 3 starter skills from this project: verify-before-done, where-things-live, commit-style-here
```

They are read off the directory — its verify commands, its layout, its commit history — so
they say `npm run check`, not "verify your work". **Nothing is written that detection could
not fill in.** A repo with no test command gets no testing skill rather than a platitude
about testing; a pack of generally-good advice is true, unobjectionable, and useless,
because every generic line loaded into a session displaces a specific one.

They are hypotheses rather than findings and say so in their own text. They regenerate as
the project changes, and stop the moment you edit one.

## What hoppr can read

hoppr can index prose, HTML, JSON, YAML, CSV, PDF, Word, Excel, PowerPoint, and common
image formats. Images use local OCR for searchable text and an optional vision model for
visual description. Scanned PDFs use OCR on the first five pages.

```gitignore
# .hopprignore
secret/              # never index
*.zip

[no-curate]
archive/**            # searchable, never sent to a model
*.csv
```

Extraction failures are isolated to the affected file and fall back to indexing its name
and path. See [supported inputs](docs/FILE-TYPES.md) for exact formats and fallbacks.

## Local-first by construction

```text
raw input  ──curate──>  curated/  ──index──>  .index/
never rewritten         Git-tracked            rebuildable
```

- A directory source is indexed in place and never opened for writing.
- Agent sessions are stored as normalized snapshots in `.hoppr/raw/`; ordinary folder
  sources are referenced where they already live.
- Curated Markdown, tables, and skills are tracked in Git.
- Search indexes and embedding caches are rebuildable.
- A single optional daemon watches every registered store; CLI and MCP access work
  without it.

hoppr does not scrape the web or connect to external accounts. Designs for arXiv,
YouTube, bookmarks, iMessage, and platform exports live in
[Future sources](docs/FUTURE-SOURCES.md), outside the core package.

## Models and cost control

Keyword search needs no model or optional dependency. Local embeddings add semantic
search. Curation needs either a supported API key or Ollama.

```bash
export OPENROUTER_API_KEY=...
```

```toml
[llm]
fast_provider = "openrouter"    # tagging and extraction
quality_provider = "anthropic"  # synthesis and skill mining
```

`index-only` makes no model calls. `[no-curate]` keeps selected files searchable without
sending them to a model. Set `[llm] provider = "ollama"` to keep curation local.

Configuration precedence:

```text
defaults < ~/.hoppr/hoppr.toml < <store>/hoppr.toml < HOPPR_* environment < CLI flags
```

Keep API keys in the environment, `~/.hoppr/.env`, or `<store>/.env`, not in
`hoppr.toml`. `hoppr doctor` reports the active provider, model, and key source.

## Security

Folders and agent logs may contain pasted keys or echoed `.env` files. hoppr redacts
recognized credentials before extracted text is indexed, embedded, committed, or sent
to a model. The original source is never modified.

Built-in redaction covers common vendor tokens, private keys, bearer tokens, JWTs,
credentials in URLs, suspicious assignments, and an entropy-based fallback. It reduces
accidental exposure but cannot make an untrusted corpus safe to publish.

## Commands

```text
hoppr init | setup | doctor
hoppr add | sync | search | get | related
hoppr index | curate | deep | reindex | embed | catalog
hoppr tables | table | sql | graph
hoppr skills | mirror | prompts | journal | undo
hoppr mcp | vfs | daemon | web | browse
```

See the [command reference](docs/COMMANDS.md) for every command, flag, configuration key,
and environment variable.

## Documentation

- [Command reference](docs/COMMANDS.md)
- [Supported inputs and redaction](docs/FILE-TYPES.md)
- [Complete configuration examples](docs/examples/)
- [Future source designs](docs/FUTURE-SOURCES.md)

## Development

```bash
npm install
npm run check
npm run e2e
npm run hoppr -- --help
```

## License

MIT
