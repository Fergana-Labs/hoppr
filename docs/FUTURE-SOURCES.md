# Future: external sources

The sources in this document are not part of core hoppr. They require network access,
platform authentication, or access to another application's database, along with the
associated rate limits and maintenance.

This document preserves the design work and measurements for implementations that were
tested and later removed.

---

## The shape they all share

Every source has the same output: **read input → produce `IngestCandidate[]`**. Existing
code handles redaction, deduplication, staleness, embeddings, indexing, cursors, and
per-record failures. A new source therefore only needs an adapter for its input format.

There are two existing plugin points and a third that should exist:

| point | shape | exists |
|---|---|---|
| `Connector` | "here is a place, keep pulling from it" (cursor, resumable) | ✅ `src/connectors/types.ts` |
| `UrlHandler` | "here is one link, turn it into text" (stateless) | ❌ removed — design below |
| `Importer` | "here is one export file, produce many captures" | ❌ never formalised |

An `Importer` should come first because it supports platform export files without
requiring scraping or account access.

---

## Removed, with working code kept

These implementations were verified against live services before removal. Their source
is in [`future-src/`](future-src/). It is not compiled or included in the current test
suite.

### `UrlHandler` — the interface

```ts
interface FetchedDoc {
  title?: string
  text: string
  meta?: Record<string, unknown>
  follow?: string[]   // further URLs worth capturing as their OWN records
  handler: string
}

interface UrlHandler {
  id: string
  match(url: URL): boolean                        // cheap, synchronous, no network
  fetch(url, ctx): Promise<FetchedDoc | undefined>
}
```

`follow` supports one level of related capture. For example, an arXiv abstract can return
its PDF URL, allowing metadata and full text to remain separate records with separate
provenance. Limiting traversal to one hop prevents the feature from becoming a crawler.

Handlers must match narrowly and run from most specific to most general. An earlier
`arxiv` matcher claimed every `arxiv.org` URL, including PDF follow-ups, and captured the
abstract twice. The `generic` handler matches any URL and must run last.

### arXiv · verified working

Metadata from `export.arxiv.org/api/query?id_list=<id>` (no scraping), then the PDF as a
second record.

- Scope the title regex to `<entry>`. The Atom feed has its own `<title>` which is the
  query echoed back, so reading the outer one titles every paper `arXiv Query: …`.
- Measured: abstract 1,294 chars in 146ms; full paper 39,559 chars in 276ms.

### YouTube · verified working, via `yt-dlp`

- Do not request `timedtext` directly. The caption `baseUrl` is still in the page and
  still extractable, but the endpoint answers server-side requests with **200 and an empty
  body** in every subtitle format (`json3`, `srv3`, `vtt`, none). Verified, not assumed.
- Shell out to `yt-dlp` instead. Keeping up with YouTube's countermeasures is that
  project's entire job.
- Check its output files as well as its exit code. It can exit nonzero for a version notice
  or one unavailable subtitle language while having written the captions perfectly.
- Auto-captions are a rolling two-line window, so consecutive duplicate lines must be
  dropped or the transcript comes back at roughly twice its true length.
- Measured: 2,066 chars in ~3.9s.

### PDF-by-URL · verified working

Download → text layer → OCR fallback if the layer is empty. Reuses the local extractors
that remain in core.

### Generic web page · verified working

Remove `nav/header/footer/aside/form/svg` before stripping tags to avoid indexing page
chrome. Preserve `og:title`, `description`, `author`, and `article:published_time`.
Measured: Wikipedia 40,192 chars; Hacker News 3,728.

### Browser bookmarks · verified working

Netscape bookmark HTML — the 1994 format Chrome, Firefox, Safari and Edge all still emit.

- Nesting comes from `<DL>`/`</DL>` around `<H3>`, not from valid XML. One regex pass over
  `<h3>` / `</dl>` / `<a>` in document order, with a folder stack.
- Preserve the folder path as user-authored taxonomy and use it as tag input.
- `ADD_DATE` is seconds; a few browsers write milliseconds. Detect by magnitude.
- Skip non-`http(s)` entries — `javascript:` bookmarklets are common.

---

## Never built

### iMessage

`~/Library/Messages/chat.db`, opened **read-only** (`?mode=ro`). It is already SQLite, so
this is the same shape as the existing `opencode` connector: probe `sqlite_master` first
and disable with a clear warning if the schema moved, because a third-party schema is not
a contract. Needs Full Disk Access, which must be requested explicitly rather than
failing with a permissions error.

Bodies live in `message.attributedBody` (a serialised `NSAttributedString`) on newer
macOS, not always in `message.text` — a naive reader silently returns empty strings for
recent messages.

### Screenshots

`hoppr init` in `~/Desktop` or `~/Screenshots`. The OCR path in core reads them today.

### iCloud Photos

`~/Pictures/Photos Library.photoslibrary/database/Photos.sqlite`, read-only, plus the OCR
path that already exists. Apple's schema is undocumented and changes between OS versions,
so probe and degrade rather than trust it. Prefer the screenshots-folder route above
where it suffices — it is the same value for none of the fragility.

### Local video

`ffmpeg` for keyframes → the OCR path in core; `whisper.cpp` (or `yt-dlp`'s audio path)
for speech. Both are external binaries hoppr shells out to, the same arrangement that
works for `yt-dlp`. Keyframe interval matters: one frame per scene change, not per second,
or a 40-minute screen recording produces thousands of near-identical OCR jobs.

### Twitter/X, Instagram, and WhatsApp

| | why scraping is the wrong answer |
|---|---|
| **Twitter/X** | bookmarks need an authenticated session; the API tier that reads them is paid; scraping breaches the ToS and risks the account |
| **Instagram** | same, plus aggressive bot detection on reels |
| **WhatsApp** | end-to-end encrypted. The local store is encrypted at rest, and Beeper is a bridge, not a database you can read |

Use platform export files for all three. Exports avoid authenticated scraping, rate
limits, and dependency on page structure while providing a complete account snapshot.

- **Twitter/X**: Settings → Download an archive → `data/bookmarks.js`, `data/tweets.js`
  (JS files with a `window.YTD.*.part0 = ` prefix to strip before `JSON.parse`).
- **Instagram**: Settings → Your activity → Download your information → JSON.
- **WhatsApp**: per-chat *Export chat* → a `.txt` with `[date, time] Sender: message`
  lines. Multi-line messages continue until the next timestamp.

Each is a parser plus a loop. Formalise `Importer` first so they are three files rather
than three CLI edits.

---

## Order I would build them in

1. `Importer` interface, to support the three export-file sources.
2. iMessage, which already uses SQLite.
3. Twitter/X archives, which are static local input.
4. `UrlHandler` with arXiv and generic handlers, restored from `future-src/`.
5. YouTube, with `yt-dlp` as an external dependency.
6. Local video, then iCloud Photos, which require the most platform-specific work.
