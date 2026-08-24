# Aldo Aim Lab — Engineering Pass 8 Final Report

Status: **Complete — FINAL PRE-HARDWARE RELEASE AUDIT.** Feature commit
`25ebb65` — "Finalize Aldo Aim Lab pre-hardware release" (29 files,
+508/−123: 16 defects fixed across engine, UI, launcher, CI, and docs; 9
new regression tests; version advanced to **1.0.0-rc.2**) — followed by this
report committed separately.

Pass 8 was a hostile release audit, not a feature pass. Its purpose was to
try to prove the RC is NOT ready. It found real defects — including two
silent data-integrity failures that would have corrupted Aldo's own session
history during the hardware visit — fixed them with regression tests, and
re-ran every gate. The conclusion: **A = NONE; GO.**

---

## 1. Baseline commit

`02a13e4` — "Add Pass 7 report" (the fully merged, hardened Pass 7 tree).
All findings below are against that baseline.

## 2. Defects found

Sixteen demonstrated defects (2 launcher, 7 app-layer, 5 engine, 1 test-
suite, 1 documentation), listed with fixes in §3. The most serious:

| # | Severity | Defect |
|---|---|---|
| D1 | **major / data-integrity** | Every live session reused ONE experiment id (`experiment-live-<seed>`, seed default constant). Each new session overwrote the previous `recommendations/`, `experiments/`, `optimizer-runs/`, `audit/` artifacts AND mixed all trials into one `trials/<id>/` folder; history summaries then displayed the NEWEST recommendation/confidence for EVERY past session. Two back-to-back sessions on Aldo's PC would silently destroy session 1's provenance and contaminate trends/rankings. |
| D2 | **major / data-loss (latent)** | `NodeFsBackend.listFiles` used a FLAT `readdir`: on filesystem backends, whole-store backups contained ZERO nested trials/checkpoints while their SHA-256 "verified" successfully. Silent loss in the disaster-recovery path. (Browser IndexedDB path unaffected — latent until a desktop/CLI backend runs.) |
| D3 | **major / contract** | Native handshake checked protocolVersion but NEVER compared `helperVersion`, despite `EXPECTED_HELPER_VERSION` being documented as fail-closed handshake pinning (the compromised-helper mitigation in SECURITY-REVIEW). A wrong-build helper could stream data into tier-1 trust decisions. |
| D4 | **major / UX-failure** | `BrowserRunController.create()`/`start()` rejections were unhandled: blocked storage left the arena dead ("Click to lock in" forever); a mid-session runner rejection bricked the hidden-sidebar chrome until manual reload. |
| D5 | **major / security-hygiene** | Launcher token adopted from `?token=` was never stripped from the URL/history — and adoption was LAZY (only when Diagnostics opened), so the credential could sit in the address bar indefinitely across reloads/screenshots/bookmarks. |
| D6 | **major** | `InstanceGuard` replied to every peer message unconditionally → two tabs ping-ponged BroadcastChannel messages forever at full speed (the exact duplicate-instance scenario the guard exists for). |
| D7 | **major-in-flow** | Calibration "Start rep" ignored pointer-lock denial: rep "ran" unlocked (counter stuck at 0, no feedback) and every later click skipped locking entirely — unrecoverable without reload. |

Plus: self-test records stamped `new Date(performance.now())` → **1970-era
provenance timestamps** persisted into the hardware-validation evidence;
rAF refresh estimate diluted up to 4 s by helper-stall dead time; one
truncated checkpoint JSON hid the ENTIRE resume list and broke Discard;
completed-session storage error rendered a misleading "No results yet";
calibration preview re-implemented engine math (dropping the `turns`
factor); ranking history fabricated identical per-candidate eDPI values;
bundle import accepted `schemaVersion: 0`; Home trend card had an unhandled
rejection; Diagnostics claimed storage health unconditionally.

## 3. Defects fixed (all in feature commit `25ebb65`)

**Engine (`src/`)**
1. Handshake now fails closed on `helperVersion !== EXPECTED_HELPER_VERSION`
   and on non-finite/non-positive `nominalRateHz`
   (`src/capture/nativeClient.ts`; tests/nativeTransportProtocol +2).
2. `InstanceGuard` replies exactly once per NEW peer
   (`src/lifecycle/lifecycle.ts`; storm-bound regression test added).
