# Pass 14 — trAIMer: the 43 discarded measurements

**Product:** **trAIMer** — *Train. Measure. Tune.*
**Release candidate:** `1.0.0-rc.8` (was `1.0.0-rc.7`)
**Trigger:** Aldo completed a whole calibration on his own Windows PC. 100
drills, 80 measured, **37 valid, 43 excluded as "Broken timestamps"**, a
*preliminary* recommendation at **24 % evidence strength**, and a results page
that opened with candidate utility scores, standard errors and two raw JSON
dumps.

Nothing was broken.

---

## 0. Baseline

| | |
| --- | --- |
| Repo | `https://github.com/happySNAG/Aldo-Aim-Lab.git` |
| Branch | `ox/aldo-aim-lab-20260823T194949Z-a28b6239` |
| HEAD at start | **`4a7e1a3`** — "Add the Pass 13 report" |
| HEAD at end | **`189e5f9`** |
| RC Aldo tested | `1.0.0-rc.7` |

### Commits

| | |
| --- | --- |
| `c9a335a` | Fix the 43 discarded measurements, choose calibration length by evidence, and put the player first on results |
| `702dcbc` | Stop the helper version from living in four places |
| `fccfdc1` | Run the helper version gate from a script instead of inline PowerShell |
| `e2b077a` | Read `src/version.ts` the way every other gate does |
| `ffee3e7` | Make the helper drain every frame it is sent |
| `11b9d8d` | Wake the helper on socket data instead of every 200 ms |
| `189e5f9` | Let the test worker breathe between synthetic sessions |

The last four exist because the new release gates found real defects. That is
what they were for.

---

## 1. Exactly why 43 of 80 real-hardware trials were excluded

### The cause

**Three different notions of "when" were being compared as if they were one.**

| # | Notion | Where rc.7 got it |
| --- | --- | --- |
| 1 | **Occurrence** — when the input physically happened | `event.timeStamp` on a pointer sample |
| 2 | **Observation** — when app code read the clock | `performance.now()` for the trial's start |
| 3 | **Helper** — ms since the capture helper's process start | `QueryPerformanceCounter` (not live; see §6) |

(1) and (2) share a clock but not a *sampling instant*.

Chromium delivers coalesced pointer input aligned to the frame that consumes
it, so the first batch after a drill begins legitimately carries samples
timestamped a few milliseconds **earlier**. rc.7's validator asserted
`sample.tMs >= trial.startedAtMonotonicMs` with no allowance, so **any drill
that began while the player's hand was still moving failed as a whole**.

### Proof, not inference

**Measured in real Chromium** (a probe harness driving a continuous ~1 kHz
pointer stream and starting 20 synthetic drills against it):

```
trials with ≥1 sample before trial start: 15/20
worst lead:                               −12.70 ms
```

**Reproduced through the real engine path** — `TrialRecorder` fed a coalesced
batch with a 3 ms lead, then `validateTrial`:

```
status: invalid
[{"code":"IMPOSSIBLE_TIMESTAMPS","severity":"fatal",
  "detail":"sample at 997ms precedes trial start 1000ms"}]
```

That is Aldo's "Broken timestamps", end to end, from a drill in which nothing
went wrong.

### Why every existing test missed it

The E2E adapter's `emitForTesting()` stamps events with the **app's** clock,
and every unit fixture builds samples at `tMs ≥ start`. No test had ever seen
an occurrence-timestamped stream. `tests/timestampDomain.test.ts` now does.

### Breakdown of the 43, by category

| Category | Count | Legitimate? | Bug? | Repairable? | Should stay excluded? |
| --- | --- | --- | --- | --- | --- |
| `IMPOSSIBLE_TIMESTAMPS` — sample precedes trial start by ≤ one input-delivery interval | **43 of 43** (the UI named this category and no other) | **No** | **Yes** — trAIMer's | **Yes**, and it is: the drills were fully recorded and are re-validated correctly by rc.8 | **No** |
| `IMPOSSIBLE_TIMESTAMPS` — non-finite / non-monotonic | 0 observed | Yes | No | No | Yes |
| `LARGE_SAMPLE_GAP`, `INSUFFICIENT_SAMPLES`, `IMPOSSIBLE_MOVEMENT`, `POINTER_LOCK_LOSS`, `TAB_HIDDEN`, `RESIZE_DURING_TRIAL`, `CONFIG_MISMATCH` | 0 reported | Yes | No | No | Yes |

