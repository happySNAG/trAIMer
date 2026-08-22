# Aldo Aim Lab — Engineering Pass 1 Final Report

Status: **Complete.** All work described here is committed on branch
`ox/aldo-aim-lab-20260822T190348Z-f653d4f2`. The engine foundation (domain
model, capture abstraction, metrics, simulator, optimizer, persistence, tests,
demo CLI) was implemented, tested, documented, and committed before this
report was written. This report describes that completed work.

---

## 1. Architecture chosen

**TypeScript (strict mode, NodeNext ESM) with zero runtime dependencies**,
Vitest for tests, ESLint + `tsc --noEmit` for checks, tsx for the demo CLI.
No frameworks are used or needed by the core.

Strict downward dependency layering:

```
demo → optimizer/sim → metrics/sensmath/validation/experiments → capture → domain
```

Key architectural properties:

- **Pure headless engine.** No DOM, no rendering, no UI state. The production
  visual UI is explicitly out of scope for this pass (owned elsewhere); the
  contract is that the future UI feeds `CaptureEvent`s into `TrialRecorder`
  and reads `Recommendation` objects — it never computes aim statistics.
- **Capture-source abstraction** (`src/capture/`): browser Pointer Lock, a
  future native capture layer, and the synthetic simulator all emit the same
  event vocabulary into the same `TrialRecorder`, so analytics run unmodified
  regardless of input source.
- **Monotonic timing only.** `MonotonicClock` (system `performance.now()` or a
  manual clock for tests/simulation). Wall-clock time never enters reaction or
  movement calculations.
- **Explicit Fortnite calibration boundary** (`src/sensmath/calibration.ts`):
  the mouse-count → camera-rotation transform is a pluggable
  `CalibrationParameters` value, defaulting to `UNCALIBRATED` (physical
  conversion functions return `null`). No undocumented engine constants were
  invented. eDPI = DPI × X% is definitional and calibration-free.
- **Raw-first measurement model**: trials retain full timestamped pointer
  samples, target spans/motion keyframes, shot events, focus interruptions,
  capture context, and structured validity results. Summaries are always
  recomputable; raw data is persisted verbatim.
- **Local-first persistence** with versioned envelopes and a migration
  registry. No cloud, no network, no telemetry, no secrets.

The required A/B/C classification lives in `docs/ARCHITECTURE.md`:
(A) directly measured quantities (timestamps, positions, targets, shots),
(B) statistically inferred quantities (metrics, dimension scores, utilities,
confidence), (C) quantities requiring future empirical Fortnite calibration
(degrees-per-count, cm/360).

## 2. Files created or changed

58 files changed, +9,912 / −41 lines relative to the initial commit
(`db16b7f Initialize Aldo Aim Lab`, which contained only `README.md` and
`.gitignore`). Everything below is new except `README.md` (rewritten).

**Project config**

