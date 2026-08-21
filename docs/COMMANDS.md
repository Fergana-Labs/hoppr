# hoppr — command reference

The default workflow starts in a directory you already have:

```bash
cd <folder>
hoppr init
hoppr index
hoppr search "what you are looking for"
```

`hoppr init` creates `<folder>/.hoppr/` and uses the surrounding folder as its source.
The source files remain in place and are never opened for writing. Generated wiki pages,
tables, schemas, prompts, and the search database live under `.hoppr/`.

Every command accepts these global flags:

| flag | meaning |
|---|---|
| `-H, --hopper <name>` | which hoppr to act on |
| `--store <path>` | an explicit store path, bypassing the registry |
| `--json` | machine-readable `{ok, data, meta}` envelope — on every read command |

With neither `-H` nor `--store`, hoppr walks **up** from your working directory looking for
a `.hoppr/` store, the way git finds `.git/`.

---

## Creating and listing hoppers

```bash
hoppr init [path]                       # index THIS folder — like `git init`
hoppr init --from agents:claude-code,codex --global --name work
hoppr init --from dir:~/research --global --name papers
```

| option | meaning |
|---|---|
| `--from dir:<path>` | index a folder; the files stay where they are |
| `--from agents:claude-code,codex,opencode,openclaw` | index your AI coding sessions |
| `--from manual` | nothing automatic; you throw things in by hand |
| *(omitted)* | **the folder you are in** |
| `--global --name <n>` | put the store in `~/.hoppr/<n>` instead of here |
| `--manual` | capture-only: do not index the surrounding folder |
| `--curation <preset>` | `notes` \| `papers` \| `agents` \| `index-only` \| `minimal` |
| `--describe <text>` | the one-line "when to use this" an agent reads to pick a hoppr |
| `--copy` | copy raw inputs into the store instead of referencing in place |
| `--exclude <glob...>` | skip these paths (`.hopprignore` is the fuller mechanism) |
| `-y, --yes` | index and curate immediately, without asking |

`hoppr init` can index and curate immediately. In a non-interactive terminal, the prompt
defaults to no so scripts do not start model work unexpectedly.

```bash
hoppr hoppers            # every hoppr, wherever it lives
hoppr init [path]        # a store here — like `git init`
hoppr init --global --name <n>   # …under ~/.hoppr instead
hoppr setup              # find your agent logs, offer a hoppr for each
hoppr curation           # what each preset builds
```

`hoppr setup` detects Claude Code, Codex, opencode, and openclaw, reports the available
session counts, and offers to create one hoppr per harness. It is idempotent.
`--skip-agents` only downloads the embedding model.

## Putting things in

```bash
hoppr add "a note that belongs with this folder" -t idea
echo "..." | hoppr add                    # reads stdin when piped
hoppr add --file ./paper.pdf
hoppr add --url https://example.com/post   # records the link; hoppr does not fetch
hoppr sync                                # pull from the configured source
hoppr sync --since 7d | --full | --dry-run
```

`hoppr ingest` is an alias of `hoppr add`. For a folder hoppr you rarely need either —
putting a file in the folder is the same thing, and the daemon picks it up.

## Finding things

```bash
hoppr search "papers that disagree about scaling laws"
hoppr query  "..."                         # backward-compatible alias
```

| option | meaning |
|---|---|
| `--scope curated\|raw\|all` | default `all`; restrict to generated artifacts or source material when needed |
| `--mode hybrid\|fts\|vec` | default `hybrid` — BM25 arm + vector arm, RRF-fused |
| `--tag <t...>` `--project <p>` `--kind <k>` `--since <when>` | filters, applied **inside** each arm before ranking |
| `-n, --limit <n>` | how many hits |
| `--explain` | per-arm ranks and the boosts applied |

Filters also work inline: `hoppr search "rrf tag:search project:hoppr since:7d"`.

```bash
hoppr get <id> [--meta]      # one capture or page (id prefix is enough)
hoppr source <id>            # captured source content
hoppr related <id> [-n]      # vector neighbours plus wiki backlinks
hoppr ls [-n] [--kind]       # newest captures first
hoppr catalog [--rebuild]    # the wiki catalog
hoppr log [-n]               # the curator's diary
hoppr stats                  # what is in the store
```

