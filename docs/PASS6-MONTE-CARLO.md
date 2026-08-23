# Pass 6 — Monte Carlo Campaign Methodology

Status: engineering documentation for the Pass 6 hardening pass. All numbers
below describe **engine behavior on synthetic players**. They make no claims
about human players; human calibration remains the explicit post-hardware
workstream (docs/HUMAN-VALIDATION.md).

## 1. What was built

- `src/campaigns/playerFamilies.ts` — 17 deterministic player families, each a
  pure function of an integer seed (same seed ⇒ byte-identical parameters):
  clean-unimodal, broad-plateau, asymmetric-curve, skewed-optimum,
  boundary-optimum, outside-ladder, high/low-motor-noise, reaction-heavy,
  precision-heavy, tracking-heavy, fatigue, warming, collapse-drift,
  inconsistent-day, false-xy-asymmetry, real-xy-asymmetry.
- `src/campaigns/runner.ts` — executes full
  simulate → validate → score → optimize → budget-decide pipelines,
  INCLUDING the real refinement/boundary-expansion loop between rounds.
  Optional staged joint-X/Y exploration.
- `src/campaigns/metrics.ts` — population aggregation: error distributions,
  coverage, boundary correctness, plateau detection, false-high-confidence,
  confidence monotonicity proxy, X/Y verdict scoring.
- `scripts/campaigns/*.ts` — deterministic drivers that emit sorted-key JSON.

## 2. Ground-truth definition

The engine is scored against the **Monte-Carlo composite optimum**: a dense
9-point ladder (×1/2.2 … ×2.2 around baseline) measured with MORE data
(14 reps) than the evaluated session, reduced by the same utility definition.
This is strictly better-informed than the engine under test and sidesteps the
Pass-1 finding that the physics parameter (`trueOptimalEdpi`) differs from the
utility argmax by a small systematic offset.

## 3. Population run

`docs/pass6-data/monte-carlo-main.json`: **1,700 cases** = 17 families ×
100 seeds (seeds `1000·k + familyIndex`, k=1..100), protocol reps 6 × 2 rounds
on the canonical five-scenario mix at 120 Hz simulation.

## 4. Headline results

| Metric | Value |
| --- | --- |
| Median relative error | 5.6 % |
| p90 relative error | 18.5 % |
| Error ≤10 % / ≤15 % / ≤25 % | 76 % / 85 % / 95 % of cases |
| Truth covered by plausible range | 92.1 % |
| Boundary-optima handled honestly (refuse confident claim) | 98.1 % |
| False unresolved-boundary flags (truth inside span, conf > 0.7) | 0 % |
| Plateau families detected as plateau/wide-range | 100 % |
| False HIGH confidence (conf ≥ 0.80 AND error > 15 %) | 0.24 % (4/1700) |
| High-confidence share overall | 9.5 % |
| Mean measured trials per case | 70.1 |
| Mean estimated active time | ~380 s (~6.3 min) |

By-family medians (relative error): precision-heavy 2.8 %, low-noise 4.6 %,
clean-unimodal 4.5 %, tracking-heavy 5.4 % … high-noise 7.7 %,
real-XY-asymmetry 6.1 %. The two hardest populations are structural:
outside-ladder optima (27.3 % median error, but ALWAYS honest: conf ≤ 0.45,
retest recommended in 100 % of cases) and boundary optima (8.9 % median,
92 % covered, never confidently wrong).

## 5. Known simulator limitations (honesty notes)

- The physics simulator produces a **unimodal** sensitivity response by
  construction. TRUE bimodal/multimodal response is not representable;
  multimodal refusal correctness is therefore exercised by constructed-
  evidence suites (tests/curveAdequacy.test.ts) and noisy families. Documented
  rather than papered over.
- Warming is modeled as negative per-trial fatigue (bounded to ±[−100, +150]
  ms after the Pass 6 NaN fix); "sudden collapse" is approximated with steep
  late-session drift, not an actual discontinuity.
- Campaign early-stop evaluation checks evidence-based criteria only
  (wall-clock/fatigue timers are not simulated).
