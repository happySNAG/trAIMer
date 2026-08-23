# Optimizer methodology (Pass 4 update)

## Search pipeline

```
trials → validate → paired cell utilities
      → pair contrasts (paired.ts)
      → contrast regression: candidate effects + SEs (pairedFit.ts)
      → curve adequacy analysis (adequacy.ts)
      → quadratic surrogate ONLY when geometry supports it
      → recommendation with result-type-appropriate output
```

## Model adequacy (non-quadratic safeguards)

`analyzeCurveAdequacy` classifies the tested (log2 eDPI, utility) geometry:

| Shape | Trigger | Result type |
| --- | --- | --- |
| insufficient | < 4 distinct positions | `insufficient` |
| multimodal-inconsistent | ≥ 2 separated local maxima | `inconsistent` |
| monotonic-boundary | strictly monotone means, or significant slope without significant curvature | `unresolved-boundary(direction)` |
| broad-plateau | neither curvature nor slope significant | `plateau` interval |
| single-smooth-optimum / asymmetric-optimum | significant concave curvature (t ≥ 2) | `point` at empirical argmax; vertex refinement allowed |

A naive parabola is demonstrably fooled by monotone and multimodal fixtures
(`tests/curveAdequacy.test.ts`); the optimizer only uses the fitted vertex
when `vertexUsable` is true, caps confidence at 0.4 on inconsistent evidence,
and forces `unresolvedBoundary` on boundary trends.

## Information-driven allocation

After balanced minimums, extra blocks are ranked by decision value
(`src/session/informationAllocation.ts`): near-tied contenders, peak
uncertainty, unresolved boundaries (edge candidates), suspected asymmetry
(neighbors), joint-X/Y participants. Dominated candidates get periodic
controls only. Every request carries a machine-readable reason into the audit
log; decisions are pure functions of observations.

## Formal change-point adaptation

`src/optimizer/changepoint.ts` scans a single best split by pooled SSE with a
BIC-style penalty, then classifies:

- warmup-learning (early worse, step up in first half),
- abrupt-degradation (significant Welch-z drop),
- temporary-collapse (down-step plus significant later recovery),
- fatigue-slope (gradual negative trend without a dominant jump),
- stable / insufficient-data.

Per-candidate contamination flags mark comparisons that early-learning can
bias, and recommended actions (extra warmup / rest / re-exposure /
downweighting / exclusion) are surfaced on the recommendation. Raw trials are
never modified.

## Session capture-quality gating

The robust session summary (`src/diagnostics/captureQuality.ts`) — median
per-trial quality, drop fraction, lock/resize totals, degradation slope +
late-half median comparison, source transitions, high-quality trial fraction —
feeds confidence: `retestingNecessary` sessions cap confidence at 0.45 and
force the further-testing suggestion. A single bad trial dents the score but
cannot flip the verdict unless interruptions are widespread (>25% of trials).

## Experiment duration policy

`evaluateBudgetDecision` (`src/experiments/budget.ts`) implements:
early stop when separation is clear AND shape is honest AND nothing is open;
continue reasons (tied contenders, unresolved boundary, weak capture,
adaptation contamination, below minimum); hard defer-to-next-session at wall
clock/fatigue caps. Defaults (`DEFAULT_SESSION_BUDGET`) were chosen from the
duration campaigns in `tests/budgetEarlyStop.test.ts`: ~40–80 measured trials
covers most geometries; beyond that, marginal information drops sharply while
fatigue risk grows.
