#!/usr/bin/env bash
# End-to-end acceptance test. Runs the BUILT artifact, not the source, so this
# exercises what a user actually installs.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STORE="${1:-$(mktemp -d)/store}"
export HOPPR_HOME="$(dirname "$STORE")/hoppr-home"
HOPPR=("node" "$ROOT/dist/cli.mjs" "--store" "$STORE")
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }
jq_()  { python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
# Capture combined output of a command that is EXPECTED to exit non-zero.
# Piping it directly would trip `pipefail` and fail the assertion instead.
out()  { "$@" 2>&1 || true; }
has()  { case "$2" in *"$3"*) ok "$1";; *) bad "$1";; esac; }

rm -rf "$STORE"
echo "── init ──"
"${HOPPR[@]}" init --no-daemon >/dev/null 2>&1
[ -f "$STORE/CLAUDE.md" ] && ok "CLAUDE.md written (store is self-describing)" || bad "CLAUDE.md missing"
[ -d "$STORE/curated/wiki/concepts" ] && ok "Karpathy wiki skeleton" || bad "wiki skeleton missing"
[ -f "$STORE/curated/prompts/ingest.md" ] && ok "prompts ejected for editing" || bad "prompts not ejected"
[ -d "$STORE/.git" ] && ok "git repo initialized" || bad "no git repo"
git -C "$STORE" ls-files | grep -q '^\.index/' && bad "index is tracked" || ok "index/views/state gitignored"

echo "── capture ──"
# `add` takes a FILE. Writing a note is writing a file, which is the whole
# model for a folder hoppr.
INBOX="$(dirname "$STORE")/incoming"
mkdir -p "$INBOX"
echo "RRF at k=60 beat weighted score blending for hybrid retrieval" > "$INBOX/rrf.md"
echo "Capture about SQLite FTS5 external content triggers" > "$INBOX/fts5.md"
echo "A third note about vector search recall" > "$INBOX/vectors.md"
"${HOPPR[@]}" add "$INBOX/rrf.md" -t search >/dev/null 2>&1
"${HOPPR[@]}" add "$INBOX/fts5.md" -t sqlite >/dev/null 2>&1
"${HOPPR[@]}" add "$INBOX/vectors.md" -t search >/dev/null 2>&1
N=$("${HOPPR[@]}" --json ls 2>/dev/null | jq_ 'print(len(d["data"]))')
check "3 captures from files" "$N" "3"

echo "── redaction ──"
LEAK="sk-ant-api03-$(printf 'C%.0s' $(seq 1 40))"
echo "my key is $LEAK please remember" > "$INBOX/leak.md"
"${HOPPR[@]}" add "$INBOX/leak.md" >/dev/null 2>&1
if grep -rq "$LEAK" "$STORE/raw" 2>/dev/null; then bad "live credential written to raw/"; else ok "credential scrubbed before write"; fi
grep -rq 'redacted:anthropic-key' "$STORE/raw" && ok "redaction marker left in place" || bad "no redaction marker"

echo "── search ──"
"${HOPPR[@]}" setup >/dev/null 2>&1
"${HOPPR[@]}" embed >/dev/null 2>&1
LEX=$("${HOPPR[@]}" --json search 'rank fusion' 2>/dev/null | jq_ 'print(len(d["data"])>0)')
check "search defaults to all and finds a source hit" "$LEX" "True"
# "reciprocal"/"blending" share no words with the query; only the vector arm can reach them.
SEM=$("${HOPPR[@]}" --json search 'how do I combine two different rankers' --scope all 2>/dev/null | jq_ 'print(any("blending" in (h["title"]+h["snippet"]).lower() for h in d["data"]))')
check "semantic search reaches a doc with no shared keywords" "$SEM" "True"
FILT=$("${HOPPR[@]}" --json search 'tag:sqlite' --scope all 2>/dev/null | jq_ 'print(len(d["data"]))')
check "tag filter narrows" "$FILT" "1"

