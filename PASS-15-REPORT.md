# Pass 15 — the sensitivity the arena never applied

**Product:** **trAIMer** — *Train. Measure. Tune.*
**Release candidate:** `1.0.0-rc.9`
**Campaign:** trAIMer Game Profile Campaign, Pass 1 of 5 — plus the
release-blocking measurement defect that pass uncovered.

**The defect, in one sentence:** the arena moved the crosshair the same
distance for every sensitivity it was comparing, so every human calibration
trAIMer has ever run measured everything except sensitivity.

---

## 0. Baseline

| | |
| --- | --- |
| Repo | `https://github.com/happySNAG/Aldo-Aim-Lab.git` |
| Branch | `ox/aldo-aim-lab-20260823T194949Z-a28b6239` |
| HEAD at start | `dd464bf` — "Add the Pass 14 report" |
| Last RC tested on hardware | `1.0.0-rc.7` |
| Unit tests at start | 980 passing, 92 files |
| Unit tests at end | **1032 passing, 94 files** |
| Browser tests at end | **136 passing** (was 134) |

---

## 1. Exact root cause

`VirtualReticle.applyRawDelta` (`src/capture/browserSource.ts`), as it stood in
rc.8:

```ts
applyRawDelta(dx: number, dy: number): { dx: number; dy: number } {
  const nextX = Math.min(this.#viewport.widthPx,  Math.max(0, this.#position.x + dx));
  const nextY = Math.min(this.#viewport.heightPx, Math.max(0, this.#position.y + dy));
  ...
}
```

One mouse count in, one logical pixel out. No candidate anywhere in the
expression, and nothing upstream scaled `dx`/`dy` before they arrived.

`BrowserRunController.#executeTrial` looked up the trial's candidate, wrote its
`sensitivity` and `dpi` into the trial record, called
`this.#capture.reticle.reset()` — position only — and started the drill. The
candidate was **metadata**, never a control input.

### Why four release candidates shipped it

Because the arithmetic was correct everywhere it existed. The candidate flowed
correctly into:

- the trial record (`request.sensitivity`, `request.dpi`),
- the optimizer, the paired fit, the adequacy gates, the recommendation,
- the results page, the history trend, the export bundle,
- **and the simulator's player model**, where
  `SyntheticExperimentRunner.#effectFor` computed
  `(dpi × sens) / trueOptimalEdpi` and degraded the synthetic player's motor
  performance accordingly.

That last one is the reason nothing caught it. Every blind-recovery campaign,
every duration-policy campaign, every statistical validation ran against a
simulator that *did* model candidate sensitivity — validating an arena the
product did not ship. The simulator was correct and the arena was inert, and
nothing in the tree compared them.

The E2E suite could not catch it either: the scripted player aims by reading
the reticle and closing the loop, so it hits targets identically at any gain.

---

## 2. Proof of failure, before the fix

`tests/arenaCandidateGain.test.ts` was written first, against unmodified rc.8
code, driving the production `PointerLockCaptureSource` through the same
candidate → capture → `VirtualReticle` sequence a real Electron trial runs, and
using candidates from a real `buildExperimentDefinition` ladder. Verbatim
output:

```
 ❯ tests/arenaCandidateGain.test.ts (2 tests | 2 failed)
   × moves the reticle identically for two materially different candidates
     → expected 1 to be close to 1.8225000000000002,
       received difference is 0.8225000000000002, but expected 5e-7
   × does not move the reticle 1 logical px per raw mouse count regardless of candidate
     → candidate cand-baseline (sensX 7) moved 1 px/count: expected true to be false
```

Read the first line carefully. The two candidates' **sensitivity** ratio is
1.8225 (the two outer ladder arms, 1.35² apart). The **displacement** ratio the
real arena produced for identical raw counts is **1.000**.

The second line is the same fact stated absolutely: every candidate in the
ladder, including the baseline, moved exactly 1 px per count.

The simulator was not used as evidence for either.

---

## 3. The candidate-gain equation, after the fix

`src/sensmath/arenaGain.ts`. Three multiplications, each a physical fact.

**1 · Candidate → physical rotation.** A game's slider fixes degrees per
*count*; the mouse's DPI fixes counts per centimetre. Physical sensitivity is
therefore proportional to `sens × dpi` — which is exactly why players compare
in eDPI — so an anchor must state the DPI its reference was quoted at:

