# Optimizer methodology

`SensitivityOptimizer` turns raw trials into a sensitivity recommendation with
quantified evidence. Design goals: no opaque single score, no false precision,
explicit refusal when evidence is thin, and a search strategy that can be
replaced without touching callers.

## Pipeline per evaluation pass

1. **Validation** — every incoming trial is validated (`validateTrial`) and the
   structured result is attached. Invalid trials under `fatalReasons` and
   suspects (default policy) are excluded from scoring but counted by reason.
2. **Scenario centering** — for each scenario, cross-candidate mean of each
   dimension is subtracted from each trial's dimension scores (clamped to
   [−1,1]). This removes scenario-difficulty effects from candidate comparisons
   while preserving between-candidate differences. Combined with paired
   geometry (same instances per candidate), comparisons are tightly controlled.
3. **Dimension estimates** — per candidate: mean/SE/sample-count per dimension.
4. **Composite utility** — weighted mean over dimensions present; SE propagated
   as `sqrt(Σ shareᵢ²·SEᵢ²)` assuming dimension independence (documented
   approximation).
5. **Consistency** — `clamp01(1 − CV)` of per-trial utilities within the larger
   scenario kind (flick vs tracking), avoiding cross-kind mixing.

## Search

**Stage 1** — geometric ladder around baseline (default factors ×1/1.35,
×1/1.15, ×1, ×1.15, ×1.35), block-randomized candidate order per round
(seed-controlled), warmups excluded from scoring.

**Stage 2+ (refinement rounds, up to `maxSearchRounds`)** — proposals:
- **Weighted quadratic surrogate**: utility ≈ a·x² + b·x + c over
  `x = log2(candidateEDPI / baselineEDPI)` with weights 1/SE². Covariance gives
  vertex SE and peak significance (|a/SE(a)| ≥ 2). Vertex proposed when it lies
  in (−0.45, +0.45) octaves off tested points.
- **Top-two midpoint**, when distinct enough (>0.03 octaves).
- **Boundary expansion** (±0.35 octaves beyond the tested edge) when the best
  candidate sits at an edge — the search can walk outward toward an optimum
  outside the initial span.

Proposals enter the experiment via `optimizer.addCandidates` (the orchestrator
amends the running definition; simulator and optimizer share the object).

## Recommendation

- **Best** = argmax mean utility. **Runner-up gap z** =
  Δu / sqrt(SE₁²+SE₂²) (Welch-style).
- **Tied set** = candidates whose 95% CI upper bound reaches the best's lower
  bound. Reported range = tied set's eDPI extent.
- **Boundary extension**: if the best sits at the tested edge, the range is
  extended half a ladder step outward with an explicit warning — evidence says
  "at least this far", not "exactly here".
- **Surrogate widening only**: when peak curvature is significant and the
  vertex lies inside the span, the vertex 95% CI is unioned into the range
  (clipped to safe limits). Development showed narrowing by the CI produced
  confident misses; the direction of adjustment is deliberately one-way.
- **Point estimate**: median of {weighted-fit vertex, unweighted-fit vertex,
  best candidate} clamped into the reported range — robust to single-fit
  pathologies on asymmetric plateaus.
- **Confidence** ∈ [0.05, 0.99]: base `2(Φ(|z|) − 0.5)`; +0.25 if significant
  interior peak; −0.15 any incomplete candidate; ≤0.45 if the *best* candidate
  lacks minimum valid trials; −0.10 boundary best; capped 0.65 when separation
  is weak; 0.15 floor when <3 candidates have data. Labels: <0.5 low,
  <0.8 moderate, else high. `refusedHighConfidence = confidence < 0.5`.
- **Separation labels**: `insufficient` (incomplete data / no gap), `weak`
  (|z| < 2 and no significant interior peak), `clear` otherwise.
- **Refusal path**: fewer than 3 evaluated candidates or below-minimum total
  valid trials yields the dedicated insufficient recommendation: wide range,
  confidence 0.15, explicit warning, no dimension claims.

## Evidence object

Every recommendation ships: analyzed/excluded trial counts, exclusion reason
histogram, per-candidate valid-trial counts, best/runner-up ids, utility gap +
z-score, separation label, rounds run, and notes (e.g. exclusions applied).

## What would change next passes

- Replace fixed weights with fitted/preference-elicited ones.
- GP/Bayesian optimization over (x, y) independently; adaptive rep allocation.
- Proper mixed-effects modeling (scenario as random effect) replacing additive
  centering; paired-difference inference using the shared-instance design.
- Confidence calibration against real-player test/retest data.
