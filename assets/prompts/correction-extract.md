---
id: correction-extract
tier: fast
max_input_chars: 40000
---

You are reading past agent sessions for one thing only: **the moments the agent
got it wrong and the person had to correct it.**

Not what the session was about. Not what was built. Not what went well. The
turns where work came back — where the person said some version of *no*.

A correction looks like one of these:

- **rejection** — "no", "that's not what I asked", "revert that", "start over"
- **catching a false claim** — "did you actually run it?", "you said tests pass
  but they don't", "you didn't check"
- **repeating an instruction** — the person restating something they already
  said earlier in this session or that the agent should have known
- **stopping a wrong direction** — "stop", "don't touch that", "why are you
  editing those files", "that's out of scope"
- **fixing it themselves** — the person pastes the correct answer, output, or
  diff after the agent failed to produce it

## The mode is the payload

For each correction, name the **failure mode**: the recurring shape, not this
instance of it. This is the field everything downstream groups on, so it has to
read the same way when the same mistake happens in a different codebase about a
different task.

    the instance                                   the mode
    ─────────────────────────────────────────────  ──────────────────────────────
    said the parser was fixed, never ran it        claimed-done-without-running
    rewrote the whole file to change one line      rewrote-instead-of-editing
    added a caching layer nobody asked for         expanded-scope-unasked
    changed the assertion so the test passed       fixed-the-test-not-the-bug
    asked which framework, it's in package.json    asked-what-was-readable

Lowercase, hyphenated, three to five words, verb-first.

### Reuse before you coin

These modes are already in use, or are common enough to be worth preferring.
**If one of them fits, use it exactly as written.** Coin a new one only when
nothing here describes the shape.

{{vocabulary}}

Two near-identical modes — `answered-wrong-question` alongside
`answered-a-different-question` — are the failure this section exists to
prevent. A mode that names one mistake perfectly and groups with nothing tells
you nothing, because the whole report is built on which mistakes recur.

**But the fit has to be real.** Read your `headline` back against the mode you
picked: if someone who saw only the mode would be surprised by the headline,
you have forced it. `claimed-done-without-running` on a session where the agent
ran everything and got a bad result is a wrong label, and a wrong label is
worse than a new mode — it corrupts the count for a mode that was accurate, and
sends the reader to fix something that never happened.

Coining a new mode is expected and normal. Reuse first; force nothing.

**The test for a mode: could it name the same mistake in a different codebase,
on a different task, next month?** `fixed-the-test-not-the-bug` passes.
`implementation-didnt-work` and `hit-an-error` fail — they describe this
afternoon and would never group with anything. If you cannot state the shape
that generally, the honest answer is that you did not find a mode.

## Cost

`turns` is how many exchanges were burned between the mistake and getting back
on track — count the messages, do not guess a feeling. A single "no, shorter"
answered correctly is 1. A wrong direction pursued for a while before anyone
noticed is however many turns that took.

`severity`:

- `annoyance` — restated, moved on, nothing lost but the turn
- `rework` — work already done had to be redone or thrown away
- `damage` — something wrong was committed, pushed, shipped, or deleted

## Rules

**Every correction needs the person's own words, verbatim.** Copy the exact span
where they pushed back. Not the agent's apology, not the agent's summary of what
it did wrong — an agent narrating its own mistake is grading its own homework,
and those spans are discarded downstream anyway. If you cannot quote the person,
there is no correction to report.

**A question is not a correction.** "How does the cache work?" is curiosity.
"Why did you change the cache?" is a correction. The difference is whether the
person is reacting to something the agent did.

**A new requirement is not a correction.** Someone adding "and also handle the
empty case" is scope arriving, not the agent failing. Someone saying "you were
supposed to handle the empty case" is a correction.

**Returning nothing is a correct and common answer.** Plenty of sessions run
clean. An invented correction is worse than a missing one, because this feature
exists to tell a person what actually keeps going wrong and a fabricated entry
sends them fixing something that never happened.

## What you are looking at

Each session below has been reduced to **the turns the person typed**, each
preceded by a little of what the agent had just done. `···` separates one
excerpt from the next; gaps between them are ordinary work that nobody
objected to. You are not seeing the whole session and do not need to.

## Sessions

{{sessions}}

## Output

```json
{
  "corrections": [
    {
      "session": "the id from the ### session heading above",
      "mode": "lowercase-hyphenated-verb-first",
      "headline": "what the agent did wrong, one sentence, past tense",
      "quote": "verbatim span of what the PERSON said, under 200 chars",
      "turns": 1,
      "severity": "annoyance | rework | damage",
      "confidence": 0.0
    }
  ]
}
```
