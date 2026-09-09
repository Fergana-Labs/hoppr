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
hoppr add ./paper.pdf                     # copy a file into the store
hoppr add ./notes.md -t idea -p launch     # with tags and a project
hoppr add ./draft.md --title "Q3 plan"
hoppr sync                                # pull from the configured source
hoppr sync --since 7d | --full | --dry-run
```

`hoppr ingest` is an alias of `hoppr add`. It takes a file, not prose: for a folder hoppr
writing a note is writing a file in the folder, and the daemon picks it up.

## Finding things

```bash
hoppr search "papers that disagree about scaling laws"
hoppr search  "..."                         # backward-compatible alias
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

The deep pass runs, in order: taxonomy convergence, concept pages, lesson extraction, correction extraction, ledger assembly, usage judging, skill mining, guardrail mining for the top failure modes, the replay bench over new proposals, the front door, and lint. Each stage fails independently; a failed stage is noted in `hoppr journal` and retried next pass.

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
hoppr skills list [--state <state>]
hoppr skills show <slug>
hoppr skills why <slug>            # per line for a ledger, per session for a procedure
hoppr skills review                # accept/reject interactively, costliest first
hoppr skills accept <slug...> [--project|--no-install]   # non-interactive, for pipes and CI
hoppr skills reject <slug...>      # remembered; not re-proposed
hoppr skills install <slug> [--to <harness>|--project|--target <dir>|--force]
hoppr skills uninstall <slug>
hoppr skills audit                 # score every skill against the promotion gate
hoppr skills verify [slug] [--all|--limit <n>|--cases <n>|--samples <n>|--no-ground]
hoppr skills repair <slug> [--rounds <n>|--cases <n>]
hoppr skills principles            # the repair patterns, and how often each worked
hoppr skills routing               # can an agent find the right skill in this pool?
hoppr skills resolver              # regenerate the dispatcher table
hoppr skills mine                  # read, assemble and mine now, without a full deep pass
hoppr skills mark <slug> --worked [--note <text>]   # record that it did the right thing
hoppr skills mark <slug> --wrong  [--note <text>]   # record that it was wrong, stale, or unhelpful
```

Sections below cover [verify](#verifying-a-skill), [repair and principles](#repairing-a-skill-the-bench-rejected),
[routing](#can-the-right-skill-be-found), and [mirror](#what-your-sessions-say).

Every kind is written as `SKILL.md`:

| slug | how it is made |
|---|---|
| `hoppr` | the front door: standing context inlined, situational skills routed to |
| `glossary` | a list built from your sessions: what the nouns in your world mean and where they live |
| `preferences` | a list built from your sessions: rules and tastes, each marked MUST or PREFER |
| `verify-before-done`, `where-things-live`, `commit-style-here` | read off **this project** at init, before anything has been mined |
| a guardrail | mined from a recurring failure — see `hoppr mirror` below |
| anything else | a procedure, mined from a cluster of sessions and then verified |

`hoppr skills install hoppr` installs the front door alone. It inlines the standing
halves — what your words mean, how you want work done, what has already gone wrong — and
routes to the situational skills rather than inlining those. Standing context has to be
known *before* the work: by the time an agent notices it is writing a status update it has
already chosen a register, so a dispatch table saying "consult preferences when relevant"
is a table nobody consults.

The starter skills are written by reading the directory, not by observing you: its verify
commands, its layout, its commit history. Nothing is written that detection could not fill
in — a repo with no test command gets no testing skill rather than a platitude about
testing. They regenerate as the project changes and stop the moment you edit one.

A list is assembled from extracted claims **by code, not by a model** — so every line cites
a real capture, the diff is exactly what changed, and rebuilding is free. A newer statement about the same subject replaces the older one;
`git log --follow` on the file is the history. `hoppr skills why <ledger>` shows every
line's quote, its date, and what it superseded.

A statement made once is enough for a list. For a procedure, whether it recurred is
corroboration; whether it *generalizes* is judged by the miner reading the transcript and
re-checked by a refutation pass, because counting repetitions is a proxy that is wrong in
both directions.

Only quotes from what you typed count toward a ledger. Assistant prose, tool output, and
files the agent read are all excluded, and the check is against the transcript rather than
a prompt instruction.

`hoppr skills audit` scores procedures and guardrails against the promotion gate; ledgers
are not scored, since a vocabulary list has no steps and no pitfalls to have.

`hoppr skills review` shows the costliest proposals first. A queue ordered by the model's
confidence is ordered by a number about the model, and every proposal in it has already
cleared the same gate — so those confidences sit in a narrow band and carry almost
nothing. What a guardrail has already cost you is the ordering worth reading.

Edit any generated `SKILL.md` by hand and hoppr stops rewriting its prose, keeping only
its evidence links current. It records that in `<store>/LOCKED`:

```
# Things hoppr generated that it must now leave alone.
# Globs are relative to curated/, the only place hoppr writes.

