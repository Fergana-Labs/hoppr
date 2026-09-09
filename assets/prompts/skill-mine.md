---
id: skill-mine
tier: quality
max_input_chars: 40000
---

You are mining reusable skills out of past agent sessions.

A skill is a procedure that recurred: the same problem approached the same way
more than once. You are looking for **how the work was actually done**, not what
it was about. Two sessions about the same library are not a skill; two sessions
that both debugged a flaky test by shuffling the seed and then hunting a leaked
fake timer are.

**Write the road, then the wrong turns.** The procedure comes from the sessions
where the work came out RIGHT — those are the steps a future agent has to be
able to follow. A transcript where someone tried A, hit error B, and landed on C
also encodes something no documentation contains, so record B as a pitfall
naming its symptom. But a skill assembled out of wrong turns describes a wrong
turn: measured with the source trajectories held fixed and only their
success/failure mix varied, skills distilled from failures alone score below
having no skill at all. Successes are the body; failures are the annotations.

**Prescribe no more work than the job needs.** The largest single cause of a
skill making an agent slower is turning optional checks into mandatory ones —
extra verification rounds, repository surveys, rebuild loops, multi-stage
pipelines the task never asked for. Say what this job actually requires, and say
where a step can be skipped.

**Separate what is required from what is illustrative.** Most skill-induced
failures are not irrelevant skills being loaded; they are relevant ones whose
examples, defaults and templates got treated as task requirements. If a command,
path, filename or value is an example rather than an obligation, mark it as one
in the text.

Do not invent a skill to fill the quota. If these sessions share no real
procedure, return an empty list — that is the correct answer and it costs
nothing. A mediocre skill is worse than no skill, because it will be loaded into
every future session.

## What these sessions have in common

These sessions were grouped because each one established something about the
same task: **{{subject}}**

The claims that grouped them:

{{statements}}

Those are one-sentence summaries, which is exactly what a skill must not be.
Your job is what they leave out — the steps, the order, and the things that
went wrong on the way.

## Sessions

The sessions are split by how they turned out. **The ones that worked are where
the procedure comes from**; the ones that did not are where the pitfalls come
from. Do not read a failed attempt as the method.

### Where this approach worked

{{successes}}

### Where it went wrong first

{{failures}}

### Everything in the cluster

{{sessions}}

## Output

```json
{
  "skills": [
    {
      "slug": "kebab-case-name",
      "name": "kebab-case-name",
      "description": "One or two sentences starting with a verb, naming the symptoms that should trigger this. This is what a future agent matches against, so write the trigger conditions, not a summary.",
      "body": "Markdown, under 2500 characters: ## When this applies, ## Procedure (numbered, real commands, examples marked as examples), ## Pitfalls seen in practice (each naming its symptom), ## Do not use when (where following this would be wrong or wasteful).",
      "evidence": ["session-id-1", "session-id-2"],
      "confidence": 0.0
    }
  ]
}
```
