# Release & version metadata (Pass 4)

## Version strings (`src/version.ts`)

- `APP_VERSION` — `1.0.0-rc.2` for the V1 release line (rc.1 was the Pass 5
  candidate; rc.2 is the Pass 8 pre-hardware candidate).
- `ENGINE_VERSION` — `engine-v4` (bumped per engineering pass with contract
  changes).
- `OPTIMIZER_VERSION_V4` — `optimizer-v3` (paired-effects surrogate,
  adequacy gating, change-point analysis).

## Where versions are persisted

| Artifact | Fields |
| --- | --- |
| Recommendation | `engineVersion`, `appVersion` (+ optimizer-run record) |
| ResumeCheckpoint | `appVersion`, `engineVersion`, `optimizerVersion` |
| HumanSessionRecord | `optimizerVersion` (+ release fields on export) |
| Diagnostic bundle | full `ReleaseMetadata` block |

## Compatibility checks

- `checkEngineCompatibility(artifactEngineVersion)` rejects artifacts from a
  different engine generation loudly; pre-versioning artifacts (null) load.
- Bundle imports reject `schemaVersion` newer than supported.
- Checkpoints reject unknown resume schemaVersions.

## V1 release checklist

1. `npm test && npm run lint && npm run typecheck && npm run build`
2. `npm run test:browser`
3. Build the Windows helper (`native/windows/BUILD.md`) and run the native
   probe once against real hardware.
4. Tag `v1.0.0`, ship `dist-app/` + helper binary together so engine and
   transport protocol match.

## Component version matrix (V1 RC, frozen)

| Component | Version |
|---|---|
| App | 1.0.0-rc.2 |
| Engine | engine-v4 |
| Optimizer | optimizer-v3 (paired fit + adequacy gating + change-point) |
| Scoring model | scoring-v1 (weights: accuracy .28, speed .14, tracking .14, correction .12, overshoot .11, undershoot .11, consistency .10) |
| Native transport | protocolVersion 1 |
| Native helper | helper-1.0.0 |
| Calibration workflow | calibration-v2 |
| Resume checkpoints | resume schemaVersion 2 |
| Persistence envelopes | schemaVersion 1 |

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
