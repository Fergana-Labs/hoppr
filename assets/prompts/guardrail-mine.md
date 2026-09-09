---
id: guardrail-mine
tier: quality
max_input_chars: 18000
---

You are writing a **guardrail**: a skill whose only job is to stop one specific
failure from happening again.

This is not mined from a task that went well. It is mined from a mistake that
recurred, and you are being shown every time it happened along with what the
person said when it did.

## The failure

**Mode:** `{{mode}}`
**What the agent did:** {{headline}}
**Happened in:** {{sessions}} sessions · roughly {{turns}} turns burned · severity `{{severity}}`

### What the person said, verbatim

{{quotes}}

### The moments themselves

{{evidence}}

## What to write

A guardrail is short. It is read at the top of a task, and its whole value is
that an agent about to make this mistake notices in time. A page of context
does not get read; four lines do.

**The description is the trigger and it is the most important field.** It has to
name the SITUATION in which this mistake gets made, not the mistake. An agent
matching on "use this when you are about to report that a change works" will
load the skill at the moment it can still help. One matching on "avoiding false
completion claims" will load it after the damage, or never.

Start it with "Use when" and name the concrete moment.

**Under 200 characters, one sentence.** The dispatcher renders it as a single
table cell; a description with three clauses and a parenthetical has its
trigger buried in the middle where nothing will match on it. Name the situation
and stop — the detail belongs in the body.

**The body has four parts, in this order:**

1. `## The rule` — one or two sentences. What to do instead. Imperative.
2. `## Procedure` — the concrete steps that make the rule checkable. Numbered.
   A rule with no procedure is a slogan; "verify before claiming done" means
   nothing until it says what verification is here. **Write these from what the
   person asked for**, not from what the agent did wrong: the corrections above
   each contain the right answer as well as the wrong one, and the right answer
   is what a future agent needs to be able to follow.
3. `## What goes wrong` — the failure itself, and at least one real quote from
   the evidence above, attributed to the person. This is the part that makes an
   agent take the skill seriously, and it is the part you cannot invent.
4. `## Do not use when` — the situations where following this rule would be
   wrong or wasteful. Every rule has them, and a skill that claims none will be
   applied where it does not belong.

## Rules

**Be specific to what you were shown.** If the evidence is about test claims,
write about test claims. A guardrail generalized into "always be careful" is
worse than nothing: it displaces attention and matches everything.

**Lead with the correct behavior, not the mistake.** You are being shown only
the moments that went wrong, and a skill written from failures alone reliably
comes out worse than no skill at all — it describes a wrong turn instead of a
road. Everything a future agent should DO has to be stated positively and
concretely enough to follow without having seen the failure.

**Do not prescribe more work than the mistake warrants.** The single largest
cause of skills making agents slower is guidance that turns optional checks
into mandatory ones — extra verification passes, repository surveys, rebuild
loops. If the fix is one check, say one check, and say when even that is
unnecessary.

**Keep the body under 2,000 characters.** It is loaded into every session that
matches, so its length is paid on every model call. Detail that a reader needs
only sometimes is detail that belongs somewhere else.

**Quote, do not paraphrase.** Use the person's own words in `## What goes
wrong`. They are already verbatim and already verified as theirs.

**Do not write a guardrail you cannot support.** If the evidence does not show a
repeatable mistake with a repeatable fix — if it reads as one bad afternoon, or
the "mode" groups things that are not really the same failure — set
`reusable` to false and say why in `problem`. That answer is expected sometimes
and is much better than a plausible skill about nothing.

## Output

```json
{
  "slug": "kebab-case, names the rule not the failure, under 40 chars",
  "name": "Short title case name",
  "description": "Use when <the concrete situation>. …",
  "body": "markdown with the four sections above, under 2000 characters",
  "reusable": true,
  "confidence": 0.0,
  "problem": "empty unless reusable is false"
}
```
