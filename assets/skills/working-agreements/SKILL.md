---
name: working-agreements
description: >-
  Standing constraints on how work gets done in this codebase — what to verify
  before claiming done, what needs permission, what to never do. Use at the
  start of any task that changes files, and before reporting completion.
---

## Procedure

1. Read the surrounding code before adding to it. Match its idiom, its comment
   density, its naming. Code that reads as foreign is a defect even when it works.
2. Verify by running, not by inspection. A change that "should work" has not
   been tested.
3. When a test fails, fix the cause. Adjusting the assertion to match the new
   behaviour is only correct when the assertion was wrong, and you should say
   which case it is.
4. Before deleting or overwriting, look at the target.
5. Commit or push only when asked.

## Pitfalls seen in practice

- Claiming a fix works because the code changed and the types check. Neither is
  evidence about behaviour.
- Testing against a fixture you wrote to match your implementation. The fixture
  and the code then agree with each other and with nothing else.
- Fixing the symptom a test reports rather than the cause it points at.

## Maintaining this skill

A **seed**, not a finding. Edit it to your standards; editing pins it. Mined
skills accumulate alongside it from real sessions.
