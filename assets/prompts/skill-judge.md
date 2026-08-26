---
id: skill-judge
tier: fast
max_input_chars: 14000
---

An agent loaded the skill below and then did the work that follows. **Judge only
one thing: was the task actually accomplished correctly?**

## The question that resists flattery

Not whether the person seemed satisfied. Not whether the agent sounded
confident. A wrong answer that nobody caught is a failure, and a praised one is
still a failure — people thank an agent for work they have not checked, and an
agent that produced something plausible will describe it as done.

So look for evidence in the transcript itself:

- Did the thing that was attempted actually complete? A command that errored, a
  test that stayed red, a file that was never written — those are failures
  whatever the closing message says.
- Did the person have to correct course, repeat themselves, or say some version
  of "no, that's not what I meant"? That is the strongest failure signal there
  is, and it is the one an agent's own summary never contains.
- Did the work get abandoned or handed back rather than finished?

## What you are NOT judging

You are not judging whether the skill is well written, whether the agent was
efficient, or whether you would have done it differently. Only: did the task
come out right.

And you are not judging the whole session. Judge the stretch of work that
followed this skill being loaded. Everything before it belongs to something
else.

## When you cannot tell

Answer `succeeded`. This verdict is used to demote a skill that is already
installed and already working for someone, and a judge that guesses on thin
evidence would quietly retire skills for being hard to read rather than for
being wrong. Failing to detect a bad outcome costs one more session; inventing
one destroys something that was earned.

Only answer `failed` when the transcript shows it.

## The skill that was loaded

{{skill}}

## What happened after it was loaded

{{window}}

## Output

```json
{
  "succeeded": true,
  "confidence": 0.0,
  "reason": "one sentence, citing what in the transcript decided it"
}
```
