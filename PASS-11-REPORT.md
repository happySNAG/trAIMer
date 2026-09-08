# Pass 11 — gameplay fixes from the first playable hardware session

**Release candidate:** `1.0.0-rc.5` (was `1.0.0-rc.4`)
**Trigger:** rc.4 launched and ran on Aldo's Windows PC (the first time any
build did). Four pieces of real-user feedback came back: a three-target drill
where only two could be shot, an enforced break that felt intrusive, a session
that felt like the same few drills repeated ~80 times, and plain green circles.
This pass is strictly gameplay + presentation. The game-profile campaign has
not been started.

---

## 1. Three-target drill — exact root cause

`src/scenarios/director.ts`, `ScenarioDirector.tick()`:

```js
const earliestAllowed =
  this.#lastRemovalAtMonotonicMs !== null
    ? this.#lastRemovalAtMonotonicMs + SWITCH_INTER_TARGET_GAP_MS
    : scheduled;              // ← no removal yet ⇒ spawn on schedule anyway
...
if (planned.kind === "static" && this.#isSequentialScenario()) break; // one per FRAME, not one at a time
```

The gate that was meant to hold the next target until the previous one was
removed only engaged **after a first removal existed**. Before any hit, every
target spawned on its own cumulative delay (30–90 ms each), one per frame, so
all three of the "switch sequence" were on screen within ~250 ms — exactly
what Aldo saw ("three targets visible").

That turned the drill into a simultaneous cluster competing for a **single
2400 ms trial budget**. Three acquisitions of 220–480 px targets, including
reaction to the spawn, under an unfamiliar (±35 %) sensitivity, need roughly
700–900 ms each. The third acquisition was therefore routinely cut off by the
trial timeout mid-flick: the target vanished, the trial recorded
`miss-shot-fired`/`timeout`, and the next trial began. Nothing told the player
why. There was also **no per-target expiry**, so an ignored target stalled the
drill until the whole trial timed out.

Hit detection itself was sound — a scripted player that reaches each target
within 500 ms completed all three under the old code. The defect was
sequencing + budget, verified by re-introducing the old gate: 6 of the 7 new
regression cases fail against it.

**Fix**
- genuinely sequential: a target spawns only when no other target is live,
  120 ms after the previous removal (`#liveTargetCount() > 0 → break`);
- new `perTargetTimeoutMs` (1100 ms — the same order of budget a single static
  flick gets): an unhit target **expires** (recorded `removalReason:
  "expired"`, animated red fade) and the next appears; missing the middle
  target no longer costs the third;
- trial ceiling `timeoutMs` 2400 → 3800 so three windows + gaps + spawn delays
  always fit (`90 + 3×1100 + 2×120 = 3630`);
- `TrialRecorder` exposes `appearedMs`/`targetId` in `state` and a
  `removedTargetsAt()` view so both the director and the renderer work from
  the engine's own record;
- sequence pips at the bottom of the arena show hits/misses in the drill.

Measurement note: `computeTargetSwitchLatency` measures onset latency from
each target's `appearedMs`. With three simultaneous spawns those latencies were
meaningless (the player was still on target 1 when 2 and 3 "appeared"). They
are meaningful now.

## 2. Exactly how breaks work now

- **Every break is skippable.** `SessionRunner.#rest()` races the planned
  sleep against `skipRest()` and `cancel()`; whichever comes first ends it.
  `runner.resting` is true only while a break is in progress.
- **UI:** the break overlay shows the title (`Break` between candidate blocks,
  `Rest break` when fatigue-triggered), a live countdown, and a **Skip break**
  button. **Space** or **Enter** end it too. Esc still ends the session.
- **Setup controls:** *Automatic break between candidate blocks* (default on)
  and *Break length* 5–60 s (default **10 s**, was 15 s). Off ⇒ no rest state
  is entered at all between blocks. Settings saved before the option existed
  keep breaks on.
- **Fatigue-triggered rests** (12 min continuous or a measured slowdown) still
  fire — they protect measurement — but are **30 s** (was 45 s) and skippable.
- **Audit trail:** `rest-started {reason, durationMs}` and
  `rest-ended {skipped, usedMs, plannedMs}` so a skipped break is visible in
  the session record rather than indistinguishable from a full one.
- Ending the session during a break does not wait the break out.

## 3. What changed to reduce repetition

Default composition is unchanged and the reason it is 80 measured trials is
statistical (`rcDefaults.ts`: 8 reps × 5 candidates × 2 rounds; halving error
up to ~78 trials). What made it *feel* like the same few drills:

- **Draws were independent.** 8 weighted draws from 5 families per round
  routinely gave a block three of one drill and none of another, and
  back-to-back repeats (three 6-second tracking trials in a row happened).
  → `drawBalancedScenarios()`: every family appears as evenly as the rep
  count allows (8 reps ⇒ 3 families ×2, 2 families ×1 — never 0).
- **Order was an unconstrained shuffle.** → `arrangeWithoutAdjacentRepeats()`:
  no drill twice in a row inside a block whenever the multiset permits.
- **The player had no map.** → top bar shows `Round r/R · Block b/B · Drill
  d/D` plus the drill's instruction; the instruction map was keyed by one
  scenario *id* instead of its kind, so the strafing drill had no instruction
  at all.
- Colour per drill family (§4) so the switch between drills is visible.

What did **not** change, deliberately: every candidate in a round still sees
the identical drill multiset (the paired comparison relies on it), the plan is
still a pure function of the seed, and rep counts are untouched.

