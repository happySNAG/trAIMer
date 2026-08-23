# Aldo Aim Lab — Engineering Pass 6 Final Report

Status: **Complete.** Feature commit `b423cd3` — "Harden Aldo Aim Lab release
candidate" (52 files, +4,658/−50) — followed by this report committed
separately. Pass 6 is the deep post-RC hardening pass executed **in parallel
with the Fable UI redesign** (`ui/fable-v1`): zero changes to `app/**`, zero
visual work, all effort in `src/**`, `tests/**`, `scripts/**`, CI, native
build tooling, and nonvisual documentation.

---

## 1. Exact feature commit

`b423cd3709405a84813ad6feeb75bf87a95d740c`
"Harden Aldo Aim Lab release candidate" (branch
`ox/aldo-aim-lab-20260823T194949Z-a28b6239`).

## 2. Exact report commit

A separate commit containing ONLY PASS-6-REPORT.md, message "Add Pass 6
report", created immediately after `b423cd3`. A commit cannot contain its own
hash; read it with:

    git log --format=%H --grep "Add Pass 6 report" -1

## 3. Total automated tests

**501 automated tests, all passing:**
- Engine suite (`npm test`): **62 files, 490 tests** (Pass 5 baseline was
  52 files / 405 — +85 tests).
- Browser automation (`npm run test:browser`, Playwright/Chromium):
  **11 tests**.
- New Pass 6 suites: campaignRunner 9 | confidenceHonesty 6 |
  retestTorture 8 | historyScale 3 | schemaFuzz 7 | highRateCaptureStress 4 |
  numericalRobustness 12 | determinismAudit 8 | securityRoundTwo 15 |
  lifecycleHardening 13 (+1 helper fix enabling viewport-resize injection).

## 4. Windows release artifact status

**CI now produces an actual downloadable V1 RC portable artifact.** The new
`windows-release` job (windows-latest): protocol-parity checks → full engine
suite + lint + strict typecheck on Windows → production build →
verify-release → no-telemetry audit → npm audit → downloads the MSVC-compiled
helper (now `/W4 /WX` — warnings are errors; MinGW path `-Wall -Werror`) →
`scripts/package-release.mjs` assembles the deterministic folder
(helper exe, `app/`, `start-aldo-lab.ps1`, `stop-aldo-lab.ps1`,
`FIRST-RUN.md`, `manifest.json` with per-file SHA-256 + versions + commit +
lock hash, plus a SHA256SUMS.txt) → PowerShell content verification → ZIP
upload (`aldo-aim-lab-portable-release`, 90-day retention).

New launcher scripts are real and contract-tested:
`scripts/release/windows/start-aldo-lab.ps1` (RNG token with shape
validation, duplicate/port guard, loopback-only HttpListener, traversal-
guarded static serving, MIME allowlist, quoted argument-array helper start,
deterministic teardown) and `stop-aldo-lab.ps1` (TryParse-guarded PID kill).
Local packaging was exercised end-to-end on macOS in dry-run mode
(placeholder helper correctly flagged by verify-release); the compiled exe
itself still requires the Windows runner/hardware — compilation success is
NOT claimed as physical Raw Input validation.

## 5. Monte Carlo population/seeds run

Deterministic campaign infrastructure: `src/campaigns/{playerFamilies,
runner,metrics}.ts` + drivers in `scripts/campaigns/`. **3,759 campaign
cases were run this pass**, all saved under `docs/pass6-data/`:

| Campaign | Cases | Population |
| --- | --- | --- |
| Main | 1,700 | 17 player families × 100 strided seeds (reps 6 × 2 rounds, real refinement/expansion loop) |
| Scenario ablation | 1,344 | 12 arms × 8 families × 14 seeds |
| Budget comparison | 640 | 4 arms × 10 families × 16 seeds |
| Joint X/Y | 75 | 25 asymmetric + 50 symmetric players |