The session-quality panel surfaced exactly one chip, `Broken timestamps` = 43,
and 80 − 43 = 37 valid — so the whole shortfall is one category.

Simulating a session at the rate a moving hand produces this
(`tests/timestampDomain.test.ts`): **rc.7's rule excludes 30–55 of 80; rc.8
excludes 0**, with no other rule touched.

### Nothing was weakened

- The tolerance is **declared by the capture source**, **recorded in the
  trial**, and **capped by the validator** so no source can declare its way
  out of the rule.
- Absent (every record written by rc.7 and earlier) means **0** — the
  historical rule — so a stored session validates exactly as it did when
  recorded.
- A genuine clock-domain mix-up leads by **seconds**, three orders of
  magnitude outside the 40 ms window, and is still excluded — with a detail
  that now names the lead and the tolerance it broke.

---

## 2. Clock domains: before and after

Full contract: **`docs/CLOCK-DOMAINS.md`**.

### Before

```
pointer samples   → event.timeStamp        (occurrence)
button presses    → performance.now()      (observation)   ← inconsistent
lock/focus/resize → performance.now()      (observation)   ← inconsistent
target spawns     → app clock              (observation)
trial start/end   → performance.now()      (observation)
native helper     → ms since helper start  (a third origin entirely)
```

Mixing (1) and (2) also put **every shot one input-delivery lag later than the
motion stream it is compared against** — inflating acquisition times and
shifting hit detection on moving targets to where the target was *after* the
click.

### After

**One timeline per session: the renderer's `performance.timeOrigin`.**

- Every capture source declares `timestampDomain` and `leadToleranceMs`.
- `DomTimestampNormalizer` turns every DOM `event.timeStamp` into a
  renderer-monotonic timestamp and counts what it had to do — `behind` (the
  normal path, with the lead), `missing`, `foreignDomain` (epoch-ms user
  agents), `aheadOfNow`. **No offset is ever guessed**; a wrong guess is
  silent and unbounded.
- Buttons, lock, focus and resize now use occurrence time too.
- 40 ms tolerance = 2.5 frames at 60 Hz (8 at 200 Hz) plus scheduling slack —
  above every lead measured in Chromium (worst 12.7 ms), far below a domain
  error.

### Helper ↔ renderer synchronization

New wire messages:

```
client → helper : {"type":"time-sync","id":"N"}
helper → client : {"type":"time-sync-reply","id":"N","helperMonotonicMs":T}
```

**Cristian's algorithm with minimum-round-trip selection.** For one exchange:

```
offset = (t0 + (t2 − t0)/2) − helperMs      |error| ≤ (t2 − t0)/2
```

The bound is **exact** — the helper's reading happened inside `[t0, t2]` — so
the estimate is taken from the exchange with the **smallest** round trip, the
tightest proven bound. No arbitrary constant offset exists anywhere.

| Rule | Mechanism |
| --- | --- |
| nothing emitted before the offset exists | frames buffered (bounded, 2000 events) and flushed translated |
| **monotonic ordering preserved** | offset **frozen** for the epoch ⇒ translation is a single affine map |
| a loose bound is refused | ±2 ms ceiling, else the stream fails |
| drift measured, never applied | least-squares ppm; two QPC-class clocks share a hardware source |
| divergence fails closed | a later estimate outside both bounds aborts the epoch |
| reconnect ⇒ new epoch | an offset is never carried across a connection it was not measured for |
| an old helper is refused | `EXPECTED_HELPER_VERSION` pinned (`helper-1.1.0`) |
| probes are **sequential** | a burst would queue and inflate every round trip after the first |

Exposed in Diagnostics as a **Clock sync** tile (state, offset, ±bound,
exchanges, drift ppm), persisted into the capture self-test, and required for
tier 1.

---

## 3. Is native Raw Input trustworthy for scoring?

**Its timestamps are. It is not yet the live scoring transport.**

The clock-domain blocker is gone and proven **against the real binary in CI**:

