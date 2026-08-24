# Aldo Aim Lab — Engineering Pass 7 Final Report

Status: **Complete.** Feature commit `adc0556` — "Harden integrated Aldo Aim
Lab release" (33 files: +~1,900/−74, incl. the never-committed Windows
launcher scripts and 8 new test suites) — followed by this report committed
separately. Pass 7 is the integration + release-hardening pass executed
against the FULLY MERGED product (engine + Fable UI at `9d1b6a7`), the
exact artifact Aldo will run.

---

## 1. Integrated baseline commit

`9d1b6a7be9822a58aa5cb56cbae88f2d58de6f5e` — "Merge Fable V1 UI into Pass 6
release candidate". All findings below are against that tree.

## 2. Vitest/RPC root cause and resolution

**The documented "Vitest worker/RPC timeout" was a misdiagnosis of a missing
files defect.** Forensics across every branch in the repository showed that
`scripts/release/windows/start-aldo-lab.ps1`, `stop-aldo-lab.ps1`, and
`FIRST-RUN.md` — claimed as "real and contract-tested" in the Pass 6 report
— were **never committed anywhere** (`git log --all --diff-filter=A` is
empty for that path). Consequently `tests/securityRoundTwo.test.ts` failed
AT COLLECTION (deterministic ENOENT) on every committed tree since Pass 6:
the merged main's first run gave "Test Files 1 failed | 61 passed,
475/490 tests" with exit 1. The historical "Timeout calling onTaskUpdate"
symptom on the pre-merge UI branch could not be reproduced after the fix.

Resolution:
- Created the three launcher artifacts to satisfy the frozen S12 static
  contract tests (RNG token + `^[0-9a-f]{32}$` shape check, loopback-only
  HttpListener `Prefixes.Add("http://127.0.0.1:$port/")`,
  `$helperArgs = @(...)` quoted argument array, `GetFullPath` +
  `StartsWith($fullAppDir` traversal guard, MIME allowlist,
  TryParse-guarded PID kills, no shell-interpolation sinks).
- Verified reliability: **4 consecutive full-suite runs, exit 0 each**
  (24–26 s wall clock). No timeout values were raised; no assertions were
  weakened; no tests skipped.

## 3. UI-engine contract audit

- **Defect found & fixed**: results/home derived confidence COLOR from raw
  numeric cutoffs (≥0.7 / ≥0.4) while the engine labels use
  `CONFIDENCE_LABEL_THRESHOLDS` (0.5 / 0.8) — UI color and engine wording
  could disagree (0.72 rendered green/"moderate"). Both views now derive
  tone from the engine-owned `confidenceLabel`;
  `SessionSummaryViewModel` gained an optional `confidenceLabel` field so
  Home needs no numeric re-derivation.
- New `tests/uiContract.test.ts` statically enforces §4/§5 of
  docs/UI-CONTRACT.md over all of app/src: no network-capable APIs, no
  remote URLs, no numeric confidence re-derivation, no innerHTML-family
  sinks, fixed logical viewport geometry, engine seams wired
  (buildFinalResult/planNextTest/runPreflightChecks), elapsed-time-only
  render loop.
- Verified clean: preflight verdicts, calibration adequacy gating,
  capture-source negotiation, blinding, scenario timing, target geometry —
  all render engine outputs verbatim; no duplicated logic found elsewhere.
- docs/UI-CONTRACT.md updated with the "Pass 7 compatibility statement".

## 4. Active-session performance findings

Audited the live measurement path end-to-end (code-level; see budgets in
docs/RELEASE.md "Pass 7 additions"):

- Zero DOM work per raw input event — events flow only into the in-memory
  recorder even at 1000 Hz; HUD updates are bounded by session-state
  transitions; progress bar updates once per persisted trial (~70/session).
