# Simulator methodology

The simulator exists to prove the measurement + optimizer pipeline
end-to-end. It synthesizes **raw trial data** (240 Hz pointer samples, target
spans, button events) through the same `TrialRecorder` a browser capture would
feed, so every analytic downstream runs unmodified.

Honesty note: the player model is a *heuristic motor-performance model*, not a
validated human model. Its constants were chosen to produce human-plausible,
sensitivity-dependent behavior with an identifiable optimum — they are not
claims about neuro-motor physiology, and no citation is implied.

## Seeding & determinism

- RNG: mulberry32 (32-bit, well-characterized, fast); Gaussian via Box–Muller;
  lognormal via exp(normal). `Rng` and `combineSeeds` in `src/util/rng.ts`.
- Trial seeds derive from `(sessionSeed, round, scenarioHash, measuredIndex)`
  for measured trials — so **every candidate faces identical instance
  geometry** within a round (paired design), while warmups use sequence-based
  seeds. Same inputs ⇒ bit-identical output; verified by tests.
- The hidden optimum lives only inside the player config held by the runner.
  It never appears in trial payloads or optimizer inputs (tested).

## Sensitivity response

Let `r = candidateEDPI / trueOptimalEDPI` and `x = log2(r)`.

**Flick trial synthesis** (`#flickToTarget`):

1. Reaction: lognormal(`reactionMedianMs=210`, σ=0.2), clamped [80, 650] ms;
   independent of sensitivity; fatigue adds `fatiguePerTrialMs · index`
   (clamped ≤150 ms).
2. Cursor speed: `v = referenceFlickSpeedPxPerMs(4.2 px/ms) · r^0.88`,
   clamped to [0.35, 14]. Lower sens ⇒ proportionally slower screen travel.
3. Amplitude error (the core mechanism):
   - `x < 0`: factor `1 − undershootGain(0.46)·|x|^amplitudeExponent(1.0)`
   - `x > 0`: factor `1 + overshootGain(0.45)·|x|^1.0`
   - clamped [0.5, 1.9], then multiplied by
     `exp(N(0, amplitudeNoiseBase(0.035) + 0.09·(1−flickSkill) + 0.03·|x|))`.
   Linear-in-octaves gain means ±15% sens error produces ~6% endpoint error
   before corrections — enough for small targets to expose it.
4. Movement: smoothed-step submovement over `max(40, executedDist / v)` ms with
   per-sample tremor `motorNoisePx(1.2)·trialNoiseScale·(1 + 2.5·max(0,x)²)`.
   Moving targets are intercepted at predicted arrival time.
5. Corrections: up to `1 + round(3·(1−correctionSkill))` strokes, each reducing
   remaining error by `reduceFactor = (0.55 + 0.42·skill)·max(0.25, 1 − 0.5x²)`
   plus noise `motorNoisePx·(1.7 − 1.15·skill)·(1 + 2.5x²)`. Correction
   effectiveness degrades quadratically away from optimal sens.
6. Trigger: settle 20–60 ms + lognormal trigger delay (~70 ms). Hit is decided
   geometrically by the recorder (cursor within radius at shot time).
7. Per-target budget from scenario timeout; exceeding it aborts without a shot
   (timeout outcome).

**Tracking trial**: target follows a Lissajous path (periods ≈2.1/3.4 s).
Cursor pursuit uses first-order lag `kp = clamp(16 · r^0.45, 2, 26)` s⁻¹ with
per-sample noise `6px · (2.2 − 1.65·trackingSkill) · (1 + 2.2·max(0,x)² +
1.6·max(0,−x)²)`. Low-skill players receive periodic distraction impulses
(probability scaled by skill) producing loss/reacquisition events.

## Scenario set (`CORE_SCENARIOS`, viewport 1280×720)

| Scenario | Timeout | Radius | Notes |
| --- | --- | --- | --- |
| flick-static-medium | 900 ms | 26 px | distances 220–620 px |
| flick-static-small | 1000 ms | 16 px | distances 260–640 px |
| flick-dynamic-horizontal | 2000 ms | 24 px | full-window sweep across the centre, 260–480 px/s |
| target-switch-triple | 3800 ms total | 24 px | 3 sequential targets, 1100 ms each |
| tracking-smooth-sine | 6000 ms | 30 px | Lissajous path |

Timeouts are deliberately tight (target-lifetime style protocols): with a
generous timeout even badly mismatched sensitivities complete accurately, and
the composite utility loses its peak.

## Composite optimum vs nominal knob

`trueOptimalEdpi` nulls the *amplitude-error* response. The *composite*
utility (speed, accuracy, control dimensions weighted as documented in
`docs/OPTIMIZER.md`) peaks where those trade off — typically slightly off the
nominal value because e.g. the speed dimension keeps improving with higher
sens while accuracy degrades symmetrically. This is realistic and intentional:
a real player's best sensitivity balances more than endpoint error.

Consequences:

- Blind-recovery tests assert against `estimateCompositeOptimumEdpi`
  (`src/sim/calibrate.ts`): a Monte-Carlo calibration that measures each
  candidate's mean utility on a 9-point ladder (16 reps × 3 rounds) through the
  exact production scoring stack, then refines with the same weighted quadratic
  surrogate the optimizer uses (falling back to the raw best grid point when
  the fit is unstable).
- The demo's `--calibrate` flag runs the same harness and prints both errors:
  recommendation vs nominal knob, and vs measured composite optimum.

## Presets

`consistent-medium` (default Aldo-like), `jittery-fast` (fast reactions, high
motor noise, weak correction), `deliberate-slow` (slow, precise, strong
correction), `noisy-beginner` (high variance everywhere). All parameters are
overridable; nothing is special-cased around "Aldo".