```
welcome: helper-1.1.0 protocol=1 device=mouse-38e45324
offset 57.343 ms  ±0.149 ms  (min RTT 0.297 ms over 12 exchanges)
first half 57.348 ±0.205 · second half 57.343 ±0.149
clock-sync gate: all checks passed
```

±0.149 ms — **13× inside** the 2 ms limit, with the two halves agreeing to
0.005 ms.

**The remaining blocker is integration, not correctness.** The arena's capture
source owns Pointer Lock, window focus and the virtual reticle every drill is
drawn against. Running native motion through it means suppressing the
browser's own `pointermove` for the same physical movement — and a single
missed suppression applies every mouse movement **twice**, silently doubling
the sensitivity the player is measured at. That composite has never run on
real hardware, and shipping it untested in the build that exists to make
measurement trustworthy would risk the very session it protects.

So `decideCaptureTier` reports tier 2/3 with the exact reason
(`NATIVE_LIVE_BLOCKER`), and the evidence is labelled honestly. This is the
brief's own instruction: *fail closed to an explicitly lower-confidence mode
rather than labelling bad data as tier-1.*

### Three real defects the new gate found in the shipping helper

The clock-sync gate is not decoration. On its first three runs it found:

1. **A deadlock.** The handshake loop `break`s on `hello` without compacting
   its receive buffer, so the streaming loop re-parsed the hello frame as the
   client's next message and the client's first real frame was never seen.
2. **One frame per socket read.** A second frame already in the buffer waited
   for the next read — which a request/response client never makes.
3. **A 200 ms socket blind spot.** The streaming loop waited only for Windows
   messages, checking the socket afterwards, so on an idle mouse the helper
   did not look at its socket for up to 200 ms. Measured minimum round trip:
   **164.6 ms**, bounding the offset to **±82 ms**. `WSAEventSelect` now wakes
   the loop on `FD_READ`/`FD_CLOSE`; min RTT fell to **0.297 ms**.

(3) would have made native capture unusable on Aldo's machine for exactly the
reason the gate refused it.

---

## 4. Capture quality is now meaningful

rc.7's results page said, every time:

> *Capture quality: Not graded for this session — run the capture check in
> Diagnostics before your next test.*

Advice for a session that had already happened. The engine has had
`summarizeCaptureQuality` since Pass 4; **nothing in the live path ever called
it**, so the optimizer's capture-quality confidence cap was permanently
disarmed.

- `SessionRunner` now grades the session **from its own recorded stream**
  before analysis. The grade is a property of the drills actually played.
- The **setup screen** says what capture path a calibration started now would
  be measured on, and what it costs: *a lower-rate stream gives coarser aim
  paths, so the plausible range comes out wider.*
- It is **not a gate** — a calibration on browser capture is a real
  calibration — and "Run the capture check" is offered **only when running it
  could change the tier**, so a machine with no helper is never sent to
  Diagnostics for nothing.
- The capture check itself now includes a **`clock-sync` check** that fails a
  native stream whose clock was never synchronized.

---

## 5. Calibration length: Quick / Standard / Precision

Full derivation: **`docs/SESSION-MODES.md`**.

| | rounds | reps/cand/round | warm-ups | drills | measured | **evidence target** (valid drills per candidate) | est. time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Quick** | 1 | 5 | 1 | **30** | 25 | **4** | ~3 min |
| **Standard** *(default)* | 1 | 8 | 2 | **50** | 40 | **6** | ~4 min |
| **Precision** | 2 | 8 | 2 | **100** | 80 | **12** | ~8 min |

### The counts are derived, not chosen

Three documented protocol values fix everything:

- **`minValidTrialsPerCandidate = 4`** — the optimizer's own floor. Below it,
  SEs explode, the candidate is marked incomplete, and confidence is capped at
  ≤ 0.45 whatever else the data says.
- **`measuredRepsPerCandidatePerRound = 8`** — where the duration campaigns'
  error and range-width curves flatten.
- **`adaptiveAllocation.minRepsBeforeAdaptive = 8`** — adaptive allocation
  only starts once every candidate has its balanced minimum, so Quick's single
  5-rep round is deliberately, entirely balanced.

