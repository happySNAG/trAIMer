# Aldo Aim Lab — Engineering Pass 2 Final Report

Status: **Complete.** Feature commit `9be608f` — "Build real-player aim
testing and adaptive optimization" (69 files, +6,603/−291) — followed by this
report committed separately. A human can now run a real Pointer Lock aim
experiment locally end-to-end: configure → lock → shoot all five scenario
families → raw persistence → optimizer → recommendation with range,
confidence, and warnings.

## 1. Architecture additions

- Browser runtime (`app/`, Vite + vanilla TypeScript, no framework): Setup /
  Run / Results / Data / Calibration tabs around a fixed logical 1280x720
  canvas. The engine remains completely DOM-free.
- Capture: `PointerLockCaptureSource` + `VirtualReticle`
  (`src/capture/browserSource.ts`) behind the unchanged `CaptureSource`
  interface; new event kinds `lock-change` and `resize`.
- Shared scenario planner (`src/scenarios/planner.ts`): one deterministic
  geometry source used by BOTH the simulator and the browser runtime, keyed by
  `(experimentSeed, round, scenarioId, repIndex)` — identical instances per
  candidate (paired design carried into human testing).
- ScenarioDirector (`src/scenarios/director.ts`): scheduled spawning,
  sequential target-switch logic, completion detection, outcome computation.
- Session layer (`src/session/`): explicit state machine + ports-injected
  runner + adaptive allocation + fatigue protocol.
- Statistics: paired-difference inference (`src/optimizer/paired.ts`,
  docs/STATISTICS.md) replacing additive centering as the primary contrast,
  with Dunnett-adjusted exclusions.
- Optimizer hardening: unresolved-boundary outcomes, vertex-inside-span point
  guard, boundary-touched confidence cap.
- Y-axis staged strategy (`src/optimizer/yAxis.ts`) plus asymmetric-optimum
  simulator support (`trueOptimalEdpiY`, directional weighting).
- Calibration workflow (`src/calibration/core.ts`, Calibration tab).
- Persistence ports (`StoreBackend`: Node fs / in-memory / IndexedDB) with
  envelope guarantees unchanged; versioned session-bundle export/import.

## 2. Real capture implementation

- Wraps requestPointerLock on the canvas; grant resolved via
  pointerlockchange, denial via pointerlockerror, hard timeout (5 s default).
  Denial or loss never crashes the session: they surface as structured events
  and abort measured trials safely (no silent continuation).
- mousemove deltas (movementX/Y) timestamped with performance.now() at
  handler time; button 0 down/up become press/release; other buttons ignored;
  context menu suppressed while locked.
- Pointer Lock operates a virtual reticle only; OS cursor irrelevant once
  locked. The reticle integrates raw deltas, clamps to viewport bounds, and
  emits ONLY the applied delta so the recorder's cursor equals the rendered
  reticle. Raw input kept separately for diagnostics; reticle resets per
  trial. Raw delta / virtual position / target position stay distinct.
- Lock loss mid-trial -> lock-change{locked:false,"pointer-lock-loss"} which
  the recorder converts into a focus interruption; validation marks the trial
  POINTER_LOCK_LOSS (fatal); window blur -> WINDOW_BLUR; tab hidden ->
  TAB_HIDDEN (fatal); resize events carry viewport dims and are flagged
  RESIZE_DURING_TRIAL when area changes >10% mid-trial.
- All events feed the existing TrialRecorder; zero analytics in UI code. A
  future native high-frequency source implements the same interface.

## 3. Playable scenarios

All five families run on real input from the shared planner:

| Scenario | Behaviour |
|---|---|
| flick-static-medium | Single disc, seeded angle/distance (220-620 px), 26 px radius |
| flick-static-small | Same at 16 px radius |
| flick-dynamic-horizontal | Strafing target (220-520 px/s), lead required |
| target-switch-triple | Three sequenced targets, next after previous resolution |
| tracking-smooth-sine | 6 s Lissajous pursuit |

Deterministic placement/paths come from planner seeds; repeated candidate
blocks face identical instances per rep index (pairing). Warmup vs measured
phases are distinguished internally and in HUD text; candidates are blinded
(letters only) during play; rests and block transitions show overlays.

## 4. State-machine design

Explicit states: idle, setup, awaiting-lock, candidate-transition, warmup,
trial-ready, trial-active, inter-trial, rest, paused, analyzing, complete,
aborted — with an explicit event table (`src/session/stateMachine.ts`);
illegal transitions throw IllegalTransitionError. Unit-tested: happy path,
pause/resume, rest cycling, cancel-from-every-live-state, terminal states.

SessionRunner (ports-injected: clock/sleep/store/execution/callbacks) drives:
lock acquisition -> round plans -> candidate blocks with rests -> warmups ->
measured trials (validate + persist immediately + checkpoint) -> adaptive
allocation between rounds -> analysis -> recommendation persisted -> complete.
Pause/resume/cancel work between trials; session-checkpoint documents record
completed sequence keys, phase log, active testing time (crash/resume data).
Misattribution is structurally prevented: candidate/scenario/phase/rep-index
are stamped from the plan spec before execution.