| File | Purpose |
|---|---|
| `package.json` | scripts (`typecheck`, `lint`, `test`, `demo`), dev-deps only |
| `package-lock.json` | lockfile |
| `tsconfig.json` | strict TS, NodeNext ESM, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` |
| `vitest.config.ts` | deterministic test runner config |
| `eslint.config.js` | flat ESLint config (js + typescript-eslint) |
| `README.md` | rewritten: purpose, quickstart, layout, standards |

**Domain model (`src/domain/`)**

| File | Contents |
|---|---|
| `schema.ts` | `SCHEMA_VERSION = 1`, `VersionedEnvelope<T>`, persisted kinds |
| `geometry.ts` | `Vec2`/viewport math helpers |
| `ids.ts` | branded template-literal id types + factories |
| `player.ts` | `PlayerProfile`, `MouseConfiguration`, Aldo defaults |
| `settings.ts` | `SensitivityConfiguration`, `FortniteSettings`, baseline |
| `validity.ts` | invalid reason codes, severities, `TrialValidity` |
| `trial.ts` | `TrialRecord` (samples/targets/shots/context/outcome/validity), `targetPositionAt` interpolation |
| `scenario.ts` | scenario definitions (flick static medium/small, flick dynamic, target-switch triple, tracking sine) |
| `experiment.ts` | machine-readable `ExperimentDefinition`, exclusion rules, stopping criteria, `AimSession` |
| `candidate.ts` | `SensitivityCandidate`, safe sensitivity ranges |
| `recommendation.ts` | aim dimensions, `DimensionEstimate`, `Evidence`, `Recommendation` |

**Capture (`src/capture/`)**: `events.ts` (event vocabulary, source
descriptor/kinds), `clock.ts` (`MonotonicClock`, system/manual impls),
`recorder.ts` (`TrialRecorder`: integrates deltas, records targets/shots/focus,
produces `TrialRecord`s).

**Sensitivity math (`src/sensmath/`)**: `sensitivity.ts` (eDPI, normalized/log
comparisons, multiplicative & percentage changes, calibrated physical
conversions returning `null` when uncalibrated), `candidates.ts` (bounded
geometric ladders, dedupe, clamping, manual candidates), `calibration.ts`
(`UNCALIBRATED`, empirical-measurement constructor).

**Metrics (`src/metrics/`)**: `stats.ts` (mean/median/percentile/RMS/CV/SE),
`flick.ts` (reaction/movement/acquisition times, direction error, path length
& efficiency, peak axial progress → overshoot/undershoot, correction count &
distance, final error, hit accuracy, target-switch latency), `tracking.ts`
(mean/median/RMS/percentile errors, time-on-target bands, path efficiency,
directional lag scan, correction frequency, loss/reacquisition events).

**Validation (`src/validation/validateTrial.ts`)**: nine reason codes with
fatal/suspect severity; returns structured validity without mutating records.

**Experiments (`src/experiments/protocol.ts`)**: definition builder (ladder,
manual candidates, scenario mix, warmups/reps, seeds, rests, exclusion rules,
stopping criteria) and `planCandidateBlocks` — block-randomized candidate
order per round plus **paired design**: identical scenario multiset per
candidate per round.

**Simulator (`src/sim/` + `src/util/rng.ts`)**: mulberry32 RNG + seed combiner;
`player.ts` (configurable synthetic player + four presets);
`submovement.ts` (smooth-step stroke emission with tremor);
`simulator.ts` (`SyntheticExperimentRunner`: paired instance geometry seeding,
flick synthesis with reaction/speed/amplitude-error/correction/trigger stages,
moving-target interception, tracking pursuit model, virtual monotonic clock);
`calibrate.ts` (Monte-Carlo composite-optimum estimation harness).

**Optimizer (`src/optimizer/`)**: `scoring.ts` (dimension scoring config +
per-trial [0,1] scores + weighted utility), `evaluate.ts` (exclusion policy,
scenario centering, per-candidate estimates), `quadratic.ts` (weighted least
squares parabola fit with full covariance → vertex SE, peak significance),
`confidence.ts` (normal CDF, confidence mapping, labels),
`optimizer.ts` (`SensitivityOptimizer`: trial intake + validation, refinement
proposals incl. boundary expansion, recommendation assembly, refusal path).

**Persistence (`src/persistence/`)**: `migrations.ts` (envelope wrap/unwrap,
migration registry, shipped v0→v1 trial migration), `store.ts`
(`LocalJsonStore` over fs/promises, typed save/load wrappers, path-safety).

**Demo & public API**: `src/demo/cli.ts` (full pipeline demonstration with
`--calibrate` mode), `src/index.ts` (public exports).

**Tests (`tests/`)**: `helpers.ts` (fixture builders incl. parametric straight
flick), plus `sensmath.test.ts`, `flickMetrics.test.ts`,
`trackingMetrics.test.ts`, `validation.test.ts`, `protocol.test.ts`,
`simulator.test.ts`, `optimizer.test.ts`, `persistence.test.ts`,
`blindRecovery.test.ts`.

**Docs (`docs/`)**: `ARCHITECTURE.md` (stack, module map, data flow, A/B/C
measurement classes, ten numbered decisions with rationale, limitations),
`METRICS.md` (every metric defined precisely + constants tables + reason
codes), `OPTIMIZER.md` (methodology), `SIMULATOR.md` (model equations,
constants table, determinism, composite-vs-nominal optimum distinction),
`PERSISTENCE.md` (layout, envelopes, migrations, raw-first guarantee).

## 3. Exact test count and results

Final verification run:

```
✓ tests/flickMetrics.test.ts     (15 tests)
✓ tests/trackingMetrics.test.ts  (10 tests)
✓ tests/sensmath.test.ts         (14 tests)
✓ tests/simulator.test.ts         (8 tests)
✓ tests/persistence.test.ts       (8 tests)
✓ tests/protocol.test.ts          (6 tests)
✓ tests/validation.test.ts       (10 tests)
✓ tests/optimizer.test.ts        (14 tests)
✓ tests/blindRecovery.test.ts     (8 tests)

