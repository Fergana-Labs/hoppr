# Verifying a skill before it ships

A proposal. Nothing here is built yet; the [no-regret changes](#what-already-changed)
are.

## The problem, stated precisely

Every quality mechanism hoppr has — the promotion gate, the refuter, the
grounding check, the trigger-quality test — evaluates a skill as **text**,
before it has ever been used. That is the one thing the literature says does
not work.

SkillRevise measures it directly. A one-shot LLM-authored skill, installed
without execution feedback, is frequently **worse than no skill at all**:

| executor | benchmark | one-shot skill vs no skill |
|---|---|---|
| Opus-4.7 | SWE-Skills-Hard | **−12.86 pp** |
| Opus-4.7 | SkillLearnBench-R | −10.00 pp |
| Kimi-2.6 | SWE-Skills-Hard | −7.14 pp |
| GPT-5.5 | SkillLearnBench-R | −6.00 pp |

Three bounded revision rounds against a verifier take GPT-5.5 on SkillsBench
from 31/86 (no skill) to 53/86 — **+25.58 pp**. The delta between "authored"
and "authored then verified" is larger than the delta between "no skill" and
"authored".

hoppr is squarely in the first column. It mines once, scores the prose against
five heuristics, and ships.

The reason it stops there is stated honestly in `organize/revise.ts`:

> hoppr has no benchmark and no scalar reward, so it gates on the two checks it
> CAN run.

That premise is now false.

## hoppr already has a verifier and does not know it

The `corrections` table is a labelled dataset of agent failures, each carrying:

- the situation, as transcript context
- what the agent actually did wrong
- what the person said instead, verbatim and attributed
- a normalized failure mode
- an estimated cost and severity

That is the shape of a test case. It was collected to write a report; it is
worth considerably more as an oracle.

The move is **counterfactual replay**. You cannot re-run someone's environment
from six weeks ago. You can re-run the *decision*: take the transcript up to
the moment the agent went wrong, ask a model what it would do next with and
without the candidate skill in context, and check each answer against what
actually happened and what the person actually asked for.

```
recorded case          the agent's next move        did it recur?
─────────────────────  ───────────────────────────  ─────────────
lead-in context   ──┬─▶ baseline arm (no skill) ───▶ reproduces failure?
                    │
                    └─▶ skill arm (+ candidate) ───▶ reproduces failure?
                                                     cost vs baseline?
```

A skill earns its place when the baseline arm reproduces the recorded failure
and the skill arm does not. It is rejected when it changes nothing, when it
breaks a case that was previously fine, or when it reaches the same answer for
substantially more tokens.

This costs two model calls per case. It needs no benchmark, no environment, no
new capture, and no reward function.

## What replay cannot do

It is a model judging a model against a text stub, not real execution. It
cannot see Environment Mismatch or Artifact Misplacement, which together are
**37 of 125** measured functional failures — a skill that sends the agent to
write in the wrong directory, or that assumes a package state the current
project does not have.

So replay is a cheap filter, not a verifier in SkillRevise's sense. For
repo-scoped skills where hoppr can actually run the project's own verify
command, a real-execution tier is possible later (Phase 5). Everything before
that is honest about being a proxy, and says so where the score is shown.

## Architecture

Six components. Five of the six are fed by data hoppr already collects.

### 1. Case store — `organize/cases.ts`

Derived from `corrections`, not a new capture. A case is:

```ts
interface Case {
  id: string
  raw_id: string          // the session it came from
  mode: string            // normalized failure mode
  leadIn: string          // transcript up to the wrong move
  wrongMove: string       // what the agent did
  correction: string      // what the person said, verbatim
  severity: 'annoyance' | 'rework' | 'damage'
}
```

The lead-in is already computed — `correctionWindow` builds exactly this
pairing today for extraction, and the same function serves replay.

### 2. Replay harness — `organize/replay.ts`

```ts
replay(case, skill?): Promise<{
  recurred: boolean       // did the failure happen again
  tokens: number          // cost of this arm
  reason: string
}>
```

Two arms per case. The judge is asked one question — *did the recorded failure
happen again* — with the recorded correction as the rubric. That is a much
narrower question than "was this good", and narrow questions are the ones
models answer reliably.

### 3. Held-out split

SkillOpt's validation gate, finally answerable. Cases for a mode are split:
the miner sees the training half, the gate scores the held-out half. A skill
that only prevents the failures it was written from has memorised, not
generalised — which is precisely the distinction `promotionGate` currently asks
a model to assert about itself.

### 4. Revision loop — `organize/revise.ts`, extended

SkillRevise's structure, which hoppr has two-thirds of already:

- **Diagnosis** `(verification spec, failure attribution, preservation constraints)`.
  hoppr has an edit budget and a rejected-edit buffer; it has nothing recording
  *what must not change*. Preservation constraints are the missing third, and
  they are derivable — they are the held-out cases the current version already
  passes.
- **Execution-anchored edits** — each edit names the executor action it should
  induce and where in the skill it belongs, rather than being free-form prose.
- **Bounded episode**, B = 3 rounds, keeping the **first** candidate that
  passes rather than the best-scoring one.
- **Utility fallback** only when nothing passes, with efficiency credit gated
  on success (`g_succ`) so a revision cannot win by making the agent do less.

### 5. Principle memory — `organize/principles.ts`

A cross-skill library of repair patterns, seeded and grown conservatively. Each
entry says when to consider it, what defect it addresses, how the skill should
change, what executor action the edit induces, how to verify it, and **when it
must not transfer**.

hoppr has the negative half of this already (`skill_rejected_edits`, from
SkillOpt) and no positive half. Absorption filters are non-negotiable and come
straight from SkillRevise: a candidate principle must be evidence-backed,
skill-level, utility-improving and transferable, and task-specific constants,
output paths and environment shortcuts are stripped before storage. The
`nonTransferable` detector added today is the first half of that filter.

### 6. Retrieval bench — `organize/routing.ts`

The scaling wall, and the one hoppr will hit hardest.

Actual-use precision falls from **29.6% to 3.3%** as a pool grows from 5 to 100
skills. Splitting by pool composition shows confusability rather than size is
the stressor: top-1 retrieval on *similar* pools falls 70.5% → 53.4%, against
97.7% → 84.1% on random ones. hoppr mines automatically, so it reaches large
pools without anyone deciding to, and every skill is distilled from one
person's work — so its pool is similar by construction.

gbrain's answer is a `routing-eval.jsonl` per skill plus an assertion that
triggers route correctly. Its Phase 5 demands "trigger phrases users ACTUALLY
type", which authors normally have to invent. hoppr does not have to:
`corrections.quote` is verbatim, attributed user phrasing, generated as a
by-product of the pipeline that produced the skill.

`findOverlaps`, added today, is the detection half. The bench is the
measurement half, and the floor it enforces is what keeps mining from
poisoning its own retrieval.

## Phasing

| phase | what | why now |
|---|---|---|
| 1 | no-regret gate and prompt changes | **done** — see below |
| 2 | case store + replay harness + held-out gate | **done** — see below |
| 3 | revision loop + principle memory | **done** — `hoppr skills repair` |
| 4 | retrieval bench + overlap enforcement | **done** — `hoppr skills routing` |
| 5 | grounding proposed moves in the real project | **partly done** — the safe half; see below |

Phase 2 is the one worth doing next, and it is worth doing even if 3–5 never
happen: a gate that has seen a skill fail is categorically different from one
that has read it.

## Phase 2, as built

`hoppr skills verify [slug]`. Three things came out of building it that the design above
did not anticipate.

**Single draws are not stable.** The first real run scored a guardrail `regression` on one
case; the second run, unchanged, scored the same case `prevents`. Both arms are one
generation and the judge is one verdict, so a bench that draws once reports which way the
coin landed — and this bench retires skills. Every case is now drawn three times and
decided by majority, each verdict printed with its agreement (`2/3`), and `regression`
requires a real majority rather than a plurality because it is the label that destroys
something earned.

**Baselines are cached per sample, and that is load-bearing.** The cheap reason is that
the no-skill arm does not depend on the candidate. The real reason is that every skill is
then scored against the *same* controls, so a difference between two skills is a
difference between the skills rather than between two draws of the control.

**An untestable claim is not a failed one.** A guardrail names the failure it exists to
stop. If the split puts none of that mode's cases on the holdout side, there is nothing to
test the claim against — reporting that as "prevented nothing" would fail a skill for the
split's arithmetic.

One defect worth recording: `splitFor` hashed with `sha256()`, which returns a
`sha256:`-prefixed digest, so `parseInt(…, 16)` was `NaN`, `NaN % 2 === 0` was false, and
**every case in the store landed on the holdout side**. The train half was empty, the
held-out design was inert, and nothing about it was visible from the outside.

### First real result

Run against this repo's own corrections, on a guardrail that had scored 100% against every
text-based gate:

```
pass confirm-visual-ref-before-build  prevented 1 of 2, broke nothing
  prevents  3/3  built-before-clarifying
            baseline unilaterally extends the pattern to three more config areas
  inert     3/3  built-before-clarifying
            the objection was a formatting complaint the skill does not address
  unstable  0/3  ignored-a-stated-preference
            no two draws agreed (regression, inert, prevents)
  inert     3/3  answered-a-different-question
```

Two things to read here. The unanimous verdicts are unanimous — the skill genuinely
prevented a recorded failure, and correctly did nothing about a case outside its scope.

And the `unstable` row is the same case that a single-draw run had earlier scored
`regression`, which disqualified the skill outright. Three draws show it was a coin flip:
`regression`, `inert`, and `prevents`, one each. The bench had reported a finding it had
not made, and would have retired a working skill for it.

## Phase 4, as built

`hoppr skills routing`. Fixtures come free from cases; pools are subsampled from the real
skill set at 3, 5, 10, … rather than padded with invented distractors, because a synthetic
pool measures how confusable made-up skills are and that is not a fact about this store.

Two things worth recording.

**The first number was measuring the instrument.** Situations were the tail of the case's
lead-in, which scored 0% top-1 — the guardrail ranked last of six. A transcript tail is
whatever prose the session ended on, and on real cases here that was an assistant sign-off
("Say the word and I'll do the same sweep there. Session: https://…"). Scoring that against
a skill description compares two unrelated kinds of text. Switching the situation to the
agent's next move — the symmetric comparison against "use when about to …" — took it to
50% with nothing else changed.

**The remaining miss is a mode problem, not a routing problem.** `built-before-clarifying`
clusters "built the wrong config schema", "used the wrong line breaks", and "built UI
without a reference". The guardrail mined from it specialised to the third, so the other
two cannot reach it — correctly. That is the cost of the converged mode vocabulary, which
bought recurrence at the price of coherence, and routing is the first place it shows up as
a number rather than a hunch.

### What routing found upstream

The miss above was not a routing defect. `built-before-clarifying` had absorbed three
unrelated jobs, so the guardrail mined from it could only address one — and the other two
correctly could not reach it. The mode counted three occurrences of a failure the skill
prevents once, which means the recurrence that justified writing it was partly fictional.

That is the bill for the converged mode vocabulary, and routing is where it first became a
number. The fix keeps the mode as the unit of **cost** and introduces a finer cluster as
the unit of **skill**: corrections are split by headline similarity into groups that are
actually one failure, largest group keeping the plain mode name. On this store that split
`ignored-a-stated-preference` into "kept opening the browser despite the stated preference"
and "asked what the user had already answered" — two failures with nothing in common but a
label.

Both are reasons the report names its ranker (`embedding` or `lexical` — a lexical run is a
lower bound) and holds the floor below eight fixtures. Precision over two cases moves fifty
points when one flips.

## Phase 3, as built

`hoppr skills repair <slug>` and `hoppr skills principles`.

The loop hoppr could not run before. `organize/revise.ts` has bounded its edits and
remembered rejected ones for a while, but it had nothing to revise *toward* — it gated a
rewrite on the promotion gate and the refuter, both of which read the prose. A revision
could only be checked for being plausible, and plausible was the property already failing.

Three decisions carry the design:

**Preservation constraints, derived rather than declared.** The third of SkillRevise's
diagnosis triple was the piece hoppr had no way to produce. The bench answers it directly:
the holdout cases this version already passes are exactly what must not break.

**First passing candidate, not best-scoring.** Selection on verifier success before utility
means a later candidate that might have scored higher is never generated — which is the
point, because scoring higher on a proxy is how a revision gets worse while looking better.

**Screen cheap, confirm expensive.** A round samples each case once; three draws per case
per round would triple an already costly loop to reject candidates a single draw rejects as
well. The survivor is re-run at full samples before being kept, because a decision to ship
has to meet the bench's bar rather than the screen's.

The reviser can also answer that a skill is unsalvageable. Without that exit, a reviser
narrows a skill until it stops firing — the failures disappear and nothing is fixed.

### Principle memory

hoppr has carried half of this for a while. `skill_rejected_edits` remembers what did not
work (SkillOpt's ablation is why it exists: removing the buffer cost 1.6, 4.6 and 2.4
points across three benchmarks). Nothing remembered what did.

A principle says when to consider it, what to change, what the executor should then do
differently, and **where it must not be applied** — every seeded one carries that last
line, because a principle claiming to apply everywhere will be. Seeds are the measured
defect classes rather than invented ones.

Retrieval matches on the symptom, not the cure: a reviser knows what went wrong, not which
repair it wants, so a memory indexed on cures is searchable only by someone who has stopped
needing it.

## Phase 5, and what was deliberately not built

The blind spot is real. Replay cannot see Environment Mismatch (13 of 125 confirmed
functional failures) or Artifact Misplacement (24) — a skill directing an agent to run
something this project does not have, or to write somewhere the task never named. No amount
of transcript reading reaches them.

Closing them completely means executing what the arm proposed, which means running
model-generated shell commands against a real checkout. That is not a thing to build
without being asked, and it is emphatically not what a store scoring its own skills at 3am
should be doing. **So the move is checked, not run.**

An arm already produces a concrete next action. `organize/grounded.ts` reads the project's
manifests and filesystem and asks whether that action could work here: a script
`package.json` does not define, a package manager the lockfile contradicts, a backticked
path that is not there. One finding fails the skill — the manifest either has the script or
it does not, so this is not a judgement and not a sample.

It fires only where the project has said something definite. A manifest that will not parse
reports nothing rather than reporting a project with no scripts, which would fail every
command a skill names; a lockfile-less project makes no claim about package managers; prose
that merely mentions a directory is not a path assertion. The same asymmetry
`grounding.ts` reasons about applies — a false positive discards a real skill, and the
alternative to a mined skill is no skill.

What remains for real execution: a script that exists and fails, a path that exists and is
wrong, a version skew. Those need a sandbox and someone's explicit say-so.

## What already changed

Landed as no-regret fixes, each contradicting something hoppr previously
asserted:

- **Pitfalls are credited, not required.** hoppr required them on the premise
  that "the failures are the payload". Holding source trajectories fixed and
  varying only their success/failure mix, success-only pools far exceed the
  no-skill baseline while failure-only pools fall below it.
- **A success trace is required instead.** Clusters are ranked by success ratio
  and failure-only clusters are skipped before the model call.
- **An applicability boundary is required.** `skill_guidance_misapplied_or_ignored`
  appears in 10.0% of skill-arm cases against 0.8% raw, and only 2 of 125
  functional failures come from an obviously irrelevant skill.
- **Body size is capped at 5,000 characters.** Skill-Body Context Bloat is 43 of
  46 context-overhead regressions, against 3 for material read on demand.
- **Verification scope is conditioned on change size.** Excessive Verification
  is the single largest efficiency-regression subcategory, 67 of 182.
- **The usage judge no longer rewards omitted work**, and flags invented work.
- **Overlapping triggers are reported** by `hoppr skills audit`.
- **Non-transferable constants** are detected and handed to the verifier.

## Sources

- *Demystifying Agent Skills: Why They Work—Until They Don't* — arXiv:2608.14036
- *Agent Skills Can Be Harmful* — arXiv:2608.11888
- *SkillRevise: Improving LLM-Authored Agent Skills via Trace-Conditioned Skill Revision* — arXiv:2606.01139
- SkillOpt (arXiv:2605.23904) and MSCE (arXiv:2607.16621), already cited throughout `organize/`
- gbrain `skills/skillify/SKILL.md` — the 11-item contract, routing evals, cross-modal gate
