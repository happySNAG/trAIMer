# Release & version metadata (Pass 4)

## Version strings (`src/version.ts`)

- `APP_VERSION` — `1.0.0-rc.1` for the V1 release line.
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
| App | 1.0.0-rc.1 |
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
