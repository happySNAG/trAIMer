# Aldo Aim Lab — Engineering Pass 4 Final Report

Status: **Complete.** Feature commit `0308ff9` — "Complete production aim
engine and native capture architecture" (79 files, +11,065/−257) — followed
by this report committed separately. Pass 4 closes the major technical gaps:
real Windows native capture, a hardened production transport, session-level
capture quality, fully paired statistics, non-quadratic search safeguards,
formal adaptation analysis, production resume/recovery, history APIs,
calibration hardening, duration policy, browser automation, a typed error
model, local observability, release versioning, and the frozen UI contract.

---

## 1. Native capture implementation

`native/windows/aldo_capture_helper.c` (~900 lines, dependency-free C):
Win32 **Raw Input** (`RegisterRawInputDevices` with `RIDEV_INPUTSINK |
RIDEV_DEVNOTIFY`, `WM_INPUT`, `GetRawInputData`) reading physical relative
mouse deltas at whatever rate hardware/OS deliver (125/250/500/1000 Hz+),
`QueryPerformanceCounter` monotonic ms timestamps, per-epoch sequence
numbers, button 1/2/3 press/release, device identity via
`GetRawInputDeviceInfoW` (stable hashed ids), device arrival/removal
lifecycle events, and absolute-mode devices skipped rather than misreported.

**Anti-cheat/safety boundary honored**: no injection, no memory reads, no
hooks, no input synthesis, no game-file or anti-cheat interaction; loopback
bind only, one authenticated client, no network/cloud/telemetry.

Not compiled here (no Windows toolchain on this machine); `BUILD.md` gives
MSVC and MinGW commands. The transport protocol is exercised end-to-end by
deterministic tests (§15).

## 2. Native transport

`src/capture/nativeClient.ts`: loopback WebSocket client implementing the
versioned handshake (`hello`/`welcome`/`reject`), session-token cross-talk
protection, sequence continuity (missing counted, duplicates/non-monotonic
fail closed), malformed-frame fail-closed validation (counters and sinks see
zero partial data), exponential-backoff reconnects with stream-epoch reset on
welcome, clean shutdown, explicit source metadata. Socket I/O is injected,
so the identical code runs in browser, Node tests, and against the real
helper. Frames enter the SAME recorder/validation/metrics pipeline as browser
capture.

## 3. Capture-source negotiation

`src/capture/negotiation.ts`: priority 1 validated native → 2 coalesced
browser → 3 basic mouse. Tier 1 requires a PASSING diagnostics run;
unvalidated helpers are rejected with recorded reasons. Every activation/
fallback/disconnect transition is recorded; mid-trial disconnect emits a
structured invalidation event naming the trial; inter-trial fallback only;
mid-trial mixing without invalidation throws. Source metadata persists into
checkpoints/sessions. Silent downgrades are structurally impossible.

## 4. Session capture-quality model

`src/diagnostics/captureQuality.ts`: robust aggregation over per-trial
reports — median scores (not worst-trial), drop fraction, lock/resize totals
with proportional (>25 % of trials) blocking, degradation via slope AND
late-vs-early median comparison, trial consistency (robust CV), source-kind
transitions, high-quality fraction. Outputs numeric score, grade, reason
codes, suitability classification, retesting flag. Fed into optimizer
confidence gating (retest-required ⇒ cap 0.45) and persisted on
recommendations. Tested: one bad trial cannot sink a clean session.

## 5. Statistical model changes

`src/optimizer/pairedFit.ts` replaces ALL remaining scenario-centering in
the surrogate path: pair contrasts over shared cells → weighted contrast
regression (α_i − α_j = d̂_ij, heteroskedastic 1/var weights, pinned
reference) solved by coordinate descent → candidate effects + SEs feed
`fitQuadraticWeighted`. Scenario effects are reported separately for
explanation only. Sparse designs return null explicitly (pooled fallback is
labeled). Tests prove shared scenario difficulty shifts nothing
(`tests/pairedFitStats.test.ts`); equations and assumptions are documented in
`docs/STATISTICS.md`. A real solver sign bug was caught by these tests and
fixed during development.

## 6. Search/model-adequacy changes

`src/optimizer/adequacy.ts` classifies five geometries (insufficient /
multimodal-inconsistent / monotonic-boundary / broad-plateau /
single-or-asymmetric-optimum) using curvature significance to separate
optimum from plateau (a symmetric parabola has ≈zero net slope). Quadratic
vertices are used ONLY when earned; plateaus widen ranges, boundary trends
force `unresolvedBoundary`, inconsistent evidence caps confidence at 0.4.
Synthetic campaigns that fool naive quadratic fits (monotone-concave,
two-hump) demonstrate the failure mode and its prevention
(`tests/curveAdequacy.test.ts`).

## 7. Joint X/Y behavior

