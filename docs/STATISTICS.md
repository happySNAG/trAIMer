# Statistics: paired-instance inference

## Model

For candidate `i`, scenario `c`, shared instance `r` (the r-th measured trial
of scenario `c`, identical geometry for every candidate), the observed utility
decomposes as:

```
u_ire = μ_i + s_c + b_r + ε_ire
```

- `μ_i` — the between-candidate effect we want to rank,
- `s_c` — scenario difficulty (static vs small vs tracking …),
- `b_r` — the *shared instance* effect (that particular target placement was
  hard), identical across candidates by construction of the paired planner,
- `ε_ire` — within-player trial noise.

## Estimator: paired differences over cells

A *cell* is `(scenarioId, scenarioRepIndex)`. For candidates `i` and `j`,
every shared cell contributes one difference:

```
d_cell = ū_i(cell) − ū_j(cell)
```

(averaging across search rounds within a cell first). Under the model above,
`s_c` and `b_r` cancel exactly; the mean and standard error of `d` identify
`μ_i − μ_j` uncontaminated by instance or scenario effects.

This replaces Pass 1's additive scenario-centering as the primary comparison
device (`src/optimizer/paired.ts`). Centering remains only as a fallback for
candidate pairs with fewer than 3 shared cells, where pairing is undefined.

## Multiplicity control

Pairwise "significantly worse than best" decisions are made with a
Dunnett-style adjusted threshold: exclude a candidate from the tied set only
when `z > z*` with `z* = Φ⁻¹(1 − α/(K−1))`, `α = 0.05`, `K` = number of
evaluated candidates. Without this, high-powered paired comparisons produced
false exclusions on flat plateaus in development (a Pass 1 blind case began
failing when raw `z > −1.96` was used).

## Composite utility

Unchanged from Pass 1 (`docs/METRICS.md`): weighted mean of dimension scores
present, weights shipped in every recommendation. The surrogate fit (weighted
quadratic in log2-eDPI space) still consumes the centered per-candidate means;
pairing governs pairwise gap/tie decisions.

## Assumptions and limits

- Pairing assumes instances are truly shared — guaranteed by construction for
  measured trials seeded identically across candidates.
- Cell averaging treats rounds as exchangeable; fatigue drift within a session
  can bias later rounds equally for all candidates (they are interleaved), so
  the paired contrast stays fair even when absolute utilities drift.
- SEs are normal-approximation based; with ≥6 paired cells this is adequate
  for the ranking decisions made. No precision beyond the reported CIs is
  claimed anywhere.