```
degreesPerCm(sens, dpi) = referenceDegreesPerCm × sens/referenceSens × dpi/referenceDpi
```

**2 · Physical rotation → per-count rotation.** The DPI divides back out, at
the same single boundary `degreesPerCountAt()` uses:

```
degreesPerCount = degreesPerCm × 2.54 / dpi
```

**3 · Rotation → arena pixels.** One declared display constant:

```
pxPerCount = degreesPerCount × ARENA_PX_PER_DEGREE
```

Composed, with the session DPI cancelling:

```
pxPerCount(sens) = ARENA_PX_PER_DEGREE × 2.54/referenceDpi
                 × referenceDegreesPerCm × sens/referenceSens
```

### The display constant is derived, not invented

```
ARENA_PX_PER_DEGREE = ARENA_REFERENCE_DPI / (2.54 × ARENA_REFERENCE_DEGREES_PER_CM)
                    = 800 / (2.54 × 12)
                    = 26.246719 px/deg
```

The reference is **30 cm/360 at 800 DPI** — a middle-of-the-road real
sensitivity at the most common gaming DPI — chosen so the reference comes out
at **exactly 1.0 px/count**, which is the fixed gain every build up to rc.8
used. The arena's feel at the centre of the range is therefore unchanged; what
changed is that it now moves away from that centre with the candidate.

The 1280 × 720 logical arena consequently spans **48.77° × 27.43°**. The
mapping is linear, not a tangent projection: the arena is a 2D task and a
projected frustum would be decoration rather than a fact.

### What a player now feels

Default ladder, baseline 7 % at 800 DPI, declared-reference anchor:

| Ladder factor | Sensitivity | Applied gain | cm/360 |
| --- | --- | --- | --- |
| 1/1.35 | 5.185 | 0.7407 px/count | 40.50 |
| 1/1.15 | 6.087 | 0.8696 px/count | 34.50 |
| 1.000 | 7.000 | 1.0000 px/count | 30.00 |
| 1.15 | 8.050 | 1.1500 px/count | 26.09 |
| 1.35 | 9.450 | 1.3500 px/count | 22.22 |

Crossing the arena takes 4.06 cm of mouse movement at baseline, 5.48 cm at the
slowest candidate and 3.01 cm at the fastest. That is a difference a hand
notices, which is the entire point.

---

## 4. How DPI participates

DPI appears **once**, as `1/dpi`, at the same boundary the canonical
game-conversion layer uses. `2.54` has one definition in the tree
(`src/sensmath/units.ts`); `src/games/canonical.ts` re-exports it rather than
declaring its own, so the arena's physical model and the game-conversion model
are literally the same arithmetic.

The contract, all four clauses proven in `tests/arenaCandidateGain.test.ts`:

| Claim | Holds because |
| --- | --- |
| Same **physical** sensitivity at any DPI ⇒ same arena movement for the same hand movement | Travel per cm is `pxPerCount × dpi/2.54 ∝ sens × dpi`. Tested at 400/800/1600/3200 DPI with the slider halved as DPI doubles: identical travel to 9 decimal places, identical cm/360. |
| Equal **cm/360** behaves equivalently regardless of DPI | Travel per cm of hand movement equals the player's deg/cm in arena pixels, at every DPI and every sensitivity. |
| Raising **DPI alone** speeds the arena up | ...exactly as it would speed up their real game. A slider value fixes degrees per count; DPI changes how many counts a hand movement makes. |
| The **candidate ratio** is exactly DPI-independent | The anchor and the DPI cancel in `arenaGainRatio`. Verified at four DPIs. |

**One model correction happened during this pass and is worth recording.** The
first draft of the anchor carried no `referenceDpi`, which made physical
sensitivity a function of the slider alone. My own DPI test caught it: it
scored 7 % @ 800 DPI and 3.5 % @ 1600 DPI — the same physical sensitivity — as
a factor-of-two difference. The anchor now carries the DPI it was stated at,
and the interface comment says why so the next person does not remove it.

---

## 5. One model, shared by the simulator and the arena

`arenaGainPxPerCount` is the only candidate-gain arithmetic in the tree.

