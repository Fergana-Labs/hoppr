---
tier: fast
max_input_chars: 8000
system: You extract a knowledge graph. You are precise and you decline to guess.
---
Read the capture below and extract entities and relations that are STATED in it.

## Entity types

{{ENTITY_TYPES}}

## Relations

{{RELATIONS}}

## Rules

- Extract only what the text asserts. If it is implied, likely, or would need
  outside knowledge to confirm, leave it out. A sparse correct graph is worth
  more than a dense speculative one, because every edge here will be trusted.
- `evidence` must be a short verbatim quote from the capture that supports the
  edge. If you cannot quote it, do not assert it.
- Use the entity's name as written. Do not expand abbreviations, resolve
  pronouns to people not named in this capture, or merge two names you believe
  refer to the same thing — that is decided later, across captures.
- Only use the entity types and relation names listed above.
- Two people appearing in the same sentence is not a relation.

Return JSON:

{
  "entities": [{"type": "...", "name": "...", "summary": "one clause, optional"}],
  "relations": [{"from": "...", "predicate": "...", "to": "...", "evidence": "..."}]
}

`from` and `to` must exactly match a `name` in `entities`.

---
title: {{TITLE}}

{{TEXT}}
