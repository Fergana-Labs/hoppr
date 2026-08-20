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

**The failures are the point.** A transcript where someone tried A, hit error B,
and eventually landed on C encodes something no documentation contains: the
wrong turn and why it was wrong. A skill written only from the clean final
command is strictly worse than the README that already exists. Every pitfall you
include should name the symptom, so a reader recognizes it before they lose the
same hour.

Do not invent a skill to fill the quota. If these sessions share no real
procedure, return an empty list — that is the correct answer and it costs
nothing. A mediocre skill is worse than no skill, because it will be loaded into
every future session.

## Sessions

{{sessions}}

## Output

```json
{
  "skills": [
    {
      "slug": "kebab-case-name",
      "name": "kebab-case-name",
      "description": "One or two sentences starting with a verb, naming the symptoms that should trigger this. This is what a future agent matches against, so write the trigger conditions, not a summary.",
      "body": "Markdown: ## When this applies, ## Procedure (numbered, with real commands), ## Pitfalls seen in practice (each naming its symptom).",
      "evidence": ["session-id-1", "session-id-2"],
      "confidence": 0.0
    }
  ]
}
```