`SyntheticExperimentRunner.#effectFor` used to divide eDPIs itself. It now
builds the declared-reference anchor from the definition and calls
`arenaGainRatio`, the same function the arena's gain is computed from. **The
simulated numbers did not move** — a test pins the new expression against the
old `(dpi × sens) / trueOptimalEdpi` formula for every candidate in the ladder,
to 12 decimal places — but the divergence that let the defect survive is now
structurally impossible: a candidate that moves the simulator's ratio moves the
real reticle by the identical factor.

Two tests hold the line:

- a numerical one, comparing the simulator's ratio to the real arena's measured
  displacement ratio for the same raw counts;
- a structural one, failing if `src/sim/simulator.ts` ever stops calling
  `arenaGainRatio` or reintroduces private eDPI arithmetic.

---

## 6. Applied exactly once — the audit

The gain is applied in **one place**: `VirtualReticle.applyRawDelta`.

| Input path | Reaches the reticle via | Applications |
| --- | --- | --- |
| Pointer Lock `movementX/Y`, coalesced burst | `PointerLockCaptureSource.start()` → `emitSample` | 1 |
| Pointer Lock `movementX/Y`, single event | same | 1 |
| Scripted samples (`?e2e=1`, both gates) | `emitForTesting` | 1 |
| `TrialRecorder` cursor integration | integrates the **emitted logical** delta | 0 (cannot re-scale) |
| Native Raw Input helper | **not in the scored path** | 0 |

Tests for each, including the specific double-application traps:

- the **coalesced** path applies the burst once, not once for the outer event
  and again for each coalesced sample (a test that would have silently passed
  against nothing had the harness not been made to advertise `onpointermove`,
  which is why it does);
- `gain × gain` is asserted **not** to be the observed displacement;
- the recorder's final cursor is asserted equal to the reticle position, which
  is only true if nothing downstream re-scales;
- browser acceleration cannot compound with the candidate: the gain multiplies
  whatever counts Pointer Lock delivered, once, and the arena never sees a
  second scale factor.

**Native Raw Input is still not in the scored path**, and that boundary is
preserved and re-asserted by a test. `NATIVE_LIVE_BLOCKER` in
`app/src/captureTiers.ts` already warned that integrating it means suppressing
the browser's own `pointermove` for the same physical movement, and that "a
single missed suppression applies every mouse movement twice and silently
doubles the sensitivity the player is being measured at". That warning is now
load-bearing: if the helper is ever promoted, it must route through the same
reticle.

---

## 7. Blinding is unchanged

The candidate now changes what the player *feels*, which is the variable under
test. It still changes nothing they can *read*:

- the gain goes to the capture source, which draws nothing and labels nothing;
- no candidate id, sensitivity, gain, px/count or cm/360 appears in the arena,
  the overlay, the run screen or `ArenaSnapshot` — asserted by tests over the
  emitted events, the snapshot type, the drawing code, and the live run screen
  in a real browser;
- the run screen still shows only the blinded letter ("Candidate A");
- target plan, scenario geometry, viewport, timing and pairing are untouched;
  only the effective gain changes.

Both release gates measure the gain **by observation** — inject a known mouse
movement, read the reticle — rather than asking for it. Proving the fix
therefore required exposing nothing a player cannot already see on screen.

---

## 8. Effect on every prior real-PC recommendation

**Every sensitivity recommendation trAIMer has produced on real hardware is
scientifically invalid and must not be acted on.** That covers rc.5, rc.6,
rc.7 and rc.8 — including the four hardware sessions on Aldo's PC and the
**~9.26 % increase** the most recent of them reported.

This is not a confidence qualifier. The session compared five candidates that
all moved the crosshair identically, so any separation the optimizer found
between them came from drill draw, target geometry, fatigue and noise. A
recommendation derived from it is a correctly-computed number about nothing.

What those sessions **do** remain valid evidence for, because none of it
depends on the candidate: the drills happened, the timings are real, the
capture quality is real, the hit rates and tracking scores are real
measurements of Aldo's aim at *one* sensitivity, and the rc.7 → rc.8 timestamp
work is confirmed by them. The 43-discarded-measurements fix from Pass 14 is
unaffected.

Nothing is deleted. The raw sessions are preserved in full for provenance.

---

## 9. How affected sessions are marked

