# Pass 12 — three gameplay defects from the second hardware session

**Product:** trAIMer — *Train. Measure. Tune.* (repo/package still `aldo-aim-lab`)
**Release candidate:** `1.0.0-rc.6` (was `1.0.0-rc.5`)
**Trigger:** Aldo played rc.5 on his own PC (Windows, 1920×1080, 200 Hz,
Logitech Lightspeed @ 800 DPI) and reported three things. All three were real
defects. Nothing else in gameplay was touched.

---

## 0. Baseline

| | |
| --- | --- |
| Repo | `https://github.com/happySNAG/Aldo-Aim-Lab.git` |
| Worktree | `/Users/claw/OxWorktrees/aldo-aim-lab/20260823T194949Z-a28b6239` |
| Branch | `ox/aldo-aim-lab-20260823T194949Z-a28b6239` |
| HEAD at start | `6851028` — "Add Pass 11 report" |
| Working tree | clean; `git fetch --all --prune` brought nothing new |
| Relation to `main` | 11 commits ahead, 0 behind (linear) |
| RC Aldo tested | **`1.0.0-rc.5`**, `AldoAimLab-Setup-1.0.0-rc.5.exe`, SHA-256 `9c967cb2d93c6ef997ed42286e2ff995f78d122ddb579d174a49099a95a25c70`, built by CI run 34070387920 (commit `59b24f9`) |

Reports and verification artifacts from Passes 1–11 are untouched.

### Which target is which

Confirmed from `TARGET_PALETTE` in `app/src/runController.ts`, so there is no
guessing about what Aldo saw:

| Aldo's words | Drill | Colour |
| --- | --- | --- |
| "light blue circle" | `flick-dynamic-horizontal` (strafing) | `#4fd8f0` |
| "pink one that moves fast" | `tracking-smooth-sine` (tracking) | `#ff6fd8` |
| "time out screen" | the break/rest overlay | — |

---

## 1. Bug 1 — the light-blue circle

> "The light blue circle don't go far enough across the screen to be able to
> shoot, I didn't hit a single one."

### Root cause

**Two independent defects, and the second one is why he hit exactly zero.**

**1a — the hit disc was not where the target was drawn.** `TrialRecorder` had
its own private `spanMotionPosition()` that resolved a moving target's position
by snapping to the **previous keyframe**:

```js
for (const key of keys) { if (key.tMs <= tMs) prev = key; else break; }
return prev.position;              // no interpolation
```

The renderer used a different function, `targetPositionAt()` in
`src/domain/trial.ts`, which **interpolates** between keyframes. With rc.5's
50 ms keyframes and speeds up to 520 px/s the hit disc trailed the drawn disc
by up to `0.050 × 520 = 26 px` on a target whose radius is **24 px**. A shot
placed perfectly on the centre of the circle on screen was 26 px from the
centre of the hit disc — **outside it**. Scored a miss. Across the speed band
the average lag was ~10 px, eating 40 % of the radius on every shot.

**1b — the sweep was short and ended mid-approach.** rc.5 planned the path as
"start 260–560 px off centre, drift toward the centre for the trial's 1100 ms
budget". Measured over 40 seeds at the arena's logical 1280×720 viewport:

| | rc.5 | rc.6 |
| --- | --- | --- |
| horizontal travel | 272–515 px (21–40 % of the field) | **523–953 px (41–74 %)** |
| visible life | ~1.03 s, then gone mid-flight | **~1.95 s, still moving when the window closes** |
| crosses the reticle's start column | sometimes | **always, by construction** |
| speed | 260–520 px/s | 261–477 px/s (unchanged band) |

So: an acquisition window of about one second, for a target that had to be led,
whose hitbox was more than a radius behind where it appeared. Zero hits is the
expected outcome, not bad play.

### Fix

- `src/capture/recorder.ts` — hit detection and nearest-miss distance now call
  the same `targetPositionAt()` the renderer draws from. The private snapping
  helper is deleted; there is now exactly one function that answers "where is
  this target at time t".
- `src/scenarios/planner.ts` — `planDynamicFlickInstance()` rewritten: the
  sweep runs for the **whole** trial window and is laid out symmetrically about
  the centre, so it is guaranteed to cross the column the reticle starts on.
  New `clampFullyVisible()` clamps the target *centre* so the whole disc stays
  inside the 24 px margin (`clampToViewport` only kept the centre in bounds,
  which permits a half-off-screen target). Keyframes tightened 50 → 25 ms.
