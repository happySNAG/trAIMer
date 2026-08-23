# Pass 6 — Windows Release Pipeline & Lifecycle Matrix

## 1. Downloadable V1 RC release artifact (CI)

`.github/workflows/ci.yml` now contains a **`windows-release`** job that turns
a tagged commit into an actual downloadable artifact:

1. Windows runner (`windows-latest`), Node 20.
2. Native protocol/version constant parity (C ↔ TS) + config validation.
3. Full engine test suite, lint, strict typecheck on the Windows host.
4. Production build (`dist-app/`).
5. `scripts/verify-release.mjs` — 12+ structural checks.
6. No-telemetry audit over sources AND the shipped bundle.
7. `npm audit --audit-level=moderate`.
8. Helper compiled by the `native-windows` job with **MSVC `/W4 /WX`**
   (warnings are errors; MinGW path uses `-Wall -Werror`) and downloaded.
9. `scripts/package-release.mjs` assembles:

   ```
   AldoAimLab-v<version>/
   ├── aldo_capture_helper.exe
   ├── app/                  (production static bundle)
   ├── start-aldo-lab.ps1
   ├── stop-aldo-lab.ps1
   ├── FIRST-RUN.md          (first-run + troubleshooting)
   └── manifest.json         (versions, commit, lock hash, SHA-256 per file)
   ```

10. A PowerShell verification step re-checks the assembled folder, then
    `Compress-Archive` produces `AldoAimLab-portable.zip`, uploaded as
    `aldo-aim-lab-portable-release` (90-day retention) together with the
    checksum manifest.

Honesty rule: compilation success is NOT physical Raw Input validation. The
helper binary ships as *unvalidated-by-design* until the on-hardware checks in
docs/RELEASE.md §hardware are performed; preflight/self-test keep tier-1
native capture gated until a passing self-test exists.

## 2. Launcher scripts

- `start-aldo-lab.ps1`: token load/mint (RNG, validated shape), duplicate/
  occupied-port guard, helper started via quoted ARGUMENT ARRAY (no string
  interpolation into a shell), dependency-free HttpListener bound to
  `http://127.0.0.1:8123/` only, traversal-guarded static file serving with a
  strict MIME allowlist, deterministic teardown of both processes in
  `finally`.
- `stop-aldo-lab.ps1`: PID files parsed with TryParse before any kill; no
  kill-by-name; belt-and-braces port cleanup.

Both are statically contract-tested (`tests/securityRoundTwo.test.ts`):
no Invoke-Expression/iex/Invoke-Command, loopback-only bind assertions,
argument-array token passing, traversal guard presence.

## 3. Lifecycle failure matrix (mandated transitions)

Engine-level behavior for every transition; "visible" = structured status or
typed invalidation, never silent corruption.

| Transition | Engine behavior | Where tested |
| --- | --- | --- |
| Helper launch | launcher-only; browser never spawns processes | ps1 contract tests |
| Helper shutdown | stop routine kills helper + server deterministically | ps1 contract tests |
| Orphan helper | harmless by design: loopback-only, exits at shutdown/stop | docs + policy table |
| Duplicate helper | second instance fails to bind and exits; first keeps serving | policy table |
| Duplicate app instance | InstanceGuard peer detection warns | lifecycleHardening |
| Browser already open | launcher opens URL; existing session unaffected (stateless static server) | ps1 review |
| Port 8123 occupied | launcher fails loudly with instructions, helper torn down | ps1 (Get-NetTCPConnection guard) |
| Malformed/stale token | launcher refuses non-32-hex tokens; transport rejects wrong token at handshake (fail closed) | ps1 + nativeTransportProtocol |
| App crash mid-trial | checkpoint-before-trial ⇒ ≤ 1 ambiguous trial; resume invalidates it explicitly | sessionResumeRecovery |
| Browser crash/refresh | unfinished sessions listed at boot; interrupted trial suspect-excluded | sessionResumeRecovery, lifecycleHardening |
| Sleep/wake mid-trial | > 2 s monotonic jump ⇒ trial invalidated via gap rules | lifecycleHardening |
| USB mouse disconnect/reconnect | sequence gaps counted, epoch reset on welcome; no fabricated samples | lifecycleHardening |
| Device identity change | calibration fingerprint flags DEVICE_CHANGED | lifecycleHardening |
| Display resolution change | resize > 10 % area mid-trial fatal to that trial | lifecycleHardening |
| Scaling change (<10 %) | tolerated (not suspect-worthy) | lifecycleHardening |
| System clock jump | wall clock never feeds measurement; monotonic rules only | validateTrial design |
| Weak capture session | quality summary forces retest-required; confidence capped 0.45 | captureQualitySession |

## 4. High-rate capture stress findings

Simulated 125 → 8000 Hz streams (3 s each) through serialization, ingest,
validation, input-quality, persistence, and replay
(`tests/highRateCaptureStress.test.ts`):

- Serialization round-trips are lossless at every rate; zero sequence gaps.
- Validation stays green with monotonic timestamps up to 8000 Hz; input
  quality reports observed rates correctly (>90 % of nominal at every rate).
- Ingest cost per 1000 samples stays well under interactive budgets even at
  8000 Hz; a repeated full-stream soak shows bounded memory (no leak).
- The product does NOT advertise >1000 Hz support; the engine simply neither
  degrades nor fails catastrophically if future hardware delivers more.
