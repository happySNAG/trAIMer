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