## 5. Statistical changes

Model: u_ire = mu_i + s_c + b_r + e_ire, where b_r is the shared instance
effect, identical across candidates by construction. Primary contrast is now
the paired difference over cells (scenarioId x scenarioRepIndex): per-cell
mean utility differences averaged across shared cells give candidate-pair gaps
with SE = sd(diffs)/sqrt(cells); scenario AND instance effects cancel exactly
(docs/STATISTICS.md).

- Best-vs-runner-up gap z uses pairing when >= 3 shared cells exist; pooled SEs
  remain the documented fallback for sparse pairs.
- Tied-set membership uses paired z vs best with a Dunnett-adjusted threshold
  z* = Phi^-1(1 - 0.05/(K-1)) controlling multiplicity — without this, the
  powerful paired tests falsely excluded plateau candidates during development
  (caught by a Pass 1 blind case regressing).
- The weighted quadratic surrogate still fits centered means; pairing governs
  gap/tie decisions. Distinctions preserved: between-candidate effect (paired
  diffs), instance difficulty (cancelled), within-player noise (within-cell).

## 6. Adaptive allocation behavior

After every candidate has >= minRepsBeforeAdaptive (default 8) valid measured
trials, later rounds allocate non-uniformly (src/session/allocation.ts):

- Best and statistically tied contenders receive full reps
  (contender-tied-with-best).
- Dominated but ladder-adjacent candidates get half reps as controls
  (ladder-neighbor-control).
- Clearly dominated far candidates get one control rep every N adaptive rounds
  (control-refresh-dominated) — never silently dropped.
- Budget capped by maxTotalMeasuredTrials (budget-exhausted). Decisions are
  pure functions of observations (deterministic, unit-tested) and each carries
  a machine-readable reason explaining why trials were or were not requested.

## 7. Pass 1 vs Pass 2 blind-recovery comparison

Campaign cases target the exact weaknesses observed in Pass 1
(tests/blindCampaign.test.ts, deterministic seeds):

| Case | Pass 1 behaviour | Pass 2 behaviour | Verdict |
|---|---|---|---|
| Below-ladder optimum (3200, seed 21) | Point pinned low; moderate confidence despite boundary | unresolvedBoundary=true, conf 0.36 low, range [2998,5222] covers truth, further-testing flagged | improved: honest range over wrong precision |
| Above-ladder optimum (8800, seed 22) | Precise point at expansion edge (+39.6% vs nominal), risk of confident miss | Vertex guard prevents edge drift; boundary-touch caps conf <= 0.65 moderate with warning; further-testing suggested | improved: no high-confidence miss possible |
| Far-above optimum, rounds exhausted (15000, seed 30) | Edge-best with exhausted rounds | Explicit unresolvedBoundary=true, conf <= 0.45, refusal signalled | hardened and tested |
| Flat/noisy plateau at baseline (noisy-beginner @5600, seed 44) | Moderate accuracy, low conf | Point within 0.1% of truth, conf capped 0.65 moderate | maintained |
| Noisy away from baseline (noisy-beginner @7000, seed 45) | Low-conf wide reporting | Refuses overclaim: low conf AND/OR range covers truth; further-testing suggested | maintained |
| Deliberate-slow profile (@5600, seed 46) | Weak-separation guardrails | Point within 15.4%, conf below high | maintained |
| Fatigue drift (fatiguePerTrialMs=6, seed 31) | Not simulated in Pass 1 campaigns | Err -7.7%, completes cleanly; fatigue modelled in-session | new coverage |
| Asymmetric X/Y optimum (X 5600 / Y 2800) | Unsupported | Staged Y exploration detects unequal-Y advantage at z >> 2 and recommends sensY != sensX | new capability |

Suite grew from 93 to 163 tests. The original Pass 1 blind suite still passes;
its assertion policy is unchanged (the MC ground-truth definition and planner
refactor shifted absolute numbers, documented inline where relevant).

## 8. Independent Y behavior

Staged strategy avoids combinatorial explosion:

- Stage 1 finds the X region as before (X=Y ladder).
- Stage 2 (opt-in checkbox in setup) anchors at the winning X and tests modest
  Y-only factors (default x0.85 / x1.18) against an equal-Y anchor. Paired
  comparisons decide: equality is recommended unless the best unequal-Y
  variant beats the anchor by z >= minImprovementZ (default 2).

Rationale (documented): most players' optimal X/Y coincide; independent Y pays
off only when vertical control differs measurably, so it is tested narrowly
AFTER X settles, keeping search space linear. Simulator support:
trueOptimalEdpiY with directional weighting heuristic rX^|cos| * rY^|sin|.
When evidence does not support inequality, the summary explicitly recommends
sensY = sensX.

## 9. Fortnite calibration workflow

