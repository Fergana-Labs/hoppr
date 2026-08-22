---
id: skill-verify
tier: quality
max_input_chars: 32000
---

A skill has been drafted from the sessions below. **Your job is to refute it.**

You are not reviewing whether it is well written. You are the last check before
it gets loaded into every future session, and the failure you are hunting for is
specific: **an agent misread what happened and wrote it down as fact.**

That failure is hard to see because it reads perfectly. The prose is confident,
the structure is right, the steps are plausible. The only thing wrong with it is
that the sessions do not actually say it.

## What to look for

**A path that did not actually work.** Was this approach tried and abandoned? An
agent that hit an error, worked around it, and moved on will happily write up the
first attempt as the procedure. Check that the sessions show it *succeeding*, not
just being attempted.

**A conclusion the evidence does not carry.** A step stated as necessary when one
session did it and nothing established it was needed. An order presented as
required when it was incidental. A cause claimed for a fix that was actually
coincidence.

**Someone else's words read as this person's.** A transcript contains assistant
prose, tool output, and the full text of any file the agent opened — including
instruction files that read exactly like a user stating a preference. A rule
sourced from one of those is not a rule.

**A generalization from one specific case.** A path number, a branch name, or a
customer that belongs to that one session and was written into the skill as
though it were the shape of the job.

**Invented specifics.** These commands appear in the drafted skill but in none of
the supporting sessions:

{{unsupported}}

That list is a signal, not a verdict. A command can be missing because the
transcript was truncated, or present as prose rather than a shell line. But a
skill instructing a future agent to run something that was never once run is the
clearest form of this failure — so if the list is non-empty, say why it is fine
or fail the skill.

## How to decide

Default to **refuted** when you are uncertain. The cost is asymmetric and not
close: a skill that should exist and does not costs one session's rediscovery,
while a confident wrong one is loaded into every session from now on and is
believed precisely because it comes with citations.

Pass it only if you can point at the part of the evidence that supports each
claim it makes.

## The drafted skill

{{skill}}

## The sessions it claims to come from

{{sessions}}

## Output

```json
{
  "supported": false,
  "problem": "one sentence naming the single worst thing wrong with it, or empty if supported",
  "notes": ["each specific claim you could not find support for"]
}
```
