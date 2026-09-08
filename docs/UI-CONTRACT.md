# UI Contract (frozen for the Claude Code design pass)

Status: **Pass 4 contract.** The visual/product redesign may replace anything
in `app/src/**` freely EXCEPT the rules below. The engine (`src/**`) is not
part of the redesign surface.

## 1. What Claude may replace freely

- All markup, styling, layout, typography, color, animation in `app/`.
- View structure: `app/src/*View.ts` are disposable renderers.
- `app/src/dom.ts` helpers, `styles.css`, `index.html`.
- Tab organization, navigation, copy, empty states.

## 2. Engine APIs that MUST stay stable

These are consumed by the views today and are the only supported seams:

| API | Module | Notes |
| --- | --- | --- |
| `renderSetupView(container, {onStart})` shape | `app/src/setupView.ts` | `AppSettings` type is the contract |
| `BrowserRunController.create(canvas, settings, callbacks, options)` | `app/src/runController.ts` | callbacks: `onHud/onTrialPersisted/onExperimentFinished`; `options.virtualLock` is TEST-ONLY |
| `HistoryApi.snapshot()/listSessions()/trends()/…` | `src/history/api.ts` | typed view models; render them verbatim |
| `renderResumeList(container, store, callbacks)` | `app/src/resumeView.ts` | Resume / Discard / Export actions mandatory |
| `LocalDiagnosticLog.exportBundle()` | `src/diagnostics/localLog.ts` | Export Diagnostic Bundle button must exist |
| `SessionRunner.resumeFrom(checkpoint, definition, ports, trials)` | `src/session/runner.ts` | resume UX must go through this |
| `analyzeNativeStream(...)` verdicts | `src/diagnostics/nativeDiagnostics.ts` | Diagnostics view renders checks verbatim |
| Recommendation fields incl. `curveAdequacy`, `captureQualitySession`, `changePointAnalysis`, `jointXY`, `confidenceCalibration`, `explanation`, `sensitivityChangePlan` | `src/domain/recommendation.ts` | display, never recompute |

Anything else inside `src/**` can change between minor releases; do not import
engine internals beyond the table above from UI code.

## 3. Persisted schemas that must NOT be casually changed

Envelope kinds (see `docs/PERSISTENCE.md`): `trial-record`,
`experiment-definition`, `recommendation`, `human-session`,
`session-checkpoint` (resume schemaVersion 2), `calibration-record`,
`optimizer-run`, `session-bundle`, `native-capture-fixture`,
`reliability-summary`, `audit-trail`.

Rules:

1. Adding OPTIONAL fields is allowed. Removing/renaming fields or changing
   types requires a migration registered in `src/persistence/migrations.ts`
   plus a schema review.
2. Raw trial samples are append-only truth: never transform, filter, or
   "clean" them at persistence or render time.
3. `ResumeCheckpoint` integrity is load-bearing: `parseResumeCheckpoint`
   fails closed; do not loosen it to make bad data load.

## 4. Calculations that MUST stay out of presentation code

The view layer must never re-implement:

- utility/dimension scoring, paired statistics, curve adequacy, change-point
  detection,
- confidence computation or capping (capture-quality gating lives in the
  optimizer),
- capture-source negotiation/priority decisions,
- staleness checks for calibration,
- any threshold constants (they live in named exports like
  `DEFAULT_CAPTURE_QUALITY_THRESHOLDS`, `INPUT_QUALITY_THRESHOLDS`,
  `CONFIDENCE_LABEL_THRESHOLDS`).

If a number shown in the UI is not read from an engine-produced object, that
is a bug.

## 5. Non-negotiable product behaviors

- Never silently downgrade capture sources; show which source produced data.
- Never repeat completed measured trials on resume; interrupted trials are
  invalidated with visible audit metadata.
- No network access, no telemetry; the diagnostic bundle is user-triggered.
- Confidence is always labeled heuristic until empirical calibration exists.

## 6. Pass 5 additions to this contract

New stable engine seams the redesign must use (never reimplement):

