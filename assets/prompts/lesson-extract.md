---
id: lesson-extract
tier: fast
max_input_chars: 24000
---

You are reading past agent sessions to find what a **future** agent should have
known before it started.

Not what the session was about. Not what was built. What it *established* — the
standing facts, rules, and habits that were true when the session ended and will
still be true next month.

Each bin below is looking for a different **moment** in a transcript. Answer its
question, not a general one.

Each block starts with `### name`, then a few `key: value` lines — `heading` and
`description` are for the person reading the finished file, `graded: true` marks
each line MUST or PREFER — and then the question itself.

**For this store, collect only these bins: {{active}}.** Every other section
below is defined but switched off — anything you return for one is discarded, so
returning it is wasted effort. Add a heading here and a name to `[skills] have`
and you have a new bin.

## Bins

### glossary
heading: This person's world
description: What the nouns in this person's world mean and where they live — their names for systems and stages, and which directory, service, or document is the real one for a given subject. Read before interpreting an unfamiliar term, before searching for something, and before creating a file that may already exist elsewhere.

Which nouns in these sessions would a new agent get wrong? Look for a term being
defined or corrected ("we call that…", "no, a hoppr is the whole directory"), and
for the moment someone says where a thing actually lives ("contracts are in Drive
under Legal, not the repo") — especially when it corrects a wrong guess. Both are
the same answer: given a noun from this person's world, what is true about it?

Record the noun itself, lowercase, as the subject. The statement is what it means
or where it is — and where it is NOT, if that was the confusion.

### preferences
heading: How work gets done here
graded: true
description: Standing rules and preferences about how work gets done here. Lines marked MUST are constraints and are not negotiable; lines marked PREFER are defaults you may override with a reason. Read before writing anything this person will read and before picking a default they have already chosen once. Every line was stated explicitly; none were inferred.

What did this person correct, reject, or ask for again? A correction is the
strongest signal there is — "no, shorter", "stop apologizing", "never use the word
delightful" — and a rejected draft carries a rule even when none is stated
outright. Take standing constraints they state outright too, even calmly.

The subject is the specific axis it governs ("response length", "commit
messages"), never a broad bucket like "writing". The statement is the rule,
phrased as an instruction.

### procedure
heading: How recurring work gets done
description: How a job that recurs here gets done, and what goes wrong on the way.

Which job in these sessions is one this person will do again? Deploying, cutting a
release, making a deck, answering an inbound sales email. Ignore the one-off — a
bug that existed once and is now fixed is not a procedure. Ask whether a different
instance of the same job would follow the same path.

The subject is the job as a short verb phrase ("deploy hoppr", "answer inbound
sales"); the statement is the approach in one sentence. Also set `outcome`: did it
work in THIS session — `worked`, `failed`, or `mixed`? Set `failed` when the
approach was tried and did not succeed, and `mixed` when it eventually worked but
only after going wrong first. Be honest rather than generous here: the sessions
where something failed are where the pitfalls come from, and one mislabelled
`worked` takes its failure out of circulation.

## Rules

**Every lesson needs a verbatim quote.** Copy the exact span from the transcript
that establishes it — the person's own words where possible, not the agent's
restatement of them. A lesson you cannot quote is one you inferred, and inferred
standing facts are how a memory system starts lying confidently. Drop it.

**For every bin except `procedure`, the quote must come from the human.** In
these transcripts that means the `## Prompts` block or a `**user:**` line —
nowhere else. A transcript also contains assistant prose, tool output, and the
full text of any file the agent happened to read, and all of it reads like
confident prose about how things should be done. None of it is evidence about
what this person wants. Quoting a prompt file back as a user preference is the
specific failure to avoid.

**The subject is a key, and a newer statement about the same subject REPLACES
the older one.** Choose it at the grain where that is the behaviour you want: a
noun has one meaning, and "response length" holds one rule while "writing" would
wrongly collapse several. Two rules that can both be true at once need two
different subjects.

**Say how binding a rule is.** `must` for a real constraint — something that
would be a mistake to violate, however good the reason. `prefer` for a default,
a taste, a way they like it. When in doubt use `prefer`: treating a preference
as law is the more damaging error, because it makes an agent refuse reasonable
work. Bins other than rule-like ones can leave it alone.

**Skip anything true only of this session.** "The bug was a missing await" is not
a lesson. "We use vitest, not jest" is.

**Skip anything already obvious from the repository.** Config files, the README,
and the directory layout are already available to a future agent. You are looking
for what is *not* written down anywhere.

**Returning nothing is a correct and common answer.** Most sessions establish
nothing durable. An invented lesson is worse than a missing one, because it will
be stated as fact to every future agent with a citation that looks legitimate.

## Sessions

{{sessions}}

## Output

```json
{
  "lessons": [
    {
      "session": "the id from the ### session heading above",
      "kind": "{{kind_names}}",
      "subject": "short, lowercase, normalized — the thing this is about",
      "statement": "one sentence, stated as fact or instruction, no hedging",
      "quote": "verbatim span from the transcript, under 200 chars",
      "strength": "must | prefer",
      "outcome": "worked | failed | mixed | unknown  (procedures only)",
      "confidence": 0.0
    }
  ]
}
```