`ARENA_GAIN_MODEL_VERSION` (`arena-gain-v1`) is written onto every session this
build records, alongside the anchor, its basis, and the logical px/count
applied for **each** candidate (`src/session/arenaGainRecord.ts`).

**Absence of the field is the marker.** That choice is deliberate: no
historical file is rewritten, and a build that cannot read the field still
reads the session.

| Surface | What an affected session shows |
| --- | --- |
| `HistoryApi` | `candidateGainApplied: false`, `candidateGainWarning: <sentence>`, `arenaGain: null` on the session summary |
| History banner | "N of M stored sessions cannot tell you a sensitivity." |
| History row | a `no sensitivity difference` badge |
| History detail | a full "Sensitivity validity" explanation, above the statistics, which remain visible and unaltered |
| "Latest eDPI" headline tile | `—` rather than a pre-fix number presented as actionable |

An experiment with a recommendation but **no** human-session artifact (a bundle
import, a CLI run) is marked the same way. It cannot testify that its arena
applied candidate gain, and unproven is not the same as good.

A post-fix session's detail instead states what it really compared: *"The
sensitivities compared here spanned 82 % in how far the crosshair moved for the
same mouse movement, based on …"*.

---

## 10. New regression tests

**`tests/arenaCandidateGain.test.ts` — 42 tests.** Drives the production
`PointerLockCaptureSource` and the production `candidateReticleGain` (not a
copy of the arithmetic):

- the reproduction, inverted: displacement ratio equals sensitivity ratio; five
  ladder arms produce five distinct gains; the reference reproduces rc.8's
  1.0 px/count exactly, and only there;
- the equation, term by term; the derived display constant; the implied field
  of view is plausible; impossible inputs throw rather than yielding a silent
  zero gain;
- the four DPI clauses of §4;
- the anchor ladder: calibration used, inadequate calibration ignored, game
  profile used only when the scales match, mismatched scales refused, an
  **unplayable** anchor refused, a realistic one accepted, a resumed session
  anchored on its original definition, and **identical candidate ratios on all
  three anchors**;
- applied exactly once, on all three input paths, plus the recorder identity;
- X/Y symmetry, asymmetric-anchor support, negative deltas, 1e9 deltas clamped
  without NaN, sample-rate independence (200 samples of 1 px ≡ 1 sample of
  200 px), gain constant across 500 samples of a drill, gain surviving
  pause → lock loss → resume → reset, gain changing only at candidate
  boundaries;
- blinding: nothing identifying in emitted events, the snapshot type, or the
  drawing code;
- simulator/arena agreement, numerically and structurally.

**`tests/arenaGainHistoryValidity.test.ts` — 10 tests.** The gain record's
spread arithmetic; a degenerate all-1.0 record correctly read as "not a
comparison"; junk read back as `null` rather than throwing; a pre-fix session
flagged and still fully readable; a post-fix session accepted; an artifact-less
experiment not assumed good; the release metadata and compatibility matrix.

**`tests/browser/candidateGain.spec.ts` — 2 tests.** Real Chromium, real
`BrowserRunController`, real session (below).

---

## 11. The gates that would have caught it

A unit test could not have caught the original defect, because the arithmetic
was correct everywhere it existed — the arena simply never called it. So both
new gates measure the **outcome**: inject a known mouse movement into a live
session, read how far the crosshair actually travelled, and require the answer
to change when the blinded candidate does.

**Real-arena gate** — `tests/browser/candidateGain.spec.ts`, CI `browser` job.
Runs the shipped run controller in Chromium.

**Installed-app gate** — `scripts/verify-candidate-gain.mjs`, CI
`windows-installer` job, run against the **silently-installed application**
(and against the dev tree in the same job). Live output from the real Electron
shell:

```
candidate-gain gate: development tree
  ok   the shipped bundle's arena answered the probe — 6 probes
  ok   two blinded candidates move the crosshair by different amounts — gains observed: 0.8696, 1
  ok   the difference is at least one ladder step — spread 1.1500x
  ok   the arena has NOT reverted to 1 px/count regardless of candidate — gains observed: 0.8696, 1
  note measured reticle gains (logical px per mouse count): 0.8696, 1.0000
```

0.8696 and 1.0000 are exactly the `1/1.15` and baseline rungs of the ladder.

