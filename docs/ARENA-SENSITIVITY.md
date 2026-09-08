# Arena sensitivity — how a blinded candidate reaches the player's hand

**Status:** normative for 1.0.0-rc.9 and later.
**Owner module:** `src/sensmath/arenaGain.ts` (the arithmetic),
`app/src/arenaSensitivity.ts` (which anchor it runs against).

---

## 1. The defect this document exists because of

Up to and including **1.0.0-rc.8**, `VirtualReticle.applyRawDelta` moved the
reticle **one logical pixel per mouse count, always** — whichever blinded
candidate was running.

The candidate reached everything else. It was written into the trial record's
`sensitivity` and `dpi`. It drove the optimizer, the paired fit, the
recommendation, the results page and the history trend. It drove the synthetic
player's motor model in the simulator, so every campaign that "validated" the
search was validating a model of an arena the product did not ship.

It never reached the player's hand.

The consequence is not subtle and not partial. **A human calibration run on
rc.5–rc.8 compared five sensitivities that all felt exactly the same.**
Whatever differences the optimizer found between them were differences in
drill luck, fatigue and noise. The recommendation such a session produces is a
real number computed correctly from real data that contains no information
about sensitivity at all.

Every claim in this document is enforced by
`tests/arenaCandidateGain.test.ts`, `tests/browser/candidateGain.spec.ts` and
`scripts/verify-candidate-gain.mjs`.

---

## 2. The model

Three multiplications, each a physical fact.

### 2.1 Candidate → physical rotation

A game's sensitivity slider fixes **degrees of view rotation per mouse count**.
The mouse's DPI then fixes **how many counts a centimetre of hand movement
produces**. Physical sensitivity — degrees per centimetre of hand movement — is
therefore proportional to `sens × dpi`, which is exactly why players compare
each other in eDPI.

So an anchor has to state the DPI its reference was measured at:

```
degreesPerCm(sens, dpi) = referenceDegreesPerCm
                        × sens / referenceSens
                        × dpi  / referenceDpi
```

Degrees-per-centimetre is the same canonical unit `src/games/canonical.ts`
stores, for the same reasons (see docs/GAME-PROFILES.md §3).

### 2.2 Physical rotation → per-count rotation

The player's DPI divides back out, at the single boundary
`degreesPerCountAt()` uses:

```
degreesPerCount = degreesPerCm × 2.54 / dpi
```

### 2.3 Rotation → arena pixels

The arena is a flat angular field with one declared display constant:

```
pxPerCount = degreesPerCount × ARENA_PX_PER_DEGREE
```

### 2.4 Composed

```
pxPerCount(sens) = ARENA_PX_PER_DEGREE
                 × 2.54 / referenceDpi
                 × referenceDegreesPerCm × sens / referenceSens
```

The session DPI cancels — correctly, because a slider value fixes degrees per
count and DPI has nothing to do with it. DPI's real effect arrives through the
number of counts a hand movement produces, which is where it belongs.

### 2.5 The display constant

`ARENA_PX_PER_DEGREE` is **derived, never typed in**:

```
ARENA_PX_PER_DEGREE = ARENA_REFERENCE_DPI
                    / (2.54 × ARENA_REFERENCE_DEGREES_PER_CM)
                    ≈ 26.2467 px/deg
```

with the reference being **30 cm/360 at 800 DPI** — a middle-of-the-road real
sensitivity at the most common gaming DPI. That pins the constant so the
reference sensitivity comes out at exactly **1.0 px/count**, which is the fixed
gain every build up to rc.8 used. The arena's feel at the centre of the range
is therefore unchanged by this fix; what changed is that it now moves away from
that centre with the candidate.

The 1280 px logical arena consequently spans ≈48.8°. The mapping is linear, not
a tangent projection: the arena is a 2D task, and a projected frustum would be
decoration rather than a fact.

---

## 3. What the model guarantees

| Property | Why it holds |
| --- | --- |
| Two candidates differ **in proportion to their sensitivities** | `pxPerCount` is linear in `sens`. A ±15 % ladder arm is a ±15 % change in what the hand feels. |
| The ratio between two candidates is **exactly DPI-independent** | The anchor and the DPI cancel in `arenaGainRatio`. |
| The same **cm/360 at any DPI is the same arena** | Travel per centimetre of hand movement is `pxPerCount × dpi / 2.54 ∝ sens × dpi`. |
| Raising **DPI alone makes the arena faster** | ...exactly as it would make the player's real game faster. |
| **X/Y symmetry** is preserved, and asymmetry is supported | Both axes carry their own reference; a symmetric anchor gives a symmetric gain. |
| **No frame-rate or sample-rate dependence** | The gain is per count, so N small samples equal one large one. |
| **Nothing else changes** | Target plan, scenario geometry, viewport, timing and blinding are untouched. |

---

## 4. The anchor ladder

The model needs one anchor: what one unit of *this* player's slider is worth
physically. `app/src/arenaSensitivity.ts` resolves it once per session, from
the best evidence available, and then holds it fixed — re-resolving mid-session
would move the ruler during the measurement.

1. **`measured-calibration`** — the player completed a physical calibration, so
   degrees-per-count is known outright. The arena turns as far as their real
   game does, and a later DPI change re-expresses that rather than corrupting
   it.
