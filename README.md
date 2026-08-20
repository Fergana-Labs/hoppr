# hoppr

**A local-first hopper for agent memory.** Throw things in — notes, links, files, agent
transcripts. A sleep-time agent curates them into a linked markdown wiki, structured
tables, and reusable skills. Other agents read it back over MCP, the filesystem, a CLI,
or a local HTTP API.

Your Claude Code, Codex, opencode, and openclaw sessions already sit on disk as JSONL.
Nothing indexes across them, so every new session starts cold and every workflow you
worked out last month is buried in a transcript nobody will read again. hoppr turns that
exhaust into something that compounds.

```bash
cd ~/code/myproject
npx hoppr init                    # like `git init` — creates ./.hoppr
npx hoppr add "we chose RRF because bm25 and cosine aren't on one scale"
cd src/deep && npx hoppr query "why rank fusion"    # found by walking up
```

**A hoppr lives in a directory, the way a git repo does.** Create one anywhere, throw
things in, get a sleep-time index over it. It moves, clones, and `rm -rf`s with the thing
it describes.

Point one at a folder and it indexes what is already there — prose, PDFs, Word, Excel,
PowerPoint, and images by their text:

```bash
npx hoppr new papers --from dir:~/Downloads            # files stay where they are
npx hoppr new work   --from agents:claude-code,codex   # your coding sessions
```

Each hoppr has its own index, its own tag vocabulary, and its own wiki — which is what
lets the vocabulary actually converge. `~/.hoppr/hoppers.json` indexes them all wherever
they live, so `-H <name>` and the daemon reach any of them, and one daemon manages
every one.

**hoppr does not go to the network.** No scraping, no APIs, no accounts — a folder and an
index over it. External sources (bookmarks, arXiv, YouTube, iMessage, platform exports)
are designed but deliberately not built: see
[`docs/FUTURE-SOURCES.md`](docs/FUTURE-SOURCES.md).

---

## Where things live



The store holds metadata — index, wiki, tables, skills. **Raw inputs may live somewhere
else entirely**, and for a folder source they do.

| source | raw tier | why |
|---|---|---|
| `dir:~/Downloads` | **stays where it is** | your files; hoppr records provenance and extracted text, and never opens them for writing |
| `agents:claude-code` | copied into `raw/` | the harness rotates its logs, so a reference would silently rot |

```
  INTAKE ─▶  raw tier     irreplaceable · hoppr never writes it     ·  git-tracked (copy mode)
               │
          curate (LLM)
               ▼
  AGENT  ─▶  curated/     wiki · tables · skills                    ·  git-tracked
               │          regenerable — costs tokens, not data
             index
               ▼
  SYSTEM ─▶  .index/      one search index over BOTH tiers          ·  gitignored
```

1. **hoppr never writes the raw tier.** In copy mode, `src/store/raw.ts` exports no
   function that rewrites or deletes a capture. In reference mode it is stronger still:
   the files are never opened for writing at all. Both are tested.
2. **`curated/` is disposable.** `hoppr curate --rebuild` reproduces it. A bad prompt, a
   bad model, or a bad night costs tokens, never data.
3. **`.index/` is disposable.** `hoppr reindex --full` rebuilds it and carries the
   embedding cache across, so it costs nothing at all.

Only tier 1 needs backing up. That is what makes it safe to point this at your entire
agent history and let an LLM loose on it.

## Git is the review layer

The store is a git repo and **hoppr commits automatically — one commit per curate pass**,
with the curator's own log entry as the message. `[git] mode = "off"` turns that off.

```
$ git log --oneline
8f3a201 deep pass — 1 tag merges, 3 concept pages, 2 skill proposals
1c0e9dd fast pass — 12 captures, 12 pages written, new tags: rank-fusion, flaky-tests
3515db6 captured 12 items
f771995 hoppr init

$ git diff HEAD~1 curated/     # exactly what the agent did last night
$ git revert 8f3a201           # undo, predating hoppr's own journal
```

This works only because writes are **skip-if-identical**: a pass that inspects 2,000
files and changes 12 produces a 12-file diff. There's a test for it.

## The wiki

