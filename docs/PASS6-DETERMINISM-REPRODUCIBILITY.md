# Pass 6 — Determinism & Release Reproducibility

## 1. Determinism audit (engine surfaces)

Contract: identical seed + raw trials + calibration + scoring weights +
engine version ⇒ **byte-stable** outputs for every designed-deterministic
surface. Enforced by `tests/determinismAudit.test.ts` using the sorted-key
canonical serializer (`stableStringify` from `src/persistence/backup.ts`).

Verified byte-stable across independent re-runs:

| Surface | Status |
| --- | --- |
| Simulator raw trials (same seed) | stable |
| Recommendation object (recompute + re-run) | stable |
| Protocol/planned trial order `(seed, round)` | stable |
| Adaptive allocation decisions | stable |
| Candidate ranking + paired-fit effects | stable |
| Curve-adequacy classification | stable |
| Retest planning (`planNextTest`) | stable |
| `FinalResult` | stable |
| Export bundle checksums (same inputs) | stable |

### Intentionally NON-deterministic metadata (documented, excluded from the contract)

- `savedAtIso` on persistence envelopes (wall clock at save time)
- `startedAtIso` / `endedAtIso` / `exportedAtIso` on session records and bundles
- `InstanceGuard` instance ids (random per launch)
- Launcher-generated session tokens (`%LOCALAPPDATA%` secret)

These fields carry no analytical weight; analysis/recommendation logic never
reads them.

## 2. Release reproducibility

`scripts/package-release.mjs` produces the portable release folder plus:

- `manifest.json` — app/engine/optimizer versions, native protocol version,
  expected helper version, git commit (passed by CI as `github.sha`),
  dependency-lock hash (SHA-256 of package-lock.json), per-file SHA-256 for
  every packaged file, and an aggregate artifact digest.
- `<release>-SHA256SUMS.txt` — deterministic checksum manifest.

**Repack determinism was verified**: two consecutive runs of the packager on
identical inputs produce byte-identical manifests and checksum files.

### What is reproducible at which strength

| Level | Scope | Status |
| --- | --- | --- |
| Bit-for-bit | manifest.json, SHA256SUMS.txt, FIRST-RUN/ps1 scripts, app static assets given identical `dist-app/` inputs | verified locally |
| Bit-for-bit | `aldo_capture_helper.exe` | NOT claimed — MSVC output embeds timestamps/paths; the helper is verified by SHA-256 against its manifest entry instead |
| Logically reproducible | full release contents from a tagged commit | CI `windows-release` job rebuilds everything from the commit and verifies versions via verify-release |

Verification tooling: `node scripts/verify-release.mjs --release-dir <folder>`
recomputes every file hash from disk against the manifest, asserts a real
(non-placeholder) helper binary, and checks required launcher/docs assets.