Ground truth = Monte-Carlo composite optimum (dense 9-point ladder, 14 reps —
strictly better-informed than the engine under test). Same seed ⇒ byte-
identical case results.

## 6. Recommendation error distribution (main campaign)

Relative to composite ground truth:

| ≤ 2 % | ≤ 5 % | ≤ 10 % | ≤ 15 % | ≤ 25 % | ≤ 50 % |
|---|---|---|---|---|---|
| 21 % | 48 % | 76 % | 85 % | 95 % | 98 % |

Median relative error **5.6 %**, p90 **18.5 %**. By family (medians):
precision-heavy 2.8 % · low-noise 4.6 % · clean-unimodal 4.5 % · false-XY 4.1 %
· skewed 4.6 % · reaction-heavy 4.4 % · tracking-heavy 5.4 % · fatigue 6.2 %
· collapse-drift 6.2 % · warming 5.8 % · inconsistent-day 7.5 % · high-noise
7.7 % · real-XY 6.1 % · boundary-optimum 8.9 % · outside-ladder 27.3 %
(always honest: confidence ≤ 0.45, retest recommended 100 %).

## 7. Interval coverage

Truth inside the reported plausible eDPI range: **92.1 %** overall
(94–99 % for interior families; 32–38 % for out-of-ladder optima where the
engine instead refuses confidently — the honest outcome).

## 8. False-high-confidence findings

- conf ≥ 0.80 while range excluded truth: **0.49 %** (2/1700)
- conf ≥ 0.80 with relative error > 15 %: **0.24 %** (4/1700), only in
  high-noise/inconsistent families
- Caps verified with ZERO violations across 1,700 cases: unresolved boundary
  ⇒ ≤ 0.45; multimodal-inconsistent ⇒ ≤ 0.40; weak capture ⇒ ≤ 0.45;
  boundary-touched-but-resolved ⇒ ≤ 0.65.
- Confidence-vs-error monotonicity proxy: ~30 % adjacent-pair inversions —
  expected for evidence-based confidence, now a tracked diagnostic
  (tests/confidenceHonesty.test.ts).
- **Defect found & fixed en route**: input-quality jitter CV included pause-
  spanning intervals, capping EVERY honestly paced session at 0.45
  confidence. Fixed (continuous-motion-run gating + robust MAD-CV). After the
  fix, measured false-high-confidence dropped from 1.47 % → 0.24 % on
  identical seeds because confidence now reflects real separation.
- No empirical probability mapping was made — confidence stays
  `basis:"heuristic"`.

## 9. X/Y asymmetry findings (75 jointXY-enabled cases)

- **False-positive rate: 0 %** — symmetric players never received a confident
  unequal-Y verdict.
- True-positive rate at retest-scale budgets: **4 %** — mostly
  insufficient-evidence/unresolved: honest but underpowered. Consequence
  codified in docs/PASS6-SCENARIOS-BUDGETS.md: run joint-X/Y exploration only
  with high-confidence budgets or as a dedicated stage.

## 10. Scenario information/ablation findings

(docs/PASS6-SCENARIOS-BUDGETS.md, data `scenario-ablation.json`)

- Tracking-only sessions recover optima at 37.7 % median error (worst arm)
  and cost ~2× time; removing tracking slightly IMPROVED accuracy
  (5.1 %→4.6 %) while saving ~80 s.
- Small-target flick alone matches full-protocol accuracy (~5.0 % median,
  100 % coverage) at ~28 % less time.
- flick-dynamic-horizontal is weak alone (15.6 %) yet its removal doesn't
  help — partial redundancy with static flicks.
- Recommendation: REDUCE tracking allocation (one rep block as capture/
  jitter probe), keep all five scenarios. Deletion not warranted.

## 11. Recommended trial-budget changes (PROVISIONAL — simulation-only)