The knowledge layer implements
[Karpathy's LLM wiki spec](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
— same folder shape, same page types, same `[[wikilinks]]`, same ingest/query/lint verbs.

```
curated/wiki/
  index.md          catalog — generated deterministically, so it can't drift
  log.md            append-only record of every operation
  sources/          one page per capture
  concepts/         accumulates across sources
  entities/  comparisons/  digests/
```

`hoppr init` also writes a **`CLAUDE.md`** describing the whole contract. That's the
portability play: an agent pointed at the store with no MCP server and no knowledge of
hoppr can read that file and work the wiki correctly. Obsidian opens `curated/wiki/` and
the links resolve.

## What it reads

| | how | fails to |
|---|---|---|
| `.md .txt .html .json .yaml .csv` … | direct | — |
| **PDF** | text layer (`unpdf`, optional dep) | name, and says "likely a scan" when there is no text layer |
| **Word · Excel · PowerPoint** | `.docx/.xlsx/.pptx` are ZIPs of XML — unzipped in-process, no format library, no native build | name, and names the reason |
| **Images** `.png .jpg .gif .webp` | vision model: text **verbatim first**, then a description | name, when no model is configured |
| `.doc .xls .ppt` | pre-2007 binary — not extractable | name, and tells you to re-save as `.docx` |

There is no separate OCR engine on purpose: the models hoppr already talks to transcribe
text *and* describe an image, where a native OCR dependency would add an install step for
half the result. Text comes first in the prompt because a screenshot of an error message
is only useful if the error message itself is searchable.

### What it skips — one file, two sections

```
# .hopprignore  (gitignore syntax, and .gitignore is honoured too)

secret/            # never indexed — hoppr does not know these exist
*.zip

[no-curate]        # indexed and searchable, never sent to a model
archive/**
*.csv
```

The two tiers are a real difference, not a shade of one: indexing is pure SQL, so
`[no-curate]` files are fully findable by keyword *and* vector at **zero token cost**.
That is the setting a big archive actually wants — worth finding, not worth paying to
summarise.

They live in one file because both are the same kind of decision — which paths get how
much attention — and splitting them across a dotfile and a config key made one concept
look like two.

A third tier is not a pattern at all: hand-edit any curated page and it becomes `pinned`,
after which evidence still accrues but the prose is yours.

Every branch degrades to indexed-by-name rather than throwing. A folder you point hoppr
at *will* contain a corrupt PDF, a password-protected spreadsheet, and a file you cannot
read; none of them should cost you the other 900.

```bash
$ hoppr search "no such table vec_chunks"      # text that exists only inside a PNG
$ hoppr search "openrouter latency benchmark"  # a row in an .xlsx
$ hoppr search "not a vector database"         # a slide in a .pptx
```

## Choosing what gets built

Four things can be built from a source, and they are independent:

| | what it is | costs |
|---|---|---|
| **keyword index** | BM25 over every capture | nothing — always on |
| **vector index** | local embeddings, semantic search | a one-time 200MB model download |
| **wiki** | a page per document, plus concept pages across them | one model call per capture |
| **skills** | recurring procedures distilled into `SKILL.md` | model calls in the nightly pass |

Search is **hybrid whenever both indexes exist** — a BM25 arm and a vector arm, RRF-fused.
With no vector index it degrades to keyword and says so. There is no "which search" to
configure, only which indexes you built.

Pick a bundle rather than four switches:

```bash
$ hoppr curation
notes        a page per document, plus concept pages that accumulate across them
papers       a page per document — summary, tags, entities. No cross-document synthesis
agents       pages, concepts, and procedures distilled into installable skills
index-only   keyword + vector search, no model calls at all
minimal      keyword search only — no model, no embeddings, nothing to download

$ hoppr new archive --from dir:~/Archive --curation index-only
```

A preset supplies defaults; every switch stays overridable in `hoppr.toml`. It is a preset
rather than a mode because the switches genuinely are independent — vectors without a wiki,
a wiki without skills — and the useful configs are the corners between the named ones.

**Wiki schema.** Page types are Karpathy's, and two of them are implemented: `source` (one
per capture) and `concept` (one per recurring theme, built across captures). `entity`,
`comparison`, and `digest` are specified in the layout but **not built yet**, so no preset
claims them — there is a test asserting no preset advertises a page type hoppr cannot
produce. Frontmatter and `[[wikilinks]]` follow the gist exactly, so the folder opens in
Obsidian either way.

**`index-only` means no model call anywhere**, which also means no tags — tags come from
the same call that writes a page. Spending a call per item while calling it index-only
would be the dishonest version.