- The run screen removes the sidebar (`display:none`); charts exist only in
  History/Home and render solely on tab activation — none can run during
  trials. The only timer during play is the trial rAF loop; the Diagnostics
  probe ticker lives entirely inside an explicit user-triggered probe and
  clears itself.
- Frame cost is one cached-gradient fillRect plus a handful of arcs on the
  fixed 1280×720 backing store; no blur/shadow animates; the hit ring is
  draw-after-the-fact and self-expiring (160 ms).
- No layout thrash: state chip/detail are textContent writes; meter width
  writes are style-only.

## 5. High-refresh timing findings

New `tests/highRefreshTiming.test.ts` drives the real ScenarioDirector at
60/120/144/165/200/240 Hz frame cadences across all five scenarios:

- Recorded spawn timestamps are EXACTLY identical at every cadence (they
  are absolute scheduled times); trial-end expiry differs by ≤ one 60 Hz
  frame (deadline landing on the next frame — inherent, not drift);
  completion spread ≤ 16.67 ms; tracking motion is keyframe-interpolated by
  elapsed time with no frame-count input anywhere in the API.
- This validates the simulation/timing contract only — NOT real monitor
  behavior (see §20/§29-B).

## 6. Windows DPI/display findings

Coordinate model documented (docs/RELEASE.md): fixed 1280×720 LOGICAL
viewport; canvas backing store exactly 1280×720 CSS px scaled by CSS;
reticle deltas, targets, and eDPI math share one logical space so OS
scaling (100–200%) changes apparent size, never geometry relations;
`devicePixelRatio` is recorded as metadata only. Vite `base: "./"` added so
the packaged app is relocatable across any launcher port and remains
openable from disk as a last-resort fallback.

## 7. Pointer-lock/focus torture findings

- Engine coverage verified: lock denial, mid-trial lock loss, focus loss,
  tab hidden, resize, sleep/wake time-jump invalidation, pause/cancel
  (sessionRunner/stateMachine/lifecycleHardening suites).