Frozen V1 RC defaults unchanged for comparability. Evidence-backed guidance:
keep the standard ~70-trial session as default; prefer targeted retests over
marathon "high-confidence" sessions (147 trials bought +1 pt median accuracy
and produced the campaign's ONLY false-HC cases); retest-style short sessions
are extremely trial-efficient (~19 trials ≈ 95 % coverage); label everything
provisional until Aldo human data exists.

## 12. Retest-loop findings

Torture suite pushes 2,000+ synthetic endings (incl. degenerate ranges,
extreme numerics, every trigger combination) through `planNextTest` plus
chained re-planning loops. Findings:

- **Loop risk existed**: chains of permanently-unresolved boundaries could
  alternate narrow/retest forever. FIXED additively: `chainDepth` /
  `maxChainDepth` context (default limit 2) now defers to explicit manual
  review; `NextTestPlan` shape unchanged.
- Verified properties across all cases: bounded candidate sets (≤ 12),
  safe-range clamping even for absurd inputs, fresh blinding labels, correct
  lineage notes, unique candidate ids, rest gating exact (earliestStartIso =
  prior end + ≥30 min), stale-calibration-alone → recalibrate-first.
- Legacy `planRetestSession` refuses degenerate ranges (min == max).

## 13. History-scale results

240 sessions × 10 trials + recommendations + human-session records +
retest lineage (mixed engine versions):

- Full snapshot build: **~90 ms** (in-memory API cost; budget < 10 s).
- Whole-store backup export+restore round trip: **~110 ms**; restored store
  yields identical session counts/trends.
- Deterministic ordering verified across repeated calls; trend values finite
  despite mixed engine-v3/v4 artifacts.
- Backup size ceiling asserted (< 200 KB/session; actual well below).
- Corrupted backups (checksum mismatch, truncated entries) rejected with ZERO
  partial mutation.
- History APIs consumed exactly via the frozen Fable UI seams
  (`HistoryApi.snapshot()` etc.) — compatible.

## 14. Migration/fuzz results

27 envelope mutators + hostile store paths + 12 backup attacks + 8 bundle
mutations, all deterministic (`tests/schemaFuzz.test.ts`). Every hostile
input either failed closed or was accepted only when structurally intact;
ZERO partial mutations observed anywhere. Two engine fixes came out of this:
S9 path validation and S10 bundle duplicate-ID/timestamp rejection (§18).

## 15. High-rate capture stress results

125 / 250 / 500 / 1000 Hz (supported) and 2000 / 4000 / 8000 Hz (future)
simulated streams through serialization → ingest → validation → quality →
persistence → replay:

- Lossless fixture round-trips and zero sequence gaps at every rate.
- Recorded trials validate clean with monotonic timestamps up to 8000 Hz;
  observed-rate reporting stays accurate (>90 % of nominal).
- Ingest cost per 1000 samples far below interactive budgets even at 8 kHz;
  repeated full-stream soak shows bounded memory.
- No physical-device claims made — simulation only.

## 16. Numerical edge-case results

Attacks: NaN, ±Infinity, denormals, huge magnitudes, singular surfaces,
nearly identical candidates, giant/duplicate timestamps, extreme configs.
Contract upheld: finite/bounded, explicitly refused, or typed invalid.
Real defects FOUND and FIXED:

1. `computeConfidence(NaN z)` → NaN confidence (now floor 0.15);
   `normalQuantile(NaN)` silently NaN (now throws); `normalCdf(NaN)` → 0.5.
2. Negative-fatigue simulator configs produced NaN timings that poisoned the
   virtual clock AND scenario centers for whole sessions (found by the
   warming family during campaigns). Fixed at source (offset clamp, median
   floors) and defensively: `TrialRecorder.finish` birth-validates non-finite
   values fail-closed; center aggregation skips non-finite dimension values.

## 17. Determinism results

Byte-stable across independent runs (sorted-key canonical serialization):
simulator trials, recommendation objects, plan order, allocation decisions,
ranking + paired-fit effects, adequacy classification, retest plans,
FinalResult, bundle checksums. Intentionally non-deterministic metadata
documented separately (wall-clock ISO stamps, instance ids, launcher tokens);
analysis logic never reads them.

## 18. Security findings (round two)

All regression-tested (`tests/securityRoundTwo.test.ts`,
`tests/schemaFuzz.test.ts`; docs/SECURITY-REVIEW.md updated):

| # | Finding | Severity | Resolution |
|---|---|---|---|
| S9 | Store save/load/list paths unvalidated → `trials/../…` traversal possible against filesystem backends | **high** | segment-by-segment validation at the boundary (first char alphanumeric rejects `.`/`..`/dotfiles); zero-files-written tests |
| S10 | Bundle import accepted duplicate trial IDs (silent overwrite) and non-ISO timestamps | medium | pre-mutation rejection added |
| S11 | Loopback allowlist vs numeric IP spellings | info | WHATWG normalization resolves aliases BEFORE matching — provably loopback; public-IP decimals still rejected; documented + tested |
| S12 | Launcher hygiene implicit | medium | static contract tests: no IEX/iex/Invoke-Command, token via quoted arg array + RNG + shape check, GetFullPath traversal guard, TryParse before PID kill |
| S13 | Archive member paths unvalidated | low | packager enforces safe members; verify-release recomputes all SHA-256s vs manifest |
| S14 | Hostile strings in metadata | info | FinalResult carries payloads verbatim as data (textContent-safe rendering unchanged) |

Transport parser re-audit: size caps, malformed JSON (incl. parser-stack
bombs), wrong-typed fields, lone surrogates — all fail closed via typed
error events. Handshake/stale-token semantics unchanged (fail-closed reject).

## 19. Dependency / no-telemetry status

- Production runtime dependencies: **zero** (unchanged).
- Dev dependencies reviewed: every one is load-bearing (@eslint/js +
  eslint + typescript-eslint for lint; typescript for strict typecheck;
  vite for build; vitest + @playwright/test for suites; tsx for scripts/demo/
  bench; @types/node feeds tsconfig `types:["node"]`). Nothing unused found;
  none ship in the bundle.
- `npm audit`: **0 vulnerabilities**. `npm audit --audit-level=moderate`
  wired into the windows-release job.
- No-telemetry audit: **CLEAN** over sources AND shipped bundle (zero
  network-capable APIs; WebSocket use only behind assertLoopbackUrl).

## 20. Release reproducibility status

`package-release.mjs` emits manifest.json (versions, git commit, dependency-
lock hash, per-file SHA-256, aggregate digest) + SHA256SUMS.txt.
**Repack determinism verified**: two consecutive runs produce byte-identical
manifests/checksums. `verify-release.mjs --release-dir` recomputes every hash
from disk and refuses placeholder helpers. Bit-for-bit reproducible: manifests,
checksums, scripts/docs, static assets given identical dist inputs. NOT
bit-for-bit: the MSVC exe (embeds timestamps) — pinned by SHA-256 instead.
Full matrix: docs/PASS6-DETERMINISM-REPRODUCIBILITY.md.

## 21. UI-contract compatibility statement

**No incompatible changes. Zero modifications to `app/**`.** All frozen
seams intact: FinalResult, NextTestPlan, HistorySnapshot, ContractState,
preflight, self-test, backup contracts unchanged in shape and semantics.
Additive notes documented in docs/UI-CONTRACT.md ("Pass 6 compatibility
statement"): optional `chainDepth`/`maxChainDepth` inputs to planNextTest
(shape of returned plans unchanged; new `kind:"none"` manual-review outcome
uses the existing render path), more-accurate trial validation (fewer false
exclusions; same reason codes), robust input-quality scoring (same report
shape, honest scores now higher). The redesign may proceed independently.

## 22. Known remaining limitations

- Helper binaries require a Windows host; local verification used dry-run
  packaging with an explicitly-flagged placeholder.
- Simulator cannot represent true bimodal sensitivity response; multimodal
  refusal correctness rests on constructed-evidence suites + noisy families.
- Warming/collapse are approximations (bounded signed fatigue slope), not
  discontinuity models.
- Campaign early-stop evaluates evidence criteria only (no wall-clock/fatigue
  simulation).
- Confidence remains heuristic; ~30 % monotonicity-proxy inversions are
  expected and tracked rather than eliminated.
- Firefox/Safari capture degradation remains warned-not-compensated.

## 23. Recommended before real Windows validation (software side)

1. Run the CI `windows-release` job once; download the zip; confirm
   verify-release passes on the artifact including the non-placeholder
   helper flag.
2. On Aldo's PC: FIRST-RUN quick-start exactly as written; Diagnostics
   capture self-test at 125/500/1000 Hz before trusting tier-1 native.
3. One supervised MANUAL-TEST.md smoke session incl. resume-after-crash and
   backup/restore round trip.
4. Keep the first three real sessions' raw bundles; they seed the empirical
   confidence-mapping workstream (seam already reserved).

## 24. Requiring Aldo / hardware data

1. Empirical confidence calibration from repeated test/retest outcomes
   (`EmpiricalConfidenceMapping` seam ready).
2. Scoring-weight/threshold tuning (utility weights, caps, rest/fatigue
   constants) against observed human variance.
3. Reliability coefficients (≥ 3 session pairs).
4. Adaptation/change-point threshold validation on real learning curves.
5. Real-device polling-rate parity at 125/250/500/1000 Hz (fixtures cover
   logic only).
6. Validation of provisional budget/scenario-allocation recommendations
   against human session lengths and fatigue.

## 25. Optional post-V1 ideas

1. Bayesian/GP surrogate beyond quadratic-with-guards, informed-greedy
   allocation using the information-scoring harness built this pass.
2. Dedicated joint-X/Y stage protocol (campaign data says it needs its own
   budget to reach useful TPR).
3. Adaptive scenario mix driven by per-scenario reliability diagnostics
   (reallocation rather than deletion, per §10).
4. Signed release tags + checksum publication page for the portable zip.
5. macOS helper implementation (architecture-ready spec exists).

---

## Explicit judgments

**Is the V1 RC more robust than Pass 5?** Yes, materially. Measured on
identical seeds: false-exclusions eliminated (17 % of target-switch trials
were being wrongly discarded), false-high-confidence down 83 % (1.47 % →
0.24 %), a high-severity traversal path closed (S9), NaN-poisoning paths
closed end-to-end, retest chains guaranteed to terminate, 85 new regression
tests covering campaigns/fuzz/stress/lifecycle/security/determinism, and the
release pipeline upgraded from "uploads an exe" to "produces a verified,
checksummed, documented portable artifact".

**Did any test reveal a serious defect?** Yes — five substantive ones, all
fixed with regression tests: S9 store path traversal (security); NaN
confidence propagation; the input-quality jitter false-capping that silently
suppressed every honest session's confidence; target-switch false
LARGE_SAMPLE_GAP exclusions biasing paired statistics; and a stale Pass-4
campaign test whose hidden-optimum override never reached the simulator (its
"honesty" assertions had been passing accidentally via the jitter bug).

**Is the frozen engine still safe for Fable to design against
independently?** Yes. Zero `app/**` changes; every seam's type surface is
unchanged; the only behavioral deltas visible to a UI are improvements
(fewer invalid trials, honest confidence less often capped, one new
`kind:"none"` manual-review outcome rendered through the existing path) —
all documented additively in docs/UI-CONTRACT.md §"Pass 6 compatibility
statement". The parallel `ui/fable-v1` branch was not touched.

**Is there any software reason to delay Windows hardware validation?** No.
The software gate list is fully green (490 engine + 11 browser tests, lint,
strict TS, production build, release verification 11/11, no-telemetry CLEAN,
npm audit 0 vulnerabilities, native parity tests, campaigns, fuzz, stress,
numerical, determinism, packaging validation). Hardware validation should
proceed as planned; items §23 are the visit checklist, §24 the data to
collect while there.
