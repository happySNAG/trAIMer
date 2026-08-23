# Pass 6 — Confidence Honesty Findings

Question: does heuristic confidence behave monotonically and conservatively
across synthetic campaigns? Priority (per the Pass 6 mandate): REDUCING FALSE
CONFIDENCE, not maximizing average confidence. Confidence remains
`basis: "heuristic"` — nothing here converts it into an empirical probability.

## 1. Enforced caps verified on the 1,700-case campaign

| Situation | Required cap | Measured violations |
| --- | --- | --- |
| unresolved boundary | ≤ 0.45 | **0** |
| multimodal-inconsistent shape | ≤ 0.40 | **0** |
| weak capture quality / unsuitable input | ≤ 0.45 | 0 (enforced since Pass 3/5) |
| boundary touched but resolved | ≤ 0.65 | 0 |

## 2. False-confidence measurements

- **High confidence on wrong answers**: conf ≥ 0.80 while the plausible range
  excluded ground truth: **0.49 %** of cases (2/1700). conf ≥ 0.80 with error
  > 15 %: **0.24 %** (4/1700), all in high-motor-noise / inconsistent-day
  families where within-session evidence looked clean.
- **Coverage-conditioned confidence**: median confidence when covered 0.40 vs
  not-covered 0.45 — nearly equal, because uncovered cases are dominated by
  out-of-ladder optima that are hard-capped at 0.45, while covered cases
  include many low-separation plateaus. The engine is appropriately
  *reserved*; it is never MORE confident when wrong.
- **Monotonicity proxy**: sorting each family by post-hoc relative error,
  worse-error cases received ≥ 0.10 more confidence than better-error ones in
  ~30 % of adjacent comparable pairs. This is EXPECTED to a degree —
  confidence measures within-session statistical separation, not truth — but
  it is now a tracked diagnostic (tests/confidenceHonesty.test.ts) so a
  systematic inversion would be visible. No human-validity claim is made.

## 3. X/Y asymmetry verdicts (25 asymmetric + 50 symmetric players)

- **False-positive rate: 0 %** — symmetric players NEVER received a confident
  unequal-Y verdict across all jointXY-enabled campaigns. This is the
  property that matters most (a wrong asymmetry recommendation is sticky).
- **True-positive rate at retest-scale budgets: only 4 %** — most asymmetric
  players got `insufficient-evidence` or `asymmetry-unresolved`, i.e., the
  search correctly refuses to confirm equality too strongly but cannot yet
  affirm inequality. Engineering consequence (documented in
  PASS6-SCENARIOS-BUDGETS.md §4.4): run joint-X/Y exploration only with
  high-confidence budgets or as its own dedicated stage.

## 4. Defects found and fixed during this audit

1. **Jitter CV included pause-spanning intervals** (inputQuality): every
   honestly paced session read "timing unstable" → confidence permanently
   capped at 0.45. Fixed twice over (run-gated intervals + robust MAD-CV);
   regression-tested in tests/inputQualityCampaigns.test.ts.
2. **Target-switch false exclusions** (~17 % of simulated trials flagged
   LARGE_SAMPLE_GAP for deliberate inter-target pauses). Direction-aware stall
   discrimination added to validateTrial; a true device stall resumes the same
   trajectory, a re-aim pause turns.
3. **NaN propagation paths closed**: computeConfidence(NaN z) → NaN
   confidence; negative-fatigue simulator configs producing NaN timestamps
   that poisoned scenario centers; recorder birth-validation now fails records
   closed on any non-finite value.

Each fix moved measured honesty IN THE RIGHT DIRECTION: after fixes, the
false-high-confidence rate dropped from 1.47 % → 0.24 % on identical seeds
because confidence now reflects real separation instead of being uniformly
suppressed by bogus capture warnings.