## Getting it off the ground

```bash
hoppr index                  # sync + curate + embed, in the order it has to happen
hoppr index --no-curate      # index and embed only; no model calls
hoppr index --full           # pull all history, not the default window
```

`hoppr init` creates the store and offers to do this straight away. `hoppr index` is the
same pipeline on demand, which is useful after changing the configuration. The individual
`sync`, `curate`, and `embed` commands remain available when you need to run one stage.

## Curating

```bash
hoppr curate                 # fast pass: a page per new capture
hoppr curate --dry-run       # show what would happen, write nothing
hoppr curate --rebuild       # discard curated pages, regenerate from raw
hoppr curate -n 20           # stop after 20 captures

hoppr deep                   # the nightly pass, now
hoppr deep --dry-run
```

The deep pass runs taxonomy convergence, concept pages, skill mining, and lint.

```bash
hoppr prompts list | show <id> | reset <id>
```

Prompts are ejected to `curated/prompts/*.md` on init. Editing one re-stales exactly the
rows it produced, so the next pass regenerates them.

## Reviewing and undoing

```bash
hoppr journal                # recent passes
hoppr undo <passId>          # reverse one pass — curated/ only, never raw/
git -C <store> diff HEAD~1 curated/
git -C <store> revert <sha>
```

## Skills

```bash
hoppr skills list
hoppr skills show <slug>
hoppr skills why <slug>            # the exact sessions it was mined from
hoppr skills review                # accept/reject interactively
hoppr skills accept <slug...>      # non-interactive, for pipes and CI
hoppr skills reject <slug...>      # remembered; not re-proposed
hoppr skills install <slug> [--project|--target <dir>]
hoppr skills uninstall <slug>
hoppr skills audit                 # score every skill against the promotion gate
hoppr skills resolver              # regenerate the dispatcher table
hoppr skills mine                  # mine now without a full deep pass
```

Skills must be accepted and installed explicitly.

## Tables

```bash
hoppr tables list
hoppr tables new <name>            # a starter definition you then edit
hoppr tables rebuild [name]        # re-extract rows
hoppr tables drop <name>
hoppr table <name> [--trace] [--csv]
hoppr sql "select outcome, count(*) from v_sessions group by outcome" [-n]
```

`--trace` walks each cell back to the capture it came from. `hoppr sql` is read-only: a
separate connection, a single-`SELECT` parse gate, a row cap.

## The graph

Off by default. Turn it on with `[retrieval] graph = true` and define your entity types
and relations — see [`examples/schemas/graph.toml`](examples/schemas/graph.toml).

```bash
hoppr graph                     # entities, most-mentioned first
hoppr graph --type person -q dana
hoppr graph show <name>         # one entity and everything one step from it
hoppr graph build [-n]          # extract now, without a full deep pass
```

Every edge stores its source sentence. Types and relations outside the configured schema
are discarded. The graph is also exported to ordinary tracked files:

```text
curated/graph/nodes.jsonl    typed entities
curated/graph/edges.jsonl    relationships, evidence quotes, and source ids
curated/graph/seen.jsonl     extraction checkpoint for rebuilding the index
```

Agents can search these files directly with `rg` or `grep`. MCP clients can use
`hoppr_graph_search` for entity lookup and `hoppr_graph_show` for cited one-hop traversal.

## Serving it to agents

```bash
hoppr mcp install                     # every hoppr, selected per call
hoppr -H work mcp install --pinned    # MCP tools always target one hoppr
hoppr mcp status [--probe]            # who is wired up; --probe does a real handshake
hoppr mcp uninstall
hoppr mcp serve [--pinned]            # stdio server; your editor runs this, not you
hoppr vfs 'find . -name "*.md" | head'   # the read-only shell agents get
```

The filesystem is the primary interface: agents can read the store's Markdown and JSONL
directly. MCP adds indexed retrieval and a read-only shell for clients that prefer tools;
pinning controls tool routing, not filesystem visibility.

## The daemon

```bash
hoppr daemon start | stop | status | logs
```

