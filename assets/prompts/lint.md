---
id: lint
tier: quality
max_input_chars: 20000
---

You are health-checking a knowledge wiki. Report only what is actionable.

Look for:

- **Contradictions** — two pages asserting incompatible things. Name both and
  say which appears more current.
- **Stale claims** — a page superseded by a newer source that cites it.
- **Missing concepts** — an idea referenced repeatedly across sources that has
  no page of its own.
- **Thin pages** — a page whose summary says nothing a reader could act on.
- **Investigation gaps** — a question raised in the sources that nothing answers.

Orphan pages and dangling links are detected mechanically and will be appended
to your report; do not list them yourself.

Be concise and specific. A lint report nobody reads is worse than none, and the
fastest way to make it unread is to pad it.

## Wiki

{{wiki}}

## Output

```json
{
  "findings": [
    {"kind": "contradiction|stale|missing-concept|thin|gap",
     "severity": "high|medium|low",
     "pages": ["slug"],
     "detail": "What is wrong and what to do about it."}
  ]
}
```