Test Files  9 passed (9)
Tests      93 passed (93)
Duration   ~57–93 s (blind-recovery Monte-Carlo suite dominates runtime)
```

Coverage highlights: hand-built trajectories for overshoot/undershoot/direction
error/switch latency; every validation reason code; determinism and blinding;
byte-level persistence round-trips incl. v0→v1 migration; surrogate-fit
exactness; ordering/pairing protocol properties; fatigue effects; refusal paths.

## 4. Lint / type-check results

```
npm run lint     → eslint .          0 problems (0 errors, 0 warnings)
npx tsc --noEmit →                   clean (exit 0)
```

Both re-run immediately before writing this report.

## 5. Simulator implementation and determinism

**Seeding.** mulberry32 PRNG; Gaussian via Box–Muller; lognormal via
exp(normal). Seeds combine via FNV-style `combineSeeds`. Measured-trial seeds
derive from `(sessionSeed, round, hash(scenarioId), measuredIndexWithinBlock)`
so that **within a round every candidate faces byte-identical target instance
geometry** — a genuinely paired experiment rather than independent draws.
Warmup trials use sequence-based seeds. A virtual monotonic clock sequences
trials and rest periods.

**Flick synthesis** (per target): lognormal reaction (~210 ms median, σ=0.2,
independent of sensitivity; fatigue adds up to +150 ms); cursor speed
`v = 4.2 px/ms · r^0.88` clamped [0.35, 14] where `r = candidateEDPI /
hiddenOptimalEDPI`; **amplitude error linear in octaves** — factor
`1 − 0.46·|x|` below optimal (`x = log2 r`) and `1 + 0.45·|x|` above, times
lognormal execution noise scaled by skill and |x| — producing undershoot on
the slow side and overshoot on the fast side; smoothed-step submovement at
240 Hz with tremor `motorNoisePx·(1+2.5·max(0,x)²)`; corrective strokes capped
by correction skill, each reducing residual error by
`(0.55+0.42·skill)·max(0.25, 1−0.5x²)` with noise growing `(1+2.5x²)`;
settle + lognormal trigger delay; hits decided geometrically by the recorder
(cursor within target radius at shot time); per-target timeout aborts without
a shot. Moving targets are intercepted at predicted arrival time.

**Tracking synthesis**: Lissajous target path (periods ≈2.1/3.4 s); first-order
pursuit `kp = clamp(16·r^0.45, 2, 26)` s⁻¹; per-sample noise
`6px·(2.2−1.65·trackingSkill)·(1+2.2x₊²+1.6x₋²)` (jitter when too fast, drift
when too slow); distraction impulses scale with (1 − trackingSkill) and decay,
generating loss/reacquisition events.

**Determinism.** Verified by test: two fresh runners with equal seeds produce
identical samples/targets/outcomes; different seeds diverge. The hidden optimum
lives only inside the runner's player config and provably never appears in
definitions, trial payloads, or recommendations (structural leak tests assert
this).

**Presets** (all fields overridable): `consistent-medium` (Aldo-like default),
`jittery-fast`, `deliberate-slow`, `noisy-beginner`.

## 6. Optimizer methodology

Per evaluation pass:

1. Validate every incoming trial; attach structured validity results.
2. Exclude trials under the fatal-reason policy (and suspects under the
   configured policy), counting exclusions per reason code.
3. Scenario-center dimension scores cross-candidate (additive adjustment) so
   scenario difficulty cannot masquerade as sensitivity effects.
4. Per-candidate dimension estimates (mean / standard error / n).
5. Composite utility = weighted mean over present dimensions
   (accuracy .28, speed .14, trackingPrecision .14, correctionEfficiency .12,
   overshootControl .11, undershootControl .11, consistency .10; weights ship
   inside every recommendation). SE propagated as √Σ shareᵢ²SEᵢ².

Search:

- **Stage 1:** geometric ladder around baseline (default ×1/1.35, ×1/1.15, ×1,
  ×1.15, ×1.35), block-randomized order, warmups excluded from scoring.
- **Refinement rounds** (up to `maxSearchRounds`): proposals from (a) the
  vertex of a weighted quadratic surrogate fitted in `log2(eDPI/baseline)`
  space using 1/SE² weights, (b) the midpoint between the top two candidates,
  and (c) boundary expansion ±0.35 octaves when the best candidate sits at a
  tested edge. Proposals enter the running experiment via
  `optimizer.addCandidates`.

Recommendation:

- Best = argmax mean utility; Welch-style gap z vs runner-up.
- Reported range = eDPI extent of the statistically tied set (95 % CI overlap).
  Boundary-best extends the range outward half a ladder step with an explicit
  warning. When peak curvature is significant, the surrogate's 95 % vertex CI
  is unioned in — ranges can be widened by the model, never narrowed (narrowing
  produced confident misses during development and was deliberately removed).
- Point estimate = median of {weighted-fit vertex, unweighted-fit vertex, best
  candidate}, clamped into the reported range.
- Confidence ∈ [0.05, 0.99]: base `2(Φ(|z|)−0.5)`; +0.25 significant interior
  peak; −0.15 any incomplete candidate; ≤0.45 if the best candidate lacks
  minimum valid trials; −0.10 boundary best; capped 0.65 on weak separation;
  floor 0.15 with <3 candidates having data. Labels low/<0.5, moderate/<0.8,
  high otherwise; `refusedHighConfidence ⇔ confidence < 0.5`.
- Dedicated insufficient-evidence path returns a wide range, confidence 0.15,
  explicit warning, and no dimension claims.

## 7. Blind hidden-optimum recovery experiments

Protocol: for each case, build a fresh 5-candidate experiment around the 7 %
baseline @800 DPI (stage-1 candidates 4148–7560 eDPI), 10 measured reps per
candidate, 2 warmups, up to 2 rounds including refinement/expansion; run the
optimizer against simulated observations only; compare against ground truth.
Ground truth is the **Monte-Carlo measured composite optimum** (9-point ladder
× 16 reps × 3 rounds through the identical production scoring stack, quadratic
vertex where stable, raw best grid point otherwise) — because the multi-
dimensional optimum legitimately differs from the amplitude-error "nominal"
knob (speed/tracking gradients tilt the trade-off). This distinction is
documented in `docs/SIMULATOR.md` and surfaced by the demo's `--calibrate`
mode.

All seven experiments (re-executed at report time):

| # | Player configuration | Hidden nominal (eDPI) | MC composite truth (eDPI) | Seed | Recommendation | Confidence / label | Reported range (eDPI) | Abs err vs MC truth | Abs err vs nominal | Separation |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | consistent-medium (flick .65, corr .60, track .60, motorNoise 1.2 px, trialNoise 1×) | 3200 | 2545 (raw-best grid point) | 101 | 3255 eDPI (sensX 4.07 %) | 0.51 moderate | [2553, 4870] | 27.9 % | 1.7 % | weak (boundary warnings fired; range brackets truth within 8 eDPI) |
| 2 | consistent-medium | 5600 | 5126 (quadratic vertex) | 101 | 4999 eDPI (6.25 %) | 0.11 low | [4148, 7560] | 2.5 % | 10.7 % | weak |
| 3 | consistent-medium | 5600 | 5126 (vertex) | 202 | 5187 eDPI (6.48 %) | 0.68 moderate | [4148, 7560] | 1.2 % | 7.4 % | clear |
| 4 | consistent-medium | 8800 | 8960 (raw-best grid point) | 202 | 12281 eDPI (15.35 %) | 0.19 low | [5600, 12281] | 37.1 % (point drifted to expansion edge; range covers 8960 ✓) | 39.6 % | weak (refused high confidence) |
| 5 | jittery-fast (flick .85, corr .45, track .40, RT 180 ms, noise 1.8 px, over-gain .42) | 5600 | 4860 (vertex) | 303 | 4866 eDPI (6.08 %) | 0.07 low | [4494, 4866] | 0.1 % | 13.1 % | weak |
| 6 | deliberate-slow (flick .50, corr .75, track .70, RT 260 ms, speed 3.2 px/ms) | 4400 | 4480 (raw-best grid point) | 404 | 3846 eDPI (4.81 %) | 0.55 moderate | [3255, 5600] | 14.2 % | 12.6 % | clear |
| 7 | noisy-beginner (flick .30, corr .30, track .35, σ_RT .30, noise 2.4 px, trialNoise 1.6×) | 7000 | 5694 (vertex) | 505 | 6460 eDPI (8.07 %) | 0.48 low | [4148, 7560] | 13.5 % | 7.7 % | weak |

Test-suite assertion policy (as implemented): runs that are simultaneously
confident (clear separation **and** confidence ≥ 0.5) must land within
±0.35 octaves of MC truth; any run must either cover truth/nominal with its
range or be tightly concentrated near it; low-confidence runs must additionally
bracket truth within 8 % slack, stay ≤0.55 octaves, and signal their epistemic
state (refusal flag or warnings). Cases 1 and 4 are honest-boundary outcomes:
the optimizer detected "best candidate at search boundary", extended its range
outward, warned explicitly, and (case 4) refused high confidence rather than
overclaiming. All eight blind-suite tests pass.

## 8. Insufficient-evidence negative tests

- **Starved budget** (2 reps/candidate, single round, hidden 5600): every
  candidate ends below the 4-valid-trial minimum → `refusedHighConfidence =
  true`, label `low`, separation insufficient/weak, explicit warnings. Passes.
- **Structural floor:** fewer than three candidates with data forces
  confidence ≤ 0.15 even at gap z = 5 (unit-tested).
- **Incomplete best candidate** caps confidence at ≤ 0.45 even with large gaps
  (unit-tested).
- **Weak separation cap:** confidence ≤ 0.65 whenever separation is weak,
  preventing "high" labels on flat plateaus.

## 9. Persistence implementation

- `LocalJsonStore` (Node `fs/promises`; the only Node-specific module, isolated
  behind one class): typed save/load wrappers for profiles, sessions, experiment
  definitions, raw trials (`trials/<experimentId>/<trialId>.json`),
  recommendations, and optimizer-run metadata (version + weights + config).
  Path segments validated against `^[A-Za-z0-9._-]+$`.
- Every document stored as `{schemaVersion, kind, savedAtIso, payload}` with
  `SCHEMA_VERSION = 1`.
- Migration registry with sorted per-kind chains; reads migrate stepwise and
  return `{payload, migratedFrom}`; missing migration paths and
  newer-than-supported versions fail loudly — old data is never silently
  reinterpreted. Shipped worked example: v0 trial samples `{t,pos}` migrate to
  v1 `{tMs,cursor,dx,dy}` with deltas integrated.
- Raw-first guarantee: full sample streams, targets, shots, focus events,
  capture context, and validity results persist; derived artifacts are stored
  alongside but never instead of raw data.
- Round-trip tests: profile/experiment/recommendation shapes, byte-level
  sample fidelity, wrong-kind rejection, future-version rejection, null-on-
  missing, and the v0→v1 migration.

## 10. Synthetic demo output

Default run (`npm run demo`, seed 20260822):

```
Aldo Aim Lab — synthetic demonstration

