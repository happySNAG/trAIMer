# Architecture

## Stack

- **TypeScript (strict, NodeNext ESM)** — one language across engine, simulator,
  tests, and the future UI. The engine is pure TS with **zero runtime
  dependencies**; only `node:fs`/`node:path` appear inside the persistence layer.
- **Vitest** for tests (deterministic, seeded), **ESLint + tsc** for checks,
  **tsx** to run the demo CLI. No framework is used or needed by the core.
- The future production UI will be a browser app; the engine already runs
  unchanged in that environment except for `persistence/store.ts`, which is
  Node-specific by design (local-first file storage) and sits behind a small
  class boundary.

## Ownership boundary

The visual/product UI belongs to a later pass owned elsewhere. This repository
deliberately contains no rendering, no DOM code, and no UI state. The contract
between engine and future UI is:

1. The UI drives capture (`CaptureSource` → `CaptureEvent`s) and calls
   `TrialRecorder`.
2. Everything downstream — validation, metrics, optimizer, persistence —
   operates on plain `TrialRecord` data.
3. The UI reads `Recommendation` objects; it never computes aim statistics.

## Module map

| Module | Responsibility | Key types |
| --- | --- | --- |
| `domain/` | canonical data model, versioned schema envelope | `TrialRecord`, `ExperimentDefinition`, `SensitivityCandidate`, `Recommendation`, `TrialValidity`, `VersionedEnvelope` |
| `capture/` | monotonic clocks, capture event vocabulary, recorder | `MonotonicClock`, `CaptureEvent`, `CaptureSource`, `TrialRecorder` |
| `sensmath/` | sensitivity arithmetic & candidate generation | `edpi`, `compareSensitivity`, `generateCandidateLadder`, `CalibrationParameters` |
| `metrics/` | deterministic analytics over raw trajectories | `computeFlickMetrics`, `computeTrackingMetrics`, stats helpers |
| `validation/` | trial quality control with reason codes | `validateTrial` |
| `experiments/` | machine-readable experiment protocol, ordering | `buildExperimentDefinition`, `planCandidateBlocks` |
| `sim/` | seeded synthetic players & trial synthesis | `SyntheticPlayerConfig`, `SyntheticExperimentRunner`, calibration harness |
| `optimizer/` | dimension scoring, evaluation, search, confidence | `SensitivityOptimizer`, `CandidateEvaluation`, `fitQuadraticWeighted` |
| `persistence/` | local JSON storage, envelopes, migrations | `LocalJsonStore`, `unwrapEnvelope`, migration registry |
| `demo/` | developer-facing proof of the whole pipeline | `runDemo` |

Dependency direction is strictly downward: `demo → optimizer/sim → metrics/
sensmath/validation/experiments → capture → domain`. Nothing imports upward;
`domain` imports nothing from the project.

## Data flow

```
CaptureSource (browser / native / synthetic)
      │ CaptureEvents (monotonic ms)
      ▼
TrialRecorder ──► TrialRecord (raw samples, targets, shots retained verbatim)
      │
      ▼
validateTrial ──► TrialValidity {status, reasons[]}        (never silent)
      │
      ▼
computeFlickMetrics / computeTrackingMetrics              (per-trial physics)
      │
      ▼
scoreTrialDimensions ──► per-dimension [0,1] scores       (interpretable axes)
      │
      ▼
evaluateCandidate (scenario-centered) ──► CandidateEvaluation
      │
      ▼
SensitivityOptimizer (surrogate search, rounds)
      │
      ▼
Recommendation {point, range, confidence, evidence, warnings, rationale}
      │
      ▼
LocalJsonStore (versioned envelopes; raw trials persisted first-class)
```

## Measurement classes

Explicit distinction required by the project brief:

**A. Measured directly.**
Timestamps (monotonic), pointer positions/deltas, target geometry/motion,
shots, hits/misses, focus interruptions. Raw samples are the source of truth
and are persisted unsummarized.

**B. Inferred statistically from A.**
All flick/tracking metrics (onset thresholds, interpolation), dimension scores,
candidate utilities and their standard errors, the composite optimum estimate,
confidence values, and every simulator-derived claim in tests. These carry
model assumptions and sampling error; the API surfaces SEs and ranges rather
than hiding them.

