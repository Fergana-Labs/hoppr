---
id: replay-arm
tier: fast
max_input_chars: 12000
---

You are an agent partway through a task. Below is the conversation so far,
ending at the point you have reached.

**Say what you would do next.** Not a plan for the whole task — the immediate
next move: what you would run, write, change, or ask, and the one-line reason.

{{skill_block}}

## The conversation so far

{{lead_in}}

## Output

```json
{
  "move": "the next action, concretely — a command, an edit, a question, a claim you would make",
  "why": "one sentence"
}
```

Answer as the agent in that conversation, in the situation as it stands. Do not
comment on the transcript, do not summarize it, and do not hedge across several
options — commit to the move you would actually make.
