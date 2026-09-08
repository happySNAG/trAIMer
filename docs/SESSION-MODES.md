# Calibration length

> The session's goal is **enough valid evidence**, not a drill count.

## Why this document exists

The `1.0.0-rc.7` default made a player run **100 drills**, then told them **37**
were usable and the recommendation was preliminary at **24 % evidence
strength**. Two separate problems: the plan was long, and the plan's own idea
of "done" was "the drills ran out".

## The three modes

Every mode runs the **same** drills, candidate ladder, blinding, block
randomisation, paired scenario draws, target geometry, hit detection, scoring
weights, validation and exclusion rules. A shorter mode buys **less evidence**;
it never buys **easier evidence**.

| | rounds | measured reps / candidate / round | warm-ups / block | drills | measured | evidence target (valid drills per candidate) |
| --- | --- | --- | --- | --- | --- | --- |
| **Quick** | 1 | 5 | 1 | 30 | 25 | 4 |
| **Standard** *(default)* | 1 | 8 | 2 | 50 | 40 | 6 |
| **Precision** | 2 | 8 | 2 | 100 | 80 | 12 |

(Drill counts assume the standard five-candidate ladder.)

### Where those numbers come from

Three values in the documented V1 protocol (`src/experiments/rcDefaults.ts`)
fix everything above. Nothing here invents a threshold.

- **`minValidTrialsPerCandidate = 4`** — the optimizer's own floor. Below four
  valid measured drills for a candidate its standard error explodes, the
  candidate is marked incomplete, and session confidence is capped at ≤ 0.45
  whatever else the data says. A mode that cannot reach four per candidate
  cannot produce a recommendation at all.
- **`measuredRepsPerCandidatePerRound = 8`** — the point at which the duration
  campaigns' median-error and range-width curves flatten.
- **`adaptiveAllocation.minRepsBeforeAdaptive = 8`** — adaptive allocation only
  starts once every candidate has its balanced minimum, so a mode running fewer
  than 8 reps in its only round is deliberately, entirely balanced.

**Quick** sits one rep above the floor: four is the least the engine will rank
on, and the fifth rep is headroom that absorbs a single unusable measurement
without a replacement block. It is a *directional estimate* by construction.

**Standard** is one full documented round, with two reps of headroom per
candidate above the floor.

**Precision** is Standard plus the refinement round the protocol was designed
around, and is the only mode that reaches the search's second stage — adaptive
allocation, boundary expansion, and change-point analysis over two exposures of
every candidate.

### What a mode does *not* promise

A mode declares the strongest state its evidence *can* support
(`bestSupportedState`), never a confidence percentage. Confidence is driven by
how far apart the player's own candidates turn out to be, which is a property
of the player, not of the plan.

## Completion is decided by evidence

After the planned rounds, the session compares **valid measured drills per
candidate** against the mode's target. If a candidate is short *because
measurements were lost*, a bounded replacement block runs.

The player is told, in their units, before the drills start:

> *3 additional drills needed because some measurements could not be used.*

### Four independent stops

An extension can never become an open-ended chase:

1. the mode's `maxReplacementBlocks` (2 for Quick and Standard, 3 for
   Precision);
2. a drill budget of **half** the plan the player agreed to;
3. the experiment's own `maxTotalMeasuredTrials`;
4. **progress** — a block that produces no new valid measurement ends the phase
   immediately. If the machine cannot produce usable data, running the same
   drills again will not change that, and the results screen is a better place
   to say so than another five minutes of drills.

A cancel, an engine abort or a failed resume during a replacement block ends
the phase like any other.

**A custom plan is never extended.** Nothing named it, so nothing may grow it.

## Persistence

The selected mode is stored with the rest of the session settings and survives
a reload. Two rules keep it honest:

- **The label never contradicts the plan.** A stored blob whose
  `calibrationMode` disagrees with its `rounds` / `repsPerCandidate` /
  `warmupTrials` is *renamed from the plan*, not obeyed — so a session labelled
  Standard is always the Standard plan.
- **A resumed calibration keeps its own mode.** The evidence target comes from
  the stored experiment definition, never from the setup screen's current
  selection, so continuing a Quick calibration stays Quick even if the player
  has since picked Precision.

Editing a plan number in the advanced form is a deliberate move off the named
modes; the screen says so rather than keeping a label that has become a lie.

## Pairing, and why the shortest mode needed it fixed

The paired comparison cancels scenario and instance effects by comparing two
candidates on the same cell, `scenarioId#pairIndex`. Until Pass 14 the index
was a per-candidate running counter, so two candidates shared a cell only when
their independently shuffled block orders happened to agree.

Measured over 200 seeds with the standard five-candidate ladder:

| | cells per candidate | paired cells per candidate PAIR | yield |
| --- | --- | --- | --- |
| Quick, before | 5 | 0.98 (worst 0.3) | 20 % |
| Standard, before | 8 | 1.97 | 25 % |
| Precision, before | 16 | 3.96 | 25 % |
| **any mode, after** | 5 / 8 / 16 | **5 / 8 / 16** | **100 %** |

`TrialPlanSpec.pairIndex` is the occurrence number of a scenario within a
candidate's block, offset by the round. Every candidate in a round draws the
identical multiset, so every occurrence has a partner **by construction**. A
reduced adaptive allocation now takes a *nested* prefix of the shared draw
rather than a random subset, so a candidate playing fewer reps still pairs on
every cell it does play. Only the **order** varies per candidate, so order
effects remain unconfounded.

This mattered most for Quick: at five reps, an average candidate pair shared
**one** cell, and some shared none.

Because the paired path is now the normal case at 5, 8 or 16 cells, the
comparison's `mean / SE` is read as a **t statistic on n − 1 degrees of
freedom** rather than a normal z (`equivalentNormalZ`). At five cells the
two-sided 95 % point is 2.78, not 1.96; without the correction a Quick
session's five cells would be read with the authority of an asymptotic sample.

Measured over 200 seeds of the hardest honesty case — a noisy beginner whose
optimum sits at the ladder edge:

| | overclaims | refusals | range covers truth | mean confidence |
| --- | --- | --- | --- | --- |
| coincidental pairing (rc.7) | 53/200 (26.5 %) | 125/200 | 62/200 | 0.415 |
| **by construction + t (rc.8)** | **49/200 (24.5 %)** | **132/200** | **68/200** | **0.396** |

Every honesty indicator improved, and the mean point-estimate error fell from
0.221 to 0.212 octaves with a slightly *wider* range.

## Where this is enforced

| File | Holds |
| --- | --- |
| `src/experiments/sessionModes.ts` | the modes, their derivation, plan estimates, shortfall assessment |
| `src/experiments/protocol.ts` | `pairIndex`, nested allocation subsets |
| `src/session/runner.ts` | evidence-driven completion and the bounded replacement phase |
| `src/optimizer/confidence.ts` | `equivalentNormalZ`, the boundary confidence cap |
| `app/src/state.ts` | mode persistence and the label/plan reconciliation |
| `tests/sessionModes.test.ts`, `tests/pairedEvidence.test.ts` | all of the above |