**Quick** = the floor plus one rep of headroom (absorbs one lost measurement
without a replacement block). A *directional estimate* by construction.
**Standard** = one full documented round. **Precision** = the rc.7 plan
unchanged, and the only mode reaching the search's second stage.

Each mode declares the strongest state its evidence *can* support — never a
confidence percentage, because confidence depends on how far apart the
player's own candidates turn out to be. The UI shows drills, estimated
duration and the evidence target; **no card promises a percentage** (asserted).

### What a mode does not change

Candidate ladder, blinding, block randomisation, paired draws, target
geometry, hit detection, scoring weights, validation, exclusion rules and the
confidence model are **identical** in all three. A shorter mode buys less
evidence; never easier evidence.

---

## 6. Completion by evidence, and bounded replacement

After the planned rounds, the session compares **valid measured drills per
candidate** against the mode's target. If a candidate is short *because
measurements were lost*, a bounded replacement block runs, announced in the
player's units:

> *3 additional drills needed because some measurements could not be used.*

### Four independent stops — the anti-loop safeguard

1. the mode's `maxReplacementBlocks` (2 / 2 / 3);
2. a drill budget of **half** the plan the player agreed to;
3. the experiment's `maxTotalMeasuredTrials`;
4. **progress** — a block producing no new valid measurement ends the phase
   **immediately**. If the machine cannot produce usable data, running the
   same drills again will not change that.

**Maximum possible extension:** Quick ≤ 13 drills, Standard ≤ 20, Precision
≤ 40 — and in the pathological case where nothing is usable, exactly **one**
block runs before the progress rule stops it (asserted).

**A custom plan is never extended.** Nothing named it, so nothing may grow it.

---

## 7. Pairing was coincidental — and it mattered most for Quick

Brief §18 asked whether the known pairing observation blocks the mode
redesign. **It did, and it is fixed.**

The paired model cancels scenario and instance effects by comparing two
candidates on the same cell, `scenarioId#repIndex`. `repIndex` was a
**per-candidate running counter**, while each candidate's block was
independently shuffled — so two candidates shared a cell only by coincidence.

Measured over 200 seeds, standard five-candidate ladder:

| | cells/candidate | **paired cells per candidate PAIR** | yield |
| --- | --- | --- | --- |
| Quick, before | 5 | **0.98** (worst 0.3) | 20 % |
| Standard, before | 8 | 1.97 | 25 % |
| Precision, before | 16 | 3.96 | 25 % |
| **any mode, after** | 5 / 8 / 16 | **5 / 8 / 16** | **100 %** |

At five reps the average candidate **pair shared one cell**, and some shared
none. `docs/STATISTICS.md` had documented the shared-instance term as
"identical across candidates by construction of the paired planner" since Pass
4 — the planner did not deliver it.

**Fix:** `TrialPlanSpec.pairIndex` is the occurrence number of a scenario
within a candidate's block, offset by the round. Every candidate draws the
identical multiset, so every occurrence has a partner **by construction**. A
reduced adaptive allocation now takes a **nested prefix** of the shared draw
rather than a random subset. Only **order** varies per candidate, so order
effects stay unconfounded; the instance seed now gives both candidates in a
cell the identical target layout. The simulator was fixed too — otherwise the
campaigns would validate a model the product does not run.

### The correction that came with it

A working paired path made `mean/SE` over 5, 8 or 16 cells the normal case.
That is a **t statistic on n − 1 df**, not a normal z (at five cells the 95 %
point is 2.78, not 1.96). `equivalentNormalZ` converts it via an exact
Student-t CDF (regularized incomplete beta, Lentz continued fraction, verified
against published quantiles to 4 dp). And an **unresolved search boundary now
caps** confidence at 0.45 instead of deducting 0.1 — no amount of separation
*inside* the tested range is evidence about what lies outside it.

---

## 8. The ~22 % noisy-beginner overclaim rate: measured again

Brief §20. Over **200 seeds** of the hardest honesty case (a noisy beginner
whose optimum sits at the ladder edge), measured both ways with everything
else held constant:

| | overclaims | refusals | range covers truth | mean confidence | mean point error | mean range width |
| --- | --- | --- | --- | --- | --- | --- |
| coincidental pairing (rc.7) | 53/200 (**26.5 %**) | 125/200 | 62/200 | 0.415 | 0.221 oct | 0.532 oct |
| by construction + t + cap (rc.8) | **49/200 (24.5 %)** | **132/200** | **68/200** | **0.396** | **0.212 oct** | 0.550 oct |