Pre-existing observation (not changed here, worth a future look): pairing
cells are keyed `scenarioId#repIndex` with `repIndex` counted per candidate,
while each candidate's block is independently shuffled — so identical-instance
pairing across candidates is coincidental rather than by construction.

## 4. Visual / game-feel improvements

All in `app/src/runController.ts`, presentation only — hit detection, target
geometry and timing still come solely from the recorder/director.

- **Stage:** cached offscreen backdrop — deep blue-black radial gradient, faint
  64 px grid (alpha 0.055, enough to read motion against), vignette.
- **Targets:** one colour family per drill kind (static = volt, strafing =
  cyan, switch = amber, tracking = magenta); layered disc with soft glow,
  bright rim, radial highlight and dark centre; **140 ms spawn-in** where the
  fill scales up but the **true hit radius is outlined from frame one** so the
  animation never misrepresents where a shot counts.
- **Hit:** white flash + expanding ring + 10 shards with slight gravity
  (260 ms), where the engine says the target was.
- **Expired target:** ring dims to red and sinks (240 ms).
- **Missed click:** faint red ripple at the reticle (180 ms).
- **Tracking:** an on-target lock ring while the reticle is inside the target.
- **Switch drill:** sequence pips (filled = hit, red = missed).
- **Reticle:** crosshair with halo and centre dot.
- Effects are bounded arrays (≤24 each) of tiny objects; no per-frame
  allocation beyond canvas calls. Verified in the real Electron shell
  (screenshots in the session scratchpad; the arena gate still goes live in
  ~206 ms).

## 5. Tests run and results

New:
- `tests/targetSwitchDrill.test.ts` — 7 cases: one target at a time; 500 ms
  and **900 ms** players complete all three; next spawns only after removal
  + gap; ignored targets expire in their window and the sequence continues;
  missing the middle target still yields the third; budget covers the drill.
  6/7 fail against the old director.
- `tests/breaks.test.ts` — 9 cases: full-length rests, skipped rests end
  within a tick with audit `skipped:1`, `resting` only during rest, 0 ms ⇒ no
  rest state, skip outside a rest is a no-op, cancel during a rest doesn't
  wait; settings defaults / legacy blobs / clamping.
- `tests/drillSequencing.test.ts` — 9 cases: balanced draws, weighted
  proportions, determinism, no-adjacent-repeat arrangement (and graceful
  degradation), identical multiset per candidate, no drill twice in a row,
  every family in every block, seed purity.
- `tests/browser/breaks.spec.ts` — 4 cases in the real run screen: countdown
  + Skip break button ends a 20 s break in <5 s; Space ends it; Enter ends it;
  setup exposes the controls and disables length when auto is off.

Changed:
- `blindCampaign` case E was a single-seed knife edge (seed 45). A 40-seed
  sweep: rc.4 baseline 9/40 overclaims, this pass 10/40, old draws + new
  switch timing 9/40 — the rate is unchanged, so it now asserts over 20 seeds
  with a bound from the measured baseline (≤6/20; further testing suggested
  ≥18/20). That ~22 % rate for a noisy beginner at the ladder edge is
  pre-existing optimizer behaviour, not touched here.
- Setup inputs gained stable ids (`#setup-seed/-rounds/-reps/-warmups`); all
  browser specs and the arena gate use them instead of positional selectors.
- `session.spec` drives until the engine finishes (cap 90) instead of a fixed
  25 trials; sequential switch trials take longer under the scripted player.

| Gate | Result |
| --- | --- |
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npx vitest run` | **71 files, 620 tests passed** (was 68 / 595) |
| `npm run test:browser` | **89 passed** (was 85) |
| `node scripts/verify-arena-entry.mjs` (Electron) | all checks passed — live in 206 ms |
| `npm run build` / `build:desktop` | clean |

## 6. CI

Run **34070387920** (commit `59b24f9`) — all five jobs green: engine 1m46s,
browser 5m10s, native-windows 1m18s, windows-release 2m24s,
windows-installer 6m12s. Both arena-entry release gates from Pass 10 passed on
this build: the dev tree went live in 214 ms and the **installed** application
(`C:\aldo-install-test\Aldo Aim Lab.exe`, native helper running) in 228 ms
with pointer lock held.

## 7. Installer

| | |
| --- | --- |
| File | `AldoAimLab-Setup-1.0.0-rc.5.exe` (also copied as `AldoAimLab-Setup.exe`) |
| Size | 100,456,309 bytes |
| SHA-256 | `9c967cb2d93c6ef997ed42286e2ff995f78d122ddb579d174a49099a95a25c70` |
| Built by | CI run 34070387920, commit `59b24f9` |

## 8. Flash drive

Copied to `/Volumes/NO NAME` as `AldoAimLab-Setup.exe`,
`AldoAimLab-Setup-1.0.0-rc.5.exe` and `AldoAimLab-Setup-SHA256.txt`; both
executables re-hashed **after** the copy and match the CI-published checksum
byte for byte.

Note: when this copy was made the drive had been remounted and no longer held
the rc.4 installer placed there in Pass 10 (nothing here removed it). Aldo's
PC should uninstall rc.4 (Settings → Apps → Aldo Aim Lab) before running this
installer; user data is preserved by the uninstaller.

## 9. Not in this pass, deliberately

- The multi-game profile campaign.
- Native raw-input as the live measurement transport (still gated on
  helper/renderer clock-origin alignment — see Pass 10 §3).
- The pre-existing pairing observation in §3 and the ~22 % noisy-beginner
  overclaim rate in `blindCampaign` case E — both optimizer/protocol work,
  recorded here so they are not lost.