External, manual, legitimate (docs/CALIBRATION.md, Calibration tab):

1. Player aims at a landmark in Fortnite; chooses method: full rotation(s)
   (theta = 360 deg known by construction) or two landmarks with known angle.
2. Start/Stop a rep: raw pointer-lock counts are summed for that rotation.
3. Repeat >= 4 (6 recommended). Per-rep deg/count@100% = theta / (counts x
   pct/100). Outliers rejected beyond 2.5 MAD — retained and flagged, never
   deleted; mean +- 95% CI reported; adequacy gates require >= 4 retained
   samples and CV <= 15%.
4. Inadequate data persists with explicit reasons and NEVER produces
   calibration parameters. Adequate records persist as versioned
   calibration-record artifacts and merge via
   calibrationParametersFromRecords(xRecord, yRecord) into the existing
   CalibrationParameters interface, after which physicalCmPer360(params, dpi,
   axis, sensPercent) returns true cm/360 at the player's sensitivity
   (sens-aware parameter added in Pass 2).

No memory reading, injection, input automation to the game, game-file
modification, or anti-cheat interaction anywhere.

## 10. Persistence changes

- StoreBackend port with three implementations: NodeFsBackend (CLI/tests),
  InMemoryBackend (tests), IndexedDbBackend (browser app through a minimal
  IDB facade). Envelope wrapping, schema versioning, and migration machinery
  untouched — browser storage inherits all Pass 1 guarantees.
- New persisted kinds: calibration-record, session-checkpoint, session-bundle.
- Versioned export/import bundles: full experiment (definition + raw trials +
  recommendation) as one JSON file; import validates envelopes (wrong kind /
  future versions rejected). Round-trip and rejection tests included; the
  IndexedDB backend is exercised through its facade in automated tests and in
  a real browser via the manual checklist.

## 11. Exact test counts/results

20 test files, 163 tests, all passing (~2.5 min wall clock):

Pass 1 suites re-run unchanged and green (94 tests across sensmath,
flick/tracking metrics, validation, protocol, simulator, optimizer structure,
persistence round-trips, blind recovery, helpers-based fixtures).

New Pass 2 suites:
scenariosPlanner 6 | stateMachine 9 | calibration 7 |
persistenceBackends 7 | browserCapture 11 | sessionRunner 5 |
allocation 4 | pairedStats 4 | optimizerBoundary 5 |
yAxis 3 | blindCampaign 8

## 12. Lint/type/build results

npm run lint      eslint .                    0 problems
npx tsc --noEmit  strict TS incl. app/        clean
npm test          vitest run                  163 passed (163)
npm run build     vite production build       succeeds (dist-app/, ~81 KB js)

## 13. Manual-run instructions

npm install
npm run app          # http://localhost:5173

Full human smoke-test checklist (Pointer Lock acquisition, clicks, static /
small / moving flicks, target switch, tracking, focus loss, pause, completion,
persisted session, recommendation generation, calibration):
docs/MANUAL-TEST.md. No cloud services, API keys, accounts, or telemetry.

## 14. Known limitations

- Browser pointer sampling is coalesced to frame rate (~60-125 Hz) and silent
  while the mouse is still; motion-aware gap validation handles this, but true
  high-rate capture awaits the future native source.
- IndexedDB backend verified via facade in automated tests plus the manual
  browser checklist; no automated cross-browser UI suite yet.
- Independent-Y directional weighting in the simulator is a documented
  heuristic, not a validated perceptual model.
- Adaptive allocation is greedy-contender with control refreshes; formal
  multi-armed-bandit guarantees are out of scope for this pass.
- Calibration requires honest external execution in Fortnite; accuracy depends
  on the user performing exact rotations. Adequacy gates refuse bad data but
  cannot detect systematically biased technique.
- Session resume restores checkpoints and completed trials; mid-trial crash
  loses only the interrupted trial (persisted as partial raw data when the
  recorder produced one).
- No real-human validation of recommendations yet; all recovery evidence is
  simulation-based by construction.

## 15. Exact commit hash

Feature commit:
9be608f "Build real-player aim testing and adaptive optimization"
(branch ox/aldo-aim-lab-20260822T190348Z-f653d4f2)

This report was committed separately immediately afterward; see
git log -1 --format=%H after the report commit for its hash.

## 16. Recommended Pass 3 priorities

1. Real-human data collection sessions; recalibrate scoring constants and
   confidence mapping against actual test/retest reliability.
2. Native high-frequency capture source behind the existing port (Windows/
   macOS) for 1000 Hz delta streams.
3. Formal mixed-effects fitting (per-player random effects) replacing the
   paired-difference approximation once multi-session data exist.
4. Bayesian/GP surrogate search with information-driven rep allocation;
   independent-Y joint search if human data shows asymmetric optima matter.
5. Polished UI pass (owned elsewhere): visual design over the existing views.
6. Longitudinal history features: trend tracking across stored sessions,
   re-test prompts driven by confidence decay.