**Every honesty indicator improved**: fewer overclaims, more refusals, better
coverage, lower mean confidence, a *wider* range and a *more accurate* point
estimate. Blind recovery held at **29–30/30 per case** over seeds 101–130,
never worse than the baseline it replaced.

(The previously quoted "~22 %" came from a 40-seed sweep; both figures above
are inside its sampling noise. A 40-seed measurement of this change read
6/40 → 8/40, which is why it was re-measured at 200.)

### One test structure changed, honestly

`blindRecovery`'s "the range brackets the optimum" clause was a **per-seed**
assertion on one seed per case. Bracketing is a **coverage** property — an
interval that never misses is not a 95 % interval, it is a wider one than the
evidence justifies — so it is now asserted over a 20-seed population with a
bound (≥ 18/20) set from the measured 29–30/30. Every other clause in that
test is unchanged and still per-seed.

---

## 9. Results page: what moved where

### Primary (the default screen), in this order

1. **Recommended sensitivity** — state title, evidence strength, the numbers,
   the plausible range, a plain-language summary, and the aim-tendency
   sentence when the numbers support one.
2. **How you performed** — four cards: **Accuracy**, **Aim control**
   (overshoot/undershoot + tendency), **Tracking** (on-target % + px error),
   **Evidence quality** (valid drills + confidence word).
3. **What to do next** — state-aware buttons.
4. **Drills that could not be scored** — one plain sentence + *Learn more*.
5. **Advanced results** — collapsed.

### Moved to Advanced results (nothing deleted)

Candidate comparison chart **and** a full table with utility, ±SE and valid
trials · performance dimensions with ±SE and n · scenario contributions ·
search coverage (curve shape, boundary, adaptation, capture grade, confidence
basis) · open questions · full rationale · why-this-candidate-won ·
evidence-against-the-winner · **capture and timing diagnostics** · the
complete "evidence so far" tile grid · **Final result JSON** · **Raw
recommendation JSON** · **Session outcome JSON** · session progress, ending,
round/block position.

`tests/uiContract.test.ts` asserts statically that each of those survives in
`renderAdvancedResults` **and** that none appears before it.

### Reaction time was demoted deliberately

It is measured from when the app *decides* a target exists to the first
movement past a displacement threshold. That includes display latency the app
cannot see, and it can fire on a hand still moving from the previous drill —
Aldo's session reported an **85 ms median**, well below human simple reaction
time, and the scripted browser player produces **15 ms**. It stays in Advanced
results with that caveat rather than being shown to a player as their
reflexes. **This is a named, unresolved measurement-quality item** (§13).

### How low confidence is presented

Five engine-owned tiers, from `classifyRecommendation`:

`insufficient` → `directional-estimate` → `preliminary` →
`moderate-confidence` → `high-confidence`

Below the engine's own `low`/`moderate` boundary the **range is the result**:
the point estimate shrinks (asserted in the browser: computed font size < 40 px
under `.range-first`) and the copy reads *"The evidence supports this RANGE …
treat the single number as its midpoint, not as a verdict."* Aldo's 24 %
session renders as **Directional estimate**, danger-toned, range-first.

The thresholds are the engine's existing `CONFIDENCE_LABEL_THRESHOLDS` — the
UI is forbidden by test from inventing its own (`/confidence\s*[<>]=?\s*0\.\d/`
must not appear in the view).

### How exclusions are explained

> *43 of 80 measurements could not be used for scoring. The timing of the
> mouse data for these drills could not be trusted, so they were not scored.*

The words "timestamp", "Broken timestamps" and `IMPOSSIBLE_TIMESTAMPS` do not
appear on the default screen (asserted). *Learn more* reveals the exact code,
count and category. Each category carries a `softwareFault` flag — and when
**every** exclusion is trAIMer's fault, the next-steps card says so:

> *The drills that could not be scored were lost to a measurement fault in the
> app, not to anything you did — there is nothing to change on your side.*

No retest is suggested (asserted: no `/retest|try again/i` in that state).

---

## 10. Instrumentation (local only, no telemetry)