## Search

One unified projection — captures, wiki pages, table rows, and skills all land in one
`docs` table with one FTS index and one vector index. Every artifact type is searchable
lexically *and* semantically by default, including types added later.

```bash
hoppr query "rrf fusion tag:search project:hoppr since:7d"
hoppr query "the meeting where we killed the v2 rewrite" --scope all --explain
```

- **RRF fusion** across a BM25 arm and a vector arm — rank-based, so it needs no score
  calibration between bm25's unbounded negatives and cosine's 0..2.
- **Curated outranks raw** (1.5×), and a raw hit whose capture already has a page
  *collapses into that page* rather than competing with it.
- **Filters run inside each arm, before ranking.** Post-filtering silently empties
  results, which reads as "there's nothing about X" rather than "your filter was narrow".
- **Snippets are built after fusion**, only for the rows actually returned.

## Tables

Define a schema; the curator fills it. Every cell traces back to the capture it came from.

```toml
# .hoppr/curated/tables/meetings.table.toml
match = "scope:raw"          # the ORIGINAL capture, not its summary
[columns]
date      = { type = "date", required = true }
attendees = { type = "list[string]" }
outcome   = { type = "enum", values = ["solved","partial","abandoned"], converging = true }
```

```bash
$ hoppr table meetings
date        | attendees        | decision                    | outcome
2026-03-11  | ["Dana","Sam"]   | Ship rank fusion with k=60  | solved
2026-03-04  | ["Dana","Priya"] | Drop the v2 schema rewrite  | abandoned

$ hoppr sql "select outcome, count(*) n from v_meetings group by outcome"
$ hoppr table meetings --trace     # …with the source capture per row
```

A table is a **standing instruction**, not a one-off report: once defined, every new
capture is classified into it on the next curate pass.

`converging = true` feeds the column's existing values back as preferred vocabulary — the
same trick that keeps tags from drifting, applied per column. Without it, `outcome`
accumulates *abandoned*, *dropped*, *cancelled* and *killed*.

**`match` matters more than it looks.** `scope:raw` reads the original capture;
`kind:source` reads the curated summary, which has already dropped the detail a table
wants — a date that was in the source comes back `"Unknown"`.

### Editing rows by hand

Rows are exported to `<table>.jsonl` and **that file is authoritative**. Edit a cell, add
a line, delete a line — the next pass adopts your version and **pins** the row, so
extraction maintains everything around it and never overwrites what you wrote.

### An explicit outline

Most of the wiki is emergent — a concept page exists because captures clustered around a
tag. That is right for discovery and wrong for the three pages you know you want before
any data arrives. Name them, each with a standing brief:

```toml
# .hoppr/schemas/wiki.toml
[[outline]]
path = "open-questions.md"
mode = "maintain"                # rebuilt each deep pass; `once` writes it and stops
prompt = """
Questions the corpus raises and does not answer: decisions deferred, arguments
left unresolved, things marked TODO and never revisited. One bullet each, with a
[[wikilink]] to where it came up. If there are none, say so — do not invent.
"""
```

A page you hand-edit is pinned and left alone. A `path` ending in `/` reserves a folder
without dictating its pages. If there is nothing to write about yet the page is skipped
rather than filled with plausible generalities a later pass would have to unlearn.

## The graph

Off by default. Turn it on and define what you actually have — these entries are
**prompts, not validation rules**: each `description` is handed to the model verbatim as
the definition of what counts.

```toml
[retrieval]
graph = true

[[graph.entity_types]]
name = "person"
description = "A named individual who participated. Not an author cited in passing."

[[graph.relations]]
name = "works_on"
from = ["person"]
to = ["project"]
description = "Sustained involvement. Two names in one sentence is not a relation."
```

```bash
$ hoppr graph show Dana
Dana  person · 2 mentions

  → works_on         search rewrite
      "Dana leads the search rewrite"
```

**Every edge quotes the line it was read from.** That is the difference between a graph
you can audit and a pile of assertions — when an edge looks wrong you can read the
sentence that produced it. Off-schema types and relations are dropped in code, not asked
for politely in the prompt, because a model told to use five types will occasionally
invent a sixth.

## Skills