| API | Module | Notes |
| --- | --- | --- |
| `runPreflightChecks(env)` + `PREFLIGHT_THRESHOLDS` | `src/preflight/preflight.ts` | Setup-tab panel; verdicts READY / READY_WITH_WARNINGS / NOT_READY_FOR_HIGH_CONFIDENCE / BLOCKED; reason codes rendered verbatim |
| `analyzeCaptureSelfTest(...)` | `src/diagnostics/captureSelfTest.ts` | Diagnostics probe persists `capture-self-test` records; verdict gates native tier-1 trust |
| `buildFinalResult(input)` → `FinalResult` (`final-result-v1`) | `src/results/finalResult.ts` | THE results-screen object incl. ONE decided next action + rationale |
| `planNextTest(...)` → `NextTestPlan` | `src/session/retest.ts` | retest loop: triggers, targeted-vs-repeat, enforced rest |
| `exportBackupAll` / `importBackupAll` | `src/persistence/backup.ts` | whole-store backup with SHA-256 integrity; restore validates everything pre-write |
| `ContractState<T>` loaders | `src/contracts/states.ts` | empty/loading/ready/error for history & results views |
| lifecycle helpers (`assessTimeJump`, `InstanceGuard`, `LIFECYCLE_POLICY`) | `src/lifecycle/lifecycle.ts` | sleep/wake invalidation, duplicate-instance guard |

### Handoff state (Pass 5)

The engine is feature-complete for V1 RC. Every calculation, threshold,
verdict, and next-action decision lives in `src/**`; the app layer only
renders. Claude Code may restyle all of `app/**` freely under §1 while
keeping the seams above intact. The Results view already renders
`FinalResult` as its headline; History renders `HistorySnapshot`; Setup
renders the preflight report and resume list.

### Pass 6 compatibility statement (additive, non-breaking)

Pass 6 was executed in parallel with the Fable UI redesign. Every change is
backward-compatible with the frozen seams above; no shape, field, verdict
enum, or reason code was removed or renamed:

- `planNextTest` gained OPTIONAL context inputs (`chainDepth`,
  `maxChainDepth`) for loop prevention; the returned `NextTestPlan` shape is
  UNCHANGED. Callers that ignore the new fields behave exactly as before.
- `planNextTest` may now return `kind:"none"` with a "manual review"
  rationale once a retest chain reaches its depth limit — UIs already render
  `kind:"none"` plans (recalibrate-first precedent).
- Trial validation became MORE ACCURATE: deliberate inter-target pauses are
  no longer misflagged as capture stalls (`LARGE_SAMPLE_GAP` false positives
  eliminated). Sessions will show fewer invalid trials; reason codes and
  severity semantics are unchanged.
- Input-quality jitter is now robust (median/MAD over continuous-motion
  runs). Honest sessions will show HIGHER input-quality scores and therefore
  less-often-capped confidence. The report shape (`InputQualityReport`) is
  unchanged.
- Persistence paths are validated segment-by-segment (S9); all previously
  valid paths remain valid.
- New engine-only modules used by tests/CI (campaigns, packaging, release
  manifest) are not UI-facing.

No visual or layout prescription is added; the redesign remains free within
§1.

### Pass 7 compatibility statement (integration hardening)

Changes made while auditing the merged engine+UI release candidate. All
additive or presentation-only; no seam shape was removed or renamed:

- `SessionSummaryViewModel` (src/history/api.ts) gained an OPTIONAL
  `confidenceLabel: string | null` field carrying the engine's own
  low/moderate/high label. Views must derive confidence COLOR from this
  label, never from numeric cutoffs — a static contract test
  (tests/uiContract.test.ts) enforces that app/src contains no
  `confidence >= 0.x` re-derivation and no network-capable APIs.
- Results/Home confidence tones now follow the engine label
  (`CONFIDENCE_LABEL_THRESHOLDS`); the accepted visual language is unchanged.
- Card titles render as h3 instead of h4 (heading hierarchy: page h2 → card
  h3; CSS is class-based so pixels are identical). Form labels are now
  programmatically associated via `for=` (ui.ts `field()`).
- Session-mode side-effect guards: selection/drag/context-menu suppressed on
  the run screen; `user-select:none` + overscroll chaining off while a
  session is active.
- Storage-failure experience: views that cannot open IndexedDB render a
  WHAT-HAPPENED / IS-DATA-SAFE / WHAT-NEXT failure card instead of failing
  silently.
- Stored settings are sanitized against engine bounds
  (`PREFLIGHT_THRESHOLDS`, `DEFAULT_SAFE_RANGE`) on load — old/corrupt/
  hostile blobs can no longer poison session definitions.
