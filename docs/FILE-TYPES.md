# What hoppr can read

Two ways in: a **folder source** (`--from dir:`) picks up files by extension, and
**anything** can be thrown in by hand with `hoppr add`.

## Folder sources — indexed by extension

| type | extensions | how the text is extracted | cost |
|---|---|---|---|
| **Markdown & prose** | `.md` `.markdown` `.mdx` `.txt` `.rst` `.org` | read directly | free |
| **HTML** | `.html` `.htm` | tags stripped, scripts and styles dropped | free |
| **Structured data** | `.json` `.jsonl` `.yaml` `.yml` `.toml` `.csv` `.tsv` | read directly | free |
| **PDF** | `.pdf` | text layer via `unpdf`, de-hyphenated and re-wrapped | free |
| **Word** | `.docx` | `mammoth`, falling back to a built-in reader — tables keep their rows, footnote bodies come through | free |
| **Excel** | `.xlsx` | built-in reader; shared strings resolved, date serials formatted, one block per sheet | free |
| **PowerPoint** | `.pptx` | built-in reader; one block per slide, numbered | free |
| **Images** | `.png` `.jpg` `.jpeg` `.gif` `.webp` | **local OCR** for text, then a vision model for the description *if one is configured* | OCR free; description optional |
| **Scanned PDF** | `.pdf` with no text layer | pages rasterised and OCR'd (first 5) | free |
| **Legacy Office** | `.doc` `.xls` `.ppt` | *not extractable* — recognised so the reason is visible | free |

### Notes on the harder ones

**Office formats are ZIPs of XML**, unzipped with Node's own `zlib` — no native build.

**Images: local OCR first, model second.** Measured on a 720×220 screenshot of an error
message, tesseract took **765ms and cost nothing**, and its text was as usable as the
vision model's. Paying per image to read text a WASM binary reads for free turns "index my
Downloads folder" into a bill — so OCR always runs, and a model is asked only for what OCR
cannot give: what the image *shows*. With no model configured at all, images are still
fully searchable by their text.

**Scanned PDFs go through the same path.** No text layer means a scan — text to a human,
opaque to every extractor. hoppr rasterises the pages and OCRs them, capped at the first
five, because the goal is to make the document findable rather than to transcribe it
completely. If OCR also finds nothing, the file is indexed by name and the reason is
recorded.

**Word uses `mammoth` when it is installed.** The formats are genuinely complex and the
dependency-free reader loses real content: measured on a fixture with both, it flattened
table rows into one value per line and dropped footnote bodies entirely (they live in a
different XML part). `mammoth` is 2.1MB and optional; without it the built-in reader still
gets the prose.