echo "── the index is disposable ──"
BEFORE=$("${HOPPR[@]}" --json search 'fusion' --scope all 2>/dev/null | jq_ 'print([h["id"] for h in d["data"]])')
"${HOPPR[@]}" reindex --full >/dev/null 2>&1
CACHED=$("${HOPPR[@]}" --json embed 2>/dev/null | jq_ 'print(d["data"]["embedded"])')
AFTER=$("${HOPPR[@]}" --json search 'fusion' --scope all 2>/dev/null | jq_ 'print([h["id"] for h in d["data"]])')
check "full rebuild reproduces the same ranking" "$AFTER" "$BEFORE"
check "rebuild cost zero embedding calls (cache hit)" "$CACHED" "0"

echo "── read-only surfaces ──"
has "vfs refuses to escape the store"   "$(out "${HOPPR[@]}" vfs "cat ../../../etc/passwd")" "escapes the store"
has "vfs has no write command"          "$(out "${HOPPR[@]}" vfs "rm -rf curated")"          "not available"
has "sql refuses DDL"                   "$(out "${HOPPR[@]}" sql "DROP TABLE raw")"          "must start with SELECT"
has "sql refuses stacked statements"    "$(out "${HOPPR[@]}" sql "select 1; drop table raw")" "single SELECT"

echo "── mcp ──"
cd "$STORE"
A=$("${HOPPR[@]}" --json mcp install --target "$STORE/.mcp.json" 2>/dev/null | jq_ 'print(d["data"][0]["outcome"])')
B=$("${HOPPR[@]}" --json mcp install --target "$STORE/.mcp.json" 2>/dev/null | jq_ 'print(d["data"][0]["outcome"])')
check "mcp install" "$A" "installed"
check "mcp install is idempotent" "$B" "skipped"
echo '{"mcpServers":{"hoppr":{"command":"theirs"}}}' > "$STORE/.mcp.json"
C=$("${HOPPR[@]}" --json mcp install --target "$STORE/.mcp.json" 2>/dev/null | jq_ 'print(d["data"][0]["outcome"])')
check "mcp install never clobbers a foreign entry" "$C" "conflict"
cd - >/dev/null


TOOLS=$(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | "${HOPPR[@]}" mcp serve 2>/dev/null \
  | python3 -c "
import sys,json
for line in sys.stdin:
    try: d=json.loads(line)
    except: continue
    if d.get('id')==2: print(len(d['result']['tools'])); break
")
check "mcp server exposes 13 tools (12 + hoppr_list)" "$TOOLS" "13"

echo "── degradation ──"
HOPPR_NO_LLM=1 "${HOPPR[@]}" search 'fusion' --scope all >/dev/null 2>&1 && ok "search works with no LLM configured" || bad "search needs an LLM"
echo "captured with no LLM" > "$INBOX/nollm.md"
HOPPR_NO_LLM=1 "${HOPPR[@]}" add "$INBOX/nollm.md" >/dev/null 2>&1 && ok "capture works with no LLM" || bad "capture needs an LLM"
has "curate says why it cannot run" "$(HOPPR_NO_LLM=1 out "${HOPPR[@]}" curate)" "no LLM provider"

echo "── named hoppers ──"
SRC="$(dirname "$STORE")/papers"; rm -rf "$SRC"; mkdir -p "$SRC/sub"
printf '# Rank fusion\nRRF at k=60 needs no calibration.\n' > "$SRC/rrf.md"
printf '# Timers\nFake timers leak across files.\n' > "$SRC/sub/timers.md"
HN=("node" "$ROOT/dist/cli.mjs")
"${HN[@]}" init --no-daemon --global --name papers --from "dir:$SRC" >/dev/null 2>&1
"${HN[@]}" init --no-daemon --global --name work --from agents:claude-code >/dev/null 2>&1
N=$("${HN[@]}" --json hoppers 2>/dev/null | jq_ 'print(all(k in [x["name"] for x in d["data"]] for k in ("papers","work")))')
check "two isolated hoppers, each with its own store" "$N" "True"

SUM=$(out "${HN[@]}" -H papers sync)
"${HN[@]}" -H papers setup >/dev/null 2>&1; "${HN[@]}" -H papers embed >/dev/null 2>&1
[ -d "$HOPPR_HOME/papers/raw" ] && bad "folder hoppr copied files into raw/" || ok "folder hoppr copies nothing (raw/ absent)"
BEF=$(shasum "$SRC/rrf.md" | cut -d' ' -f1)
"${HN[@]}" -H papers reindex >/dev/null 2>&1
AFT=$(shasum "$SRC/rrf.md" | cut -d' ' -f1)
check "source folder is never written to" "$AFT" "$BEF"
HIT=$("${HN[@]}" -H papers --json search "combining rankers" --scope all 2>/dev/null | jq_ 'print(len(d["data"])>0)')
check "folder hoppr is searchable" "$HIT" "True"
RP=$("${HN[@]}" -H papers --json search "combining rankers" --scope all 2>/dev/null | jq_ 'print(d["data"][0]["refId"])')
GOT=$("${HN[@]}" -H papers --json get "$RP" 2>/dev/null | jq_ 'print(d["data"]["path"].startswith("'"$SRC"'"))')
check "captures point at the ORIGINAL file" "$GOT" "True"
CONN=$("${HN[@]}" -H papers --json sync 2>/dev/null | jq_ 'print(",".join(s["connector"] for s in d["data"]))')
check "a folder hoppr never touches agent logs" "$CONN" "dir"

has "a folder hoppr refuses to mine skills" \
    "$(out "${HN[@]}" -H papers skills mine)" "no procedures in it to mine"
has "review says so when there is nothing to review" \
    "$(printf 'q\n' | out "${HN[@]}" -H papers skills review)" "nothing to review"

TOOLS=$(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"hoppr_list","arguments":{}}}' \
  | "${HN[@]}" -H papers mcp serve 2>/dev/null \
  | python3 -c "