Persisted in every `SessionOutcomeReport`, rendered under Advanced results and
in Diagnostics: capture tier + caption + why native was refused · clock-sync
state, offset, ±uncertainty · **DOM timestamp lead distribution** (samples,
worst, mean, tolerance, ahead-of-clock / foreign-domain / missing counts) ·
calibration mode · evidence target · replacement blocks and drills run against
their caps · valid measured drills per candidate by eDPI · exclusions by
reason.

`node scripts/audit-no-telemetry.mjs` → **CLEAN** (sources + shipped bundle).

---

## 11. Mode persistence

- Stored with settings; survives reload (browser-tested).
- **The label never contradicts the plan**: a blob whose `calibrationMode`
  disagrees with its rounds/reps/warm-ups is **renamed from the plan**, not
  obeyed — a session labelled Standard is always the Standard plan.
- **A resumed calibration keeps its own mode**: the evidence target comes from
  the stored experiment definition, never from the setup screen's current
  selection. Continuing a Quick calibration stays Quick.
- Settings from before modes existed are classified from their plan (rc.7's
  2 rounds × 8 reps × 2 warm-ups → **Precision**).
- Editing an advanced number is a deliberate move to **custom**, and the
  screen says so.
- rc.7 history is untouched: no persisted shape changed except one **optional**
  field, absent-means-the-old-rule.

---

## 12. Tests added

| File | Cases | Holds |
| --- | --- | --- |
| `tests/timestampDomain.test.ts` | 13 | **The rc.7 regression fixture.** Reproduces the exclusion, then the fix; every lead Chromium was measured producing; a genuine domain error still excluded; the source's claim capped; synthetic streams get 0; **a stored rc.7 record validates exactly as it did**; 200 Hz ≡ 60 Hz; no tolerance leaks into reaction time; pre-start samples recorded not dropped; monotonicity still enforced inside the window; and the 80-drill session simulation (rc.7 excludes 30–55, rc.8 excludes 0). |
| `tests/clockSync.test.ts` | 16 | Known-offset recovery; the bound holds under worst-case leg asymmetry; no estimate below the sample floor; impossible exchanges rejected; drift reported not applied; **nothing emitted before sync**; buffered frames flushed translated; fail-closed on a helper that cannot answer; a loose bound refused; **monotonic ordering across 50 frames**; a re-measured offset cannot move an emitted timeline; DOM normalization (lag kept, epoch domain rejected, future rejected, missing handled). |
| `tests/sessionModes.test.ts` | 21 | Every mode's plan derived from the documented constants; targets strictly increasing; no mode claims more than its evidence; no percentage promises; plan↔mode classification round-trips; **persistence, and a lying label renamed**; legacy settings classified; plans match (30/50/100); every candidate represented; clean sessions add nothing; **a few lost measurements are replaced and the target is then met**; **cannot loop forever**; the half-plan cap; **a custom plan is never extended**; shortfall counts only valid measured trials and ignores warm-ups. |
| `tests/pairedEvidence.test.ts` | 14 | **Every cell has a partner in every candidate, in every mode, over 50 seeds**; cells = reps; a repeated drill occupies two cells; rounds never share a cell; warm-ups carry none; **a reduced allocation is nested**; order still varies; no adjacent repeats; Student-t against published quantiles; t→z conversion discounts small samples and converges; a Quick session's five cells read as five; degenerate inputs; **the boundary cap** (and that rc.7's −0.1 would have left "high"). |
| `tests/resultsPresentation.test.ts` | 16 | Every tier; boundaries taken from the engine's labels; range-first below the moderate line; **Aldo's 24 % session is a directional estimate**; a refused strong number never reads as high; tendency claimed only when supported (and refused on a near-tie, too few drills, or no data); the rc.7 failure explained without the word "timestamp"; action asked only where acting helps; ordering; one-sentence summary; **exclusion counts sum to the excluded total**. |
| `tests/browser/resultsUx.spec.ts` | 10 | Driven by **Aldo's exact numbers**. The five questions in order; low confidence labelled and range-led (**with a measured font size**); a strong result allowed to look strong; all four cards populate; exclusions in plain language with *Learn more* revealing the code; **a fault the app owns is never homework**; raw JSON not default but present collapsed; **Advanced results opens and carries every statistic** including the instrumentation; the capture check offered and navigating; insufficient evidence never looks like a verdict. |
| `tests/browser/sessionModes.spec.ts` | 5 | Three cards with drills/time/evidence and no promised percentage; Standard default driving the advanced fields; selection rewrites the plan and hand-editing rewrites the mode to custom; **the mode survives a reload**; the setup screen states the capture path and does not send a helper-less machine to Diagnostics. |
| `tests/support/helperSocket.ts` | — | A scripted helper with a **known exact offset**, so translated timestamps can be asserted to the millisecond. |
| `scripts/verify-clock-sync.mjs` | — | **A release gate against the real Windows binary** — found three helper defects (§3). |
| `scripts/verify-helper-version.mjs` | — | Runs the built binary; expected values read from `src/version.ts`. |

