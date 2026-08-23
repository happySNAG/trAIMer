# Aldo Aim Lab — Engineering Pass 3 Final Report

Status: **Complete.** Feature commit `750da15` — "Add human validation and
capture-quality hardening" (37 files, +3,472/−35) — followed by this report
committed separately. The build is now a much more robust human-testing
instrument: structured human-session provenance, test/retest reliability
analysis, input-quality gating of confidence, native-capture transport prep,
deterministic session replay, a complete audit trail, recommendation
explainability, staged-change safety, adaptation detection, baseline-informed
setup, targeted retest flow, and extended analysis export.

## 1. Human validation architecture

`HumanSessionRecord` (`src/session/humanSession.ts`, persisted kind
`human-session`, versioned) captures every mandated field:

- player id/display name, DPI, starting Fortnite X/Y,
- device/browser info (UA, platform, screen, pointer-coalescing capability),
- started/ended ISO timestamps, wall-clock and active-testing durations,
- scenario order, blinded candidate order + reveal map, warmup/measured counts,
- pause/rest periods, invalid-trial count, fatigue indicators (forced rests,
  degradation detected/ratio),
- recommendation linkage (eDPI, confidence, range), optimizer version,
  scoring weights, per-axis calibration adequacy state,
- `retestOfExperimentId` + `sessionIndexForPlayer` for repeat-session lineage.

The browser app persists one record per completed session automatically.
Repeat sessions for the same player produce comparable records suitable for
test/retest analysis; `docs/HUMAN-VALIDATION.md` defines the practical
protocol.

## 2. Longitudinal reliability implementation

`compareSessions(prior, next)` (`src/analysis/reliability.ts`) produces a
structured `ReliabilitySummary`:

- **recommendation drift** in absolute eDPI and octaves,
- **prior-inside-new-range** containment check,
- **confidence consistency** (label match + numeric delta),
- **candidate ranking stability** via Kendall's tau over shared top-ranked
  candidates, with plain-language interpretation,
- **dimension stability** (per-dimension mean deltas),
- **within-session variance** (mean per-candidate CV) and between-session
  utility variance hooks,
- explicit caveats: two-session comparisons are descriptive diagnostics, not
  validated reliability coefficients.

## 3. Confidence calibration framework

`src/confidence/calibration.ts` keeps the Pass 2 heuristic as the single
source of confidence while attaching `ConfidenceCalibrationMetadata` to every
recommendation:

- `basis: "heuristic"` with a version string — **never** presented as an
  empirically validated probability (stated explicitly in metadata notes),
- diagnostics block: trials analyzed, candidates evaluated, gap z, separation,
  unresolved-boundary flag, input-quality score, search rounds,
- `EmpiricalConfidenceMapping` interface reserved so future test/retest data
  can supply a calibrated model without changing the recommendation shape.

## 4. Input-quality diagnostics

`computeInputQuality(trial)` (`src/diagnostics/inputQuality.ts`) derives from
the raw sample stream: observed event rate (median interval), rate p10/p90,
timing jitter CV during active motion, large-gap count/largest gap,
zero-motion fraction/longest stillness, click latency relative to last motion,
pointer-lock losses, viewport resizes. Warnings include low event rate,
unstable timing, excessive lock loss, unstable viewport, and an aggregate
"unsuitable for high-confidence recommendation" flag; scores map to [0,1].

Integration: the optimizer accepts the worst trial-level report (override or
auto-derived from measured trials) — degraded capture caps confidence at
0.45, adds an explicit warning, and forces further-testing suggestions
(unit-tested end-to-end).

## 5. Browser capture improvements

Pointer Lock capture now prefers `pointermove` with
`getCoalescedEvents()`: every coalesced OS sample is emitted individually
with its own raw `event.timeStamp` — no synthetic samples, no fabrication,
and analytics are no longer tied to animation-frame cadence. Capability
detection (`detectPointerEventCapabilities`) reports
`pointermove-coalesced | pointermove | mousemove` and stores it on both the
capture source and human-session records. When only `mousemove` exists
(older Safari), we document that deltas arrive frame-coalesced and silent
while still; motion-aware gap validation handles the silence correctly.

## 6. Native capture port design

`src/capture/native.ts` defines the production transport for a future
500/1000 Hz helper without building one:

- versioned wire format: header (protocol version, device id/description,
  nominal rate, time-origin note) + frames `{sequence, tMonotonicMs,
  events[]}` using the exact engine `CaptureEvent` vocabulary,
- sequence-gap detection for loss/drop reporting,
- `ReplayCaptureSource implements CaptureSource` with instant and realtime
  modes so recorded native streams replay through recorder → validation →
  metrics identically to a live feed (tested),
- fixtures serialize/parse losslessly as JSON (persisted kind
  `native-capture-fixture`) for browser-independent regression tests.

## 7. Session replay

`replayExperiment(definition, trials)` re-runs stored raw records through
validation, scoring, and the optimizer with no live input. Tests prove:
(a) two replays of one bundle are byte-identical recommendations,
(b) replay equals live analysis of the same records,
(c) scoring-weight experiments can be evaluated against historical sessions.