import sys,json
for line in sys.stdin:
    try: d=json.loads(line)
    except: continue
    if d.get('id')==2:
        rows=json.loads(d['result']['content'][0]['text'])
        print(all(k in [r['hopper'] for r in rows] for k in ('papers','work'))); break
")
check "hoppr_list exposes every hoppr to an agent" "$TOOLS" "True"

echo "── daemon (one process, all hoppers) ──"
HD=("node" "$ROOT/dist/cli.mjs")
"${HD[@]}" init --no-daemon --global --name dtest --from manual >/dev/null 2>&1
"${HD[@]}" daemon start >/dev/null 2>&1
sleep 4
"${HD[@]}" daemon status 2>/dev/null | grep -q running && ok "daemon starts" || bad "daemon did not start"
# Count only daemons for THIS store. A plain process count fails whenever the
# developer has a real hoppr daemon running, which reads as a product bug.
PROCS=$(ps ax -eo command= | grep "[c]li.mjs daemon start --foreground" | grep -c "HOPPR_HOME=$HOPPR_HOME" || true)
[ "$PROCS" = "0" ] && PROCS=$(pgrep -f "[c]li.mjs daemon start --foreground" | while read -r p; do
  ps eww -o command= -p "$p" 2>/dev/null | grep -q "HOPPR_HOME=$HOPPR_HOME" && echo x
done | grep -c x || true)
check "exactly one daemon process for all hoppers" "$PROCS" "1"
HZ=$(python3 -c "import json;print(json.load(open('$HOPPR_HOME/daemon.json'))['port'])" 2>/dev/null)
MANAGED=$(curl -s "http://127.0.0.1:$HZ/healthz" | jq_ 'print(len(d["hoppers"])>=2)')
check "one daemon manages every hoppr" "$MANAGED" "True"
echo "A note dropped in the inbox" > "$HOPPR_HOME/dtest/inbox/dropped.md"
sleep 4
[ -f "$HOPPR_HOME/dtest/inbox/dropped.md" ] && bad "inbox not consumed" || ok "inbox watcher consumed the drop"
"${HD[@]}" daemon stop >/dev/null 2>&1
"${HD[@]}" daemon status 2>/dev/null | grep -q "not running" && ok "daemon stops cleanly" || bad "daemon did not stop"


echo
printf '\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