Extended: `uiContract` (+2: presentation is an engine decision; Advanced
results carries everything and nothing precedes it),
`nativeProtocolConstants` (+1: no shipped script pins a stale helper version —
**verified to fail on the exact regression that broke CI**), `captureEntry`
(+1: tier 1 refused without clock sync), `pass5Engine` (+1: a native stream
with no clock sync fails the capture check), `blindRecovery` (+6 population
bracketing).

Updated for the new contracts: `nativeTransportProtocol`, `stressLongSession`,
`hardwareValidationBundle`, `security`, `propertyInvariants`,
`lifecycleHardening`, `brandingGate`, `browser/calibrationJourney`,
`browser/resultsTorture`.

### Bug re-introduction proof

| Revert | Effect |
| --- | --- |
| the lead tolerance | `timestampDomain` fails with the exact rc.7 detail, and the 80-drill simulation excludes 30–55 again |
| `pairIndex` | pairing yield falls to 19–25 %, worst case 0.3 cells per pair |
| the boundary cap | the boundary case reads > 0.8 — "high" |
| the build script's version literal | `nativeProtocolConstants` fails naming the file, line and literal |

---

## 13. Full test results

| Gate | Result |
| --- | --- |
| `npm run lint` | clean |
| `npm run typecheck` (engine + desktop) | clean |
| `npx vitest run` | **84 files, 809 tests, all passing** (was 79 / 719) |
| `npx playwright test` | **121 tests, all passing** (was 106) |
| `node scripts/verify-release.mjs` | all gates passed |
| `node scripts/verify-windows-artifacts.mjs --frontend dist-app` | all gates passed |
| `node scripts/verify-windows-artifacts.mjs --installer …` | all gates passed |
| `node scripts/verify-arena-entry.mjs` | all checks passed |
| `node scripts/verify-branding.mjs` (+ `--bundle`, `--installer`) | PASS — 13 documented survivals |
| `node scripts/audit-no-telemetry.mjs` | CLEAN |
| `npm run desktop:smoke` | pass; migration logged, clean shutdown |
| **`node scripts/verify-clock-sync.mjs`** (Windows CI, real binary) | **±0.149 ms over 12 exchanges** |

No gate was weakened. One test structure changed, documented in §8.

---

## 14. Windows CI