## 8. Audit trail

`AuditLog` (`src/session/audit.ts`) emits ordered entries across the runner:
experiment-created, trial-started/ended/invalidated (with reason codes),
rest-started/ended, adaptive-allocation-decisions (with reasons),
recommendation-created. Entries persist inside session checkpoints and export
bundles, making any recommendation explainable after the fact.

## 9. Recommendation explainability

`buildExplanation()` attaches a structured `RecommendationExplanation`
answering all required questions: why this X / why this Y lines; every
candidate tested (eDPI, utility ± SE, valid trials); per-scenario
contributions with difficulty tiers; evidence for and against the winner;
remaining uncertainty (range width, confidence, boundary state); concrete
further-testing actions; boundary-reached flag; capture-quality adequacy.
The Results view surfaces these plus confidence basis ("heuristic — not an
empirically validated probability") and any staged-change plan.

## 10. Staged sensitivity safety

`applyStagedChangeSafety()` enforces a configurable policy (default ±25 %
immediate step): when the inferred optimum is farther away AND confidence is
below 0.8 or the boundary is unresolved, the headline value becomes a bounded
first step toward the optimum, the full inferred optimum is labelled
separately, an adaptation retest is scheduled, and rationale lines document
the decision. Confident interior recommendations pass through unchanged.

## 11. Adaptation handling

`detectAdaptation()` compares each candidate's early vs late halves of its
measured sequence (z-test on means). Significant late improvements mark
adaptation effects surfaced on the recommendation and in the UI note.
The interleaved block design keeps this orthogonal to candidate differences;
first encounters are never assumed representative.

## 12. Scenario changes

All five scenarios gained `difficulty` metadata (tier + discriminated
dimensions + notes) documenting what each measures: small-target flick is the
strongest sensitivity discriminator; tracking is jitter/lag sensitive;
target-switch exposes consistency. Config tuning: small-target distances up
(280–640 px), dynamic speed floor raised (260 px/s), tracking amplitude/speed
slightly harder. Seeded pairing semantics unchanged (planner consumes the same
ranges).

## 13. Retest workflow

`planRetestSession(priorDefinition, priorRecommendation)` builds a follow-up
definition that narrows to the prior plausible range at ~half-step resolution,
drops previously out-of-range candidates, uses fresh candidate ids/labels
(blinding preserved), links back via `notes` and
`HumanSessionRecord.retestOfExperimentId`, and bumps rounds when the prior
search needed them. Returns null when nothing can be narrowed honestly.

## 14. Test counts/results

```
22 test files, 201 tests, all passing

New Pass 3 suites:
  humanSession 4 | reliability 3 | confidenceCalibration 4 |
  nativeTransport 5 | sessionReplay 3 | auditTrail 1 |
  explainability 3 | adaptationBaselineRetest 6 | exportExtended 3 |
  inputQualityCampaigns 6

Pass 1+2 suites re-run unchanged and green (163 tests).
```

## 15. Lint/type/build results

```
npm run lint      eslint .                    0 problems
npx tsc --noEmit  strict TS incl. app/        clean
npm test          vitest run                  201 passed (201)
npm run build     vite production build       succeeds (~98 KB js)
```

## 16. Known limitations

- Confidence remains heuristic by design; empirical calibration activates
  only once repeated human test/retest outcomes exist.
- Input quality derives from per-trial sample streams; cross-trial device
  drift (thermal USB throttling etc.) is not yet aggregated into a
  session-level verdict beyond worst-trial gating.
- Coalesced-event fidelity depends on browser support; mousemove-only browsers
  remain frame-coalesced (documented, detected).
- Kendall tau ranking stability covers shared top-2 candidates only; full
  ladder rank correlation awaits multi-session data with identical candidate
  sets.
- Adaptation detection uses within-candidate halves; formal change-point
  models are future work.
- Retest planning narrows around the prior range; it does not yet re-expand
  if the retest itself hits a new boundary (recommended manually today).
- No real-human data collected yet; every robustness claim here is backed by
  simulation campaigns, not field studies.

## 17. Exact commit hash

Feature commit:
750da15 "Add human validation and capture-quality hardening"
(branch ox/aldo-aim-lab-20260822T190348Z-f653d4f2)
This report was committed separately immediately afterward.

## 18. Recommended Pass 4 priorities

1. Collect Aldo's real 3–5 session dataset per protocol; run the empirical
   confidence mapping once reliability pairs exist.
2. Build the native helper against the defined transport; validate at
   1000 Hz with fixture parity tests on real hardware.
3. Replace heuristic scenario-centering remnants entirely with the paired
   model in the surrogate fit (currently pairing governs gaps/ties only).
4. Joint X/Y search driven by observed asymmetric optima rather than staged
   exploration.
5. Session-resume UX in the app (list checkpoints, resume button) — engine
   support already persists checkpoints.
6. Formal change-point adaptation modeling and per-scenario rep rebalancing
   driven by accumulated per-scenario reliability diagnostics.