2. **`game-profile`** — their current in-game settings converted through their
   selected game profile. Used **only** when the sensitivity they entered on
   the game screen equals the baseline the ladder is built around (within
   0.1 %); otherwise the two numbers are on different scales and pairing them
   would produce an arena that is confidently wrong.
3. **`baseline-reference`** — neither available. The baseline candidate is
   *declared* to be 30 cm/360 at the player's DPI and the ladder scales exactly
   around it.

A rung is used only if the arena it describes can actually be played:
`anchorIsPlayable()` requires the baseline to land between 5 and 200 cm/360.
A calibration taken with a mistyped turn count, or a game sensitivity entered
in the wrong units, is arithmetically fine and physically absurd — hundreds of
centimetres of mouse movement to cross the arena, so no drill could be
completed and every trial would be garbage. Better evidence that says
something impossible is worse than no evidence, so it falls through to the
next rung.

**The rung does not affect what the experiment measures.** The ratio between
two candidates is identical on all three, because the anchor cancels. Only the
absolute feel improves as the evidence improves — and rung 3 says so in the
player-facing `basis` sentence rather than implying a measurement it did not
make.

---

## 5. Applied exactly once

The gain is applied in **one place**: `VirtualReticle.applyRawDelta`.

Every scored input path converges there:

| Path | Reaches the reticle via |
| --- | --- |
| Pointer Lock `movementX/Y`, coalesced burst | `PointerLockCaptureSource.start()` → `emitSample` |
| Pointer Lock `movementX/Y`, single event | `PointerLockCaptureSource.start()` → `emitSample` |
| Scripted samples (`?e2e=1`, gates) | `emitForTesting` |
| Native high-rate helper | **Does not carry scored sessions.** Diagnostics only — see `NATIVE_LIVE_BLOCKER` in `app/src/captureTiers.ts`. |

`applyRawDelta` emits the **logical** (gained, clamped) delta, and
`TrialRecorder` integrates exactly that into its cursor. So the recorded cursor
track and the drawn reticle are the same thing by construction, and there is no
second place downstream where a scale factor could be applied again.

If the native helper is ever promoted to carry scored drills, it **must** route
through the same reticle, and the browser's own `pointermove` for the same
physical movement must be suppressed — otherwise every movement is applied
twice and the sensitivity under test silently doubles.

---

## 6. Blinding

Applying the candidate is what the player is supposed to feel; naming it is
not. Nothing changed about blinding:

- the gain goes to the capture source, which draws nothing and labels nothing;
- no candidate id, sensitivity, gain, px/count or cm/360 appears in the arena,
  the overlay, the run screen or `ArenaSnapshot`;
- the run screen still shows only the blinded label ("Candidate A");
- target behaviour is identical across candidates for the paired comparison —
  only the effective gain changes.

The release gates measure the gain **by observation** (inject a known mouse
movement, read the reticle) rather than by asking for it, so proving the fix
does not require exposing anything a player cannot already see.

---

## 7. When the gain changes

At the start of **every trial**, from the candidate that trial is recorded
under. Per-trial rather than per-block on purpose: a per-trial call reads the
same candidate the record is written with, so the two cannot drift apart.

`VirtualReticle.reset()` recentres the position and deliberately does **not**
touch the gain. A trial start, a pause/resume and a re-acquired pointer lock
all reset the position; any of them silently reverting the sensitivity under
test to 1 px/count would reintroduce the defect one drill at a time.

---

## 8. History and validity

`ARENA_GAIN_MODEL_VERSION` (`arena-gain-v1`) is written onto every session this
build records, together with the anchor and the gain applied for each
candidate (`src/session/arenaGainRecord.ts`).

**Absence is the marker.** A session with no `arenaGain` field predates the
fix. Nothing historical is rewritten and nothing is deleted:

- `HistoryApi` reports `candidateGainApplied` and `candidateGainWarning` on
  every session summary;
- the History view shows a banner, a per-row badge, and a full explanation in
  the session detail;
- the "Latest eDPI" headline reads `—` rather than presenting a pre-fix number
  as actionable;
- the drills, trials and statistics of an affected session remain visible and
  unaltered — what is withdrawn is the claim that its recommended sensitivity
  is about sensitivity.

An experiment with no human-session artifact at all (a bundle import, a CLI
run) is treated the same way: unproven is not the same as good.

---

## 9. Gates

| Gate | Proves | Runs in |
| --- | --- | --- |
| `tests/arenaCandidateGain.test.ts` | the model, the single application point, simulator/arena agreement | `engine` job |
| `tests/arenaGainHistoryValidity.test.ts` | pre-fix sessions are marked, not trusted or deleted | `engine` job |
| `tests/browser/candidateGain.spec.ts` | two blinded candidates differ in a REAL Chromium arena | `browser` job |
| `scripts/verify-candidate-gain.mjs` | the same, in the shipped Electron shell and the INSTALLED app | `windows-installer` job |

The last two measure the outcome rather than the arithmetic, which is the only
kind of gate that could have caught the original defect: the arithmetic was
correct everywhere it existed; the arena simply never called it.