All 136 browser tests and 1032 unit tests pass, and every existing release
gate (arena entry, release verification, no-telemetry, branding on sources and
on the shipped bundle) still passes.

**Both gates were verified to fail on the defect**, not merely to pass on the
fix. Reverting the single `#applyCandidateGain(candidate)` call produces:

```
✘ blinded candidates produce measurably different reticle gain
  Error: every probe measured the same gain (1) — the arena is ignoring the blinded candidate
```

A gate that has never been seen to fail is a decoration.

Also added to the `engine` job:
`RELEASE GATE - the arena applies the blinded candidate sensitivity`.

---

## 11b. Two defects this pass found in its own work

Both were caught by tests I wrote for this pass, before any of it shipped.
Recording them because a report that only lists what went right is not a
record of what happened.

**The anchor had no DPI.** The first draft made physical sensitivity a
function of the slider alone, which scored 7 % @ 800 DPI and 3.5 % @ 1600 DPI
— the same physical sensitivity — as a factor-of-two difference. The DPI
equivalence test failed and the model was corrected (§4). `referenceDpi` is
now part of the anchor, with an interface comment saying why so it does not
get removed as redundant.

**A bad calibration could produce an unplayable arena.** A calibration taken
with a mistyped turn count is arithmetically fine and physically absurd: at
0.0132 deg/count@100 a 7 % player needs **168 cm** of mouse movement to cross
the arena, so no drill can be completed and every trial is garbage. Anchor
resolution now requires the baseline to land between 5 and 200 cm/360
(`anchorIsPlayable`) and falls through to the next rung otherwise — better
evidence that says something impossible is worse than no evidence. The test
fixtures were also changed from a round-but-absurd constant to a physically
real one (0.4665 deg/count@100 ≈ 35 cm/360 at 7 % / 800 DPI), so a gain that
comes out absurd now shows up as absurd instead of quietly still passing.

**A resumed session could change ruler mid-calibration.** `resolveArenaAnchor`
originally read the live setup form. A player who edited their sensitivity and
then resumed would have had the second half of the session measured against a
different anchor from the first. It now takes the baseline and DPI explicitly,
and the run controller feeds it the **experiment definition's** own — which for
a resumed session is the original.

---

## 12. Game Profile Campaign, Pass 1 — status

The game-profile architecture built for rc.9 is **preserved unchanged and
remains valid**. Nothing in it caused the defect and nothing in it needed
revision: `src/games/**` is a translation layer over the engine, and the
measurement core still never imports it
(`tests/gameProfileBoundary.test.ts`).

Pass 1 continued in two ways, both of which the defect fix made possible:

1. **The game profile now makes the *test* feel like the player's game, not
   just the answer.** Rung 2 of the anchor ladder converts their current
   in-game settings through their selected profile into the same canonical
   degrees-per-centimetre and anchors the arena on it. This is the
   game-profile layer's first use as an input to *presentation of the test*
   rather than only as a translation of the result — and it stays outside the
   measurement core, because `app/src/arenaSensitivity.ts` is an app-layer
   module, the only layer permitted to see both sides.

   It is used only when the sensitivity entered on the game screen equals the
   baseline the ladder is built around. A player who tests at 7 but told the
   game screen they play at 0.5 gets the declared reference instead: those are
   two scales, and pairing them would produce an arena that is confidently
   wrong. The candidate ratios are exact either way.

2. **The setup screen now says what the arena will feel like, before the
   test**: *"The test arena turns at about 30 cm per 360° at your starting
   sensitivity — based on … Each blinded candidate speeds that up or slows it
   down by its own amount, which is the difference you are being asked to
   feel."* The basis sentence names the evidence honestly — a measured
   calibration, their game settings, or a declared convention — rather than
   implying a measurement that was not made.

**No named-game profiles were started.** The public registry still ships
exactly one profile, the generic/raw control, and the boundary test still
enforces that.

---

## 13. Is rc.9 scientifically valid for a new real-PC calibration?

**Yes, for the sensitivity comparison itself.** With the caveats stated
plainly:

**What is now sound.** The player physically experiences each blinded
candidate. Two candidates differ in the exact ratio of their sensitivities.
DPI participates correctly in both directions. The scaling is applied exactly
once, on every input path. The gain cannot change mid-drill, cannot be reset by
a pause or a lock loss, and changes only at candidate boundaries. The simulator
and the arena share one model. Blinding and pairing are intact. Four gates,
two of which measure the real installed application, and both of which have
been observed to fail on the defect.

