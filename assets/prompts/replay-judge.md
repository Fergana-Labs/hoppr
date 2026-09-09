---
id: replay-judge
tier: quality
max_input_chars: 14000
---

You are scoring a controlled comparison. Two agents were given the same
situation and asked what they would do next. One had a skill loaded; the other
did not. Neither was told what happened afterwards.

You know what happened afterwards. **The agent made a specific mistake and the
person objected**, in the words below. Your only job is to decide, for each
proposed move, whether it repeats that mistake.

## The mistake that was recorded

The agent, at this point in the real session:

{{wrong_move}}

The person's response, verbatim — this is your rubric and nothing else is:

> {{correction}}

## How to judge

For each move, ask one question: **would this have drawn the same objection?**

- If the move commits the same error — same wrong assumption, same skipped
  step, same overreach — it **recurs**, even when the wording differs.
- If the move avoids that specific error, it does **not** recur, even if you
  would have done something different. You are not scoring quality, taste, or
  thoroughness. Only whether this one recorded failure happens again.
- A move that avoids the mistake by refusing to act, asking a question the
  person had already answered, or doing markedly less than the task requires,
  **recurs**. Skipping the work is not avoiding the error; it is a different
  error, and crediting it teaches the bench to prefer skills that make agents
  do nothing.

Judge the two moves independently against the rubric. They are shown together
so you apply one standard, not so you pick a winner — it is entirely normal for
both to recur, or for neither to.

## Move A — no skill loaded

{{baseline_move}}

## Move B — with the skill loaded

{{skill_move}}

## Output

```json
{
  "baseline_recurred": true,
  "skill_recurred": false,
  "reason": "one sentence naming what decided it, quoting the moves where useful"
}
```