- Test-only adapter additions (?e2e=1): `simulateLockLoss()` flows a fatal
  lock-loss event through the production capture path;
  `renderResultsForTesting(...)` renders engine-built results through the
  production results view for torture automation; `&nostart=1` skips e2e
  auto-start. Production behavior without these params is unchanged.
- New Diagnostics card "Hardware validation evidence" exports
  `buildHardwareValidationBundle` output (Pass 7 requirement V) — local-only,
  user-triggered, no raw samples.
- The Windows launcher scripts now exist at
  `scripts/release/windows/` (they were referenced by Pass 6 tests/packaging
  but never committed — the integration defect Pass 7 fixed).

### Game Profile Pass 1 additions (additive, non-breaking)

The game-profile layer is a TRANSLATION layer over the frozen contracts above.
Nothing in this section changes an existing shape, verdict enum, or reason
code, and the measurement engine does not import any of it
(`tests/gameProfileBoundary.test.ts` enforces that statically).

New stable engine seams:

| API | Module | Notes |
| --- | --- | --- |
| `GAME_PROFILE_REGISTRY` (`get` / `require` / `list` / `selectable` / `checkSelection`) | `src/games/registry.ts` | THE profile lookup; no switch on a game name anywhere in the app |
| `canonicalFromGameSettings` / `gameSettingsFromCanonical` / `changeDpi` / `roundTrip` | `src/games/convert.ts` | all conversion arithmetic; views must never reimplement it |
| `buildGameRecommendationExport` → `GameRecommendationExport` (`game-recommendation-v1`) | `src/games/export.ts` | THE object the results screen renders when a game is selected |
| `importCurrentSensitivity` | `src/games/export.ts` | "what am I on today?", with no calibration and no session |
| `sanitizeGameSelection` / `defaultSelectionFor` / `matchingMethodOf` | `src/games/selection.ts` | persisted selection; ids and versions only, never display names |
| `buildSessionGameConversionRecord` / `readSessionGameConversionRecord` | `src/games/selection.ts` | the optional history record |
| `describeMatching`, `MATCHING` | `src/games/matching.ts` | player-facing wording for each zoom-matching philosophy |

Additions to §2 (engine APIs that must stay stable):

- `renderResultsView(container, input)` gained OPTIONAL `gameRecommendation`
  and `onChooseGameProfile`. Callers that omit both behave exactly as before —
  no game section is drawn.
- `AppSettings` gained OPTIONAL `gameProfile`. A settings blob written before
  game profiles existed reads back with `gameProfile: null`, which means "no
  game selected" and is a supported state, not an error.
- `SessionSummaryViewModel` gained `gameConversion`, null for every session
  recorded before game profiles existed.
- `HumanSessionRecord` gained an OPTIONAL `gameConversion` field. It is
  imported **type-only**, so nothing from the game layer exists at runtime in
  the session module.

Additions to §4 (calculations that must stay out of presentation code):

- sensitivity conversion in either direction, cm/360 and degrees-per-count
  arithmetic, slider quantization and clamping, zoom-matching ratios, and FOV
  normalization. If a converted number in the UI is not read from a
  `GameConversion` or `GameRecommendationExport` field, that is a bug.

### Game Profile Pass 2 additions (additive, non-breaking)

- `GameRecommendationExport.exactVsEntered` — one entry per value the game's
  grid or range moved: the exact equivalent, what to enter, a finer
  configuration-file value when the profile has one, and whether it was
  clamped. `current` gained `hipfireDisplay` / `verticalDisplay`, formatted
  as the game shows them. The results view renders these verbatim.
- `ConvertedZoom.achievedDegreesPerCount` / `achievedCmPer360` may now be
  `null`: a game-applied coefficient gives every optic its own value.
- `conversionUsesFov(profile)` (`src/games/convert.ts`) decides whether the
  picker shows a field-of-view input at all.
- `PUBLIC_GAME_PROFILES` is six profiles in picker order; the generic control
  is now displayed as "Generic / Raw" (its id is unchanged).

Additions to §5 (non-negotiable product behaviors):

- Rounding loss is never hidden. When a game's own entry grid cannot express
  the exact equivalent, the exact value, the enterable value and the
  difference are all shown.
- A conversion never reads as more certain than the calibration behind it.
- A malformed profile fails closed: the registry refuses to load rather than
  producing a sensitivity recommendation.
- trAIMer never touches a game — no processes, no memory, no files, no input
  injection. See docs/GAME-PROFILES.md §11.