**What is honest to say about the absolute feel.** With no calibration and no
game profile, the arena *declares* the baseline to be 30 cm/360 rather than
measuring it. The comparison — the thing the session is for — is exact
regardless. But a player who wants the arena to feel like their actual game
should complete the physical calibration first, or enter their in-game
sensitivity on the setup screen. That is now stated on the setup screen rather
than buried.

**What has not been validated.** No human has yet played rc.9. Everything above
is proven by tests, by the real Chromium arena and by the real Electron shell —
not by a person. The first genuine sensitivity measurement in this product's
history has not been taken yet; rc.9 is the first build capable of taking one.

**Recommended first session.** Standard length, calibration completed
beforehand if possible, and the result compared against the ~9.26 % figure only
as a curiosity — the two are not comparable, and the old number is not a prior.

---

## 13b. Build outcome

CI run **34174943067** on commit `99634e6` — **all five jobs green**
(`engine`, `browser`, `native-windows`, `windows-release`,
`windows-installer`).

The three new gates ran and passed on the authoritative runners:

| Gate | Job | Result |
| --- | --- | --- |
| `arenaCandidateGain` + `arenaGainHistoryValidity` | engine | 52 tests passed |
| two blinded candidates differ in the REAL arena | browser | 2 passed |
| the arena applies the candidate sensitivity (dev tree) | windows-installer | all checks passed |
| **the INSTALLED app changes sensitivity between candidates** | windows-installer | all checks passed |

The last one is the one that matters. It silently installed this exact
installer to `C:\traimer-install-test`, launched the installed
`trAIMer.exe`, ran a real session, injected a known mouse movement and
measured the crosshair:

```
candidate-gain gate: installed app at C:\traimer-install-test\trAIMer.exe
  ok   the shipped bundle's arena answered the probe — 7 probes
  ok   two blinded candidates move the crosshair by different amounts — gains observed: 0.8696, 1
  ok   the difference is at least one ladder step — spread 1.1500x
  ok   the arena has NOT reverted to 1 px/count regardless of candidate
```

**Artifact**, downloaded and checksum-verified against the value CI published:

| | |
| --- | --- |
| `release/rc9/trAIMer-Setup.exe` | 100,535,072 bytes |
| `release/rc9/trAIMer-Setup-1.0.0-rc.9.exe` | identical copy |
| SHA-256 | `758312d371ffbedb35f9b72b4edd9087d95333f550f5c8e88599c33f24535732` |

`/Volumes/NO NAME` was absent throughout. The installer is staged locally and
the flash drive is **not** prepared.

---

## 14. Files

**New**

| File | |
| --- | --- |
| `src/sensmath/units.ts` | one definition of the inch, shared with the game layer |
| `src/sensmath/arenaGain.ts` | THE candidate → px/count conversion and the anchor types |
| `src/session/arenaGainRecord.ts` | what a session records about what it applied |
| `app/src/arenaSensitivity.ts` | which anchor this session runs against |
| `tests/arenaCandidateGain.test.ts` | 42 tests |
| `tests/arenaGainHistoryValidity.test.ts` | 10 tests |
| `tests/browser/candidateGain.spec.ts` | real-arena gate |
| `scripts/verify-candidate-gain.mjs` | installed-app gate |
| `docs/ARENA-SENSITIVITY.md` | the model, the DPI contract, the anchor ladder, the gates |

**Changed**

`src/capture/browserSource.ts` (the gain, and `setReticleGain`) ·
`src/games/canonical.ts` (re-export the inch) · `src/sim/simulator.ts` (share
the function) · `app/src/runController.ts` (apply per trial, record it) ·
`src/session/humanSession.ts` · `src/history/api.ts` ·
`app/src/historyView.ts` · `app/src/setupView.ts` · `app/src/main.ts` ·
`app/styles.css` · `src/version.ts` · `.github/workflows/ci.yml` ·
`eslint.config.js` · `package.json` · `docs/ARCHITECTURE.md` ·
`docs/CAPTURE.md` · `docs/HISTORY.md` · `docs/PERSISTENCE.md` ·
`docs/RELEASE.md`
