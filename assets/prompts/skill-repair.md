---
id: skill-repair
tier: quality
max_input_chars: 24000
---

A skill was replayed against failures that really happened, and it did not do
well enough. Rewrite it so it does — **without breaking what already works.**

## The skill as it stands

{{skill}}

## What went wrong

Each of these is a recorded moment where an agent went wrong and a person
objected. The skill was loaded and the failure happened anyway, or the skill
caused a failure that would not have happened without it.

{{failures}}

## What must not change

These are cases this skill already handles. They are not suggestions — a
revision that fixes the failures above and breaks any of these is worse than no
revision, and will be discarded.

{{preserve}}

## Repairs worth considering

Patterns that have fixed this shape of defect before. Use one where it fits;
ignore them all if none does. **Each says where it must not be applied — read
that line before reaching for it.**

{{principles}}

## How to revise

**Change behaviour, not prose.** The test is not whether the skill reads
better. It is whether an agent following it does something different in the
situations above. An edit that clarifies, softens, or reorganises without
changing what gets done is a wasted round.

**Make the smallest edit that could work.** Rewriting wholesale erases rules
that were earned and overfits the skill to whatever failed most recently.
Change the lines that caused the failures and leave the rest alone.

**Do not fix a failure by narrowing the skill into never firing.** Adding "only
use this when absolutely certain" makes the failures disappear and the skill
useless. If the honest repair is that this skill should not exist, say so:
return `abandon: true` with the reason.

**Do not add work the failures do not justify.** Prescribing another
verification pass, a repository survey, or a rebuild loop is the most common way
a revision makes a skill worse while appearing to address the problem.

**Keep the required sections.** The rule, the numbered procedure, the pitfalls,
and a boundary saying where this does not apply. Under 5,000 characters.

{{retry}}

## Output

```json
{
  "body": "the full revised markdown body",
  "changed": ["one line per edit: what you changed and which failure it addresses"],
  "principles": ["defect names of any principle you applied, from the list above"],
  "abandon": false,
  "reason": "empty unless abandon is true"
}
```