Player: synthetic-medium | DPI 800 | baseline 7%/7% (5600 eDPI)
Hidden simulator optimum: 5600 eDPI (= 7.00% at 800 DPI) — withheld from the optimizer

Stage-1 candidates: 5600, 4148, 4870, 6440, 7560 eDPI
Round 0: simulated 45 trials (warmup + measured)
Round 1: refining with candidates 4995, 5222 eDPI

--- Recommendation ---
Primary: sensX=7.00% sensY=7.00% (5600 eDPI)
Plausible range: 5.19–9.45% (4148–7560 eDPI)
Confidence: 24% (low) — high confidence refused
Warning: statistically tied candidates span a wide range; treat point estimate cautiously
· Best candidate cand-baseline (5600 eDPI) utility 0.526 ± 0.071
· Runner-up cand-fm13 (4870 eDPI) trails by 0.031 utility (z=0.31)
· accuracy dimension: best 53% vs runner-up 53%
· statistically indistinguishable candidates span 4148–7560 eDPI
Evidence: analyzed=49 excluded=0 separation=weak rounds=2

--- Hidden optimum reveal ---
Nominal hidden knob eDPI: 5600
Recommended eDPI:       5600  (error vs nominal +0.0%, 0.000 octaves)
Nominal inside reported range: yes
Total simulated trials: 63
```

Calibrated run (`npm run demo -- --seed 42 --hidden-edpi 4200 --preset deliberate-slow --calibrate`):

```
Player: deliberate-slow | DPI 800 | baseline 7%/7% (5600 eDPI)
Hidden simulator optimum: 4200 eDPI (= 5.25% at 800 DPI) — withheld from the optimizer

