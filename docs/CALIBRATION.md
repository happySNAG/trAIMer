# Fortnite calibration workflow

## Goal

Convert observed mouse counts over a *known rotation angle* into
`CalibrationParameters.degreesPerCountAt100X/Y`, unlocking cm/360 and angular
units. No game integration: the procedure is entirely external and manual.

## Procedure (in-app Calibration tab)

1. In Fortnite, aim at a fixed landmark.
2. Choose a method:
   - **Full rotation** — rotate exactly `θ = 360°` (or k×360°) returning to the
     same landmark; θ is known by construction.
   - **Landmark angle** — rotate between two landmarks whose angular
     separation you know and enter as θ.
3. Press **Start rep**, perform the rotation, press **Stop rep**. The app sums
   raw pointer-lock deltas for that rep (`counts`).
4. Repeat ≥ 4 times (6 recommended).

## Math

Per repetition, with in-game X sensitivity `p` (%):

```
deg/count@100% = θ / (counts × p/100)
```

- Repetitions whose deg/count deviates from the **median by more than 2.5 MAD**
  are flagged rejected (raw values retained, never deleted).
- Retained mean ± 95 % CI (normal approximation, n ≥ 4) is reported.
- Adequacy gates: retained samples ≥ 4 AND CV ≤ 15 %. Inadequate data is
  stored with `adequate: false`, an explicit reason list, and **never**
  produces calibration parameters.
- Both axes must be adequate; `calibrationParametersFromRecords(xRecord,
  yRecord)` merges them into the existing `CalibrationParameters` interface.

Downstream, once calibrated: `physicalCmPer360(params, dpi, axis,
sensPercent)` yields true cm/360 at the player's sensitivity (Pass 2 adds the
sensPercent argument — cm/360 depends on the actual in-game sens, not the 100 %
constant).

## Storage

Calibration records persist under kind `calibration-record` with version,
method, raw measurements incl. rejection flags/reasons, derived statistics and
adequacy — schema-versioned like every other artifact.

## Boundaries

The application does not read game memory, inject code, automate input to the
game, modify game files, or interact with anti-cheat systems. It observes the
user's own mouse only.

## Pass 4 hardening

- **Multi-turn measurements**: a rep may perform 2×/3×/5× full rotations
  (`turns` field); total rotation scales accordingly, reducing endpoint
  error per rep.
- **Median/MAD robust fitting** (default estimator): center = median of
  retained reps, spread via MAD (σ̂ ≈ 1.4826·MAD), SE of median ≈ 1.2533·σ̂/√n,
  95% CI reported. Outliers beyond 2.5 MAD stay in the record, flagged.
- **Quality score** ∈ [0,1] from consistency + retention; inadequate records
  cap at 0.35 and never yield parameters.
- **Consistency view contract** (`buildConsistencyView`): per-rep values with
  rejection flags plus median/MAD/robust-CV/spread-band for visualization —
  no statistics in UI code.
- **Staleness detection** (`src/calibration/staleness.ts`): a record is STALE
  when DPI changed, device identity changed materially, the capture source
  class switched native↔browser, or calibration-relevant settings changed.
  Old records are never deleted; history lists them with adequacy flags
  (History tab).
