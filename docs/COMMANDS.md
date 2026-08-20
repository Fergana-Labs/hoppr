# hoppr — command reference

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
hoppr init --from dir:~/Downloads --global --name papers
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
hoppr add "rank fusion beat weighted scoring" -t search -p hoppr
echo "..." | hoppr add                    # reads stdin when piped
hoppr add --file ./notes.pdf
hoppr add --url https://example.com/post   # records the link; hoppr does not fetch
hoppr sync                                # pull from the configured source
hoppr sync --since 7d | --full | --dry-run
```

`hoppr ingest` is an alias of `hoppr add`. Anything dropped in `<store>/inbox/` is captured by
the daemon and the file is consumed.

## Finding things

```bash
hoppr search "how did we decide on rank fusion"
hoppr query  "..."                         # alias
```

| option | meaning |
|---|---|
| `--scope curated\|raw\|all` | default `curated`; widens automatically when nothing is curated yet |
| `--mode hybrid\|fts\|vec` | default `hybrid` — BM25 arm + vector arm, RRF-fused |
| `--tag <t...>` `--project <p>` `--kind <k>` `--since <when>` | filters, applied **inside** each arm before ranking |
| `-n, --limit <n>` | how many hits |
| `--explain` | per-arm ranks and the boosts applied |

Filters also work inline: `hoppr query "rrf tag:search project:hoppr since:7d"`.

```bash
hoppr get <id> [--meta]      # one capture or page (id prefix is enough)
hoppr source <id>            # the original bytes, unmodified
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
same thing on demand, for after you have edited the config. Three separate commands to get
going was two too many — someone edits `hoppr.toml`, runs the obvious one, and finds an
empty store because they ran the second step and not the first.

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
hoppr skills install <slug> [--project|--user|--target <dir>]
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
are discarded.

## Serving it to agents

```bash
hoppr mcp install                     # every hoppr, selected per call
hoppr -H work mcp install --pinned    # this client sees ONE hoppr
hoppr mcp status [--probe]            # who is wired up; --probe does a real handshake
hoppr mcp uninstall
hoppr mcp serve [--pinned]            # stdio server; your editor runs this, not you
hoppr vfs 'find . -name "*.md" | head'   # the read-only shell agents get
```

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
hoppr setup             # download the local embedding model (explicit, never silent)
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
| who am I — provider, model, embedder, git mode | `~/.hoppr/hoppr.toml` | ✅ |
| what are my keys | `~/.hoppr/.env`, `<store>/.env` | ✅, store wins |
| what is this hoppr — source, curation preset | `<store>/hoppr.toml` | ❌ never |
| which files — scope | `.hopprignore` beside the data | ❌ |
| how curation thinks — prompts, table schemas | files under `curated/` | ❌ |

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