- `src/domain/scenario.ts` — `timeoutMs` 1100 → 2000 (the window the sweep
  needs), `targetSpeedPxPerSec` max 520 → 480 so a full-window sweep always
  fits the visible band and is never clamped short. **The speed band is
  otherwise unchanged: the drill is not slower per pixel, it simply presents a
  real opportunity.** A hit still ends the trial immediately.

### Tests — `tests/strafingDrill.test.ts` (15 cases)

Minimum travel ≥ 40 % of the field on 40 seeds; the sweep crosses the centre
column; the whole disc stays inside the margin at every keyframe; the sweep is
never flattened by clamping; speed stays in the documented band; the target is
still travelling when the window closes and stays live for the full trial when
never shot; **a shot at the drawn centre is a hit at every sub-keyframe offset**;
a mid-flight hit finishes the trial on the next frame with one shot and one
hit; the same guarantees at 1024×576, 1280×720 and 1600×900; and a direct
witness that reconstructs rc.5's exact geometry (50 ms keyframes, 520 px/s,
r=24) and measures the drift at **25.5 px > 24 px radius**.

**5 of the 15 fail against rc.5's code** (verified by reverting
`recorder.ts`/`scenario.ts`/`planner.ts` and re-running).

---

## 2. Bug 2 — the fast pink circle

> "The pink one that moves fast, after you hit it once, you have to click again
> to get it to go to the next screen."

### Root cause

The pink target is the **tracking** drill: a six-second Lissajous sweep the
player is asked to *follow*, not shoot. `BrowserRunController.#handleCaptureEvent`
removed whatever target a shot landed on, **for every drill**:

```js
const latest = active.recorder.state.latestShot;
if (latest?.hit && latest.aimTargetId) { /* target-remove … */ }
```

Clicking the pink target therefore deleted it. Tracking completion is purely
time-based (`elapsedMs >= durationMs - 25`), so the trial then ran out the rest
of its six seconds against an **empty arena** — no target, no feedback, nothing
the player could do, and no input that would make it end sooner. From the
player's seat that is exactly "the hit registered and now it wants another
click": the next drill appeared seconds later, right around the time he clicked
again. It also destroyed that trial's tracking measurement, because the player
cannot follow a target that is not on screen.

A second, related defect found while pinning this down: `#targetUnderCursor`
skipped a resolved target only when `removedMs < tMs`. A hit removal is stamped
at `shot.tMs + 1`, so a **second click carrying the same millisecond timestamp
scored a second hit on the same target**.

### Fix

- `src/scenarios/director.ts` — new `removesTargetOnHit` (false only for
  `tracking`). The controller consults it, so the rule lives with the scenario
  rather than in the event handler.
- `app/src/runController.ts` — a shot removes its target only in the
  click-to-hit drills. Clicks during tracking are still **recorded** (shots are
  data) but never remove the target and never gate advancement.
- `src/capture/recorder.ts` — a target already resolved (`hit`, or removed at
  or before the shot) can never be hit again, whatever the click timestamps.
- `app/src/runController.ts` — the tracking drill now draws a thin time bar, so
  an arena the player cannot act on never reads as frozen. Presentation only;
  geometry and timing still come from the recorder/director.

Nothing simulates an input, auto-fires a click, or hides anything behind a
timeout. Scoring is unchanged: tracking still runs its full 6 s window, which
is what the tracking metrics need.

### Tests — `tests/fastTargetAdvance.test.ts` (12 cases)

Tracking: the arena is never blank after a hit (0 blank frames); one shot → one
shot recorded, one hit, target not removed; the drill finishes on its own clock
with **no further input**. Click-to-hit drills: one successful shot → exactly
one hit, one removal, finished on the very next frame, outcome `hit` — asserted
for static flick, strafing, and the third target of the switch sequence. No
double-scoring: two clicks in the same millisecond give 2 shots / **1 hit** / 1
removal; a five-click burst gives one removal and one finish that stays
finished; an expired target cannot be hit by a late click. Misses never
advance: a miss leaves the flick trial running to its own timeout, and a miss
on the tracking drill changes nothing at all.

**5 of the 12 fail against rc.5's behaviour.**

---

## 3. Bug 3 — the "time out" screen freezes the mouse

> "The time out screen you can't skip cause it freezes your mouse."

### Root cause

The "time out" screen is the **break** overlay between blinded candidate
blocks. Pass 11 made breaks skippable and gave them a **Skip break** button —
and `SessionRunner.#rest()` drew it while the arena still held **Pointer Lock**:

```js
async #rest(durationMs, reason) {
  this.#audit.append(…, "rest-started", …);
  this.#ports.onRest?.({ durationMs, reason, skippable: true });   // ← button UI
  …                                                               // no release
}
```

