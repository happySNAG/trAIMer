# Aldo Aim Lab — Engineering Pass 5 Final Report

Status: **Complete.** Feature commit `506d0ac` — "Prepare Aldo Aim Lab V1
release candidate" (43 files) — followed by this report committed separately.
Pass 5 turns the Pass 4 engine into a **V1 Release Candidate**: frozen RC
versioning, canonical documented defaults, first-run preflight, guided
capture self-test, complete retest loop, frozen final-results contract,
whole-store backup with integrity verification, lifecycle hardening,
transport/storage security hardening, Windows packaging + native CI pipeline,
and full release-artifact/no-telemetry/dependency audits.

Note on recovery: this pass resumed after a machine restart. The interrupted
run's uncommitted work (preflight, self-test, defaults, retest loop, results
contract, backup, lifecycle, transport limits, and their 46-test suite) was
recovered intact from the sibling worktree, repaired where the interruption
had left it inconsistent (duplicate imports, a garbled test helper, missing
contract-state narrowing), verified, and extended — never reimplemented.

---

## 1. V1 RC version

`APP_VERSION = 1.0.0-rc.1` (package.json in lockstep, verified by release
script). Frozen component versions (`src/version.ts`,
`fullReleaseMetadata()`): engine-v4 · optimizer-v3 · scoring-v1 ·
native protocolVersion 1 · helper-1.0.0 · calibration-v2 · resume schema 2.
`ARTIFACT_COMPATIBILITY_MATRIX` declares exactly what generations this build
reads/migrates/rejects; `scripts/verify-release.mjs` checks version parity on
every run.

## 2. Windows packaging approach

Portable folder, no installer/admin/services (`docs/PACKAGING-WINDOWS.md`):
`aldo_capture_helper.exe` + static `dist-app/` + PowerShell launcher that
mints a session token, starts the helper loopback-only, serves the app on
`http://127.0.0.1:8123`, opens the browser, and has a deterministic stop
routine. Uninstall = delete folder (+ `%LOCALAPPDATA%` token). Rationale:
auditability, no system mutation, browser provides the rendering stack.

## 3. Native build pipeline

- `scripts/build-native-windows.sh` / `.bat`: config validation (protocol +
  helper-version parity against `src/version.ts`, loopback bind check) on any
  host; MSVC or MinGW compilation on Windows hosts via `--compile`.
- GitHub Actions `.github/workflows/ci.yml`, job `native-windows`:
  parity tests → config validation → MSVC compile → artifact upload of
  `aldo_capture_helper.exe`.
- `tests/nativeProtocolConstants.test.ts` parses the C source directly so
  C↔TS drift fails at build time everywhere, not just on Windows.

## 4. First-run/preflight system

`src/preflight/preflight.ts` — 15 named checks (runtime support, capture
mode, native presence/protocol/tier validation, observed rate, timestamp
monotonicity, jitter/drops, DPI plausibility, X/Y configuration, calibration,
storage quota, viewport, unfinished checkpoints, stored-artifact engine
compatibility) aggregated into READY / READY_WITH_WARNINGS /
NOT_READY_FOR_HIGH_CONFIDENCE / BLOCKED with stable reason codes and named
thresholds. Wired into the Setup tab at boot
(`app/src/preflightClient.ts` gathers live-browser facts honestly as nulls;
never fabricates). A broken environment can never look valid.

## 5. Native self-test

`src/diagnostics/captureSelfTest.ts`: guided move-and-click stream analysis —
observed median-interval AND active-motion rates, interval p10/p50/p90,
jitter CV, movement volume, click pairing, zero-motion fraction, sequence
integrity (drops/duplicates/non-monotonic), reconnects, source identity.
**Honesty rule enforced**: hardware claiming 1000 Hz that delivers ~125 Hz is
explicitly NOT validated (fail below 50 % of nominal). The Diagnostics probe
persists `capture-self-test` records consumed by preflight; tier-1 native
trust requires a passing self-test.

## 6. Canonical V1 experiment defaults