The deep pass clusters sessions by **procedural** similarity — repeated tool sequences,
recurring error→fix pairs — and distills them into `SKILL.md` files you can install into
Claude Code. **The failures are the point**: a transcript where you tried A, hit B, and
landed on C encodes the wrong turn, which is the only part your README doesn't have.

```bash
hoppr deep                        # mines proposals
hoppr skills review               # accept / reject, one at a time
hoppr skills why debug-flaky-vitest   # the exact sessions it came from
hoppr skills install debug-flaky-vitest
```

Skills are **proposed, never auto-installed**. A skill changes how every future agent
session behaves, so it gets a human gate — the one thing in hoppr that isn't automatic.
Rejections are remembered.

## Install

```bash
npm i -g hoppr    # or: npx hoppr
cd ~/notes && hoppr init
hoppr setup       # finds your agent logs, offers a hoppr for each
```

Node ≥ 20. Thirteen runtime dependencies, and the only native one is
`better-sqlite3` — which falls back automatically to Node's built-in `node:sqlite`
(FTS5, bm25, and sqlite-vec via `loadExtension` all work), so a failed native build does
not stop the install.

Five optional dependencies, each degrading to something usable rather than failing:

| package | size | gives you | without it |
|---|---|---|---|
| `@huggingface/transformers` | ~210MB | local embeddings | keyword search only |
| `tesseract.js` | 1.4MB + ~13MB data | OCR for images and scans | falls back to the vision model, then to name-only |
| `unpdf` | small | PDF text layers | PDFs indexed by name |
| `@napi-rs/canvas` | native, prebuilt | rasterising PDF pages for OCR | scanned PDFs indexed by name |
| `mammoth` | 2.1MB | Word tables and footnotes | built-in reader, prose only |

### Models

Set one key and you are done — `auto` prefers raw HTTP APIs in this order:

```bash
export OPENROUTER_API_KEY=...   # or ANTHROPIC_API_KEY, or OPENAI_API_KEY
```

Tagging and table extraction run once per item across the whole corpus, so they go over
a real API. Measured on 19 real transcripts, tagging a batch of 8:

| | per batch | dropped from batch | cost | needs |
|---|---|---|---|---|
| OpenRouter `claude-haiku-4.5` | **42s** | 8 of 19, re-asked individually | $0.0016/capture | a key |
| `claude` CLI | 65s+ | none | ~11k cached prompt tokens/call | an existing login |

Wall-clock across the whole corpus was close to a wash (187s vs 197s of model time). The
API path wins on latency per call, real cost accounting, and not needing a Claude login;
the CLI path returned more complete batches. `hoppr doctor` names the provider *and* the
model for each tier, because a valid provider paired with a model id it has never heard
of fails at the first call of a nightly pass, not at configuration time.

Split the tiers to put cheap tagging and good synthesis on different models:

```toml
[llm]
fast_provider = "openrouter"    # tagging, extraction — high volume
quality_provider = "anthropic"  # synthesis, taxonomy, skill mining
```

Model ids are **resolved after the provider**, from a per-provider default table —
`claude-haiku-4-5` and `anthropic/claude-haiku-4.5` name the same model but only one of
them is valid at a time, so a single shared default would silently misconfigure whichever
provider it wasn't written for. Set `[llm.models] fast`/`quality` only to override.

`provider = "ollama"` keeps everything on the machine.

### Where settings live

Four questions, four homes. Each one lives where it does for a reason, and nothing is
configurable in two places.

| question | home | inherited? |
|---|---|---|
| **who am I** — provider, model, embedder, git mode | `~/.hoppr/hoppr.toml` | ✅ by every store |
| **what are my keys** | `~/.hoppr/.env`, `<store>/.env` | ✅, store overrides |
| **what is this hoppr** — source, curation preset | `<store>/hoppr.toml` | ❌ never |
| **which files** — scope | `.hopprignore` beside the data | ❌ per source |
| **how should curation think** — prompts, table schemas | files under `curated/` | ❌ per store |

```
defaults  <  ~/.hoppr/hoppr.toml  <  <store>/hoppr.toml  <  HOPPR_* env  <  CLI flags
```

- **Keys are not in `hoppr.toml`** because a store is a git repo, and removing a secret
  from a tracked file does not remove it from history.
- **Identity is never inherited** because a global `[hopper] source = …` would silently
  repoint every hoppr at one corpus — invisible until you searched and got someone else's
  data.