`src/optimizer/jointXY.ts`: sparse Y-neighborhood at the winning X (anchor +
±15–18 % variants), paired comparisons vs anchor, plus a ridge-regularized
4-parameter surface fit (βx, βy, βxy) across all measured candidates.
Outcomes: recommend-equal / slightly-asymmetric / clearly-asymmetric /
asymmetry-unresolved / insufficient-evidence, with separate plausible X and
Y ratio ranges. Hidden-optima campaigns all pass: (5600,5600) → equality;
(5600,5000)/(5600,4000)/(5000,6500) → correct unequal verdicts; noisy false
asymmetry resolves to equality/unresolved — never confidently unequal
(`tests/jointXYSearch.test.ts`). A target-switch timeout hang found by e2e
driving was fixed in the director (sequential scenarios now respect the
scenario time budget).

## 8. Adaptation model

`src/optimizer/changepoint.ts`: deterministic segmented scan (BIC-penalized
SSE) with Welch per-segment significance classifying warmup-learning /
abrupt-degradation / temporary-collapse / fatigue-slope / stable. Per-
candidate contamination flags and recommended actions (extra warmup, rest,
re-exposure, downweight, exclude) attach to recommendations; raw trials stay
untouched (asserted). Replaces the Pass 3 half-split heuristic.

## 9. Resume/recovery

v2 `ResumeCheckpoint` (blinding, rep counters, completed keys/ids, audit
trail with strict seq continuity, fatigue/timing state, capture-source
metadata, versions, retest/calibration links) written BEFORE every trial with
a pending-trial marker and cleared after persistence — a crash leaves exactly
one ambiguous trial. `SessionRunner.resumeFrom` fails closed on corruption,
never repeats completed steps, invalidates the interrupted trial explicitly
(`INTERRUPTED_IN_PROGRESS` audit metadata) and repeats it once. Startup UI
lists incomplete sessions (player/date/experiment/trials/round/source/state/
age) with Resume / Export bundle / Discard (marks aborted; never deletes).
Tested across crash points, rest/candidate transitions, corrupted
checkpoints, and browser reload (`tests/sessionResumeRecovery.test.ts`,
`tests/browser/persistence.spec.ts`).

## 10. History APIs

`src/history/api.ts`: typed view models for sessions, X/Y/eDPI/confidence/
quality trends, candidate ranking history, dimension trends, calibration
history (never deleted), retest lineage, device history, optimizer-version
history, plus a one-call snapshot. Rendered read-only by the History tab;
zero calculations in presentation code (`docs/UI-CONTRACT.md`,
`docs/HISTORY.md`).

## 11. Calibration hardening

Multi-turn reps (2×/3×/5× rotations), median/MAD robust estimation
(SE_median ≈ 1.2533·1.4826·MAD/√n), CI, quality score, consistency view
contract (per-rep dots + spread band), separate X/Y records, history via the
History API, context fingerprints with staleness rules (DPI change, device
change, native↔browser source switch, settings change). Old records are
flagged, never deleted (`tests/calibrationHardening.test.ts`).

## 12. Experiment-duration results

`evaluateBudgetDecision` implements early stop (clear separation + honest
shape + nothing open), continue reasons (tied contenders, unresolved
boundary, weak capture, adaptation contamination, below minimum), and hard
defer-to-next-session at wall-clock/fatigue caps. Campaign summarization
(`summarizeDurationCampaign`) shows the tradeoff directly: going from ~20 to
~78 measured trials roughly halves median error and range width while
raising confidence — beyond that, marginal gains flatten while fatigue risk
and wall-clock grow. Defaults: 160 max trials, 55 min cap, 24-trial early-
stop floor (`docs/OPTIMIZER.md`, `tests/budgetEarlyStop.test.ts`).

## 13. Automated browser tests

Playwright + Chromium (`npm run test:browser`, config
`playwright.config.ts`). **11 tests, all passing**: boot/tabs/version footer,
IndexedDB init, Data/History/Diagnostics/Calibration views, settings
persistence + clamping (caught an HTML5-constraint issue), malformed/future
bundle import failures with zero partial state, resume-checkpoint UI
(seeded checkpoint → list → discard flow), and a FULL scripted session from
setup through results. Pointer Lock limitation handled by a clearly separated
`?e2e=1` adapter (`app/src/testHooks.ts`, `virtualLock` controller option)
that injects events through the production capture path — no production code
forked. Driving e2e exposed and fixed two real bugs (sequential-scenario
timeout hang; a HUD regex crash).

## 14. Failure-injection results

`tests/failureInjection.test.ts` (+ transport/negotiation suites): flaky
IndexedDB writes → typed retryable errors; corrupted checkpoints → fail
closed; malformed/future imports → rejected with zero partial state; empty/
garbage/out-of-order native streams → fail verdicts; starved optimizer →
low-confidence refusal; clock anomalies and missing samples → excluded by
validation; invalid calibration artifacts → flagged inadequate, parameters
never produced. All expected fail-safe behaviors defined in
`docs/FAILURE-MODEL.md`.

## 15. Performance / 1000-Hz findings

`npm run bench` (`benchmarks/bench.ts`):

```
[ingest]   5,002 events @1000Hz in ~1.3 ms   (≈3 orders of magnitude headroom)
[validate] 5,002 samples in ~1.4 ms
[quality]  per-trial input-quality ~3 ms
[session]  capture-quality over 120 trials ~50 ms
[optimize] 5 candidates × 16 trials analyzed + recommended ~9 ms
```