`src/experiments/rcDefaults.ts` — single source of truth for every session-
shaping default (warmup 2, reps 8, ladder ±15 %/±35 %, maxSearchRounds 2,
maxTrials 160, fatigue/rest policy, scenario mix, exclusion rules, staged-
change bound ±25 %, early-stop floor 24, wall-clock cap 55 min…), each with
a written rationale grounded in Passes 1–4 campaigns and an explicit honesty
note: engineering-conservative choices without human data, configurable but
fixed for comparability. The protocol builder now consumes exactly these
defaults (tested).

## 7. Retest loop

`planNextTest()` completes the loop end-to-end: trigger detection from
recommendation fields + context (unresolved boundary, plateau, weak capture,
adaptation contamination, stale calibration, insufficient evidence,
suspicious asymmetry) → targeted-retest (narrowed range at half-step
resolution, dominated candidates dropped, fresh blinding, derived seed,
lineage notes) or clean-repeat (fresh seed/instances, full original ladder)
or recalibrate-only decision; enforced ≥30 min rest between sessions with
`canStartNow`/`earliestStartIso` for "continue another day". The Results
screen's decided next action consumes this plan.

## 8. Resume/recovery completion

Pass 4 engine retained; Pass 5 adds lifecycle integration: sleep/wake time
jumps >2 s mid-trial abort the trial exactly like lock loss (render-loop
wired via `assessTimeJump`); duplicate-instance guard (`InstanceGuard` over
BroadcastChannel) warns when two instances share one storage origin; the
lifecycle policy table documents every risky transition (helper orphan/
duplicate semantics, display changes, device swaps, DPI changes → calibration
staleness).

## 9. Data safety

Whole-database backup/restore (`src/persistence/backup.ts`): one JSON file
with SHA-256 integrity over deterministically serialized contents; restore
validates checksum, every envelope, kind/path agreement, AND strict path
whitelist BEFORE writing anything (zero partial state on any failure).
Session bundles gained integrity metadata + full pre-validation. Path safety
is adversarially tested (traversal, absolutes, drive letters, unknown roots).

## 10. Final history/results contracts

- `ContractState<T>` (`src/contracts/states.ts`): explicit empty/loading/
  ready/error states for History and Results — UIs never infer state from
  absent data.
- `FinalResult` (`final-result-v1`, `src/results/finalResult.ts`): THE
  results-screen object — current vs immediate-recommended sensitivity (with
  staged-change split), ranges (X/Y independent under jointXY asymmetry),
  confidence + basis, quality grades, boundary status, adaptation flag,
  narrative blocks, evidence tables, excluded-trial reasons, calibration
  state, and ONE engine-decided next action with rationale. The Results view
  renders it as its headline; nothing is recomputed in presentation code.

## 11. Lifecycle hardening

See §8 plus the documented policy table covering: app startup, helper
present/disconnect, sleep/wake mid-trial, display change, mouse swap,
DPI/profile change, app close. Every transition either aborts loudly through
existing fatal-validation machinery or surfaces explicit status — silent
corruption is impossible by construction.

## 12. Anti-cheat boundary review

Automated (`tests/nativeProtocolConstants.test.ts`): the C helper contains
none of CreateRemoteThread / Write-/ReadProcessMemory / SetWindowsHookEx /
SendInput / mouse_event / LoadLibrary-injection / VirtualAllocEx; uses only
Raw Input + QPC + loopback Winsock; binds INADDR_LOOPBACK; refuses to run
without a token. It observes desktop mouse input without focus
(RIDEV_INPUTSINK) — functionally identical to common input-measurement
utilities; it never touches any game process, files, or anti-cheat.

## 13. Security review findings

`docs/SECURITY-REVIEW.md` (S1–S8, all fixed + regression-tested):
loopback-only URL enforcement incl. DNS-lookalike rejection; inbound WS size
and per-frame event caps (memory-exhaustion defense); bounded-memory sequence
tracking (100 k-frame soak); backup path-whitelist before any write; bundle
import zero-partial-state validation; negative schemaVersion rejection;
**NaN/Infinity sample values bypassed every numeric comparison — found BY the
Pass 5 adversarial campaign and closed with fail-closed non-finite guards in
`validateTrial`**; static DOM-safety test (textContent-only rendering).