- **Scope sits beside the data**, not in the store, because it is a fact about the folder
  and because that is where `.gitignore` already is.
- **Prompts and table schemas are files**, not TOML values: they are long, you iterate on
  them, and they belong in git history where you can diff what changed a curation pass.

### Keys

Keys go in a **`.env` beside the config** — `~/.hoppr/.env` globally, or `<store>/.env`
for one hoppr. Gitignored by default, and `hoppr doctor` warns if the file is not `600`
and names which file supplied each key.

```bash
$ cat ~/.hoppr/.env
OPENROUTER_API_KEY=sk-or-v1-…

$ hoppr doctor
ok  fast tier: openrouter · anthropic/claude-haiku-4.5  (~/.hoppr/.env)
```

Not in `hoppr.toml`, because a store is a git repo and removing a secret from a tracked
file does not remove it from history. And not environment-only, because **the MCP server
is spawned by your editor**, so it inherits that application's environment — which for a
GUI launch contains nothing from your shell profile. The real environment still wins, so
`OPENROUTER_API_KEY=… hoppr …` overrides for one call and CI needs no file at all.

## Commands

```
hoppr new <name> [--here] --from dir:<path> | agents:<harness,...> | manual
hoppr hoppers                 list your hoppers   ·   -H <name> selects one
hoppr init | setup | doctor | reindex [--full] | stats
hoppr add | ingest  [text]  [--file --url --title -t -p]
hoppr search | query <q>    [--scope curated|raw|all --explain --json]
hoppr get <id> | source <id> | related <id> | ls | index | log
hoppr sync [--full --since]  ·  hoppr connectors list
hoppr curate [--dry-run]     ·  hoppr deep      ·  hoppr embed
hoppr tables [list|new|rebuild|drop] · hoppr table <n> [--trace] · hoppr sql <q>
hoppr skills [list|show|why|review|audit|resolver|install|uninstall|mine]
hoppr prompts [list|show|reset]      ·  hoppr journal | undo <pass>
hoppr mcp [serve|status|install|uninstall]  ·  hoppr vfs <script>
hoppr curation                       what each preset builds
hoppr daemon [start|stop|status|logs]   one process, all hoppers
hoppr serve | web | browse
```

Every read command takes `--json` and emits a stable `{ok, data, meta}` envelope.

## Serving it to agents

```bash
hoppr mcp install                      # every hoppr, selected per call
hoppr -H work mcp install --pinned     # this repo sees ONE hoppr and cannot reach the others
```

The server is a **stdio subprocess your editor spawns** — it is not the daemon and does
not need it. `mcp install` writes an entry that launches `npx -y hoppr [--hopper <name>]
mcp serve [--pinned]`; the client starts one process per session and speaks JSON-RPC over
its stdin/stdout. It opens SQLite directly in WAL mode, so it works with the daemon
stopped, and it exits when the client does.

`hoppr_list` returns each hoppr with a one-line *when to use it* — that text is the
real interface, since it is what the model matches on. Eleven MCP tools: `hoppr_search`, `hoppr_get`, `hoppr_source`, `hoppr_add`, `hoppr_index`,
`hoppr_tags`, `hoppr_related`, `hoppr_recent`, `hoppr_vfs`, `hoppr_status`.
`hoppr_vfs` is a read-only shell (`ls cat find grep tree head wc sort uniq`, with pipes)
— one tool instead of ten navigation tools, because every tool costs context in every
conversation that loads the server.

## The daemon

**One process for every hoppr, wherever they live.** Not one per folder — N daemons would
mean N pidfiles, N ports to collide, and N copies of one scheduler.

```
~/.hoppr/daemon.json          the single lock + port         one per machine
~/.hoppr/hoppers.json         which stores exist             rescanned every 60s
   ├─ ~/code/api/.hoppr/      own watcher · own cron · own SQLite · own .env
   ├─ ~/code/web/.hoppr/      own watcher · own cron · own SQLite · own .env
   └─ ~/.hoppr/work/          own watcher · own cron · own SQLite
                              ── all sharing one serial model lane ──
```

| | shared | per hoppr |
|---|---|---|
| process, lock, port `7717`, dashboard | ✅ | |
| **model call lane** (serial) | ✅ | |
| index, vocabulary, wiki, schedule, keys | | ✅ |