**C. Requiring future empirical Fortnite calibration.**
Any conversion between mouse counts and camera rotation:
`degreesPerCountAt100X/Y` (`CalibrationParameters`). Fortnite does not
document this transform; we refuse to invent it. Until calibrated:
- eDPI remains a *relative* comparison currency (definitional, not physical).
- cm/360 and degrees-per-count return `null`.
- Scenario geometry is expressed in viewport pixels, which is self-consistent
  within the lab but not convertible to real-world angular units.
`calibrationFromEmpiricalMeasurement` exists so a measured constant can be
plugged in later without touching any call site (`rotationDegreesForCounts`,
`physicalCmPer360`).

## Key decisions and rationale

1. **TypeScript everywhere, no frameworks.** The engine must survive a UI
   rewrite and run in browser and Node. Zero runtime deps keep audit surface
   minimal.
2. **Raw-first persistence.** Summaries can be recomputed; raw samples cannot
   be reconstructed. Trials persist sample-by-sample under versioned envelopes.
3. **One recorder for real and synthetic input.** The simulator emits the same
   `CaptureEvent` stream a browser would. Metrics/tests therefore validate the
   entire pipeline, not just math on fabricated aggregates.
4. **Paired experimental design.** Within a round every candidate faces an
   identical scenario multiset *and identical instance geometry* (target
   distances/speeds are drawn from seeds keyed by scenario+rep index, not by
   candidate). This mirrors counterbalanced testing and removes luck-of-the-draw
   from comparisons.
5. **Scenario centering before comparison.** Dimension scores are centered by
   their cross-candidate per-scenario means (two-way additive adjustment), so
   scenario difficulty cannot masquerade as sensitivity effects.
6. **Dimension-preserving scoring with an explicit composite.** Seven named
   dimensions with published weights; utility is a weighted mean over available
   dimensions, never an opaque single number from the simulator.
7. **Uncertainty-aware surrogate search.** Weighted quadratic fit in
   log2-eDPI space with covariance-based vertex SE; proposals come from the
   vertex, the top-two midpoint, and boundary expansion when the best candidate
   sits at the tested edge.
8. **Ranges over false precision.** Statistically indistinguishable candidates
   define the reported interval; the surrogate's 95% vertex CI can only widen
   it, never narrow it (narrowing repeatedly produced overconfident misses in
   development and was removed deliberately).
9. **Confidence is coupled to separation.** "High" confidence requires both a
   significant utility gap *or* significant peak curvature and clean data;
   weak separation caps confidence at 0.65, incomplete candidates cap it lower,
   and starving the pipeline triggers explicit refusal
   (`refusedHighConfidence`).
10. **Composite optimum ≠ nominal knob.** The simulator's amplitude-error null
    ("true optimal eDPI") need not coincide with the argmax of the full
    multi-dimensional utility (speed gradients tilt it). Blind-recovery tests
    therefore compare against a Monte-Carlo-measured composite optimum using
    the same scoring stack, not against the raw knob value. See
    `docs/SIMULATOR.md`.

## Known limitations

- Single-player, single-device, local-only persistence (by design for Pass 1).
- X-axis optimization only; independent Y exploration is typed but unused.
- Browser capture implementation not yet written; interface and recorder are
  ready and exercised via synthetic events only.
- Optimizer strategy is screening + quadratic refinement; GP/BO-style search is
  future work. Utility weights are fixed defaults pending real-player data.
- Tracking directional lag uses discrete scan steps tied to sample spacing.

## Pass 2 additions

- **Browser runtime** (`app/`, Vite + vanilla TS): Setup/Run/Results/Data/
  Calibration views around a fixed 1280×720 logical canvas. The engine remains
  DOM-free; only `app/` touches the DOM.
- **PointerLockCaptureSource + VirtualReticle** (`src/capture/browserSource.ts`):
  real mouse deltas normalized into CaptureEvents, applied-delta clamping so
  recorded cursor == rendered reticle, lock-loss/denial handling, blur /
  visibility / resize events.
- **Scenario instance planner** (`src/scenarios/planner.ts`): single source of
  deterministic geometry shared by simulator and browser runtime — identical
  instances per `(seed, round, scenario, repIndex)` across candidates.
- **ScenarioDirector** (`src/scenarios/director.ts`): spawns planned targets on
  schedule, sequences target-switch trials, detects completion, computes
  outcome, supports abort.