## 14. Stress-test findings

`tests/stressLongSession.test.ts`: a full minute of 1000 Hz events (~60 k)
ingests in <85 ms with post-marathon monotonicity/validation/quality intact;
100 k-frame transport soak stays streaming with exact counters (~180 k
frames/s); a 300-trial session validates + summarizes + optimizes within
~3 s including persistence round-trips. No pathological allocation or
correctness drift at scale.

## 15. Performance budgets/results

Budgets table in `docs/RELEASE.md`; measured: ingest ≈0.03 µs/event,
transport ≈180 k frames/s, trial validation ~2.5 ms/5 k samples, session
quality ~57 ms/120 trials, 300-trial analyze→recommend <3 s, bundle 142 KB
(47 KB gzip). All budgets met with large margins.

## 16. Browser support matrix

In `docs/RELEASE.md`: Chromium ≥114 primary (Windows Chrome/Edge: coalesced +
Pointer Lock + native tier-1); other-Chromium supported; Firefox ESR
functional-untested (frame-limited sampling warning); Safari 17+ functional-
untested (mousemove fallback); no Pointer Lock ⇒ BLOCKED. Preflight surfaces
the exact mode on every platform.

## 17. Release-artifact verification

`node scripts/verify-release.mjs` (CI-gated): package.json ↔ APP_VERSION
parity, C↔TS native constant parity, dist-app structure, bundle embeds
APP_VERSION + ENGINE_VERSION, compatibility matrix present, required release
docs exist. Current run: **12/12 ✓**.

## 18. No-telemetry audit

`scripts/audit-no-telemetry.mjs` scans sources AND the shipped bundle for
fetch/XHR/sendBeacon/EventSource/WebSocket-without-loopback-guard/non-local
URL literals. The Vite fetch-based module-preload polyfill was REMOVED from
the build (`modulePreload: false`) so shipped JS contains zero network-capable
APIs. Result: **CLEAN**. Runtime WebSocket use exists only behind
`assertLoopbackUrl`.

## 19. Dependency audit

`npm audit`: **0 vulnerabilities** (upgraded vite ^5 → ^7 to clear the
esbuild dev-server advisory; build + browser suite re-verified after the
upgrade). Production runtime dependencies: **none**. Dev deps are
build/test tooling only and never ship in the bundle.

## 20. Claude UI handoff state

GO (see §28). `docs/UI-CONTRACT.md` §6 lists the new stable seams (preflight,
self-test, FinalResult, NextTestPlan, backup, contract states, lifecycle)
alongside the Pass 4 freeze. The Results view already renders `FinalResult`
as its headline; History renders `HistorySnapshot`; Setup renders preflight +
resume list. Every calculation/threshold/decision lives in `src/**`; the
redesign may restyle all of `app/**` freely.

## 21. Exact total automated test count

**416 automated tests**, all passing:
- Engine/unit/integration/property/adversarial/security/stress suites
  (`npm test`): **52 files, 405 tests**
- Browser automation (`npm run test:browser`): **11 tests**
New Pass 5 coverage: pass5Engine 46 | security 9 | stressLongSession 4 |
adversarialCampaigns 7 | nativeProtocolConstants 4 (+ exportExtended
extended to checksummed bundles).

## 22. Lint/type/build/browser/native-CI results

```
npm run lint        eslint .                     0 problems
npx tsc --noEmit    strict TS incl. app/         clean
npm test            vitest                       405 passed
npm run test:browser playwright (chromium)       11 passed
npm run build       vite production              ✓ 142 KB js / 47 KB gzip
native pipeline     config parity validated here; compile+artifact job wired
                    in CI (windows-latest, MSVC) — actual exe requires a
                    Windows runner/hardware (see §27.B)
no-telemetry audit  CLEAN (sources + bundle)
verify-release      12/12 ✓
npm audit           0 vulnerabilities
```

## 23. Adversarial campaign results