3. `NodeFsBackend.listFiles` walks recursively and returns relative POSIX
   paths; backup round-trip test proves trials survive export→restore
   (`src/persistence/nodeBackend.ts`; persistenceBackends +1).
4. Bundle import rejects `schemaVersion < 1` (bundle.ts; test extended).
5. Ranking rows use real per-candidate eDPI from
   `explanation.candidatesTested`, range-min only as legacy fallback
   (`src/history/api.ts`; historyApi +1).
6. Dead `"window-blur-focus-restore"` exemption removed — no source ever
   emitted it; behavior is UNCHANGED (focus loss mid-trial stays fatal per
   MANUAL-TEST E4) but the code now matches its stated intent.

**App (`app/src/`)**
7. Experiment identity is now per-session:
   `makeExperimentId(\`live-${seed}-${Date.now().toString(36)}\`)`. Candidate
   order, blinding, scenario instances, and all statistics still derive ONLY
   from `orderSeed = experimentSeed` — statistical behavior is untouched;
   only artifact keys stopped colliding.
8. Eager token adoption at boot + `history.replaceState` strip (file:// safe);
   caught create()/start() rejections render a WHAT-HAPPENED / IS-DATA-SAFE /
   WHAT-NEXT failure card instead of a dead screen.
9. Finish-line failure now renders an honest session-failure card (trials ARE
   saved trial-by-trial) instead of "No results yet".
10. Calibration: lock result honored (inline alert + retry re-arms lock),
    preview table uses engine `degreesPerCountForRep`, save failures surface.
11. Resume list isolates unreadable checkpoints per-artifact; discard loop
    continues past corrupt files and reports failure honestly.
12. Self-test `startedAtIso` uses wall clock; rAF estimate clamped to the
    counted window; Diagnostics shows a danger Storage tile when IDB fails;
    Home trend failure gets a muted fallback; transition log records real
    previous state.

**Launcher (`scripts/release/windows/start-aldo-lab.ps1`)**

13. URLACL argument quoting: `Start-Process -ArgumentList` joins WITHOUT
    quoting, so `user=DOMAIN\John Smith` (space in username) previously broke
    the elevated netsh call — embedded quotes added. Browser-open failure no
    longer kills the launch silently (prints the manual URL). Removed the
    misleading unused `-port` parameter (it was silently overridden).

**CI (`.github/workflows/ci.yml`)**

14. Both Windows jobs now parse both launcher scripts with
    `[System.Management.Automation.Language.Parser]::ParseFile` and fail on
    syntax errors (static PowerShell gate; no secrets, no product change).

**Docs**

15. docs/PACKAGING-WINDOWS.md rewritten to match shipped reality (auto-picked
    48800–4809 web port, fresh-token-per-launch, `.aldo-lab/*.pid` state,
    manifest/FIRST-RUN/SHA256SUMS layout, `verify-release --release-dir`).
16. docs/MANUAL-TEST.md §C expanded to record Windows version, native
    resolution + scaling %, mouse make/model, in-app DPI/sens, browser;
    cross-references fixed (D4→C4 etc.).

## 4. Windows packaging audit

End-to-end dry-run exercised twice locally (placeholder helper, correctly
flagged): folder `AldoAimLab-v1.0.0-rc.2/` contains EXACTLY
`aldo_capture_helper.exe`, `app/index.html` + `app/assets/*` (relative base),
`start-aldo-lab.ps1`, `stop-aldo-lab.ps1`, `FIRST-RUN.md`, `manifest.json`,
plus `AldoAimLab-v1.0.0-rc.2-SHA256SUMS.txt` beside it. Verified ABSENT:
source tree, tests, node_modules, secrets, local absolute paths, temp files
(grep over packaged output clean). Manifest carries app/engine/optimizer/
protocol/helper versions + commit + dependency-lock hash + per-file SHA-256 +
aggregate digest. `verify-release.mjs --release-dir` recomputes every hash
from disk (12/13 pass in dry-run; the placeholder-flag check is the one
intentional failure that CI's real MSVC build clears). CI zip step names the
artifact `Aldo-Aim-Lab-v1.0.0-rc.2-windows-x64.zip` automatically and prints
its SHA-256 to the job summary.

## 5. Launcher audit

Line-by-line static review of start/stop scripts (see §3.13 for fixes).
Verified statically: RNG token + shape check; loopback-only HttpListener
prefix; GET-only; regex+`..`+GetFullPath+StartsWith traversal defense; MIME
allowlist; quoted argument-array helper start; TryParse-guarded PID-only
teardown; duplicate-launch refusal via port probe; ≤10 s helper-listen wait
with honest failure text; Edge/Chrome-neutral (default browser handler);
non-ASCII paths handled by .NET APIs; spaces-in-username now safe. New CI
step parses both scripts on windows-latest so drift breaks builds, not
Aldo's evening.

## 6. Windows CI audit

`windows-release` (windows-latest, needs native-windows): npm ci → PS parse
gate → C↔TS parity vitest + build-script validation → FULL engine suite on
Windows → lint + strict typecheck → production build → verify-release →
no-telemetry (sources + bundle) → npm audit → download MSVC exe (/W4 /WX,
warnings-as-errors) → package with commit SHA → pwsh content verification
(non-placeholder + required files) → zip + SHA-256 in step summary → upload
(90-day retention). No repository secrets anywhere. `native-windows` job
unchanged plus the new PS parse gate.

## 7. Release artifact reproducibility

Two consecutive packaging runs compared recursively: **byte-identical**
(manifests, checksums, scripts, static assets). Documented variance: the
MSVC exe embeds timestamps and is pinned by SHA-256 instead; `gitCommit` is
injected by CI (`--commit`), null in local dry-run. Zip-level byte identity
is not claimed (archive timestamps); functional contents are fully
hash-controlled.

## 8. Test-suite reliability

- `npm test`: **513 tests / 65 files, exit 0 on 4 consecutive full runs**
  this pass (three deliberate repeats + final; wall clock 15.8–48.0 s,
  cumulative test time 41.7–111.7 s). No flakes observed; longest file
  blindRecovery ~39 s (deterministic Monte-Carlo-shaped).
- `npm run test:browser`: **74 passed, exit 0** (~2.1 min, single-worker
  Chromium). One earlier run surfaced infra-only failures (dev server killed
  mid-run externally — ERR_CONNECTION_REFUSED, not product defects) and one
  REAL finding: my new token-strip test exposed defect D5's lazy adoption,
  which was then fixed properly.
- Specialized suites (all green within the runs above): campaigns
  campaignRunner 9 + regressionCampaigns 10 + blindRecovery 8 +
  confidenceHonesty 6; determinismAudit 8; high-refresh highRefreshTiming 7
  (60/120/144/165/200/240 Hz); schemaFuzz 7; security 9 +
  securityRoundTwo 15 + adversarialCampaigns 7; retestTorture 8;
  historyScale 4 (incl. 1000-session case); lifecycleHardening 14;
  stressLongSession 4 + highRateCaptureStress 4 + numericalRobustness 12;
  sessionResumeRecovery 8 + sessionRunner + sessionReplay 3; migration/
  restore via persistenceBackends 6 + exportExtended 3 + schemaFuzz;
  browser-side resultsTorture 16 + viewportMatrix 12 + accessibility 17 +
  securityRoundThree 5 + e2e session/boot/ui/persistence specs.

## 9. UI/engine contract audit

tests/uiContract.test.ts re-audited and extended coverage confirmed intact:
no network-capable APIs, no remote URLs, no numeric confidence re-derivation,
no HTML sinks, fixed logical viewport geometry, elapsed-time-only rendering,
engine seams wired. Fresh sweep found ONE remaining §4 violation — the
calibration preview formula — now fixed to call the engine's
`degreesPerCountForRep`. Grade→tone letter cutoffs in resultsView noted as
accepted presentation mapping (grade itself is engine-owned; no numeric
threshold exists to disagree with).

## 10. High-refresh audit

highRefreshTiming drives the real ScenarioDirector at all six cadences ×
five scenarios: spawn timestamps are exact absolute times, completion spread
≤ 16.67 ms, tracking motion keyframe-interpolated purely by elapsed time,
results refresh-independent, pause/resume creates no timing jumps
(state-machine-gated). Exact remaining limitation: these prove SIMULATION
logic only — real 200 Hz display feel/visibility still requires Aldo's
hardware (MANUAL-TEST C3/D4).

## 11. Display/DPI audit

Fixed 1280×720 logical viewport verified end-to-end (backing store pinned;
CSS scales; deltas/targets/eDPI share one logical space; DPR metadata-only).
Viewport matrix passes 1280×720 → 3840×2160 incl. dialogs and primary-action
reachability — covering 100–200% scaling geometries as CSS-pixel sizes. No
physical-display claim is made; on-site confirmation rows are MANUAL-TEST
C2/H3.

## 12. First-run audit

Zero-data walkthrough re-verified: boot → preflight (honest nulls) → empty
resume list quiet → first-use Home teaching → empty Results/History/
Calibration/Data states — no crash paths. Failure-path gaps found in the
sweep (dead arena on blocked storage, silent calibration save, diagnostics
storage tile, resume-list poisoning) are exactly those fixed in §3.

## 13. Failure UX audit

Every audited failure now states WHAT HAPPENED / IS MY DATA SAFE / WHAT NEXT:
helper missing (launcher offer + Diagnostics card), helper wrong version (NEW
fail-closed handshake message), disconnect/reconnect (transport statuses),
browser fallback (negotiated + labeled), capture quality bad (self-test
verdict gates), stale/corrupt calibration (adequacy + staleness), corrupted
checkpoint (per-artifact corruption card), corrupted backup (pre-write
rejection), storage unavailable (failure cards on Home/Test/Data/History/
Results/run/Diagnostics), unsupported browser (preflight BLOCKED), future
schema (rejected loudly), optimizer/analysis failure (honest results card).

## 14. Hardware validation checklist state

docs/MANUAL-TEST.md is THE sequential on-site checklist (sections A–H, HARD/
soft/record gates, Evidence column): artifact verification (zip SHA-256 vs
CI summary; manifest flag; helper present), launcher start/stop/duplicate/
restart, machine facts (§C: Windows version, resolution+scaling, refresh Hz,
mouse model+polling, in-app DPI/sens, browser), in-app readiness incl.
native probe vs observed rate, pointer-lock sanity (Esc/Alt-Tab/resize/
unplug), full session, results/history/backup/restore/calibration,
crash-resume, close-out with second hardware-validation bundle export.

## 15. Hardware validation export state

`buildHardwareValidationBundle` verified field-complete for the visit:
app/engine/helper/protocol versions (+ optimizer/scoring/calibration/resume
via release metadata), OS/runtime (UA, platform, cores), display dimensions,
devicePixelRatio, observed refresh estimate (now stall-proof), capture
source + nominal-vs-observed rate + jitter/drop counters, pointer-lock/
capture-path facts, session smoke status, resume/checkpoint status,
calibration status, warnings/errors. Compact (<20 KB), no raw samples, no
personal data. Timestamp provenance bug fixed (§3.12).

## 16. Final RC version

**1.0.0-rc.2** (advanced from rc.1). Rationale: since the rc.1 label was
minted in Pass 5, the candidate absorbed two hardening passes plus this
audit's contract-relevant changes (fail-closed helper-version handshake =
wire-behavior change; per-session experiment identity = changed persisted
artifact keys; settings sanitization). rc.N exists precisely to distinguish
candidates before the freeze; rc.1 never reached hardware. Updated
consistently in src/version.ts, package.json, package-lock.json,
docs/RELEASE.md, and the freeze tests; verify-release enforces parity.

## 17. Security/privacy audit

Re-scanned sources AND final bundle: zero fetch/XHR/sendBeacon/EventSource,
zero remote URLs/fonts/CDNs/analytics/update calls, WebSocket only behind
double loopback enforcement, no HTML sinks, imported metadata engine-
validated pre-write, store paths segment-validated, backup paths whitelist-
before-write, prototype-pollution shapes inert. NEW hardening this pass:
token stripped from URL/history immediately after adoption; helper-version
pinning actually enforced. Expected runtime network behavior confirmed:
localhost only.

## 18. Dependency audit

`npm audit --audit-level=moderate`: **0 vulnerabilities**. Runtime
dependencies: **none** (unchanged design goal). Dev deps are build/test
tooling only (@eslint/js, eslint, typescript-eslint, typescript, vite,
vitest, @playwright/test, tsx, @types/node), none ship in the bundle; no
dependencies were added or removed this pass.

## 19. Git/repo hygiene

Working tree clean after the two commits; dist-app/, release/,
test-results/ remain gitignored (never committed); no logs, screenshots,
temp files, local absolute paths, or unrelated NemoClaw changes; diff
reviewed hunk-by-hunk before commit (29 files, all in-scope).

## 20–23. Exact counts and results

- Engine: **65 files / 513 tests**, 4 consecutive green runs; total wall
  15.8–48 s per run; longest suites: blindRecovery ~39 s, sessionReplay
  ~9.3 s, determinismAudit ~3.6 s, regressionCampaigns ~5.4 s.
- Browser: **74 tests passed**, single worker, ~2.1 min.
- Lint 0 problems · tsc --noEmit clean · build ✓ 232.51 kB js / 77.03 kB
  gzip / 28.91 kB css (budget ≤250 kB) · verify-release 11/11 (repo) ·
  no-telemetry CLEAN (sources + bundle) · npm audit 0 vulnerabilities ·
  packaging reproducible byte-for-byte.

## 24–25. Commit hashes

- Feature commit: `25ebb65` — "Finalize Aldo Aim Lab pre-hardware release".
- Report commit: separate commit containing ONLY PASS-8-REPORT.md, created
  immediately after; read with:
  `git log --format=%H --grep "Add Pass 8 report" -1`.

## 26. Known defects (accepted, documented)

- Resume action remains the mandated hand-off dialog (full in-browser resume
  execution is post-V1, per Pass 5–7 classification).
- Human-session records hardcode `pausePeriods: []`/fatigue zeros although
  Pause works (metadata fidelity note for post-V1; raw trials unaffected).
- Preflight aggregation classifies known reason codes exhaustively today;
  an unclassified future `fail()` would degrade to advisory rather than
  fail-closed.
- Stale capture self-tests are trusted regardless of age; calibration
  staleness fails open when no context fingerprint exists.
- Diagnostics probe derives verdicts from analyzeNativeStream rather than
  analyzeCaptureSelfTest honesty rules (moot for tier-1 trust today; the
  app honestly pins activeCaptureTier=2 until negotiation is wired).
- Lock-loss provenance can be logged as "cancelled by user" in phase logs.
- Helper welcome hardcodes nominalRateHz=1000 (Raw Input cannot know the
  device's configured polling rate); deviation produces WARN, not FAIL, and
  MANUAL-TEST D4 compares observed rate to C4 human-recorded truth.

## 27. Remaining work — STRICT classification

**A. SOFTWARE WORK REQUIRED BEFORE HARDWARE VALIDATION — NONE.**
Every automated gate is green on this exact tree; the only remaining input
to the shippable artifact is the MSVC compile itself, which only a Windows
runner can perform.

**B. HARDWARE-ONLY VALIDATION**
1. Run CI `windows-release`; intake checks: zip SHA-256 matches job summary;
   `manifest.json.helperBinaryIsPlaceholder === false`.
2. Execute docs/MANUAL-TEST.md top-to-bottom on Aldo's PC (launcher start/
   stop/duplicate, URLACL/UAC + SmartScreen flow, native probe at real
   125/500/1000 Hz polling, pointer-lock matrix, full session, crash/resume,
   backup/restore, Chrome-vs-Edge parity).
3. Real 200 Hz display feel/visibility confirmation (simulations cover logic
   only).

**C. HUMAN-DATA CALIBRATION** (unchanged)
Empirical confidence mapping; scoring/threshold tuning vs human variance;
≥3 reliability pairs; adaptation/change-point validation; budget/fatigue
validation.

**D. OPTIONAL POST-V1**
In-browser resume execution UX; styled chart tooltips + rest countdown;
X/Y asymmetry panel polish; signed tags/checksum page; macOS helper; aged
self-test gating; pause-accounting fidelity in human-session records.

## 28. GO / NO-GO — installing the RC on Aldo's PC

**GO.** Contingent only on the two B1 intake checks (SHA-256 match,
non-placeholder helper flag), then follow MANUAL-TEST.md A→H exporting the
hardware-validation bundle at D5 and H1.

## 29. GO / NO-GO — stopping further pre-hardware Ox development

**GO — stop.** A = NONE. Every remaining unknown is physical (real monitor,
real mouse, real Windows security prompts) or requires Aldo's data.
Another software pass cannot reduce hardware risk; it can only add risk.

---

## Explicit judgment

**Pre-hardware software development should stop here.**
