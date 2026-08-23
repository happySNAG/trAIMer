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