Stage-1 candidates: 5600, 4148, 4870, 6440, 7560 eDPI
Round 0: simulated 45 trials (warmup + measured)
Round 1: refining with candidates 4534, 4820, 3255 eDPI

--- Recommendation ---
Primary: sensX=4.91% sensY=4.91% (3930 eDPI)
Plausible range: 3.99–8.05% (3194–6440 eDPI)
Confidence: 78% (moderate)
Warning: statistically tied candidates span a wide range; treat point estimate cautiously
· Best candidate cand-refine-vm0_3048 (4534 eDPI) utility 0.449 ± 0.090
· Runner-up cand-refine-exp-m0_7830 (3255 eDPI) trails by 0.089 utility (z=0.72)
· accuracy dimension: best 62% vs runner-up 38%
· quadratic surrogate over log2 eDPI ratio places the peak near baseline ×0.698
· statistically indistinguishable candidates span 3194–6440 eDPI
· surrogate vertex 95% CI: 3194–4783 eDPI
Evidence: analyzed=55 excluded=1 separation=clear rounds=2

--- Hidden optimum reveal ---
Nominal hidden knob eDPI: 4200
Measured composite optimum (Monte-Carlo, quadratic-vertex): 3727 eDPI
Error vs measured composite optimum: +5.5%
note: the measured optimum balances speed, accuracy and control dimensions; it need not equal the nominal amplitude-error null
Recommended eDPI:       3930  (error vs nominal -6.4%, -0.096 octaves)
Nominal inside reported range: yes
Total simulated trials: 72
```

## 11. Known limitations

- X-axis optimization only; independent Y-axis exploration is typed but unused.
- Browser/native capture not yet implemented; the interface and recorder are
  exercised end-to-end via the synthetic event stream only.
- Additive scenario centering approximates what mixed-effects models would do
  properly; utility SE propagation assumes dimension independence.
- Utility weights are fixed, documented defaults pending real-player preference
  data; confidence values are heuristic mappings, not calibrated probabilities.
- MC ground truth carries its own estimation error (grid quantization ~±0.06
  octaves; unstable fits fall back to raw best grid point).
- Directional-lag resolution bounded by discrete scan steps tied to sample rate.
- Single-player, single-device local storage only (by design for Pass 1).
- No empirical Fortnite rotation constants exist anywhere in the codebase;
  angular units remain unavailable until calibration is performed.

## 12. Exact git status (at time of main work)

```
$ git status --short
(empty — working tree clean after the Pass 1 commit)