**Excel and PowerPoint stay dependency-free.** SheetJS's npm package is stale and `exceljs`
is 22MB — for the "make it searchable" job, neither earns its weight over reading the XML
directly. The gaps that mattered are fixed instead: shared strings resolve, and date cells
format as dates rather than indexing as `45678` (Excel stores a date as a number and
records date-ness only in the cell's style).

**Legacy Office is binary OLE**, not ZIP+XML. Re-save as `.docx`/`.xlsx`/`.pptx` to index
the text.

### Optional dependencies

| package | size | gives you | without it |
|---|---|---|---|
| `unpdf` | — | PDF text layers | PDFs indexed by name |
| `tesseract.js` | 1.4MB + ~13MB language data on first use | OCR for images and scans | falls back to the vision model, then to name-only |
| `@napi-rs/canvas` | native, prebuilt | rasterising PDF pages for OCR | scanned PDFs indexed by name |
| `mammoth` | 2.1MB | docx tables and footnotes | built-in reader, prose only |
| `@huggingface/transformers` | ~210MB | local embeddings | keyword search only |

### Everything degrades, nothing throws

A corrupt PDF, a password-protected spreadsheet, a binary with a `.txt` extension, a file
you lack permission to read — each falls back to *indexed by name and path*, with the
reason recorded. A folder you point hoppr at will contain at least one of these, and it
must not cost you the other 900 files.

### Skipped by default

`node_modules` `.git` `.venv` `venv` `dist` `build` `target` `__pycache__` `.next`
`coverage` `*.lock` `package-lock.json`, plus `.hoppr/` itself and every dotfile. Files
over `[hopper] max_file_mb` (default 20) and empty files are skipped.

Source files (`.ts`, `.py`, …) are **deliberately not indexed**. hoppr is not an AST tool;
for code structure use something that parses it properly. A folder hoppr is for prose,
where summarising and tagging is the whole job.

## Agent sources — transcripts

`--from agents:<harness,...>` reads session logs directly:

| harness | location | format |
|---|---|---|
| `claude-code` | `~/.claude/projects/<slug>/<session>.jsonl` | JSONL, byte-offset cursor |
| `codex` | `~/.codex/sessions/**/rollout-*.jsonl` | JSONL + a manifest index |
| `opencode` | `~/.local/share/opencode/opencode.db` | SQLite, opened read-only |
| `openclaw` | `~/.openclaw/agents/*/sessions/<uuid>.jsonl` | JSONL |

These are **copied** into `raw/` rather than referenced, because the harness rotates its
own logs and a reference would silently rot. A session touched in the last two minutes is
marked `partial`: indexed and searchable, but not curated, since paying a model to
summarise a half-written transcript is waste.

## Manual capture — anything

```bash
hoppr add "a thought worth keeping" -t idea
echo "..." | hoppr add                  # stdin
hoppr add --file ./whatever.pdf         # any of the types above
hoppr add --url https://example.com     # fetched and converted to text
```

Capture kinds recorded in the index: `file`, `session`, `text`, `url`.

## Redaction

Text is scrubbed **at the extraction boundary, before anything is written**. Otherwise a
secret would be indexed, embedded, committed to git (where deleting it later does not
remove it), and sent to whichever model curates. This was not hypothetical: a live
Anthropic key turned up in the first real transcript captured during development.

Sixteen patterns:

| | catches |
|---|---|
| `anthropic-key` `openrouter-key` `openai-key` | `sk-ant-…`, `sk-or-v1-…`, `sk-…` / `sk-proj-…` |
| `github-token` `github-pat` | `ghp_ gho_ ghu_ ghs_ ghr_`, `github_pat_…` |
| `slack-token` | `xoxb- xoxa- xoxp- xoxo- xoxs- xoxr-` |
| `google-key` | `AIza…` |
| `aws-access-key` | `AKIA… ASIA…` |
| `stripe-key` | `sk_live_ sk_test_ rk_live_ rk_test_` |
| `hf-token` `npm-token` | `hf_…`, `npm_…` |
| `private-key` | `-----BEGIN … PRIVATE KEY-----` blocks, whole |
| `bearer-token` | `Authorization: Bearer …` |
| `jwt` | `eyJ….eyJ….…` |
| `url-credentials` | `postgres://user:pass@host` |
| `assigned-secret` | an assignment whose NAME says secret and whose value looks like one |

Plus an **entropy net underneath**, for vendors nobody has written a pattern for. It looks
for what a secret IS — a long run of characters carrying far more information per
character than language does — rather than which company issued it.

The interesting half is what it must NOT flag. Git SHAs, UUIDs, content hashes and
tool-call ids are all high-entropy by construction and all meant to be read; redacting
them would corrupt the text while protecting nothing. Tuned against 10.7M characters of
real Claude Code logs, where `srvtoolu_…` ids were the single largest source of false
positives. Current rate: roughly one flag per 100k characters. `[intake]
redact_entropy = false` turns it off.

Three deliberate choices:

- **Vendor patterns run before the broad ones.** Every `sk-…` key also matches the generic
  OpenAI shape, so ordering is what makes the label name the right key to rotate. There is
  a test for it.
- **Replacements are labelled**, not blanked — `«redacted:anthropic-key»` — so the
  surrounding text still reads and you can see what was removed.
- **The upstream log is never modified.** hoppr is not the system of record for your agent
  history and must not become a second copy of your secrets.

It is pattern-based and therefore incomplete by construction. It reduces exposure; it does
not make an untrusted corpus safe to publish. `[intake] redact = false` disables it;
`[llm] provider = "ollama"` is the path where nothing leaves the machine.