Model calls share one lane deliberately: the hoppers are isolated in their *data*, not in
their *rate limit*, and five curate passes firing at once would only get throttled.

It picks up a hoppr you create and lets go of one you delete, both within 60s — stores
live in project directories now, so `rm -rf` on one is an ordinary thing to do, and
without the release the daemon would hold a watcher, a cron, and an open SQLite handle on
a deleted directory forever.

### Checking on it

```bash
hoppr daemon status      # running, pid, port, and every hoppr it manages
hoppr daemon logs        # what it has been doing
hoppr web                # the dashboard, on 127.0.0.1:7717
```

The dashboard's **Daemon** tab answers "is it alive and what is it doing" — pid, uptime,
port, managed hoppers, and a live activity log. The **Status** tab answers it per hoppr:

- **the curate queue** — how many captures are waiting, and how many hit three strikes and
  left the queue permanently, with the most recent error
- **the nightly pass** — last fired, last *succeeded*, and how far the watermark got.
  Those are three different facts and a failing pass makes them diverge
- **spend** — calls, failures, tokens, dollars
- **recent passes** — one row per `pass_id` with what it created and updated, which is the
  same unit `git revert` and `hoppr undo` operate on

All of it is read from state that already exists — the journal for what changed,
`llm_calls` for what it cost, the watermark for how far it got. A dedicated status table
would be a fourth source of truth free to disagree with the other three.

**Nothing here is required.** The CLI and MCP server open SQLite directly in WAL mode, so
a dead daemon degrades curation — never capture, never search.

### What isn't shared: keys

Each hoppr reads its own `.env`, and those values are held per-instance rather than put
into `process.env`. In a one-process-many-hoppers design a process-global variable cannot
be per-store — whichever store loaded first would own `OPENROUTER_API_KEY` for all of
them, and the second would silently bill the first's account. Tested.

## Security

hoppr reads your agent logs, and those contain pasted API keys and echoed `.env` files.
**Credentials are scrubbed at the extraction boundary, before anything is written** —
otherwise they'd be indexed, embedded, committed to git (where deleting them later
doesn't remove them), and sent to whichever model curates. This was not hypothetical: a
live Anthropic key turned up in the first real transcript during development.

Redaction is pattern-based and therefore incomplete by construction. It reduces exposure;
it does not make an untrusted corpus safe to publish. `[intake] redact = false` disables
it; `[llm] provider = "ollama"` is the path where nothing leaves the machine.

## Design notes

Things that look like details and are load-bearing:

- **Failure is terminal per row, never per batch.** A capture that fails three times
  leaves the sweep's partial index permanently. Without this, one malformed transcript
  wedges every future pass forever.
- **Staleness is a hash comparison, never a boolean.** Re-saving an unchanged file costs
  zero tokens.
- **`embedding_cache` is keyed by `(chunk_hash, model)`** and survives `reindex --full` —
  which is why a rebuild is free rather than merely fast.
- **Never advance a connector cursor past the last complete newline.** These files are
  appended to while you read them; a truncated final line is normal, and swallowing it
  loses that record forever.
- **Sessions touched in the last two minutes are `partial`** — indexed and searchable,
  but not curated. Paying a model to summarize a half-written transcript is waste.
- **The tag set is both the output and the dictionary.** Existing tags are fed back as
  preferred vocabulary, so it converges instead of drifting into `ai-agents` /
  `agentic-ai` / `llm-agents`. Enforcement is in code, not in the prompt.
- **`vec0` needs BigInt.** Both SQLite drivers bind plain JS numbers as REAL, and vec0
  rejects a REAL primary key — a per-row failure that silently disabled vector search
  while everything else looked healthy. There's a regression test.

## Docs

- [`docs/COMMANDS.md`](docs/COMMANDS.md) — every command, flag, and config surface
- [`docs/FILE-TYPES.md`](docs/FILE-TYPES.md) — what hoppr can read, and what it does with it
- [`docs/examples/`](docs/examples/) — complete config files you can copy
- [`docs/FUTURE-SOURCES.md`](docs/FUTURE-SOURCES.md) — external sources: designed, measured, not built

## Development

```bash
npm install
npm run check      # typecheck + lint + 289 tests
npm run e2e        # build, then 38 end-to-end checks against the built artifact
node src/cli.ts    # runs from source, no build step (Node strips the types)
```

## License

MIT
