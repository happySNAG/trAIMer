# Metric definitions

All metrics are pure functions of a validated `TrialRecord`. Times are
milliseconds on the trial's monotonic clock (arbitrary origin; wall clock is
never used). Positions are viewport pixels, y-down.

Shared defaults live in `DEFAULT_FLICK_OPTIONS`, `DEFAULT_TRACKING_OPTIONS`,
`DEFAULT_VALIDATION_CONFIG`, `DEFAULT_DIMENSION_SCORING`. Every constant below
is named in code and listed here.

## Flick metrics (`computeFlickMetrics`)

Let `T` be the first target span, `tApp` its appearance time, `p0` the cursor
position at (or immediately before) `tApp`, `C(t)` the target center
(interpolated for moving targets), `d0 = |C(tApp) − p0|`, and `u` the unit
vector from `p0` toward `C(tApp)`.

- **Reaction time** `reactionTimeMs`: first sample at/after `tApp` whose
  displacement from `p0` reaches
  `max(onsetMinPx=1px, onsetDistanceFraction=0.02 · d0)`, minus `tApp`.
  Threshold-based onset has ± one sample-interval resolution by construction.
- **Arrival**: first sample after onset with `|cursor − C(t)| ≤ radiusPx`.
- **Movement time** `movementTimeMs`: acquisition end − tApp − reaction time,
  where acquisition end is the first post-onset shot time, else arrival, else
  target removal/trial end.
- **Total acquisition time** `totalAcquisitionTimeMs`: first post-onset shot
  (or arrival) − `tApp`; `null` if neither occurs.
- **Initial direction error** `initialDirectionErrorDeg`: angle between
  `(C(tApp) − p0)` and the displacement over the first
  `directionWindowMs=40ms` after onset.
- **Path length / efficiency**: sum of consecutive sample distances within
  `[tApp, acquisitionEnd]`; `pathEfficiency = clamp01(d0 / pathLength)`.
- **Peak axial progress**: max over the window of `(cursor − p0) · u`.
  - **Overshoot** `overshootPx = max(0, peakAxialProgress − d0)`;
    ratio normalized by `d0`.
  - **Undershoot** `undershootPx = max(0, d0 − peakAxialProgress)`.
  Both derive from peak axial progress, so they are mutually exclusive and
  describe position along the intended aim line (lateral misses surface as
  direction error + final error instead).
- **Correction count**: reversals of the radial-error derivative
  (`|e(tᵢ)−e(tᵢ₋₁)|` above `epsilon = radius · correctionEpsilonRadiusFraction
  / 10`) while instantaneous error exceeds `radius · 0.25`.
- **Correction distance** `correctionDistancePx = max(0, pathLength − d0)`
  (excess travel).
- **Final error**: at the primary shot — recorder-computed miss distance
  (0 when hit); otherwise cursor-to-center at window end. Also reported as
  `finalErrorRadiusRatio = finalError / radiusPx`.
- **Hit accuracy**: hits ÷ shots in the trial.
- **Target-switch latency** (`computeTargetSwitchLatency`): for each spawned
  target after the first, time from its appearance until displacement from the
  pre-spawn cursor crosses the same onset threshold. Reports raw list, mean,
  median, p90.

## Tracking metrics (`computeTrackingMetrics`)

Error series `eᵢ = |cursor(tᵢ) − C(tᵢ)|` over samples where the target exists.

- **Mean / median / RMS error**, plus **percentile errors** at configurable
  levels (default 50/75/90/95).
- **Time on target** `timeOnTargetRatio`: fraction of samples with
  `e ≤ radiusPx`.
- **Band ratios**: fraction within `k·radiusPx` for `bandMultiples=[1,2,3]`.
- **Tracking path efficiency**: `clamp01(targetPathLength / cursorPathLength)`
  — ≈1 means economical pursuit; excess cursor travel (jitter) reduces it.
  Meaningful only for pursuit-style scenarios; documented caveat: a perfectly
  still cursor while the target moves yields a high ratio but terrible error
  stats, so read it jointly with RMS/time-on-target.
- **Directional lag** `directionalLagMs`: lag τ in
  `[lagScanMinMs, lagScanMaxMs]=[-250,250]` minimizing mean
  `|cursor(t+τ) − C(t)|`, scanned at ~max(4ms, mean sample spacing) with linear
  interpolation of the cursor series. Resolution is bounded by scan step size.
- **Correction frequency**: radial-error sign reversals (same hysteresis rule
  as flick corrections) per second of tracked duration.
- **Loss / reacquisition events**: inside→outside and outside→inside radius
  transitions of the error series.

## Dimension scoring (optimizer inputs)

Raw metrics map to [0,1] dimension scores via `scoreTrialDimensions`
(`DimensionScoringConfig`):

| Dimension | Formula (flick trials) |
| --- | --- |
| speed | `exp(−max(0, acquisition − speedFloorMs) / speedTauMs)`, floor 200ms, τ=220ms — exponential discounting keeps real time differences visible |
| accuracy | hit: `1 − 0.5·min(1, finalError/radius)`; miss: `missAccuracyFloor=0.05` |
| overshootControl | `1 − clamp01(overshootRatio / 0.25)` |
| undershootControl | `1 − clamp01(undershootRatio / 0.25)` |
| correctionEfficiency | `clamp01((pathEfficiency − 0.55) / 0.45)` |

Tracking trials produce **trackingPrecision** =
`0.6·timeOnTarget + 0.4·clamp01(1 − rms/(radius·2))`.

Composite utility = weight-weighted mean over dimensions present
(`DEFAULT_UTILITY_WEIGHTS`: accuracy .28, speed .14, trackingPrecision .14,
correctionEfficiency .12, overshootControl .11, undershootControl .11,
consistency .10). Weights are data, not hidden judgment: they ship in every
`Recommendation.utilityWeights`.

## Validity reason codes

Fatal (excluded under default policy): `IMPOSSIBLE_TIMESTAMPS`,
`MISSING_TARGET_APPEARANCE`, `INSUFFICIENT_SAMPLES` (<10),
`LARGE_SAMPLE_GAP` (>250ms or >25× expected interval),
`IMPOSSIBLE_MOVEMENT` (>60 px/ms single-step or >768px jump),
`CONFIG_MISMATCH` (sensitivity/DPI differs from expectation).

Suspect (policy decides; default excludes): `FOCUS_LOSS`,
`CLICK_BEFORE_TARGET_APPEARANCE`, `TRIAL_TIMEOUT` (no-shot flicks).

`validateTrial` returns `{status, reasons[]}` and never mutates the record;
callers assign `record.validity` when persisting. Exclusions always increment
per-reason counters that surface in `Recommendation.evidence`.