1000 Hz ingestion costs ~0.26 µs/event — pathological allocation risk is nil;
recording stays far below frame budgets; optimizer runtime is negligible.
Native-transport fixture suites replay 1000 Hz-class streams deterministically
without real sockets.

## 16. UI contract

`docs/UI-CONTRACT.md` freezes: engine APIs the redesign must keep
(HistoryApi, renderResumeList, SessionRunner.resumeFrom, analyzeNativeStream,
diagnostic bundles, recommendation fields), freely replaceable app files,
persisted schemas requiring migration discipline, calculations banned from
presentation code, and non-negotiable product behaviors (no silent downgrades,
no repeated measured trials, no telemetry, heuristic-confidence labeling).

## 17. Exact total test count

- Engine suite (`npm test`): **47 files, 335 tests — all passing**
- Browser suite (`npm run test:browser`): **11 tests — all passing**
- **Total: 346 automated tests**

New Pass 4 suites: pairedFitStats 5 | curveAdequacy 6 | changePoint 8 |
jointXYSearch 7 | captureQualitySession 9 | nativeDiagnosticsFixtures 10 |
nativeTransportProtocol 9 | captureNegotiation 7 | sessionResumeRecovery 8 |
historyApi 8 | calibrationHardening 9 | budgetEarlyStop 7 | failureInjection
9 | propertyInvariants 6 | informationAllocation 5 | regressionCampaigns 10
| versionErrorsLogging 10 | browser 11. All 201 Pass 1–3 tests still pass.

## 18. Lint/type/build/native-build results

```
npm run lint        eslint .                    0 problems
npx tsc --noEmit    strict TS incl. app/        clean
npm run build       vite production build       ✓ (dist-app/, ~142 KB js / 47 KB gzip)
npm run test:browser  playwright                11 passed
native helper       C source complete; NOT compiled here (no Windows toolchain
                    on this macOS host); BUILD.md provides MSVC/MinGW commands
```

## 19. Synthetic campaign results

`tests/regressionCampaigns.test.ts` (full simulate→optimize, hidden optima
never visible to the engine): low optimum below ladder stays honest
(unresolved/further-testing, conf ≤ 0.7); high optimum never confidently
missed; far-boundary keeps unresolvedBoundary semantics; noisy plateau keeps
wide ranges; noisy player covered or low-confidence; fatigue completes
cleanly; change-point wiring attaches; multimodal geometry refuses precise
claims. Joint-X/Y hidden-optima matrix (incl. false-asymmetry resolution)
passes exactly. Blind-recovery Pass 1–2 campaigns remain green.

## 20. Known remaining limitations

- The Windows helper compiles only on Windows; it has NOT yet run against
  real hardware, so nominal-rate parity at 1000 Hz rests on the protocol +
  fixture tests until Aldo's machine validates it.
- macOS native capture is deferred (architecture-ready; exact missing work in
  `docs/NATIVE-CAPTURE.md`).
- Confidence remains heuristic; empirical calibration awaits real test/retest
  data.
- Resume restores full engine state; the browser resume flow re-attaches via
  checkpoints but does not yet auto-restart an interrupted run without user
  confirmation (by design).
- Playwright coverage exercises one representative session shape; deeper
  scenario-matrix UI automation is future work.
- No real-human data collected yet; every recovery/statistics claim is backed
  by simulation and property tests.

## 21. Exact commit hash

Feature commit: `0308ff98d1bd97c02ae28efe24e58add253cafe1`
"Complete production aim engine and native capture architecture"
(branch ox/aldo-aim-lab-20260823T012332Z-7170a7e5).
This report was committed separately immediately afterward.

## 22. Remaining-work classification

**A. Must complete before V1**
1. Compile + run the Windows helper on the Fortnite machine; run the native
   probe; validate 125/500/1000 Hz parity against fixtures on real hardware.
2. One supervised end-to-end human smoke session per docs/MANUAL-TEST.md on
   the real machine (capture, resume-after-crash, calibration round-trip).

**B. Requires first real Aldo data**
1. Empirical confidence calibration from repeated test/retest outcomes.
2. Scoring-weight and threshold tuning (utility weights, quality cut-offs,
   duration-policy constants) against observed human variance.
3. Reliability coefficients (ICC-style) once ≥ 3 session pairs exist.
4. Adaptation-model threshold validation against real learning curves.

**C. Optional post-V1 improvement**
1. macOS helper implementation.
2. GP/Bayesian surrogate refinement beyond quadratic-with-guards.
3. Richer history visualizations (design-pass scope).
4. Deeper browser scenario-matrix automation; visual regression.
5. Multi-device profiles per player.

## 23. Recommended Pass 5 scope

1. On-hardware native validation sprint (A1/A2 above) — everything else
   depends on it.
2. Wire the empirical confidence mapping seam (`EmpiricalConfidenceMapping`)
   as soon as two reliable session pairs exist.
3. Retest-loop automation: schedule/launch targeted retest sessions from
   unresolved boundaries or stale calibrations directly in the app.
4. Small UX pass for resume/diagnostics copy before first external use.