Under a pointer lock Windows hides the cursor and routes every click to the
locked element. The Skip break button, and the Pause and End session controls
in the bottom bar, were all unreachable. Space and Enter worked — but a button
asks you to reach for the mouse, and the mouse was gone.

Releasing it was not a one-line change, because **a deliberate release was
indistinguishable from a lost one**: `releaseLock()` produced
`lock-change{locked:false, reason:"pointer-lock-loss"}`, which
`BrowserRunController` treats as a fatal interruption that cancels the session
(and which `validateTrial` turns into a fatal `POINTER_LOCK_LOSS`). Handing the
mouse back would have killed the session.

**Why the suite missed it:** the browser E2E adapter (`?e2e=1`) grants the lock
**virtually**. No real pointer lock is ever held there, so every overlay button
is trivially clickable and no test could tell "mouse held" from "mouse free" —
the same blind spot that let rc.3 ship an unstartable arena.

### Fix

- `src/capture/events.ts` — new `CAPTURE_RELEASED_REASON` (`"capture-released"`)
  for an exit the application asked for.
- `src/capture/browserSource.ts` — `releaseLock()` marks the release deliberate
  so the resulting `pointerlockchange` carries that reason. A real loss (Esc,
  focus steal) still reports `pointer-lock-loss`, and the flag cannot leak into
  a later real loss.
- `src/session/types.ts` — `TrialExecutionPort` gains `suspendCapture(reason)`
  and `resumeCapture(reason)`. They are **required**, so no port can forget to
  give the mouse back.
- `src/session/runner.ts` — `#rest()` releases capture **before** the break is
  announced, and re-acquires after it ends. `#awaitIfPaused()` uses the same
  pair: a pause is the same kind of interlude, and Resume lives in the same
  unreachable bottom bar. Both go through one `#suspendCapture`/`#resumeCapture`
  path, audited as `capture-suspended` / `capture-resumed`. A refused
  re-acquisition ends the session with a named reason instead of running blind
  drills; ending the session during a break does not ask for the mouse back.
- `app/src/runController.ts` — `resumeCapture` tries a programmatic re-lock and,
  if Chromium refuses (it requires user activation), asks the player for a
  click through a new `onCaptureGestureNeeded` callback rather than ending the
  session. `cancel()` settles that gate so it can never trap anyone.
- `app/src/main.ts`, `app/styles.css` — `<body class="capture-suspended">`
  during an interlude, a real cursor over the arena, a "Click to continue"
  prompt when a gesture is needed, and break copy that says the mouse is free.
- The E2E adapter now reports the interlude too, even though it holds no real
  lock, so the automated suite can finally observe this transition.

### Tests — `tests/breakPointerRelease.test.ts` (15 cases)

Using the real `PointerLockCaptureSource` against a Chromium-shaped DOM double
(lock events on the *document*, `requestPointerLock()` returning a Promise):
a deliberate release reports `capture-released`; a real loss still reports
`pointer-lock-loss`; the flag does not leak; a released lock produces **no**
focus interruption and no `POINTER_LOCK_LOSS` validation failure; gameplay
mousedown/pointermove are inert while released; six release/acquire cycles leak
no listeners. Through `SessionRunner`: the release happens **before** the break
is announced (index-ordered, not merely present); the cursor is free for every
sampled frame of the break and the lock is held again for the drills after it;
Skip break works while the mouse is free; the suspend/resume pair is audited
1:1 and every resume is granted; a pause takes the same path; a refused resume
aborts with a named reason; a cancel during a break does not ask for the mouse
back; the session's own opening lock request is unchanged.

Plus 2 new Playwright cases in `tests/browser/breaks.spec.ts`: the break marks
`body.capture-suspended`, the canvas shows `cursor: default`, the copy says the
mouse is free, Skip break is clickable, and the class clears on resume; and the
**End session** control is genuinely clickable during a break (it opens its
confirmation dialog).

**7 of the 15 engine cases fail against rc.5's behaviour.**

---

## 4. Refresh-rate independence (Aldo's 200 Hz display)

Nothing in the changed code counts frames. Target position is
`targetPositionAt(span, t)` — a pure function of time — for both rendering and
hit detection, and the new sweep is defined by `speed × window`, not by
per-frame steps. Trial and per-target completion compare monotonic timestamps.
Pinned by `strafingDrill.test.ts` ("motion is time-based, not frame-based":
equal time steps travel equal distance, and sampling the same instant twice
gives the same point) and by the existing `tests/highRefreshTiming.test.ts`.