`tests/adversarialCampaigns.test.ts` + `tests/security.test.ts`:
200-mutation checkpoint campaign (all rejected-or-coherent; targeted
tampering proves every required field load-bearing — this campaign exposed
the missing `kind` check, now fixed); hostile fixture fuzzing with envelope
corruption; hostile-helper flood/oversize frames (zero partial ingestion);
wrong-typed bundle imports rejected with empty store; prototype-pollution
shapes inert; NaN/Infinity injection caught (validator hardened); backup
path traversal refused pre-write. Two real defects were found and fixed by
these campaigns during the pass (S7 non-finite bypass; missing checkpoint
kind check).

## 24. Exact feature commit hash

`506d0ac6656b0f3fce78c927d8cf0fe326052bd3`
"Prepare Aldo Aim Lab V1 release candidate"
(branch ox/aldo-aim-lab-20260823T012332Z-7170a7e5)

## 25. Exact report commit hash

A separate commit containing ONLY PASS-5-REPORT.md, message "Add Pass 5
report", created immediately after the feature commit `506d0ac`. A commit
cannot contain its own hash; read the exact value with:

    git log --format=%H --grep "Add Pass 5 report" -1

## 26. Known defects

- None known at the functional level. Accepted limitations (not defects):
  Firefox/Safari sampling degradation is warned, not compensated; the
  launcher's HttpListener server is HTTP-only on loopback (Pointer Lock treats
  localhost as secure); helper binaries must be produced by CI/hardware since
  no Windows toolchain exists on this host.

## 27. Remaining work — strict classification

**A. SOFTWARE WORK STILL REQUIRED BEFORE V1**
- None blocking the RC tag. (Optional pre-hardware polish: assemble the zip
  layout + launcher scripts into a release artifact once a Windows runner
  produces the exe — mechanical, tracked in §17 flow.)

**B. HARDWARE VALIDATION REQUIRED BEFORE V1**
1. Compile `aldo_capture_helper.exe` on Windows (CI native-windows job or
   local MSVC/MinGW).
2. Run the native probe + self-test on Aldo's PC at 125/500/1000 Hz; confirm
   observed-rate parity with fixtures and pass verdicts.
3. Full MANUAL-TEST.md smoke on the real machine: pointer lock, all five
   scenarios, resume-after-crash, calibration round-trip, backup/restore.
4. Confirm launcher scripts (`start/stop-aldo-lab.ps1`) against real
   Edge/Chrome behavior.

**C. HUMAN DATA REQUIRED TO EMPIRICALLY CALIBRATE V1**
1. Empirical confidence mapping from repeated test/retest outcomes
   (seam ready: `EmpiricalConfidenceMapping`).
2. Scoring-weight and threshold tuning (utility weights, quality cut-offs,
   duration/fatigue constants, rest lengths) against observed human variance.
3. Reliability coefficients once ≥3 session pairs exist.
4. Adaptation/change-point threshold validation on real learning curves.

**D. OPTIONAL POST-V1**
1. macOS helper implementation (architecture-ready; spec in docs).
2. GP/Bayesian surrogate beyond quadratic-with-guards.
3. Richer history visualizations (design-pass scope).
4. Deeper cross-browser automation matrix; visual regression.
5. Multi-device profiles per player; import/export UX refinements.

## 28. GO/NO-GO — handing the engine to Claude Code for visual redesign

**GO.** The engine is feature-complete for V1 RC; all decisions, thresholds,
verdicts, contracts, and next-action logic are engine-owned and frozen behind
documented seams (`docs/UI-CONTRACT.md` §§2, 6). The redesign cannot fork
measurement logic without violating an explicitly listed rule, and the
browser suite locks the rendered behavior end-to-end.

## 29. GO/NO-GO — moving the RC to Aldo's Windows PC for hardware validation

**GO, conditionally.** The software side is complete and self-verifying
(preflight will refuse anything broken rather than degrade silently). Move it
now WITH the understanding that items B1–B4 are exactly what the visit must
produce: compiled helper (CI artifact or on-site MSVC), native rate-parity
evidence at the real polling rates, one full supervised smoke session, and
launcher confirmation. Until B completes, tier-1 native capture stays
unvalidated-by-design and the negotiated coalesced browser fallback remains
the honest default — which the product handles correctly today.
