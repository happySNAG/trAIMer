# Pass 6 — Scenario Information Analysis & Trial Budgets

All results are synthetic-population measurements (see PASS6-MONTE-CARLO.md
for methodology). Data: `docs/pass6-data/scenario-ablation.json` and
`docs/pass6-data/budget-comparison.json`.

## 1. Scenario ablation

Population: 8 sensitivity-relevant families × 14 seeds per arm; each arm runs
the full optimize loop with the named scenario subset. Reference arm "all" =
canonical five-scenario mix.

| Arm | Median rel-err | p90 | Coverage | Trials | Est. seconds |
| --- | --- | --- | --- | --- | --- |
| all (5 scenarios) | 5.1 % | 14.5 % | 98 % | 69 | 374 |
| without flick-static-medium | 4.9 % | 14.5 % | 96 % | 69 | 400 |
| without flick-static-small | 4.5 % | 18.5 % | 99 % | 69 | 402 |
| without flick-dynamic-horizontal | 5.5 % | 11.8 % | 96 % | 70 | 405 |
| without target-switch-triple | 6.0 % | 12.9 % | 99 % | 72 | 378 |
| **without tracking-smooth-sine** | 4.6 % | 11.8 % | 99 % | 69 | **294** |
| only flick-static-medium | 5.2 % | 11.8 % | 100 % | 72 | 271 |
| only flick-static-small | 5.0 % | 9.7 % | 100 % | 71 | 271 |
| only flick-dynamic-horizontal | 15.6 % | 39.9 % | 100 % | 70 | 262 |
| only target-switch-triple | 4.4 % | 12.1 % | 100 % | 62 | 363 |
| **only tracking-smooth-sine** | **37.7 %** | 84.8 % | 100 % | 74 | **744** |
| realloc-flick-weighted (3 flick scenarios) | 5.0 % | 12.0 % | 97 % | 72 | 270 |

## 2. Findings

1. **Tracking is the weakest sensitivity discriminator and the most
   expensive** — consistent with the Pass 3 difficulty metadata. Tracking-only
   sessions recover the optimum barely better than chance (37.7 % median
   error) while costing ~2× the active time of any flick scenario.
2. Removing tracking slightly IMPROVES median accuracy (5.1 % → 4.6 %) and
   saves ~80 s: its equal allocation buys jitter/lag diagnostics, not
   discrimination.
3. Small-target flick alone matches the full protocol's accuracy at ~28 % less
   time — it remains the single strongest discriminator.
4. flick-dynamic-horizontal is weak ALONE but removing it does not help either:
   its information partially overlaps the static flicks (moving-target lead),
   so it earns a reduced-but-nonzero share.

## 3. Budget comparison (reps × rounds)

Population: 10 families × 16 seeds per arm.

| Policy | Trials | Est. sec | Median err | p90 | Coverage | High-conf | False-HC |
| --- | --- | --- | --- | --- | --- | --- | --- |
| short (4×2) | 46 | 326 | 5.9 % | 17.2 % | 96 % | 9 % | 0 % |
| standard (6×2) | 70 | 378 | 5.4 % | 14.7 % | 94 % | 6 % | 0 % |
| high-confidence (8×3) | 147 | 665 | 4.5 % | 15.8 % | 97 % | 15 % | 0.63 % |
| retest-style (4×1) | 19 | 126 | 7.0 % | 21.4 % | 95 % | 20 %* | 0 % |

*retest-style's high-confidence share comes from tiny-sample z-scores on one
round; its coverage stays honest (95 %), which matters more.

## 4. Evidence-based recommendations for V1 defaults (PROVISIONAL)

These are engineering recommendations from simulation ONLY. The frozen V1 RC
defaults stay unchanged for comparability until Aldo human data exists;
any change must be re-run through this campaign suite first.

1. **Keep the standard budget as the default session shape** (~70 measured
   trials). Going shorter costs measurable accuracy; going longer
   (high-confidence, 147 trials) doubles session time for a 1-point median
   gain AND produced the campaign's only false-high-confidence cases — prefer
   a follow-up targeted retest over one marathon session.
2. **Reduce tracking's allocation rather than deleting it** (consistent with
   the mandate). A defensible reallocation: tracking keeps ONE rep per
   candidate block as a capture-quality/jitter probe while freed trials go to
   flick-static-small / target-switch-triple. Simulated effect: full-protocol
   accuracy at ~25–30 % less wall-clock.
3. **Targeted retests are extremely trial-efficient** (~19 trials, ~2 min):
   they confirm or refute an existing range cheaply. This validates the Pass 5
   retest-loop design of narrowing to half-step resolution instead of
   repeating full ladders.
4. **Joint X/Y exploration needs its own budget**: at retest-scale data the
   staged Y-search is honest but underpowered (TPR 4 %, FPR 0 % — see
   docs/PASS6-CONFIDENCE.md). Run jointXY in high-confidence sessions or as a
   dedicated stage, never as an afterthought appended to a short session.
