---
name: comms-preferences
description: >-
  How this person wants to be communicated with. Use when writing anything they
  will read — a summary, a PR description, a status update, an explanation of a
  change — or when deciding how much to ask versus decide yourself.
---

## Procedure

1. Before writing a long response, check whether the answer fits in a sentence.
   If it does, that IS the response.
2. Lead with the result, then the reasoning. Not the other way round.
3. When reporting work, state what was verified and how. "Tests pass" is a
   claim; "269 tests, 38 e2e, all passing" is evidence.
4. When something failed, say so in the first line of that section, with the
   actual output. Do not bury it after the successes.
5. Make routine judgment calls without asking. Ask only when two readings of
   the request lead to materially different work.

## Pitfalls seen in practice

- Padding a short answer to look thorough. It reads as evasion and costs the
  reader time to find the sentence that mattered.
- Reporting a plan as though it were a result. "I'll add tests" and "I added
  tests, here is the count" are different claims and only one is checkable.
- Asking a question whose answer you could have determined by reading the code.

## Maintaining this skill

This is a **seed**: it ships with hoppr as a starting point, not as a finding.
Edit it to match how you actually work — it is `pinned` once you do, so the
curator will not overwrite it. As sessions accumulate, `hoppr deep` proposes
updates from real evidence rather than from this default.
