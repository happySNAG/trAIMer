# Release & version metadata (Pass 4)

## Version strings (`src/version.ts`)

- `APP_VERSION` — `1.0.0-rc.12` for the V1 release line (rc.1 was the Pass 5
  candidate and shipped a non-executable helper; rc.2 was the Pass 8
  pre-hardware candidate and still launched via PowerShell; rc.3 was the Pass 9
  installed-desktop-application candidate, which installed and launched on
  real Windows hardware but could not start a test; rc.4 was the Pass 10
  candidate that fixed the arena capture-entry path; rc.5 was the Pass 11
  gameplay pass: sequential three-target drill, skippable breaks, balanced
  drill sequencing, new arena presentation; rc.6 is the Pass 12 real-PC bugfix
  pass: the strafing target is hit-tested where it is drawn and sweeps the
  field, a click no longer deletes the tracking target, and breaks/pauses hand
  the mouse back before showing anything clickable; rc.7 renamed the product
  to trAIMer and fixed the break/tracking/shot-feedback defects from the third
  hardware session; rc.8 was the Pass 14 measurement-integrity candidate —
  capture timestamp domains, selectable calibration length, and a
  player-first results page; rc.9 is Game Profile Campaign Pass 1, which adds
  the versioned game-profile and sensitivity-conversion layer described in
  docs/GAME-PROFILES.md and ships one public profile, the generic/raw control
  — and which also fixes the release-blocking measurement defect found during
  that pass: rc.5–rc.8 never applied the blinded candidate sensitivity to the
  arena at all, so every human calibration on those builds compared
  sensitivities that felt identical. See docs/ARENA-SENSITIVITY.md; rc.10 is
  Game Profile Campaign Pass 2, which ships the first five public game
  profiles — Fortnite, Valorant, Counter-Strike 2, Apex Legends and Call of
  Duty / Warzone — on that architecture; rc.11 is Pass 3, which adds
  Overwatch 2, Rainbow Six Siege, Marvel Rivals, PUBG, The Finals and
  Battlefield 6, reorganises the picker, and adds the installed-app
  game-picker gate to CI; rc.12 is Pass 4, the validation and hardening
  pass — every public profile independently re-verified, Battlefield 6's
  stock ADS coefficient corrected from 177.8% to 133.3%, and golden tests
  added whose expected values come from published sources rather than from
  this repository's own constants).
- `ENGINE_VERSION` — `engine-v4` (bumped per engineering pass with contract
  changes).
- `OPTIMIZER_VERSION_V4` — `optimizer-v3` (paired-effects surrogate,
  adequacy gating, change-point analysis).

## Where versions are persisted

| Artifact | Fields |
| --- | --- |
| Recommendation | `engineVersion`, `appVersion` (+ optimizer-run record) |
| ResumeCheckpoint | `appVersion`, `engineVersion`, `optimizerVersion` |
| HumanSessionRecord | `optimizerVersion`, `arenaGain.modelVersion` (+ release fields on export) |
| Diagnostic bundle | full `ReleaseMetadata` block |

## Compatibility checks

- `checkEngineCompatibility(artifactEngineVersion)` rejects artifacts from a
  different engine generation loudly; pre-versioning artifacts (null) load.
- Bundle imports reject `schemaVersion` newer than supported.
- Checkpoints reject unknown resume schemaVersions.
- A stored session with **no** `arenaGain` record predates 1.0.0-rc.9 and its
  recommended sensitivity is not evidence about sensitivity; `HistoryApi`
  reports that and the History view shows it. The session itself stays
  readable and complete (docs/ARENA-SENSITIVITY.md §8).

## V1 release checklist

1. `npm test && npm run lint && npm run typecheck && npm run build`
2. `npm run test:browser`
3. `npm run build:desktop` — the Electron shell must compile clean.
3b. `npm run verify:candidate-gain` — two blinded candidates must move the
   crosshair by measurably different amounts in the real shell. A build that
   fails this measures everything except the variable it exists to measure.
4. Push and let the `windows-installer` CI job build the real artifacts on a
   Windows runner. It compiles the helper with MSVC `/W4 /WX`, **verifies the
   binary is a genuine x64 PE**, runs it with `--version` to prove it
   executes, builds the NSIS installer, silently installs it, and smoke-tests
   the installed application's startup and clean shutdown.
5. Download `traimer-windows-installer` → `trAIMer-Setup.exe`.
6. Install it on the target Windows PC and run the on-hardware validation in
   `docs/HUMAN-VALIDATION.md` (a compile is not hardware validation).
7. Tag `v1.0.0` once hardware validation passes. `dist-app/`, the shell and
   the helper ship inside one installer, so engine and transport protocol can
   never drift apart in the field.

## Shipped artifact

| Artifact | Audience | Produced by |
| --- | --- | --- |
| `trAIMer-Setup-<version>.exe` | players | CI `windows-installer` job |
| `trAIMer-v<version>-windows-x64.zip` (portable folder) | development / diagnostics | CI `windows-release` job |

## Component version matrix (V1 RC, frozen)

| Component | Version |
|---|---|
| App | 1.0.0-rc.12 |
| Engine | engine-v4 |
| Optimizer | optimizer-v3 (paired fit + adequacy gating + change-point) |
| Scoring model | scoring-v1 (weights: accuracy .28, speed .14, tracking .14, correction .12, overshoot .11, undershoot .11, consistency .10) |
| Native transport | protocolVersion 1 |
| Native helper | helper-1.1.0 |
| Arena sensitivity model | arena-gain-v1 (candidate → logical px per mouse count; see docs/ARENA-SENSITIVITY.md) |
| Calibration workflow | calibration-v2 |
| Resume checkpoints | resume schemaVersion 2 |
| Persistence envelopes | schemaVersion 1 |
| Game profile schema | schemaVersion 1 (see docs/GAME-PROFILES.md) |
| Public game profiles | `apex-legends`, `battlefield-6`, `call-of-duty-warzone`, `counter-strike-2`, `fortnite`, `marvel-rivals`, `overwatch-2`, `pubg-battlegrounds`, `rainbow-six-siege`, `the-finals`, `valorant`, `generic-raw` — all v1 |

The machine-readable copy of this matrix lives in `src/version.ts`
(`fullReleaseMetadata()`, `ARTIFACT_COMPATIBILITY_MATRIX`) and is verified
by `scripts/verify-release.mjs`.

## Browser support matrix

| Browser | Status | Capture path | Notes |
|---|---|---|---|
| Chrome/Edge ≥ 114 (Windows) | **supported (primary)** | pointermove-coalesced + Pointer Lock + native tier-1 via loopback helper | target platform for Aldo's PC |
| Chromium ≥ 114 (other OS) | supported | coalesced + Pointer Lock; native helper not shipped yet | full engine behavior |
| Firefox ESR | functional, untested in CI | pointermove without coalescing (frame-limited sampling) | preflight warns `NO_COALESCED_EVENTS`; quality gates still apply |
| Safari 17+ | functional, untested | mousemove fallback (silent while still) | preflight warns `MOUSEMOVE_ONLY_FALLBACK`; motion-aware gap validation handles silence |
| Any runtime without Pointer Lock | blocked | — | preflight verdict BLOCKED (`POINTER_LOCK_UNSUPPORTED`) |

## Performance budgets (V1 RC)

Measured on the dev MacBook Pro (M-class, Node 25); CI re-runs
`npm run bench` without hard thresholds (informational).

| Path | Budget | Measured |
|---|---|---|
| Raw event ingestion @1000 Hz | < 1 ms per 5 k events | ~1.3 ms per **60 k** events |
| Transport frame validation | ≥ 50 k frames/s | ~180 k frames/s (100 k-frame soak) |
| Trial validation (5 k samples) | < 10 ms | ~1.4 ms |
| Session quality over 120 trials | < 100 ms | ~50 ms |
| Full 300-trial analyze → recommend | < 5 s | ~2.9 s incl. persistence round-trip |
| Production bundle size | ≤ 250 KB js | ~142 KB (47 KB gzip), zero network calls |

### Pass 6 additions

| Path | Budget | Measured (Pass 6) |
|---|---|---|
| Full `recommend()` on a 60-trial session (incl. metrics re-derivation) | < 150 ms | < 40 ms after trial-metrics memoization (was ~1.35 s) |
| Monte Carlo campaign case (session + ground truth + analysis) | informational | ~115–140 ms/case; 1700-case campaign ≈ 4 min |
| High-rate ingest (125–8000 Hz simulated streams) | no catastrophic degradation | lossless serialization, monotonic validation, bounded memory at every rate incl. 8 kHz |
| History snapshot over 240 sessions / 2.4 k trials | < 10 s in-memory | well under (see tests/historyScale.test.ts) |
| Release repackaging determinism | byte-identical manifests | verified (docs/PASS6-DETERMINISM-REPRODUCIBILITY.md) |

### Pass 7 additions

**Active-session UI budgets** (measured trials in progress):

| Path | Budget | Basis |
|---|---|---|
| DOM work per raw input event @1000 Hz | zero — events stay in-memory (`TrialRecorder`); no DOM/React-style re-render per event | code audit: `app/src/runController.ts` ingest path touches only recorder state |
| HUD/DOM writes during play | bounded by state transitions (< ~10/s), not by event rate | `onHud` fires on session-state change only; progress bar updates per persisted trial |
| Frame render cost at any refresh rate | one cached-gradient fillRect + ≤ handful of arcs on a fixed 1280×720 backing store; no blur/shadow/filter animates during play | `#drawFrame`; hit ring is the only effect (160 ms, draw-after-the-fact) |
| Background observers/charts during trials | none — sidebar is removed (`display:none`) for the run screen; charts render only when History/Home activate | `body.session-active` CSS + view activation model |
| Timers during play | only the trial rAF loop; diagnostics probe ticker exists solely inside an explicit user-triggered probe and clears itself | audit |

**Coordinate / DPI model (Windows display readiness):**

- The stage is a FIXED logical viewport of **1280×720 units** (`LOGICAL_VIEWPORT`
  in `app/src/runController.ts`). The canvas backing store is exactly
  1280×720 device-independent pixels; CSS scales it to fit the window.
- Targets, reticle position, and movement deltas all live in this single
  logical space: pointer-lock deltas are applied to the reticle in logical
  units and scenario targets are planned against the same `Viewport`, so
  geometry can never be distorted relative to itself.
- Windows display scaling (100–200%) changes CSS-pixel density, i.e. how
  large the stage appears — not the relationship between deltas and target
  geometry. eDPI math uses raw deltas vs. logical geometry only; OS scaling
  does not enter the computation. `devicePixelRatio` is recorded as runtime
  metadata (hardware-validation bundle), never used to rescale gameplay.
- High refresh rates cannot speed up or slow down measurement: spawn times
  are absolute scheduled timestamps, motion is keyframe-interpolated by
  elapsed time, and completion is deadline-based (see
  tests/highRefreshTiming.test.ts for the 60–240 Hz cadence proofs).
