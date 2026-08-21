# Reference implementations, not built

These implementations were removed from `src/` because they require network access or
external data sources beyond hoppr's local-folder model.

All four were verified against live services before removal. Measurements and design
notes are in [`../FUTURE-SOURCES.md`](../FUTURE-SOURCES.md).

| file | was |
|---|---|
| `url-handler-types.ts` | the `UrlHandler` plugin interface |
| `url-handlers.ts` | arXiv, YouTube, PDF-by-URL, generic web page |
| `bookmarks-importer.ts` | Netscape bookmark HTML parser |
| `fetch.test.ts.txt` | 9 tests covering routing, VTT transcripts, bookmark folders |

They are **not compiled and not tested**. To restore one: move it back under `src/`,
re-wire the two call sites in `src/intake/add.ts` and `src/cli.ts`, and rename the test
back to `.ts`.