- **Session state machine** (`src/session/stateMachine.ts`) with explicit
  transition table; **SessionRunner** orchestrates rounds/blocks/rests via
  injected ports (clock, sleep, store, trial execution), persists every trial
  immediately and writes session checkpoints (crash/resume data).
- **Adaptive allocation** (`src/session/allocation.ts`): after a balanced
  minimum, reps concentrate on statistically tied contenders; dominated
  candidates receive periodic control refreshes; budget-capped; decisions carry
  machine-readable reasons; fully deterministic.
- **Fatigue protocol** (`src/session/fatigue.ts`): max continuous testing time,
  rest enforcement, rolling acquisition-time degradation detection; short-
  session guard warns against large sensitivity changes from thin evidence.
- **Paired statistics** (`src/optimizer/paired.ts` + `docs/STATISTICS.md`):
  paired differences over shared cells replace scenario centering as the primary
  contrast; Dunnett-adjusted exclusion threshold controls multiplicity on the
  tied set.
- **Boundary handling**: expansion proposals, vertex-inside-span point guard,
  `unresolvedBoundary` recommendation flag, boundary-touched confidence cap —
  wide honest ranges preferred over wrong precise numbers.
- **Independent-Y staged exploration** (`src/optimizer/yAxis.ts`): stage 2 tests
  modest Y-only variants against an equal-Y anchor at the chosen X; equality is
  recommended unless a reliable paired improvement exists. Simulator gains
  `trueOptimalEdpiY` with directional-weighting heuristic.
- **Calibration workflow** (`src/calibration/core.ts`, Calibration tab):
  repeated known-angle measurements → outlier rejection (MAD) → mean ± CI →
  adequacy gates → versioned `calibration-record`; cm/360 via the existing
  calibration interface (now sens-aware).
- **Persistence ports** (`StoreBackend`): Node fs backend (CLI/tests), in-memory
  backend (tests), IndexedDB backend (browser); envelope/migration guarantees
  unchanged; versioned session-bundle export/import.

## Pass 4 additions

- **Native capture** (`src/capture/nativeClient.ts`, `native/windows/`):
  loopback-WebSocket transport to a Raw Input helper with versioned
  handshake, session-token cross-talk protection, sequence continuity,
  fail-closed frame validation, reconnect with backoff (docs/NATIVE-CAPTURE.md).
- **Capture-source negotiation** (`src/capture/negotiation.ts`): validated
  native > coalesced browser > basic mouse; explicit transitions; mid-trial
  disconnect invalidates the affected trial; silent downgrades impossible.
- **Session capture quality** (`src/diagnostics/captureQuality.ts`): robust
  session-level aggregation feeding confidence gating.
- **Fully paired statistics** (`src/optimizer/pairedFit.ts`): contrast
  regression over pair differences replaces scenario-centering in the
  surrogate path entirely.
- **Model adequacy** (`src/optimizer/adequacy.ts`): five curve shapes;
  quadratic vertices only when earned; plateau/boundary/inconsistent result
  types.
- **Change-point analysis** (`src/optimizer/changepoint.ts`): formal
  segmented adaptation/fatigue/collapse detection with contamination flags.
- **Joint X/Y search** (`src/optimizer/jointXY.ts`): sparse 2D neighborhood,
  4-parameter weighted surface fit, conservative asymmetric-outcome policy
  with separate X/Y ranges.
- **Information-driven allocation** (`src/session/informationAllocation.ts`):
  extra blocks follow decision value; reasons audited; deterministic.
- **Resume/recovery** (`src/session/resume.ts`, runner): v2 checkpoints with
  pre-trial pending markers; resume never repeats completed trials and
  invalidates interrupted ones explicitly.
- **History API** (`src/history/api.ts`): typed view models for sessions,
  trends, rankings, dimensions, calibration history, retest lineage, device
  history, optimizer versions.
- **Budget policy** (`src/experiments/budget.ts`): early stop / continue /
  defer-to-next-session decisions from evidence + caps.
- **Error model & observability** (`src/errors/types.ts`,
  `src/diagnostics/localLog.ts`): typed categories, safe user messages,
  local-only diagnostic bundles.
- **Versioning** (`src/version.ts`): app/engine/optimizer versions persisted
  across artifacts with compatibility checks.
- **Browser automation** (`tests/browser/`, Playwright) with a test-only
  pointer-lock adapter (`?e2e=1`).
