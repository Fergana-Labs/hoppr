# Supported inputs

Run `hoppr init` in a folder to index its supported files without modifying them. Use
`--from dir:<path>` when the store should live elsewhere. `hoppr add` can also capture
text, a supported file, or a URL record directly.

## Folder sources

| type | extensions | extraction | cost |
|---|---|---|---|
| Markdown and prose | `.md` `.markdown` `.mdx` `.txt` `.rst` `.org` | read directly | none |
| HTML | `.html` `.htm` | remove scripts, styles, and tags | none |
| Structured data | `.json` `.jsonl` `.yaml` `.yml` `.toml` `.csv` `.tsv` | read directly | none |
| PDF | `.pdf` | extract and normalize the text layer with `unpdf` | none |
| Word | `.docx` | use `mammoth`, with a built-in reader as fallback | none |
| Excel | `.xlsx` | built-in XML reader; preserve sheets, strings, and dates | none |
| PowerPoint | `.pptx` | built-in XML reader; emit one numbered block per slide | none |
| Images | `.png` `.jpg` `.jpeg` `.gif` `.webp` | local OCR, plus an optional vision description | OCR is local; description may use a model |
| Scanned PDF | `.pdf` without a text layer | rasterize and OCR the first five pages | none |
| Legacy Office | `.doc` `.xls` `.ppt` | index the name and report that text was not extracted | none |

### Extraction details

Modern Office files are ZIP archives containing XML. The built-in readers use Node's
`zlib`, so Excel and PowerPoint extraction do not require a format-specific dependency.

For images, local OCR extracts searchable text. If a vision model is configured, hoppr
also asks it for a description of the image. OCR still works when no model is available.

A PDF without a text layer is treated as a scan. hoppr rasterizes and OCRs up to five
pages, enough to make most scans discoverable without processing the entire document. If
no text is found, hoppr indexes the file name and records the extraction failure.

For Word documents, `mammoth` preserves structures such as tables and footnotes. Without
it, the built-in reader still extracts ordinary prose. Legacy Office files use the older
binary OLE format and must be re-saved as `.docx`, `.xlsx`, or `.pptx` for text extraction.

### Optional dependencies

| package | capability | fallback when absent |
|---|---|---|
| `unpdf` | PDF text layers | index PDF by name |
| `tesseract.js` | OCR for images and scans | use the vision model, then name-only indexing |
| `@napi-rs/canvas` | PDF page rasterization | index scanned PDFs by name |
| `mammoth` | Word tables and footnotes | use the built-in prose reader |
| `@huggingface/transformers` | local embeddings | use keyword search |

Extraction errors are isolated to the affected file. Corrupt, encrypted, mislabeled, or
unreadable files are indexed by name and path with the reason recorded.

### Default exclusions

hoppr skips these names by default:

```text
node_modules  .git  .venv  venv  dist  build  target  __pycache__  .next
coverage  *.lock  package-lock.json
```

It also skips `.hoppr/`, dotfiles, empty files, and files larger than `[hopper]
max_file_mb` (20 MB by default).

Source code files such as `.ts` and `.py` are not indexed. hoppr extracts and curates
prose; it does not parse code structure.

## Agent transcripts

Agent history is an optional source alongside ordinary folders. It is useful when the
folder you want to query is maintained by a coding harness rather than by you.

`--from agents:<harness,...>` reads local session logs:

| harness | location | format |
|---|---|---|
| `claude-code` | `~/.claude/projects/<slug>/<session>.jsonl` | JSONL with a byte-offset cursor |
| `codex` | `~/.codex/sessions/**/rollout-*.jsonl` | JSONL plus a manifest index |
| `opencode` | `~/.local/share/opencode/opencode.db` | SQLite opened read-only |
| `openclaw` | `~/.openclaw/agents/*/sessions/<uuid>.jsonl` | JSONL |

Agent connectors parse each session into human-readable Markdown, redact recognized
credentials, and store that normalized snapshot in `raw/`. This is not a byte-for-byte
copy of the harness log. The snapshot remains available if the harness later changes or
removes its own file. A session modified within the last two minutes is marked `partial`:
it can be searched but is not curated until it becomes stable.

## Manual capture

```bash
hoppr add "a thought worth keeping" -t idea
echo "..." | hoppr add
hoppr add --file ./document.pdf
hoppr add --url https://example.com --title "Reference"
```

`--url` records the URL; core hoppr does not fetch the page. Capture kinds in the index
are `file`, `session`, `text`, and `url`.

## Redaction

hoppr redacts recognized credentials at the extraction boundary, before text is written
to the store, indexed, embedded, committed, or sent to a model. The upstream source is
never modified.

Built-in patterns cover:

| category | examples |
|---|---|
| model providers | Anthropic, OpenRouter, and OpenAI keys |
| developer services | GitHub tokens, Slack tokens, npm tokens, Hugging Face tokens |
| cloud and payments | Google API keys, AWS access keys, Stripe keys |
| generic credentials | private keys, bearer tokens, JWTs, and credentials in URLs |
| assignments | values assigned to names that indicate a secret |

An entropy check supplements the named patterns for unknown token formats. It excludes
common high-entropy identifiers such as Git SHAs, UUIDs, content hashes, and tool-call
IDs. Disable only that check with `[intake] redact_entropy = false`.

Replacements retain a label, such as `«redacted:anthropic-key»`, so surrounding text
remains readable and the credential type is visible. Vendor-specific patterns run before
generic ones to keep that label accurate.

Redaction is pattern-based and incomplete. It reduces accidental exposure but does not
make an untrusted corpus safe to publish. `[intake] redact = false` disables it. Use
`[llm] provider = "ollama"` when extracted text must remain local.
