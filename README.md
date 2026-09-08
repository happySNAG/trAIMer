# trAIMer

**Train. Measure. Tune.**

An aim measurement and sensitivity optimization engine. The measurement core
is game-agnostic: it measures physical mouse performance and reports a physical
sensitivity. A separate, versioned **game-profile layer** translates that into
the numbers a specific FPS accepts — see `docs/GAME-PROFILES.md`.
This repository currently contains the **headless core**: domain model,
measurement pipeline, metrics, deterministic synthetic-player simulator,
evidence-based optimizer, persistence, tests, and a developer CLI.
The production visual UI is intentionally out of scope for this pass and will
be owned separately; everything here runs without it.

## Quickstart

```bash
npm install
npm test            # engine suite (300+ tests incl. blind-recovery campaigns)
npm run lint        # eslint
npm run typecheck
npm run bench       # performance benchmark (1000 Hz ingest, optimizer)
npm run demo        # simulate a player, optimize, then reveal the hidden optimum
npm run app         # real-input browser aim lab → http://localhost:5173
npm run build       # production browser bundle → dist-app/
npm run test:browser  # Playwright end-to-end suite (starts vite automatically)
npm run desktop     # run the Windows desktop shell locally (Electron)
npm run dist:win    # build trAIMer-Setup.exe (Windows host / CI)
```

## Shipping on Windows

Players get **one installer**: `trAIMer-Setup.exe`. It installs an Electron
desktop shell that owns the app window, serves the built frontend from a
stable `aldo://app` origin, and starts/stops the native Raw Input helper
automatically. No PowerShell, no terminal, no browser step, no compiler, no
admin rights.

- Player instructions: `docs/INSTALL-WINDOWS.md`
- Architecture and release gates: `docs/DESKTOP-SHELL.md`
- Packaging paths: `docs/PACKAGING-WINDOWS.md`

The installer is built by the `windows-installer` job in
`.github/workflows/ci.yml`, which refuses to publish unless the bundled helper
is a genuine Windows x64 PE that actually executes and the installed
application passes a startup + clean-shutdown smoke test.

## Pass 4 headline capabilities

- **Native high-rate capture (Windows)**: Raw Input helper over a local-only
  versioned transport — 125–1000+ Hz raw counts, buttons, device metadata,
  drop/jitter diagnostics (`docs/NATIVE-CAPTURE.md`). Browser coalesced
  capture remains an explicit, negotiated fallback.
- **Production recovery**: every trial is checkpointed with a pending marker;
  sessions resume exactly, interrupted trials invalidate with audit metadata
  (`docs/RESUME.md`).
- **Honest statistics**: fully paired repeated-measures fit, curve-shape
  adequacy gating (plateaus/boundaries/multimodal refuse precise optima),
  formal change-point adaptation detection, restrained joint X/Y search
  (`docs/OPTIMIZER.md`, `docs/STATISTICS.md`).
- **History, calibration staleness, typed errors, local diagnostic bundles**:
  see `docs/HISTORY.md` pointers in the History tab, `docs/CALIBRATION.md`,
  `docs/FAILURE-MODEL.md`.

See `docs/MANUAL-TEST.md` for the human smoke-test checklist for the browser app,
and `docs/HUMAN-VALIDATION.md` for the repeated-session protocol used to
produce trustworthy recommendations.

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
  games/       game-profile schema, registry, validation, canonical sensitivity
               conversion, provenance (translation layer — never a measurement input)
  demo/        CLI demonstration
tests/         unit + integration + blind-recovery suites
docs/          architecture, metric definitions, optimizer & simulator methodology
```

See `docs/ARCHITECTURE.md` for the design tour and decision record,
`docs/METRICS.md` for exact metric definitions and constants,
`docs/OPTIMIZER.md` and `docs/SIMULATOR.md` for methodology,
`docs/PERSISTENCE.md` for storage formats,
`docs/GAME-PROFILES.md` for the game-profile architecture and how to add
a profile,
and `docs/ARENA-SENSITIVITY.md` for how a blinded candidate sensitivity becomes
movement the player's hand actually feels — the model, the DPI contract, and
the four gates that keep it applied.

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