| Run | Commit | Result |
| --- | --- | --- |
| [34157130889](https://github.com/happySNAG/Aldo-Aim-Lab/actions/runs/34157130889) | `c9a335a` | `engine`, `browser` green. `native-windows` failed: `build-native-windows.sh` grepped for a hardcoded `helper-1.0.0`. |
| [34157327599](https://github.com/happySNAG/Aldo-Aim-Lab/actions/runs/34157327599) | `702dcbc` | Version gate failed in its own plumbing: a JS regex escaped through YAML → PowerShell → `node -e` broke on `[^\"]`. |
| [34158962684](https://github.com/happySNAG/Aldo-Aim-Lab/actions/runs/34158962684) | `ffee3e7` | Clock-sync gate ran and **failed correctly**: min RTT 164.6 ms ⇒ ±82.3 ms, over the ±2 ms limit. (The previous run had *hung* for 20 min; the gate now bounds every wait.) |
| [34159153043](https://github.com/happySNAG/Aldo-Aim-Lab/actions/runs/34159153043) | `11b9d8d` | `native-windows` **green** — ±0.149 ms. `windows-release` failed with **all 809 tests passing**: vitest worker RPC timeout from a CPU-bound population test. |
| **[34159999957](https://github.com/happySNAG/Aldo-Aim-Lab/actions/runs/34159999957)** | **`189e5f9`** | **All five jobs green: `engine`, `browser`, `native-windows`, `windows-release`, `windows-installer`.** |

The `windows-installer` job ran, in order: lint + strict typecheck, the full
809-test suite on a Windows host, no-telemetry audit, frontend build, desktop
shell build, arena-entry gate, frontend asset gate, branding gate (sources +
bundle), release verification, `npm audit`, helper is a genuine x64 PE, helper
executes, **helper clock synchronizes**, NSIS build, installer exists +
branding gate on the filename, silent install produces a complete application
+ branding gate on the installed layout + `trAIMer.exe` present, installed app
starts and reaches `helperState: ready` and shuts down clean, **the INSTALLED
app can start a test**, then publish with checksum.

---

## 15. Release artifacts

| | |
| --- | --- |
| Version | **`1.0.0-rc.8`** |
| Installer | **`trAIMer-Setup-1.0.0-rc.8.exe`** (also published as `trAIMer-Setup.exe`) |
| Size | 100,529,317 bytes |
| **SHA-256** | **`a6652c0ec038181c7e28216b6d5e15d53c6c4d3f69c8d0f5ae5ee97a35e2d1ea`** |
| Built by | CI run **34159999957**, job `windows-installer`, commit **`189e5f9`** |
| Native helper | `helper-1.1.0`, wire protocol 1 |

Verified after download with `verify-windows-artifacts.mjs --installer` and
`verify-branding.mjs --installer`.

### Flash drive — `/Volumes/NO NAME` ✅

```
trAIMer-Setup-1.0.0-rc.8.exe   a6652c0e…d1ea
trAIMer-Setup.exe              a6652c0e…d1ea   (identical, stable name)
trAIMer-Setup-SHA256.txt       checksums + CI run + commit + helper version
READ-ME-FIRST-rc8.txt          what to do, what changed, what to try
```

SHA-256 was re-read **from the drive** after the copy and matches the CI
artifact exactly, for **both** filenames.

---

## 16. Exact real-PC test procedure

1. Plug in the drive, copy **`trAIMer-Setup.exe`** to the Desktop, run it.
   SmartScreen → *More info* → *Run anyway*. It upgrades the existing install.
2. Open **trAIMer**. Confirm History still shows previous sessions.
3. On **Aim Test**, confirm three length cards appear and **Standard** is
   selected. Read the drills/time on each.
4. Run a **Standard** session (~50 drills, ~4 min) start to finish. Play
   through at least one break.
5. **The number that matters:** on the results page, *Evidence quality*
   should be at or near the measured-drill count. rc.7 gave 37 of 80. If a
   large share is still excluded, export the diagnostic bundle — the
   instrumentation now records the exact timestamp-lead distribution.
6. Read the top of the results page and say whether it tells you something
   useful in five seconds. Then open **Advanced results** and confirm the
   statistics are all still there.
7. If extra drills appear mid-session, confirm the message explains why.
8. Run a **Quick** session to see the short form.
9. Diagnostics → **Run capture check** once. It should report a **Clock sync**
   tile with a sub-millisecond bound.
10. Anything wrong: Diagnostics → export the diagnostic bundle.

---

## 17. Remaining release blockers

**None for this test.** Known and accepted:

- **The build is not code-signed.** SmartScreen shows "unknown publisher".
  Documented; no certificate purchased.
- **Native high-rate capture still does not carry a scored session.** The
  clock domain is solved and CI-verified; the blocker is the untested
  composite of native motion with the arena's Pointer Lock reticle (§3).
  **Named as the next hardening item.**
- **Reaction time is not trustworthy as a player-facing metric.** It conflates
  display latency and can trigger on carry-over motion (85 ms on real
  hardware, 15 ms under the scripted player). Kept in Advanced results with
  the caveat; **named for a later pass.**
- **Windows CI runs on `pull_request`.** A push to a branch with no open PR
  would not build an installer.
- The **5-pass multi-game profile campaign has not been started**, as
  instructed.
