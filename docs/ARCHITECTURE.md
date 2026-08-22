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