One process manages all registered hoppers. It detects new and deleted stores within 60
seconds. The CLI and MCP server open SQLite directly, so capture and search do not depend
on the daemon.

## Dashboard and TUI

```bash
hoppr web [--port <n>] [--no-open]   # Search · Wiki · Tables · Skills · Tags · Status · Daemon
hoppr serve [--port]                 # just the HTTP API, foreground
hoppr browse                         # interactive terminal browser
```

## Maintenance

```bash
hoppr doctor            # store, git, daemon, MCP wiring, model tiers, key files
hoppr setup             # detect agent logs and download the local embedding model
hoppr embed [-n] [--batch]
hoppr reindex [--full] [--forget-embeddings]
hoppr retry --failed    # re-arm rows that hit the terminal failure cap
hoppr config show | path
hoppr schema sync       # regenerate CLAUDE.md so the store describes itself
hoppr connectors list
```

`reindex --full` preserves the embedding cache. Add `--forget-embeddings` to discard it
and recompute vectors.

---

## Configuration

| question | home | inherited? |
|---|---|---|
| provider, model, embedder, and Git defaults | `~/.hoppr/hoppr.toml` | ✅ |
| API keys | `~/.hoppr/.env`, `<store>/.env` | ✅, store wins |
| source and curation preset | `<store>/hoppr.toml` | ❌ never |
| indexed and model-accessible files | `.hopprignore` beside the data | ❌ |
| prompts and table schemas | files under `curated/` | ❌ |

```
defaults < ~/.hoppr/hoppr.toml < <store>/hoppr.toml < HOPPR_* env < CLI flags
```

Arrays replace rather than merging. Keys are read from the environment first, then `.env`.

### `.hopprignore`

```
# gitignore syntax; the folder's own .gitignore is honoured too

secret/            # never indexed — hoppr does not know these exist
*.zip

[no-curate]        # indexed and searchable, never sent to a model
archive/**
*.csv
```

Indexing is pure SQL, so `[no-curate]` files are fully searchable at **zero token cost**.

### Retrieval

```toml
[retrieval]
embeddings = true          # vector search; keyword is always on
graph = false              # typed entities and relations

[retrieval.extract]        # the expensive parts of "index this folder"
ocr = true                 # local OCR over images — free, ~800ms each
image_llm = true           # a vision model describing what an image SHOWS
pdf = true                 # PDF text layers
pdf_ocr = true             # rasterise + OCR a scan, first 5 pages
office = true              # Word, Excel, PowerPoint

[retrieval.rerank]
method = "rrf"             # rrf | weighted | none
k = 60                     # rrf damping; larger = flatter
```

Disabled extraction steps are skipped during sync. `rrf` is the default because it does
not require score calibration between BM25 and cosine distance. `weighted` normalizes
scores per query; `none` uses a single result arm and is useful for ranking diagnostics.

### Schemas in their own files

`.hoppr/schemas/graph.toml`, `wiki.toml`, and `skills.toml` merge into their matching
configuration sections and take precedence over them. Separate files keep larger schemas
out of the main store configuration.

**Sections inside a schema file are relative:** write `[[outline]]`, not
`[[wiki.outline]]`. The latter nests a level too deep and is silently ignored.

### Skills

```toml
[skills]
mine = "auto"              # auto | targeted | off
targets = ["cutting a release", "debugging a flaky test suite"]
seed = ["comms-preferences", "working-agreements"]
```

`seed` skills ship with hoppr and are written into every new store. Mined skills require
enough related transcripts to form a cluster. Editing a generated skill pins it.

### Advanced

Rarely worth changing, but they exist:

```toml
[index]
driver = "auto"            # auto | better-sqlite3 | node-sqlite
chunk_chars = 3200         # embedding chunk size
chunk_overlap = 200        # overlap between consecutive chunks

[intake]
redact_patterns = []       # extra regexes, on top of the 16 built in

[search]

[views]
```

### Environment

| variable | meaning |
|---|---|
| `HOPPR_HOME` | where hoppers live (default `~/.hoppr`) |
| `HOPPR_STORE` | an explicit store path |
| `HOPPR_HOPPER` | default hoppr name |
| `HOPPR_PORT` | daemon HTTP port (default 7717) |
| `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | model access |