## 5. Previous three-target regression

`tests/targetSwitchDrill.test.ts` — **7/7 pass**. One target at a time
(`maxVisible === 1`), all three appear, per-target expiry keeps the sequence
moving, the 500 ms and 900 ms scripted players complete all three, and the
budget covers the drill. The file now shares `tests/arenaHarness.ts` with the
new suites, so the switch drill is driven through the *same* shot path the run
controller uses — including the new `removesTargetOnHit` rule — rather than a
private copy that could drift. `tests/fastTargetAdvance.test.ts` adds a case
proving the third hit of the sequence finishes the trial with no extra click.

## 6. Gates

| Gate | Result |
| --- | --- |
| `npm run lint` | clean |
| `npm run typecheck` (engine + desktop shell) | clean |
| `npx vitest run` | **74 files, 662 tests passed** (was 71 / 620) |
| `npm run test:browser` | **91 passed** (was 89) |
| `node scripts/verify-arena-entry.mjs` (real Electron) | all checks passed — capture granted, session live in **8 ms** |
| `node scripts/verify-release.mjs` | all checks passed |
| `node scripts/verify-windows-artifacts.mjs --frontend --helper` | all gates passed |
| `node scripts/audit-no-telemetry.mjs` | CLEAN |
| `npm run build` / `build:desktop` | clean |
| `npm run dist:win` | installer produced |

## 7. A packaging hole found and closed

The first installer build here succeeded while printing, and ignoring,
`file source doesn't exist … native/windows/aldo_capture_helper.exe`.
electron-builder **silently skips a missing `extraResources` entry**, so it
produced a 99.7 MB installer that looked completely normal and shipped no
native capture helper. The portable packager already refuses to package a
helper it cannot verify; the installer path did not.

`npm run dist:win` now runs `verify-windows-artifacts --helper` **before**
electron-builder and fails closed (verified: exit 1 with the helper absent).
`electron-builder.yml` says why, and that electron-builder must never be
invoked directly for a release build. The helper-less installer was destroyed,
not shipped.

## 8. Release

Built on this macOS host (electron-builder's NSIS toolchain is cross-platform;
the build is unsigned either way), **not** by CI, because this pass must not
push and CI cannot run on an unpushed branch.

The native helper must be compiled by MSVC on Windows and is never committed.
`native/windows/aldo_capture_helper.c` is **unchanged** in this pass, so the
correct helper for rc.6 is the one CI compiled for rc.5. It was recovered from
the rc.5 installer still on the flash drive (in `.Trashes/502/`, whose SHA-256
matches the CI-published `9c967cb2…` byte for byte), extracted from
`$PLUGINSDIR/app-64.7z`, and gated: real PE32+, x86-64, 164,864 bytes,
self-reporting `helper-1.0.0` / `protocolVersion 1` — exactly what
`src/version.ts` expects. The helper inside the shipped rc.6 installer is
**byte-identical** to the one inside rc.5 (`0fafb048fae263ec…`).

| | |
| --- | --- |
| File | `AldoAimLab-Setup-1.0.0-rc.6.exe` (also copied as `AldoAimLab-Setup.exe`) |
| Size | 99,770,691 bytes |
| SHA-256 | `a014aef356b548908b233e9cb815bedde304f7afe364d60b0df2fcbef1e0b36c` |
| Bundled helper | `aldo_capture_helper.exe`, 164,864 bytes, SHA-256 `0fafb048fae263ecffa73476c2534e0a3240ded6e99253f3a27fb48c418dde07` |
| Local path | `release/installer/AldoAimLab-Setup-1.0.0-rc.6.exe` |

Package contents were verified by unpacking the finished installer: the helper
is present outside the asar with the expected hash, and the bundled frontend
carries `1.0.0-rc.6` and all three fixes' user-facing strings.

**Not verifiable here:** the two Windows-host gates — running the helper
(`--version`) and the arena-entry gate against the *installed* application.
Both passed for rc.5 on the identical helper binary; the rc.6 shell code is
unchanged except for the arena/session fixes covered above, and the arena-entry
gate did pass here against the real Electron dev tree.

## 9. Flash drive

One removable volume is mounted — `/dev/disk8s1`, `NO NAME`, Windows_FAT_32,
15.7 GB, at `/Volumes/NO NAME`. No ambiguity, nothing guessed.

Copied (nothing deleted, nothing else touched):

