# Statistics: paired repeated-measures inference (Pass 4)

## Model

For candidate `i`, scenario `c`, shared instance cell `(c, r)`:

```
u_ire = μ_i + s_c + b_(c,r) + ε_ire
```

- `μ_i` candidate effect (ranked),
- `s_c` scenario difficulty,
- `b_(c,r)` shared-instance effect per cell — identical across candidates by
  construction of the paired planner. **This was the documented model from
  Pass 4 onward, but the planner did not actually deliver it until Pass 14**;
  see below.
- `ε` within-cell noise.

## Pairing is a property of the plan (Pass 14)

The paired model cancels scenario and instance effects by comparing two
candidates on the same cell, `scenarioId#pairIndex`. Until Pass 14 that index
was a per-candidate running counter, so two candidates shared a cell only when
their independently shuffled block orders happened to agree.

Measured over 200 seeds with the standard five-candidate ladder: **20–25 % of
cells paired**, and in a 5-rep block the average candidate PAIR shared **one**
cell — some shared none. The paired comparison was running at roughly a
quarter of its design power, and the shorter the session, the worse it got.

`TrialPlanSpec.pairIndex` is now the occurrence number of a scenario within a
candidate's block, offset by the round. Every candidate in a round draws the
identical multiset, so every occurrence has a partner **by construction**
(100 % in every mode). A reduced adaptive allocation takes a *nested* prefix of
the shared draw rather than a random subset, so a candidate playing fewer reps
still pairs on every cell it does play. Only the **order** varies per
candidate, so order effects remain unconfounded, and the instance seed
`{experimentSeed, round, scenarioId, pairIndex}` now gives both candidates in a
cell the identical target layout.

### The small-sample correction that came with it

With pairing working, the paired path became the normal case at 5, 8 or 16
cells. `mean / SE` over *n* paired cells is a **t statistic on n − 1 degrees of
freedom**, not a normal z: at five cells the two-sided 95 % point is 2.78, not
1.96. `equivalentNormalZ(t, df)` (`src/optimizer/confidence.ts`) converts it
before it reaches the confidence model, via an exact Student-t CDF
(regularized incomplete beta, Lentz continued fraction). Without it a Quick
session's five cells would be read with the authority of an asymptotic sample.

### An unresolved boundary caps confidence

When the winning candidate sits at the edge of the tested ladder, the true
optimum may lie outside everything measured, and no amount of separation
*inside* the tested range is evidence about what is outside it. Pass 14
replaces the flat −0.1 deduction with a hard cap at
`BOUNDARY_CONFIDENCE_CAP` = 0.45 — the same cap already applied when the best
candidate is under-powered, for the same reason.

### Measured effect

Over 200 seeds of the hardest honesty case (a noisy beginner whose optimum sits
at the ladder edge):

| | overclaims | refusals | range covers truth | mean confidence | mean point error |
| --- | --- | --- | --- | --- | --- |
| coincidental pairing (rc.7) | 53/200 (26.5 %) | 125/200 | 62/200 | 0.415 | 0.221 oct |
| by construction + t + cap (rc.8) | **49/200 (24.5 %)** | **132/200** | **68/200** | **0.396** | **0.212 oct** |

Every honesty indicator improved, with a slightly wider range and a more
accurate point estimate. Blind recovery held at 29–30/30 per case over seeds
101–130, never worse than the baseline it replaced.


## Estimator

1. **Pair contrasts.** For every candidate pair `(i, j)`, each shared cell
   contributes `d_k = ū_ik − ū_jk`; pooled as `d̂_ij` with variance
   `v_ij = s²_d / K` (`src/optimizer/paired.ts`). Scenario and instance
   effects cancel EXACTLY inside every difference.

2. **Contrast regression.** Candidate effects are recovered from the weighted
   system (`src/optimizer/pairedFit.ts`)

   ```
   minimize Σ_{i<j} w_ij · ( (α_i − α_j) − d̂_ij )²     s.t. α_ref = 0,
   w_ij = 1/v_ij        (heteroskedastic)
   ```

   solved by coordinate descent on the pinned Laplacian system. This replaces
   ALL remaining scenario-centering approximations in the surrogate path:
   `fitQuadraticWeighted` now consumes paired effects with weights
   `1/SE(α̂)²` whenever the paired system is solvable (≥3 connected
   candidates). Sparse data falls back to pooled means explicitly
   (`basis: "pooled"` in diagnostics).

3. **Uncertainty.** `Var(α̂) ≈ cycleFactor · (AᵀWA)⁻¹_diag`; exact for tree
   graphs, mildly optimistic on dense cycles (documented approximation).
   SEs of pair differences remain normal-approximation based (adequate for
   K ≥ 3 cells).

4. **Scenario effects** `s_c` are reported separately for explanations only;
   they cannot re-enter rankings because effects are estimated purely from
   within-pair differences.

## Multiplicity control

Unchanged: Dunnett-adjusted exclusion threshold `z* = Φ⁻¹(1 − α/(K−1))`
governs tied-set membership.

## Assumptions and limits

- Instances truly shared across candidates (guaranteed by planner seeds).
- Cell averaging treats rounds as exchangeable; interleaving keeps fatigue
  drift common-mode so contrasts stay fair.
- The covariance approximation is exact on trees; dense candidate graphs get
  a documented safety inflation.
- With < 3 connectable candidates the paired system is refused (explicit
  null), never silently replaced by an inferior estimator without labeling.

## Joint X/Y model

The sparse joint search adds a small surface fit over ALL measured candidates
(`src/optimizer/jointXY.ts`):

```
u = β0 + βx·x + βy·y + βxy·x·y      x = log2 eDPI offset, y = log2(Y/X)
```

weighted by per-candidate SEs; the interaction column is ridge-regularized
because the design is deliberately sparse (never a grid). Decision policy:
unequal Y is recommended ONLY at paired |z| ≥ minImprovementZ (default 2);
noisy false asymmetry therefore resolves to equality/unresolved. Separate
plausible ranges are returned for X and Y.