- Gap found & closed: the ?e2e adapter had grant but no production-path
  loss simulation; added `simulateLockLoss()` (flows through
  emitForTesting → recorder.abort → runner.cancel) plus browser test
  proving ESC-style loss mid-trial ends the session visibly ("Session
  ended", partial data saved) and never silently continues.
- Launcher duplicate-launch handling: helper-port probe refuses to fight a
  running instance with an understandable message; stop script cleans both
  processes via PID files only.

## 8. Windows packaging status

- The missing launcher scripts now exist and satisfy packaging + verify-
  release + security contract tests end-to-end.
- Local dry-run packaging exercised fully on macOS: builds dist-app,
  packages 7 files (helper placeholder flagged `helperBinaryIsPlaceholder`
  — packager now synthesizes it instead of crashing), emits manifest.json
  + SHA256SUMS.txt; verify-release passes 11/11 (placeholder flag
  intentionally fails shippable verification).
- Repack determinism re-verified post-changes: byte-identical manifests.
- start script additionally verifies helper presence (offers honest
  browser-capture fallback), cross-checks manifest version metadata and
  helper SHA-256, waits for the helper's listen socket with clear failure
  text, opens the browser with a one-time shape-validated token.

## 9. Windows CI/artifact status

windows-release job retained (parity checks, MSVC /W4 /WX compile, full
suite on Windows host, lint/typecheck/build/verify/no-telemetry/npm-audit)
plus: zip renamed to versioned **Aldo-Aim-Lab-v{version}-windows-x64.zip**;
SHA-256 of the archive printed to job output AND step summary
(`SHA256:` line); artifact upload paths updated. No repository secrets
required anywhere.

## 10. Release zip status

Contents per manifest: `aldo_capture_helper.exe`, `app/` (relative-path
build), `start-aldo-lab.ps1`, `stop-aldo-lab.ps1`, `FIRST-RUN.md`,
`manifest.json`, `AldoAimLab-v*-SHA256SUMS.txt`. No source/tests/
node_modules ship. Assembly is mechanical via
`scripts/package-release.mjs` (CI) or `npm run package:dry-run` locally;
verification via `npm run verify:release`.

## 11. First-launch findings

Walkthrough re-verified through existing + new browser specs: first-use
Home teaches the three-step flow; readiness card recomputes in place;
missing-helper case explained twice over (launcher offers explicit
browser-capture continuation; Diagnostics states native stays unavailable
while browser capture keeps working); FIRST-RUN.md written for a
zero-knowledge player including SmartScreen/firewall guidance.

## 12. Migration/fresh-install findings

Existing coverage confirmed adequate (schemaFuzz envelope mutators, backup
attacks, future-schema rejection, checkpoint version fail-closed, mixed
engine-version histories). NEW: stored UI settings from earlier/hostile
versions are now sanitized against engine bounds on load AND save
(`sanitizeSettings`; S15) — previously a corrupt blob could poison DPI or
sensitivity inside experiment definitions.

## 13. History-scale findings

Extended `tests/historyScale.test.ts` with a 1000-session case (Pass 7 M):
snapshot < 15 s budget, summary list faster than snapshot, deterministic
ordering preserved, confidenceLabel present and valid on summaries.
Measured well under budgets (< 1 s seeding+snapshot on this machine).

## 14. Result-state torture findings

New `tests/browser/resultsTorture.spec.ts` pushes 16 distinct engine-built
states (strong optimum, moderate, low confidence, broad plateau,
unresolved low/high boundary, multimodal, insufficient evidence, capture
quality failure, adaptation contamination, stale calibration, staged
change, equal X/Y, unequal X/Y, retest required, continue-another-day)
through the REAL renderer via a test-only hook. Every state: no
NaN/undefined/null text, finite range-bar geometry, "What to do next"
always present, confidence wording matches engine label. (Lint also caught
that overrides were initially not applied — fixed before judging results.)

## 15. Security round-three findings

Documented in docs/SECURITY-REVIEW.md round three table:

| # | Finding | Severity | Resolution |
|---|---|---|---|
| S15 | Settings trusted on load/save (dpi -99999 or 1e9 accepted) | medium | sanitizeSettings clamps to engine bounds both directions; browser-tested |
| S16 | Launcher scripts absent from repo despite tests/packaging depending on them | high (build integrity) | committed with S12 contract enforced |
| S17 | Presentation XSS re-audit | clean | no HTML-injection sinks (statically tested); hostile names inert; prototype-pollution shapes inert; oversized input capped |
| S18 | Launcher→app token hand-off | info | one-time `?token=`, shape-validated before adoption |

## 16. No-telemetry findings

Audit CLEAN over sources AND final bundle after all changes (229.43 kB js /
76.08 gzip; 28.91 kB css). No fetch/XHR/EventSource/beacon, no remote
fonts/icons/CSS/images, no CDN, no analytics, no update checks — now also
statically guaranteed for app/src by uiContract.test.ts.

## 17. Accessibility findings

17-test dependency-light Playwright suite added (per-view labeled controls,
heading hierarchy, form label association, icon AT-hiddenness, dialog
focus/Esc). Two REAL defects found & fixed without visual change: card
titles h4→h3 (heading skips on setup/calibration/data pages) and form
labels programmatically associated (`for=` wiring in `field()`).

## 18. Viewport matrix findings

12-test matrix (1280×720 → 3840×2160 × overflow/dialogs/primary-action):
no horizontal overflow anywhere, dialogs fit at every size, primary actions
present (scroll-reachable at short heights — consistent with accepted
design). One test-harness fix along the way (view rebuilds on tab switch).

## 19. Failure-experience findings

Gap closed: IndexedDB open failures previously left Home/Data/History
blank. All storage-backed views now render a WHAT-HAPPENED /
IS-DATA-SAFE / WHAT-NEXT card with a truncated technical detail line.
Other audited failures already honest: helper absent (launcher + Diagnostics),
protocol mismatch (fail-closed handshake message), corrupt backup/restore
(rejection copy), analysis failure (results empty state + logged error),
unsupported environment (preflight BLOCKED).

## 20. Hardware-validation checklist

docs/MANUAL-TEST.md rewritten into THE sequential on-site checklist:
sections A–H covering artifact verification (zip SHA-256 vs CI summary,
manifest flag, helper present), launcher start/stop/duplicates, machine
facts (scaling %, refresh Hz, polling Hz, browser), in-app readiness incl.
native probe vs observed rate, pointer-lock sanity incl. Esc/Alt-Tab/
unplug, full session completion, results/history/backup/restore round
trip, crash-resume, close-out with second validation-bundle export. Every
row has Gate (HARD/soft/record) + Evidence columns.

## 21. Hardware validation bundle

New engine seam `src/diagnostics/hardwareValidation.ts`
(`buildHardwareValidationBundle`) + Diagnostics export button: kind
`aldo-hardware-validation-bundle` v1 with release versions (app/engine/
optimizer/native protocol/helper), runtime facts (UA, platform, screen,
DPR, cores, estimated refresh Hz from the Diagnostics rAF probe), latest
capture self-test (nominal vs observed rate, failed checks, transport
counters incl. drops/jitter counters), session smoke status, resume/checkpoint
status, calibration status, warnings list, timestamps. Compact (< 20 KB),
no raw samples, no personal data beyond the player-name field; local-only
until deliberately shared. Unit-tested both populated and fresh-install.

## 22. Exact automated test count

**Engine suite (`npm test`): 65 files, 508 tests** (baseline 62/490;
+3 files, +18 tests: highRefreshTiming 7 | uiContract 8 |
hardwareValidationBundle 2 | historyScale +1).
**Browser automation (`npm run test:browser`): 73 tests**
(baseline 23; +50: resultsTorture 16 | accessibility 17 | viewportMatrix
12 | securityRoundThree 4 | pointer-lock-loss 1).

## 23. npm test reliability/runtime

Exit code 0 on 4 consecutive full runs this pass (24–26 s wall each; ~57–70 s
cumulative test time across fork workers). Longest files: blindRecovery
~18 s, sessionReplay ~6 s, regressionCampaigns ~4 s. Worker config unchanged
(default forks pool, maxConcurrency 4, seed 20260822). No flaky behavior
observed in any repeat run; the two slowest suites are Monte-Carlo-shaped
and deterministic.

## 24. Browser test count

**73 passed** (single worker, Chromium; includes full e2e session,
torture matrix, viewport matrix at six sizes, accessibility sweep,
security round three).

## 25. Lint/type/build/package/audit results

| Check | Result |
| --- | --- |
| `npm run lint` | 0 problems |
| `npx tsc --noEmit` | clean |
| `npm run build` | ✓ 229.43 kB js / 76.08 kB gzip · 28.91 kB css (budget ≤ 250 kB) |
| `node scripts/package-release.mjs` (dry-run) | ✓ 7-file folder + manifest + SHA256SUMS; repack byte-identical |
| `node scripts/verify-release.mjs` | ✓ 11/11 (dry-run placeholder flag correctly fails shippable gate) |
| `node scripts/audit-no-telemetry.mjs` | CLEAN (sources + bundle) |
| `npm audit --audit-level=moderate` | 0 vulnerabilities |

## 26. Exact feature commit hash

`adc05564b47b43fddc89f3bfa4f23d60ddf56751` — "Harden integrated Aldo Aim
Lab release".

## 27. Exact report commit hash

A separate commit containing ONLY PASS-7-REPORT.md, created immediately
after `adc0556`. A commit cannot contain its own hash; read it with:

    git log --format=%H --grep "Add Pass 7 report" -1

## 28. Known defects

- Completed sessions can leave a 0-trial "running" checkpoint behind
  (pre-existing engine quirk, rendered honestly as a resumable entry;
  discard works).
- Chart tooltips remain native browser tooltips; rest overlay has no
  countdown (both documented post-V1 items awaiting engine seams).
- Firefox/Safari remain functional-untested (warn-not-compensated capture).
- Launcher HttpListener may require a one-time URLACL on some Windows
  configs; handled with a single UAC-elevated `netsh` offer plus disk-open
  fallback instructions (enabled by relative asset base).
- Helper exe compilation still requires a Windows host; nothing here claims
  physical Raw Input validation.

## 29. Remaining work classified

**A. SOFTWARE WORK REQUIRED BEFORE HARDWARE VALIDATION** — none.
All gates are green; the RC artifact pipeline is complete up to the point
where a Windows runner produces the exe.

**B. HARDWARE-ONLY VALIDATION**
1. Real 200 Hz monitor behavior: motion feel, target contrast/visibility,
   hit-ring readability at high refresh (simulations prove timing logic
   only).
2. Native tier-1 capture end-to-end with the compiled helper at real
   125/500/1000 Hz polling (observed-rate parity, jitter/drops).
3. Windows scaling interaction with the 1280×720 stage on Aldo's actual
   display mode (100–200%).
4. URLACL/UAC path of the launcher on his machine; SmartScreen flow.
5. Chrome-vs-Edge pointer-lock/coalescing parity on his install.

**C. HUMAN-DATA CALIBRATION** (unchanged from Pass 6 §24)
1. Empirical confidence mapping from repeated test/retest outcomes.
2. Scoring-weight/threshold tuning against observed human variance.
3. Reliability coefficients (≥ 3 session pairs).
4. Adaptation/change-point threshold validation on real learning curves.
5. Provisional budget/scenario-allocation recommendations vs human fatigue.

**D. OPTIONAL POST-V1**
1. Styled chart tooltips; rest countdown (needs engine seam).
2. X/Y asymmetry panel when jointXY runs; session-detail deep view.
3. Signed release tags + checksum publication page.
4. macOS helper implementation.
5. Live in-browser resume execution UX beyond the mandated hand-off dialog.

## 30. GO / NO-GO — producing the Windows RC artifact

**GO.** Push this commit; the `windows-release` CI job produces and uploads
`Aldo-Aim-Lab-v1.0.0-rc.1-windows-x64.zip` + checksums with the SHA-256 in
the job summary. Every input to that artifact is verified on this machine
except the MSVC compile itself, which only a Windows runner can perform.

## 31. GO / NO-GO — installing the RC on Aldo's PC

**GO,** contingent on exactly two checks during artifact intake (both part
of MANUAL-TEST section A): zip SHA-256 matches the CI-printed value, and
`manifest.json` shows `helperBinaryIsPlaceholder: false`. Then follow
docs/MANUAL-TEST.md top-to-bottom and export the hardware-validation
bundle at D5 and H1.

---

## Explicit judgments

**Was the merge actually safe before this pass?** No — and that is the
headline finding. The integrated tree failed its own test suite at
collection because files the entire release pipeline depended on had never
been committed. Engine-green + UI-green did not imply merge-green; only an
actual integrated regression audit surfaced it. It is now fixed with the
real artifacts, not test edits.

**Did anything weaken?** No assertion was loosened, no timeout raised, no
test skipped, no threshold moved. The only behavioral deltas are fixes
(confidence-tone alignment, settings sanitization, storage-failure cards,
a11y heading/label semantics, side-effect suppression) — each documented in
the UI-CONTRACT Pass 7 statement and guarded by new tests. Visual design is
unchanged; CSS is class-driven, so the h3 change alters semantics only.

**Is npm test boring now?** Yes: 508 tests, exit 0, ~25 s, four for four
this pass, longest file under 20 seconds.
