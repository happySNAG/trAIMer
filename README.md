# Aldo Aim Lab

A Fortnite-focused aim measurement and sensitivity optimization engine.
This repository currently contains the **headless core**: domain model,
measurement pipeline, metrics, deterministic synthetic-player simulator,
evidence-based optimizer, persistence, tests, and a developer CLI.
The production visual UI is intentionally out of scope for this pass and will
be owned separately; everything here runs without it.

## Quickstart

```bash
npm install
npm test        # full suite (93 tests, ~70s; blind-recovery suite dominates)
npm run lint    # eslint
npm run typecheck
npm run demo    # simulate a player, optimize, then reveal the hidden optimum
```

Calibrated demonstration (also estimates the simulator's true composite
optimum via Monte Carlo and prints the error against it):

```bash
npm run demo -- --seed 42 --hidden-edpi 4200 --preset deliberate-slow --calibrate
```

## What Pass 1 delivers

- **Versioned domain model** for players, mice, Fortnite settings, sessions,
  experiments, trials (raw pointer samples + target states + shots), candidates,
  evaluations, recommendations, and structured trial-validity results.
- **Sensitivity math** (`src/sensmath`): eDPI (Fortnite convention: DPI × X%),
  normalized/log comparisons, bounded candidate ladders. The mouse-count →
  camera-rotation transform is an explicit **calibration parameter**
  (`UNCALIBRATED` by default); no invented engine constants.
- **High-resolution measurement pipeline**: capture-source abstraction +
  `TrialRecorder` that turns monotonic-timestamped event streams into raw
  `TrialRecord`s. Browser pointer-lock and future native capture plug in behind
  `CaptureSource`; the analytics never see the difference.
- **Deterministic flick & tracking analytics** over raw trajectories
  (reaction/movement/acquisition times, direction error, path efficiency,
  overshoot/undershoot, corrections, final error; tracking error stats,
  time-on-target bands, directional lag, loss/reacquisition).
- **Trial validity system** with reason codes (impossible timestamps, missing
  targets, pre-appearance clicks, insufficient samples, focus loss, sample
  gaps, impossible movement, timeouts, config mismatch). Bad data is never
  silently dropped; exclusions are counted and reported.
- **Seeded synthetic-player simulator** producing full raw trial streams
  through the same recorder real input would use. Same seed ⇒ identical data.
  The hidden optimum is never exposed to the optimizer.
- **Evidence-based optimizer**: dimension-preserving scoring, scenario-centered
  comparisons, weighted quadratic surrogate in log2-eDPI space with uncertainty,
  refinement + boundary-expansion proposals, statistically justified ranges,
  explicit confidence, and a refusal path when evidence is insufficient.
- **Local-first JSON persistence** with versioned envelopes and a migration
  registry (a v0→v1 trial migration ships as the worked example).
- **Blind recovery tests**: synthetic players with known hidden optima are
  simulated, optimized against observations only, and the recovered point/range
  is asserted against a Monte-Carlo-measured composite optimum.

## Repository layout

```
src/
  domain/      canonical types & versioned schema envelope
  capture/     clock, event types, TrialRecorder (source-agnostic)
  sensmath/    eDPI/comparisons/candidate ladders/calibration boundary
  metrics/     stats helpers, flick + tracking analytics
  validation/  structured trial validation
  experiments/ machine-readable protocol builder + randomized/paired ordering
  sim/         seeded RNG-free zone: player model, submovements, runner, calibration harness
  optimizer/   scoring, evaluation, surrogate fit, confidence, search loop
  persistence/ envelope wrap/unwrap, migrations, LocalJsonStore
  demo/        CLI demonstration
tests/         unit + integration + blind-recovery suites
docs/          architecture, metric definitions, optimizer & simulator methodology
```

See `docs/ARCHITECTURE.md` for the design tour and decision record,
`docs/METRICS.md` for exact metric definitions and constants,
`docs/OPTIMIZER.md` and `docs/SIMULATOR.md` for methodology,
and `docs/PERSISTENCE.md` for storage formats.

## Initial player context (configurable, not hard-coded)

Player: Aldo · Game: Fortnite · Mouse: Logitech Lightspeed wireless ·
DPI: 800 · Preference: medium sensitivity (`ALDO_INITIAL_PROFILE`,
`DEFAULT_MOUSE_CONFIGURATION`, `ALDO_BASELINE_SETTINGS` in `src/domain`).
DPI, baseline sensitivity, and player identity are inputs everywhere;
nothing in the engine special-cases them.

## Engineering standards

No telemetry, no network use, no secrets. Deterministic tests. Typed public
interfaces. Every constant that affects results is named, defaulted in one
place, and documented in `docs/`. No fabricated precision: when evidence only
supports a range, the API returns a range plus confidence.
