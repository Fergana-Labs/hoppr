# Reference implementations, not built

Working code, removed from `src/` to keep the core to one idea: a folder plus a
sleep-time index over it. Each of these reached outside that folder.

All four were verified against live services before removal — the measurements are in
[`../FUTURE-SOURCES.md`](../FUTURE-SOURCES.md). They are kept as files rather than as
git history because the history did not exist when they were pulled.

| file | was |
|---|---|
| `url-handler-types.ts` | the `UrlHandler` plugin interface |
| `url-handlers.ts` | arXiv, YouTube, PDF-by-URL, generic web page |
| `bookmarks-importer.ts` | Netscape bookmark HTML parser |
| `fetch.test.ts.txt` | 9 tests covering routing, VTT transcripts, bookmark folders |

They are **not compiled and not tested**. To restore one: move it back under `src/`,
re-wire the two call sites in `src/intake/add.ts` and `src/cli.ts`, and rename the test
back to `.ts`.
