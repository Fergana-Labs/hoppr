# Future: external sources

**Not built, deliberately.** hoppr's core is one thing: *point it at a folder, get a
sleep-time index over it.* Everything below reaches outside that folder — the network, a
platform account, another app's database — and each one carries its own auth, rate limits,
ToS and breakage. Shipping them alongside the core made the core harder to explain and
harder to trust.

This file is the design record so none of it has to be re-derived. Some of it was built,
measured, and then removed; the measurements are kept because they are the expensive part.

---

## The shape they all share

Every source here reduces to: **read something → produce `IngestCandidate[]`**. The parts
that are actually hard — redaction, dedup, staleness hashing, embeddings, the search
index, incremental cursors, terminal-per-row failure — already exist and are shared. A new
source is a parser, not a subsystem.

There are two existing plugin points and a third that should exist:

| point | shape | exists |
|---|---|---|
| `Connector` | "here is a place, keep pulling from it" (cursor, resumable) | ✅ `src/connectors/types.ts` |
| `UrlHandler` | "here is one link, turn it into text" (stateless) | ❌ removed — design below |
| `Importer` | "here is one export file, produce many captures" | ❌ never formalised |

The third is the one to build first, because it is the mechanism for Twitter, Instagram
and WhatsApp — the three sources where scraping is the wrong answer.

---

## Removed, with working code kept

These were built and verified against live services before being pulled out. The source is
in [`future-src/`](future-src/) — not compiled, not tested, but working when it was
removed. Restore from there rather than rewriting.

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

`follow` is what makes **multi-hop** fall out rather than needing its own machinery: an
arXiv abstract page returns the PDF URL, the PDF handler extracts the full text, and the
two stay separately searchable with separate provenance. Cap it at one hop — following a
followed link is how a crawler happens.

**Ordering rule, learned the hard way:** a specific handler must claim its domain
*narrowly*. `arxiv` originally matched every `arxiv.org` URL, so it answered its own
follow-up hop with the same abstract — capturing metadata twice and never fetching the
paper. `generic` matches everything and must be last.

### arXiv · verified working

Metadata from `export.arxiv.org/api/query?id_list=<id>` (no scraping), then the PDF as a
second record.

- Scope the title regex to `<entry>`. The Atom feed has its own `<title>` which is the
  query echoed back, so reading the outer one titles every paper `arXiv Query: …`.
- Measured: abstract 1,294 chars in 146ms; full paper 39,559 chars in 276ms.

### YouTube · verified working, via `yt-dlp`

- **Do not scrape `timedtext` directly.** The caption `baseUrl` is still in the page and
  still extractable, but the endpoint answers server-side requests with **200 and an empty
  body** in every subtitle format (`json3`, `srv3`, `vtt`, none). Verified, not assumed.
- Shell out to `yt-dlp` instead. Keeping up with YouTube's countermeasures is that
  project's entire job.
- **Judge it by its output files, not its exit code.** It exits nonzero for a version nag
  or one unavailable subtitle language while having written the captions perfectly.
- Auto-captions are a rolling two-line window, so consecutive duplicate lines must be
  dropped or the transcript comes back at roughly twice its true length.
- Measured: 2,066 chars in ~3.9s.

### PDF-by-URL · verified working

Download → text layer → OCR fallback if the layer is empty. Reuses the local extractors
that remain in core.

### Generic web page · verified working

Strip `nav/header/footer/aside/form/svg` *before* stripping tags, or every capture is a
navigation menu. Keep `og:title`, `description`, `author`, `article:published_time`.
Measured: Wikipedia 40,192 chars; Hacker News 3,728.

### Browser bookmarks · verified working

Netscape bookmark HTML — the 1994 format Chrome, Firefox, Safari and Edge all still emit.

- Nesting comes from `<DL>`/`</DL>` around `<H3>`, not from valid XML. One regex pass over
  `<h3>` / `</dl>` / `<a>` in document order, with a folder stack.
- **The folder path is the payload.** It is a taxonomy a human already built by hand and
  it makes better tags than anything inferred.
- `ADD_DATE` is seconds; a few browsers write milliseconds. Detect by magnitude.
- Skip non-`http(s)` entries — `javascript:` bookmarklets are common.

---

## Never built

### iMessage — easiest of these

`~/Library/Messages/chat.db`, opened **read-only** (`?mode=ro`). It is already SQLite, so
this is the same shape as the existing `opencode` connector: probe `sqlite_master` first
and disable with a clear warning if the schema moved, because a third-party schema is not
a contract. Needs Full Disk Access, which must be requested explicitly rather than
failing with a permissions error.

Bodies live in `message.attributedBody` (a serialised `NSAttributedString`) on newer
macOS, not always in `message.text` — a naive reader silently returns empty strings for
recent messages.

### Screenshots — **already works, no plugin needed**

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

### Twitter/X, Instagram, WhatsApp — **importers, not scrapers**

| | why scraping is the wrong answer |
|---|---|
| **Twitter/X** | bookmarks need an authenticated session; the API tier that reads them is paid; scraping breaches the ToS and risks the account |
| **Instagram** | same, plus aggressive bot detection on reels |
| **WhatsApp** | end-to-end encrypted. The local store is encrypted at rest, and Beeper is a bridge, not a database you can read |

The export file is the right input in all three cases, and not as a workaround: it is
**more complete** than scraping, does not rate-limit, does not break when the site ships a
redesign, and does not put the account at risk.

- **Twitter/X**: Settings → Download an archive → `data/bookmarks.js`, `data/tweets.js`
  (JS files with a `window.YTD.*.part0 = ` prefix to strip before `JSON.parse`).
- **Instagram**: Settings → Your activity → Download your information → JSON.
- **WhatsApp**: per-chat *Export chat* → a `.txt` with `[date, time] Sender: message`
  lines. Multi-line messages continue until the next timestamp.

Each is a parser plus a loop. Formalise `Importer` first so they are three files rather
than three CLI edits.

---

## Order I would build them in

1. **`Importer` interface** — unblocks the three export-file sources and retires the
   one-off command shape.
2. **iMessage** — highest value per line; it is already SQLite.
3. **Twitter/X archive** — the export is sitting on disk and never changes.
4. **`UrlHandler` + arXiv/generic** — restore from `future-src/`; the code worked.
5. **YouTube** — restore; depends on `yt-dlp` being present.
6. **Local video**, then **iCloud Photos** — most moving parts, least certain payoff.