| File on drive | Bytes | SHA-256 re-read from the drive |
| --- | --- | --- |
| `AldoAimLab-Setup-1.0.0-rc.6.exe` | 99,770,691 | `a014aef3…f1e0b36c` ✓ matches local |
| `AldoAimLab-Setup.exe` | 99,770,691 | `a014aef3…f1e0b36c` ✓ matches local |
| `AldoAimLab-Setup-SHA256.txt` | 185 | — |
| `READ-ME-FIRST-rc6.txt` | 1,621 | — |

**Aldo should run `AldoAimLab-Setup.exe` (= `AldoAimLab-Setup-1.0.0-rc.6.exe`)**
after uninstalling the previous build (Settings → Apps → Aldo Aim Lab); the
uninstaller preserves his data. `READ-ME-FIRST-rc6.txt` names the build and
describes the three fixes in his own terms.

### Two things worth knowing about this drive

1. **The rc.5 build was moved to the drive's Trash between the start of this
   session and the copy** — `/Volumes/NO NAME/.Trashes/502/` holds rc.4, rc.5,
   the rc.1 portable folder and their checksum files, dated today. Pass 10 and
   Pass 11 both hit the same surprise ("the drive no longer held the installer
   placed there"). It is emptying the Trash, not a failing drive. Nothing was
   removed from `.Trashes` here — it is what made the rc.6 build possible.
2. **The volume has filesystem damage.** `diskutil verifyVolume /dev/disk8s1`
   fails (`fsck_msdos` exit 206): *"`..` entry in
   `/.Trashes/502/AldoAimLab-v1.0.0-rc.1` has incorrect start cluster"*. The
   rc.6 files copied and re-hashed correctly, so this pass is unaffected, but
   the volume should be repaired (`diskutil repairVolume /dev/disk8s1`, with
   the drive idle) before it is trusted with anything else.

## 10. Branding

`trAIMer — Train. Measure. Tune.` is used in the release material this
packaging supports: the drive's `READ-ME-FIRST-rc6.txt` and the heading of
`docs/INSTALL-WINDOWS.md`, which states plainly that the installer, the
installed application and the internal package are still named *Aldo Aim Lab*.
No historical rename of repo, package, appId or productName was attempted —
that changes the installer identity and the upgrade path, and belongs in its
own pass.

## 11. Files changed

One commit — "Fix the three gameplay defects from Aldo's second hardware
session", the tip of this branch. **Local only; nothing was pushed**
(`origin/ox/aldo-aim-lab-20260823T194949Z-a28b6239` is still at `6851028`).

```
 PASS-12-REPORT.md                   | 404 ++++++++++++++++++++++++++++
 app/src/main.ts                     |  28 +-
 app/src/runController.ts            | 151 ++++++++++-
 app/styles.css                      |  11 +
 docs/INSTALL-WINDOWS.md             |   9 +-
 docs/RELEASE.md                     |  11 +-
 docs/SIMULATOR.md                   |   4 +-
 electron-builder.yml                |   7 +
 package.json                        |   4 +-
 src/capture/browserSource.ts        |  27 +-
 src/capture/events.ts               |  11 +
 src/capture/recorder.ts             |  44 +--
 src/domain/scenario.ts              |  14 +-
 src/scenarios/director.ts           |  17 ++
 src/scenarios/planner.ts            |  79 ++++--
 src/session/audit.ts                |   4 +
 src/session/runner.ts               |  66 +++++
 src/session/types.ts                |  17 ++
 src/version.ts                      |   9 +-
 tests/arenaHarness.ts               |  94 +++++++
 tests/auditTrail.test.ts            |   4 +
 tests/breakPointerRelease.test.ts   | 517 ++++++++++++++++++++++++++++++++++++
 tests/breaks.test.ts                |  10 +-
 tests/browser/breaks.spec.ts        |  39 +++
 tests/captureEntry.test.ts          |   4 +
 tests/fastTargetAdvance.test.ts     | 241 +++++++++++++++++
 tests/pass5Engine.test.ts           |   2 +-
 tests/sessionResumeRecovery.test.ts |   2 +
 tests/sessionRunner.test.ts         |  11 +
 tests/strafingDrill.test.ts         | 359 +++++++++++++++++++++++++
 tests/targetSwitchDrill.test.ts     |  26 +-
 31 files changed, 2146 insertions(+), 80 deletions(-)
```

## 12. Not in this pass, deliberately

- The multi-game profile campaign.
- Native raw input as the live measurement transport (still gated on
  helper/renderer clock-origin alignment — Pass 10 §3).
- The product rename in packaging (§10).
- The pre-existing pairing observation and the ~22 % noisy-beginner overclaim
  rate in `blindCampaign` case E, carried forward from Pass 11 §9.
