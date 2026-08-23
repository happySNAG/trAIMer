# Statistics: paired repeated-measures inference (Pass 4)

## Model

For candidate `i`, scenario `c`, shared instance cell `(c, r)`:

```
u_ire = μ_i + s_c + b_(c,r) + ε_ire
```

- `μ_i` candidate effect (ranked),
- `s_c` scenario difficulty,
- `b_(c,r)` shared-instance effect per cell — identical across candidates by
  construction of the paired planner,
- `ε` within-cell noise.

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