# hand-edited 2026-08-21
skills/deploy-hoppr/**
```

**Two rule sets, two files, about two different people's files:**

| file | where | says |
|---|---|---|
| `.hopprignore` | beside your data | what hoppr must not index, and what it may index but never send to a model |
| `LOCKED` | inside the store | what hoppr generated and you have since taken over |

Delete a line from `LOCKED` to hand that file back to hoppr.

The hand-edit also counts against the skill's reliability: someone read it, used it, and
had to correct it.

## Repairing a skill the bench rejected

```bash
hoppr skills repair <slug>              # bounded revision episode
hoppr skills repair <slug> --rounds 5
hoppr skills principles                 # the repair patterns, and how often each worked
```

`hoppr skills verify` says a skill does not work. This fixes it, and stops as soon as it
does. Three properties are load-bearing.

**Preservation constraints are derived, not declared.** SkillRevise's diagnosis is
*(verification spec, failure attribution, preservation constraints)* and hoppr had no way
to produce the third. The bench answers it directly: the holdout cases this version already
passes are exactly what must not break. A revision that fixes the failures and breaks any
of them is discarded.

**The first passing candidate wins, not the best-scoring one.** Selection is on verifier
success before utility, so a later candidate that might have scored higher is never
generated. Scoring higher on a proxy is how a revision gets worse while looking better.

**Screen cheap, confirm expensive.** A round samples each case once — three draws per case
per round would triple an already costly loop to reject candidates a single draw rejects
just as well. The survivor is then re-run at full samples before being kept, because a
decision to ship has to meet the bar the bench actually sets, not the screen's.

`skills principles` is the memory hoppr was missing. It has had the negative half for a
while — `skill_rejected_edits`, from SkillOpt, whose ablation is why it exists — and
nothing that remembered what *worked*. A principle says when to consider it, what to change,
what the executor should then do differently, and **where it must not be applied**; every
seeded one carries that last line, because a principle claiming to apply everywhere will be.

The seeds are the measured defect classes, not invented ones: Task-Implementation Fault is
86 of 125 functional failures, Excessive Verification 67 of 182 efficiency regressions,
Skill-Body Context Bloat 43 of 46 context-overhead cases.

Retrieval matches on the **symptom**, not the cure — a reviser knows what went wrong, not
which repair it wants, so a memory indexed on cures is searchable only by someone who has
stopped needing it. Principles are ranked by fit and then by whether they have actually
worked, Laplace-smoothed so an untried one reads as no opinion rather than as a failure.

`hoppr skills why <slug>` shows the repair history, rejected rounds included — a skill that
reached its form after two failed repairs is a different object from one written right
first time, and the rejected rounds are where the reasons are.

## Can the right skill be found?

```bash
hoppr skills routing
```

Every other check asks whether a skill is any good. This asks whether it is **reachable**,
which is a separate failure and the one that scales against you. Measured with pool
composition held fixed and only size varied, the precision with which an agent actually
uses the right skill collapses from 29.6% at five skills to 3.3% at a hundred — and
splitting by composition shows *confusability* rather than count is the stressor: top-1 on
pools of similar skills falls 70.5% → 53.4%, against 97.7% → 84.1% on random ones.

hoppr sits in the worst corner of that twice over. It mines automatically, so it reaches
large pools without anyone deciding to, and every skill is distilled from one person's
work, so the pool is similar by construction.

Fixtures are free. gbrain's skillify asks authors for "trigger phrases users ACTUALLY
type", which tests the author's imagination rather than the router; a hoppr case already
holds the real situation, and the guardrail mined from that case's mode is the skill that
should fire in it.

```
12 fixtures over 7 skills — the situation just before each recorded failure

  pool   top-1    mrr
     3     92%   0.95
     5     83%   0.89
     7     75%   0.84
```

Pools are subsampled from the **real** skill set, not padded with invented distractors — a
synthetic pool would measure how confusable made-up skills are, which is not a fact about
your store. Distractors are chosen deterministically, so two runs over an unchanged store
report the same number and a drop means something moved.

Situations are the agent's **next move** — what it was about to do — with a little run-up
behind it, which is the symmetric comparison: a description says "use when about to <do a
thing>", and the situation says what thing was about to be done. An earlier version used
the tail of the transcript instead and scored 0%, because a transcript tail is whatever
prose the session happened to end on — on real cases here, an assistant sign-off. That
measured the fixture representation, not the pool.

`[skills] routing_floor` (default 0.6) is the level below which `hoppr skills audit`
complains. It is a floor, not a target, and it stays quiet below eight fixtures: a
precision computed over two cases moves by fifty points when one flips, so enforcing it
there would fail a store for having a small corpus rather than a routing problem.

**A miss is often a mode problem, not a routing problem.** If a guardrail cannot be reached
from a case of its own mode, the usual cause is upstream — the mode clustered unrelated
jobs, and the guardrail mined from it specialised to one of them. Routing is where that
first becomes a number.

**This measures offline identification, not task success.** The same study is explicit
that the two come apart: exact ground-truth invocation is neither sufficient nor strictly
necessary for the work to come out right. A falling number is a reason to merge or narrow
skills, not a prediction that anything will fail.

## What your sessions say

```bash
hoppr mirror                 # the report: what hoppr learned, and what keeps going wrong
hoppr mirror --mine          # also write a skill for each top failure mode
hoppr mirror --top 10
```

Every other command here hands you a queue. This is the one thing the corpus can produce
that no repository, README or config file already contains: a reading of how you and your
agent actually work together, in your own words.

Two halves, in this order.

**Recognition** — what hoppr now knows about you, quoted. Every line traces to something
you typed. Deliberately not a personality profile: "you are a pragmatic engineer who
values directness" is unfalsifiable, unactionable, and spends the credibility the quoted
half earns.

**Prevention** — what keeps going wrong, ranked by what it cost. The deep pass reads every
session a second time for **corrections**: the moments the agent got it wrong and you said
so. A correction is not a lesson — a lesson is a standing claim superseded when a newer one
contradicts it, while a correction is an event that happened at a time, cost turns, and
whose *recurrence is the point*.

They are grouped into failure modes and ranked by cost, not by count. A count answers "what
happens most", which you can usually guess; cost answers "what is this costing me", which
you cannot, and the two orderings disagree.

Cost is estimated turns burned **weighted by severity**. Turns alone made severity
decorative, and it is not: measured on real transcripts, the most expensive correction in
the corpus — an agent indexing 1Password credentials off the filesystem — took one turn to
stop and sorted below a run of cosmetic notes about spacing. Turns measure how long you
argued, which is not what the mistake cost. The weights are a judgement, and both they and
the turn estimates are named as estimates wherever they are shown.

A mode is the unit of **cost**; a finer cluster is the unit of **skill**. Modes converge
(below), which buys recurrence and costs coherence — on this repo
`built-before-clarifying` absorbed "built the wrong config schema", "used the wrong line
breaks", and "built UI without a reference". A guardrail mined from that has to pick one,
and the mode then counts three occurrences of a failure the skill prevents once.

So corrections are split by headline similarity into groups that are actually one failure.
Aggregating cost across a whole mode is right; writing one skill for it is not. The largest
group keeps the plain mode name and the rest get `~2`, `~3`, so a mode that holds together
is untouched. Splitting is code, not a model call, and uses embeddings where one resolves —
two headlines describing the same failure in different words score near zero on token
overlap, so no lexical threshold separates them from unrelated pairs without also splitting
related ones.

Modes converge rather than accumulate. Each extraction batch is shown the modes already in
use and asked to reuse one before coining a new one — the same mechanism the tag taxonomy
uses, and for the same reason: measured on 48 real sessions without it, 25 corrections
produced 25 distinct modes, none recurring, while six of them were plainly the same mistake
worded six ways. A report built on which mistakes recur cannot survive that.

`--mine` writes a **guardrail** for each top mode: a short skill whose only job is to stop
that one failure recurring, quoting your own words in its `## What goes wrong` section. It
faces the same promotion gate as a mined procedure, and the miner declining — "this is not
one repeatable mistake" — is an expected answer.

The link between a mode and its guardrail is causal by construction: a guardrail is mined
*from* the mode, and `skills.prevents` records which. hoppr could have inferred the link by
noting a skill and a correction came from the same transcript, and that inference would be
wrong in the ordinary case, since a session contains one mistake and several unrelated
pieces of work.

Only your own words count. An assistant apologizing for itself is the most quotable prose
in any transcript, and without the attribution check the top of every report would become
whatever the model most likes to apologize for rather than what actually cost you anything.

## Verifying a skill

```bash
hoppr skills verify                    # score everything that has not been through the bench
hoppr skills verify <slug>             # one skill, case by case
hoppr skills verify <slug> --samples 5 # more draws per case
hoppr skills verify --all              # re-score skills already scored
```

Every other check here reads a skill as **text** — the promotion gate scores its prose,
the refuter re-reads its evidence, the grounding check looks for commands nobody ran.
None of them has watched the skill do anything, and a one-shot authored skill shipped on
that basis is frequently worse than no skill at all.

The bench replays recorded failures. A correction is an instance of an agent going wrong
and a human saying so, which is a test case with its own oracle attached. Nobody can
re-run a container from six weeks ago; anyone can ask what an agent would do next given
the same lead-in, once with the candidate skill loaded and once without.

**Both arms, always.** A skill that avoids a failure says nothing on its own — the
baseline avoids plenty of them too. The verdict is the difference:

| verdict | meaning |
|---|---|
| `prevents` | the baseline reproduced the failure and the skill arm did not |
| `regression` | the skill arm reproduced it and the baseline did not — disqualifying |
| `inert` | both arms agree; the skill changed nothing here |
| `both-fail` | both reproduced it; no help, but no harm |

**Held out, always.** The cases a skill was mined from are the ones it is guaranteed to
handle. `cases.split` is assigned by hashing the case id, so the halves stay fixed across
runs and a candidate cannot be re-rolled into passing.

**Three draws per case, and the majority decides.** One draw is not stable: measured on
this repo's own corrections, the same skill scored against the same case moved from
`regression` to `prevents` between two runs. Every verdict is printed with its agreement
(`2/3`), because a verdict carried two-of-three is a different fact from one carried
three-of-three. `regression` additionally needs a real majority rather than a plurality,
since it retires a skill outright.

**A verdict needs enough cases to reproduce.** Three draws stabilise a *case* verdict and
not a *skill* verdict — the latter is a threshold over a handful of cases, and one flip
crosses it. Measured here: the same skill on the same cases scored pass, fail, then pass
again. A run below 4 resolved cases (and 3 of the skill's own mode) prints `inconclusive`
rather than pass or fail, records no reliability outcome, and is not acted on.

**Proposed moves are checked against this project.** The blind spot is real — replay is a
model judging a model against a text stub, so it cannot see Environment Mismatch (13 of 125
confirmed functional failures) or Artifact Misplacement (24). So each skill-arm move is
read against the project's manifests and filesystem: a script `package.json` does not
define, a package manager the lockfile contradicts, a backticked path that is not there.
One such finding fails the skill, because the manifest either has the script or it does
not — that is not a judgement and not a sample. `--no-ground` skips it.

The check is **static**. Closing these classes completely means executing what the arm
proposed, which is running model-generated shell commands against a real checkout, and is
not something a store scoring its own skills should do unasked. So a script that exists and
fails, a path that exists and is wrong, a version skew — those still need real execution.

Treat a pass as "did no visible harm on recorded failures, and proposes nothing this
project cannot do", not as verification.

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
# .hopprignore — about YOUR folder. gitignore-style patterns, and the folder's
# own .gitignore is honoured too. Nothing here concerns hoppr's own output;
# that lives in <store>/LOCKED.

secret/            # never indexed — hoppr does not know these exist
*.zip

[no-curate]        # indexed and searchable, never sent to a model
archive/**
*.csv
```

`[no-curate]` files are fully searchable at **zero token cost**, because indexing is pure
SQL. The difference between the two lists is only how much attention a file gets: skipped
files are invisible, no-curate files are findable but never leave the machine.

### Retrieval

```toml
[retrieval]
embeddings = true          # vector search; keyword is always on
graph = false              # typed entities and relations
glossary_expansion = true  # expand queries with the vocabulary ledger

`glossary_expansion` covers the case where you search for a word you use and the
documents do not — searching `sitrep` when the files all say "status report". hoppr
already records what your terms mean in the `vocabulary` ledger; this makes that
reachable from search rather than only from an agent that loads the SKILL.md. It fires
only when a ledger subject appears in your query as a whole phrase, and the extra terms
are OR'd alongside yours, so it can only add results. `hoppr search --explain` names
which terms expanded.

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
mine = "auto"              # auto | targeted | off — procedures only
approve = "ledgers"        # review | ledgers | auto
edit_budget = 4            # localized edits per revision pass; 0 freezes existing skills
archive_below = 0.4        # reliability floor; 0 never archives
routing_floor = 0.6        # top-1 routing precision below which audit complains; 0 never checks
min_evidence = 1           # sessions before a procedure may be proposed
```

### What should exist

Two lists of names in `[skills]`, written into your store's `hoppr.toml` at init:

```toml
[skills]
have = [
  "glossary",           # a list hoppr builds from your sessions
  "preferences",
  "comms-preferences",  # a ready-made file hoppr ships
  "working-agreements",
]
find = ["cutting a release"]   # a procedure to go looking for
```

`have` is what hoppr maintains; `find` is what it goes looking for. Delete a name and
that skill stops being maintained — nothing is added back behind you.

**What each `have` collects lives in the prompt, not the config.** `curated/prompts/
lesson-extract.md` is ejected into your store at init and defines one bin per section:

```markdown
## Bins

### glossary
heading: This person's world

Which nouns in these sessions would a new agent get wrong? Look for a term being
defined or corrected, and for the moment someone says where a thing actually lives…
```

A name in `have` with a matching bin is a list hoppr builds. A name with no bin is a file
hoppr ships. That is the whole rule, and it's why there's no `kind` field to set.

To add a list of your own: write a `### constraints` section in the prompt, add
`"constraints"` to `have`. To change what an existing one collects, edit its section —
the question is the thing that decides what lands in the file, so it belongs where you
can read it rather than escaped into a TOML string.

`graded: true` on a bin marks each of its lines MUST or PREFER. `mine = "targeted"`
restricts procedure mining to the `find` list; under `auto` those are looked for and so is
anything else that recurs.

`approve` decides what still needs a human. `review` holds everything; `ledgers` (the
default) auto-accepts the ledgers and still reviews mined procedures; `auto` accepts
both. The split is deliberate — a ledger line is a verbatim quote of something you typed,
assembled by code and superseded on change, while a mined procedure is a model's prose
about how work gets done. Accepting is never installing: accepting writes inside the
store and is reversible, installing reaches out to `~/.claude/skills`.

`edit_budget` bounds how much a revision may change at once. An existing skill is
revised by localized edits rather than regenerated, because an unbounded rewrite erases
rules that were earned and overfits the whole skill to whatever went wrong most recently.

`archive_below` is the floor for a skill's reliability, `η = (n_pass + 1)/(n_trial + 2)`.
Below it a skill leaves `RESOLVER.md` and stops being dispatched; it stays on disk and
stays searchable.

Two kinds of evidence feed it:

- **Was it used, and did that go right?** When a later session loads an installed skill,
  the deep pass judges the work that followed — did the task actually come out correct,
  regardless of whether anyone sounded pleased. This needs no hook and no daemon; hoppr
  already has the transcript.
- **Did a human have to step in?** Rejections, hand-edits, uninstalls, and
  `hoppr skills mark`.

`hoppr skills why <slug>` shows the source of every outcome, so a score built only from
corrections is never mistaken for one built from use. The judge is deliberately biased
toward success — refusing a new skill costs one rediscovery, while demoting a working one
destroys something earned.

`kind = "packaged"` skills ship with hoppr and are written into every new store — they
encode how you work before any mining has happened. `min_evidence` applies to mined
procedures only; ledgers accumulate from single statements.

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