$ git branch --show-current
ox/aldo-aim-lab-20260822T190348Z-f653d4f2
```

(This report file is added afterward in its own commit; see §13.)

## 13. Exact commit hashes

- Foundation commit (all Pass 1 engineering work):

```
d1bca050324e207a9d8c5002ac72bf6f06faf20f
d1bca05 Build Aldo Aim Lab measurement and optimization foundation
parent: db16b7f Initialize Aldo Aim Lab
branch: ox/aldo-aim-lab-20260822T190348Z-f653d4f2
```

- Report commit (this document): see `git log -1 --format=%H` after the report
  commit lands; it contains only `PASS-1-REPORT.md` and no code changes.

## 14. Recommended Pass 2 priorities

1. **Real capture layer** — browser Pointer Lock implementation of
   `CaptureSource` feeding the existing recorder, plus the session-runner
   orchestration surface the UI will drive.
2. **Statistical upgrades** — mixed-effects (or paired-difference) inference
   exploiting the shared-instance design; adaptive rep allocation toward
   promising candidates; replace additive centering assumptions.
3. **Y-axis search & preference elicitation** — independent Y sensitivity
   exploration (types already support it); fit or elicit utility weights from
   the player instead of fixed defaults.
4. **Empirical Fortnite calibration** — an in-app measurement procedure that
   fills `CalibrationParameters` (deg/count at 100 % X/Y), unlocking cm/360
   reporting and angular scenario units end-to-end.
5. **Confidence calibration & longitudinal history** — validate confidence
   mappings against human test/retest sessions; cross-session comparison over
   the persisted history; carry uncertainty forward between experiments.
