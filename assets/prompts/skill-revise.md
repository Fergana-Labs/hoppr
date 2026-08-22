---
id: skill-revise
tier: quality
max_input_chars: 32000
---

You are revising a skill that already exists, against evidence it has not seen.

**Bounded edits, not a rewrite.** You may propose at most {{budget}} edits. This
is the constraint that matters: an unbounded rewrite erases rules that were
earned, introduces instructions that contradict the ones already there, and
overfits the whole skill to whatever went wrong most recently. A skill that
survives twenty small corrections is better than one rewritten twenty times.

Each edit names a section and does one thing:

- `replace` — this section is wrong or superseded. Give the new text.
- `append`  — this section is right but incomplete. Give only what is new.
- `delete`  — this no longer applies. No text needed.

Prefer `append` to `replace`, and `replace` to `delete`. Deleting something you
merely disagree with destroys evidence someone gathered the hard way.

## What earns an edit

**A failure the skill did not warn about.** This is the most valuable edit
available. If the new sessions hit a wall the pitfalls section does not mention,
add it, and name the symptom so a reader recognizes it before losing the hour.

**A step that turned out to be wrong or incomplete.** If the recorded procedure
was followed and did not work, correct it.

**A trigger that was too narrow.** If the skill applies to a situation its
description does not name, widen the description — otherwise nothing will ever
match against it.

## What does not earn an edit

- Rephrasing something that is already correct.
- Adding a step that only applied to one session's specifics.
- Any command that does not appear in the evidence below. You are revising from
  a transcript, not from what you know about these tools. An invented command
  will be rejected mechanically and waste the edit.
- Anything in the rejected list — those were tried and made things worse.

**Returning zero edits is a correct answer.** A skill that is already right
should not be touched, and a pass that changes nothing costs nothing.

## The skill as it stands

{{current}}

## Edits already tried and rejected

{{rejected}}

## New evidence

Sessions where the procedure WORKED — preserve what these rely on:

{{successes}}

Sessions where it FAILED — these have priority, and are where the pitfalls come
from:

{{failures}}

## Output

```json
{
  "edits": [
    {
      "op": "append | replace | delete",
      "section": "the exact heading, e.g. 'Pitfalls seen in practice'",
      "text": "the new content — omit for delete",
      "why": "one sentence: what in the evidence forced this"
    }
  ]
}
```
