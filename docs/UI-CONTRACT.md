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
