# Pass 13 — trAIMer: the first break was killing the session

**Product:** **trAIMer** — *Train. Measure. Tune.*
**Release candidate:** `1.0.0-rc.7` (was `1.0.0-rc.6`)
**Trigger:** Aldo played rc.6 on his own Windows PC. He got about ten
challenges, the app returned to the main UI reporting one completed session
and no recommendation, he read the pink tracking target as one more thing to
shoot, and he said the shooting felt lame.

Every one of those was a real defect. The first one is the important one.

---

## 0. Baseline

| | |
| --- | --- |
| Repo | `https://github.com/happySNAG/Aldo-Aim-Lab.git` |
| Branch | `ox/aldo-aim-lab-20260823T194949Z-a28b6239` |
| HEAD at start | `e4fab4f` — "Fix the three gameplay defects from Aldo's second hardware session" |
| HEAD after this pass | `204bbc5` |
| RC Aldo tested | `1.0.0-rc.6`, `AldoAimLab-Setup-1.0.0-rc.6.exe` |

Reports and verification artifacts from Passes 1–12 are untouched.

---

## 1. Why the session ended after ten challenges

### It was not a completion, and it was not the player. It was the break.

Ten drills is exactly one candidate block: 2 warm-ups + 8 measured. The
session died at the **first break**, and reported it as an ordinary ending.

### The mechanism, exactly

A break hands the mouse back on purpose (`suspendCapture` →
`capture.releaseLock()`), because a break screen that asks for a click while
the arena still holds Pointer Lock has no cursor to click it with — that was
Pass 11's fix.

`PointerLockCaptureSource` marks such a release so the `pointerlockchange` it
produces is reported as `CAPTURE_RELEASED_REASON` rather than
`POINTER_LOCK_LOSS_REASON`, because consumers turn a *loss* into a fatal
interruption. rc.6 cleared that mark inside `releaseLock()` itself:

```js
this.#releaseRequested = deliberate;
this.#options.document.exitPointerLock();
// "belt and braces" — if the document never dispatches a change, do not let
// the flag leak into a later, real loss:
if (this.#options.document.pointerLockElement == null) {
  this.#releaseRequested = false;
}
```

**In Chromium/Electron, `exitPointerLock()` clears `pointerLockElement`
synchronously and dispatches `pointerlockchange` in a later task.** Measured
directly against Electron 44 while diagnosing this:

```
exitPointerLock: beforeSync='canvas'  afterSync='null'   t=2313
pointerlockchange: el='null'                             t=2313   (next task)
```

So that line ran *every* time, un-marking *every* deliberate release before
its own event arrived. The chain that followed:

1. break starts → `releaseLock()` → mark set, then immediately cleared;
2. `pointerlockchange` fires → reported as `POINTER_LOCK_LOSS_REASON`;
3. `BrowserRunController.#handleCaptureEvent` (no active trial) treats a loss
   between trials as fatal → `runner.cancel()`;
4. `cancel()` fires `#restSkip`, so the break ends instantly;
5. `#resumeCapture()` returns early because the session is now cancelled — so
   **no resume failure is recorded either**;
6. `run()` returns `#abortRun("cancelled by user")` **with no `abortReason` at
   all**;
7. the UI's only branch for an aborted run required an `abortReason`, so it
   fell through to the generic *"Session ended · Partial data was saved"* and
   navigated to Results;
8. Results had no recommendation to render, so it showed the empty state.

From the player's seat: ten challenges, back to the main screen, one session
"completed", no recommendation.

### Category

**Not** normal completion. **Not** a failed resume. **Not** a disposal. It was
an **abort caused by the app misclassifying its own deliberate release as a
lost mouse**, then reported as if it were an ordinary ending because the abort
carried no reason.

### Why every existing test missed it

- `tests/breakPointerRelease.test.ts` has a Chromium-shaped DOM double, but
  its `exitPointerLock()` dispatches `pointerlockchange` **synchronously**, so
  the flag was still set when the handler read it.
- The browser E2E adapter grants Pointer Lock **virtually** and holds no real
  lock, so `suspendCapture` never called `releaseLock()` at all.

Both are now closed.

### The fix

| File | Change |
| --- | --- |
| `src/capture/browserSource.ts` | The deliberate-release mark is a **counter**, incremented by `releaseLock()` and consumed **only** by the change handler (and reset by a fresh lock). The post-call re-check is gone, with the measurement above written down beside it. |
| `app/src/runController.ts` | Tracks interlude depth around `suspendCapture`/`resumeCapture`. A lock loss **during an interlude is never fatal** — belt to the braces above: even a user agent that mislabels a deliberate release cannot end a session at its own break. The fatal decisions are extracted as pure exported functions (`isFatalBetweenTrials`, `isFatalDuringTrial`) so the guarantee is testable without a DOM. |
| `src/session/runner.ts` | `abort(reason)` is now separate from `cancel()`. **Every** aborted run carries a machine-readable reason — a player cancel included. Interruptions carry a named, player-readable detail ("Windows took the mouse back between drills…"). |
| `app/src/main.ts` | The finish handler no longer has a path that renders an abort as a generic ending. |

---

## 2. How the calibration journey works now

```
Setup → arena → drill (SHOOT or TRACK) → block → break → next block
      → next round → analysis → results (recommendation | more data needed)
      → Continue calibration ⟲
```

- The engine owns progress. `SessionRunner.calibrationProgress()` reports
  steps completed against the **actual planned steps of every planned round**
  (refined round by round as adaptive allocation decides each round's real
  length). Rounds not yet planned are estimated from round 0's real length.
- The run screen shows **`Calibration 28%`** with a meter, plus
  `Round 1/2 · block 2/5 · 14/80 drills`. It is monotone, never exceeds 100 %,
  and only reads 100 % when the whole plan has run.
- **A block is never counted as a session.** After the first block of a default
  session the readout is ~12 %, not "1 session completed".
- Breaks remain skippable (Skip break / Space / Enter) and the mouse is handed
  back before the overlay appears.
- Every ending — completion, player exit, lost mouse, refused resume, capture
  never acquired — produces a `SessionOutcomeReport` and lands on Results with
  the exact reason.

---

## 3. How tracking works now, and how a player knows not to shoot

The tracking drill answers "am I supposed to shoot this?" in six places at
once:

1. **A `TRACK` chip in the run bar**, next to a `SHOOT` chip on every other
   drill, colour-coded and tinting the whole run screen.
2. **The instruction line**: *"Keep your crosshair on the target — don't
   shoot."*
3. **A banner over the arena**: `TRACK` with the same instruction beneath it,
   anchored to the top edge so it can never cover a target.
4. **The target itself is not a disc.** It is a hollow ring with a dashed,
   slowly rotating outer collar — a "follow me" affordance, with nothing in
   the middle to aim at. Click-to-hit targets stay solid discs.
5. **Continuous contact feedback**: on target, the ring gets a bright lock
   ring, the halo tightens, and *the crosshair itself* changes; off target, a
   soft dashed guide line points at the target and vanishes the moment the
   crosshair arrives. An `ON TARGET / OFF TARGET` label and an on-target meter
   sit along the bottom edge.
6. **A time-remaining arc drawn around the target** (plus `N.Ns left`), so the
   clock is where the eyes already are and an arena the player cannot act on
   never looks frozen.

And when a player clicks anyway:

- the click is still **recorded** (it is real behavioural data);
- it produces **no shot sound, no hit marker, no muzzle flash, no miss ripple
  and no streak** — nothing that dresses it up as a shot that failed;
- a one-time hint appears: *"No need to shoot — just stay on it"*;
- the target does **not** disappear and the window is **not** shortened.

Completion is explicit: `TRACK COMPLETE` with the on-target percentage, a
rising two-note chime, and the banner painted on the last frame of the drill
so it stays on screen through the inter-trial gap. It ends because its clock
ran out, never because the app ignored the player.

---

## 4. Shooting/game-feel improvements

All synthesized in-browser (no assets, no network), all strictly after the
recorded event:

- **Shot audio** — a short dry click plus a filtered noise transient.
- **Hit audio** — a bright two-layer ping, pitched up with the streak (capped).
- **Miss audio** — a dull low thud. **Expiry audio** — softer still.
- **Hit marker** — four diagonal ticks at the crosshair, 190 ms, gold above a
  6-hit streak.
- **Muzzle flash** — a small warm flash at the crosshair, 70 ms.
- **Target pop** — flash, expanding ring and deterministic shards (kept).
- **Streak** — a small `x3` counter near the crosshair from three hits.

Explicitly **not** added: screen shake, any transform of the playfield, weapon
models, delayed effects, or anything that changes target visibility before the
shot is recorded. `tests/arenaPresentation.test.ts` asserts statically that
`recorder.add(event)` precedes every sound, effect and streak update in the
event handler, that the hit/miss branch reads the recorder's own verdict rather
than re-deriving geometry, that the effect pools are bounded and cleared at
every drill boundary, and that `#drawFrame` contains no `translate`/`rotate`/
`scale` of the frame.

---

## 5. Results screen behaviour

Every session that runs now renders, in order:

1. **What happened** — `Calibration complete` / `You ended this calibration
   early` / `…the mouse was lost` / `…could not take the mouse back`, with the
   engine's exact sentence, the reason code, `Calibration NN%`, drills
   completed of planned, measured drills of planned, and the round/block
   reached. Early endings add: *"Every drill you finished was saved the moment
   it finished."*
2. **The evidence so far** — drills completed, valid for scoring, excluded,
   hit accuracy, reaction time, overshoot, undershoot, corrections,
   consistency, tracking on-target, tracking error. **A measurement with no
   data renders as an em dash, never as zero.**
3. Then either the recommendation, or:

### More data needed

Shown whenever the evidence does not support a defensible call:

- *"trAIMer will not guess a sensitivity for you. Here is exactly what is
  missing."*
- **Why** — e.g. *"3 of 5 candidate sensitivities are still below the 4 valid
  measured drills needed to compare them: 5600 eDPI (0/4), 4870 eDPI (0/4),
  6440 eDPI (0/4)."*
- **How much more** — measured drills still needed, a rough time, and what has
  been completed.
- **What to do next** — an ordered list.
- **Continue calibration** (primary) and Start a new calibration.

### Recommendation

Shown when the evidence clears the engine's **own documented floor**: at least
`minValidTrialsPerCandidate` (4) valid measured drills for **every** candidate,
and at least three candidates with usable data. The existing evidence-backed
FinalResult screen is then rendered unchanged — recommended sensitivity,
plausible range, confidence and its basis, candidate comparisons, scenario
contributions, exclusions, and the recommended next action.

A **weak** separation is deliberately *not* treated as insufficient. A fully
populated session whose candidates are genuinely close is a real result; the
recommendation carries its own honest confidence, range and "run a clean
repeat" next action. Withholding it would tell a player who did everything
right that their session was worthless.

**No recommendation is persisted when the evidence is insufficient**, so
History can never gain an eDPI the data does not support. The refusal is
recorded in the audit trail as `evidence-insufficient`.

### Continue calibration

Loads the newest checkpoint for that experiment, the original definition and
every trial already recorded, and resumes through the engine's own resume path:
same experiment id, same candidate ladder, same blinding, nothing already
measured measured again. If the plan is **complete but under-powered**,
`planContinuation()` adds one more search round — otherwise the button would
replay nothing and hand the player the same screen twice.

---

## 6. The trAIMer rename

### Renamed

Installer product name and filename (`trAIMer-Setup-1.0.0-rc.7.exe`, plus a
stable `trAIMer-Setup.exe`), installed application (`trAIMer.exe`), Start Menu
and Desktop shortcut, Apps & Features entry (`trAIMer 1.0.0-rc.7`), window
title, sidebar wordmark (`trAIMer` with the AIM in the accent colour) and
tagline (*Train. Measure. Tune.*), run-screen brand, diagnostics and About
copy, backup filename (`traimer-backup-*.json`), backup envelope error text,
instance BroadcastChannel, npm package name/description/author, `APP_NAME`,
the native helper (`traimer_capture_helper.exe`, source renamed with `git mv`),
the PowerShell launchers (`start-traimer.ps1`, `stop-traimer.ps1`) and their
state directory, the portable release folder and zip, every CI artifact name,
`README.md`, `docs/INSTALL-WINDOWS.md`, `docs/DESKTOP-SHELL.md`,
`docs/PACKAGING-WINDOWS.md`, `docs/RELEASE.md`, `docs/MANUAL-TEST.md`,
`docs/NATIVE-CAPTURE.md`, `FIRST-RUN.md`, `docs/SECURITY-REVIEW.md`, and the
browser/UI test fixtures that assert on branding.

### Deliberately NOT renamed — and why

| Survival | Reason |
| --- | --- |
| `aldo://app` origin (`APP_SCHEME`) | IndexedDB, localStorage and every other web-storage bucket is keyed by **origin**. Renaming it presents every existing player with an empty app and no route back to their history. Never visible: the shell has no address bar. |
| IndexedDB database name `aldo-aim-lab` | IndexedDB is keyed by (origin, name) and has **no rename operation**. A new name silently creates a new, empty database. Invisible in every UI, export and document. |
| `appId: com.aldoaimlab.desktop` (and the matching AppUserModelId) | electron-builder derives the NSIS uninstall registry key from it. Keeping it makes rc.7 an **in-place upgrade** of rc.6 rather than leaving a second, stale "Aldo Aim Lab" entry beside the new one in Apps & Features — which would be the worst possible branding outcome. Never displayed. |
| `LEGACY_APP_DIR_NAME = "AldoAimLab"` | How the shell finds the pre-rename `%APPDATA%` directory in order to migrate it. |
| `aldo-aim-lab-settings`, `aldo-session-token` | Read as fallbacks so an upgraded install keeps the player's settings and helper token. |
| `AldoAimLab` in `build/installer.nsh` | The uninstaller's "delete my data" branch clears the pre-rename directory too, so a machine that installed rc.7 but never launched it does not keep history the player explicitly asked to delete. |
| Upgrade notes in `docs/INSTALL-WINDOWS.md` / `docs/DESKTOP-SHELL.md` | A player holding an rc.6 install needs to be told, **by name**, that this is the same product and their history came with them. |
| `PASS-*.md`, `UI-PASS-*.md`, `docs/PASS6-*.md`, commit history, PR #1's title | Historical engineering records. Renaming them would damage provenance. Git history was not rewritten. |

Each survival is listed in `ALLOWED` in `scripts/verify-branding.mjs` with its
written reason; `tests/brandingGate.test.ts` asserts every entry names a file
that exists, a string that is actually present, and a reason.

### User-data migration

`desktop/userDataMigration.ts` runs **before anything opens userData**:

1. `%APPDATA%\trAIMer` already exists → use it, leave the old one untouched as
   an intact backup;
2. only `%APPDATA%\AldoAimLab` exists → **move** it;
3. the move is refused → **recursive copy**;
4. both fail → **keep using the old directory**, so the folder keeps the old
   name but not one session is lost. Logged either way.

Neither the origin nor the database name changes, so IndexedDB training
history, calibration records and diagnostics come across intact. Settings and
the session token fall back to their pre-rename localStorage keys.

### Branding release gates

`scripts/verify-branding.mjs` runs in four modes and fails the build on any
legacy name in a shipped surface:

| Mode | Covers |
| --- | --- |
| (default) | package metadata, `electron-builder.yml`, `build/installer.nsh`, `app/index.html`, player-facing docs, the PowerShell launchers, CI workflow, and every source file (comments may narrate the rename; strings, identifiers and values may not). Also asserts the product name and tagline are actually **present**. |
| `--bundle dist-app` | the built frontend the player's window renders |
| `--installed-app DIR` | `trAIMer.exe` present, no legacy-named file anywhere, no legacy-named resource |
| `--installer FILE` | the artifact filename the player double-clicks |

Wired into `npm run dist:win` and into the `engine`, `browser`,
`windows-release` and `windows-installer` CI jobs. Historical reports are out
of scope by construction.

---

## 7. Tests added

| File | Cases | What it holds |
| --- | --- | --- |
| `tests/captureReleaseSemantics.test.ts` | 5 | The root cause, against a DOM double that reproduces Chromium's *synchronous clear, asynchronous event* ordering. Includes a **witness test** that re-implements rc.6's `releaseLock()` verbatim and shows it reporting a deliberate release as a loss. |
| `tests/calibrationJourney.test.ts` | 16 | A break is not an ending; every planned block runs; progress is truthful, monotone and bounded; a block is never a session; failed resume / engine abort / player cancel each abort with a named reason and preserved data; Aldo's exact one-block session is *not* enough for a recommendation and persists none; a completed plan *is*; Continue calibration resumes without repeating a drill and reaches a recommendation; continuing a complete-but-under-powered plan adds a round. |
| `tests/arenaPresentation.test.ts` | 10 | `recorder.add(event)` precedes every sound/effect/streak; feedback is chosen from the recorded shot; effects bounded and cleared per drill; no frame transforms; tracking does not remove its target; tracking completes with no click and stays visible; ten clicks change nothing; the tracking branch emits no shooting feedback; the instruction and HUD strings exist. |
| `tests/userDataMigration.test.ts` | 14 | Move / copy-fallback / **keep-the-old-directory-on-total-failure**; an existing new directory always wins; first run; the migration runs before userData is opened; origin, database name, appId and legacy directory constants are pinned; the uninstaller clears both directories; settings fall back to the old key. |
| `tests/brandingGate.test.ts` | 12 | The gate fails on a legacy name in the built JS, on a page that never names the product, on `AldoAimLab-Setup.exe`, and on an installed layout with a legacy executable — and passes the correct ones. Every allowlist entry is validated. Historical reports still say the old name and the gate does not care. |
| `tests/browser/trackingDrill.spec.ts` | 6 | TRACK chip, instruction, screen state; SHOOT drills never say "don't shoot"; completes with **no click**, target visible the whole window, completion signal recorded; 12 clicks remove nothing, advance nothing, need no second click; on-target reported; time remaining monotone. |
| `tests/browser/shootingFeel.spec.ts` | 5 | Hits register and produce feedback with a bounded effect pool; a miss produces no hit feedback and no removal; 240 shots leave the pool bounded and the session alive; target geometry identical across a shot's effects; no shooting feedback during tracking. |
| `tests/browser/calibrationJourney.spec.ts` | 4 | Truthful progress while playing; too little evidence → the full **More data needed** screen and **no** fabricated recommendation; **Continue calibration accumulates** onto the same calibration (50 drills, not 25) and reaches a recommendation; ending early names the reason once and still shows the evidence. |
| `tests/browser/arenaPlayer.ts` | — | A synthetic player that actually aims (see §8). |

Existing suites updated: `sessionRunner`, `auditTrail` (fixtures now record the
sensitivity the trial was played at), `breakPointerRelease` (a cancel now
carries a reason), `pass5Engine` (rc.7), `desktopShell`, `windowsArtifacts`,
`securityRoundThree`, `ui`, `persistence`, `lifecycleHardening`.

### Bug re-introduction proof

Reverting `releaseLock()` to rc.6's shape makes **3 of 5** cases in
`tests/captureReleaseSemantics.test.ts` fail, including the direct assertion
that a deliberate release is reported as `CAPTURE_RELEASED_REASON`. Restoring
the fix makes all 5 pass.

---

## 8. Three defects found and fixed on the way

These were not in the brief; they were in the way.

1. **The E2E adapter never moved the virtual reticle.** `emitForTesting()`
   pushed pointer samples straight to the sink, bypassing the
   `applyRawDelta()` step the real handler performs. The reticle the arena
   draws — and that `arenaSnapshot()` reports — stayed pinned at the centre of
   the screen for every automated session, so the scripted player could not
   aim and the browser suite had **never once exercised a hit**. Fixed to
   apply and re-emit the clamped delta, exactly like the real path.

2. **Every trial the browser suite produced was fatally invalid.** The old
   driver fired 40 samples of 8 px inside one microtask burst — about
   160 px/ms against the validator's 60 px/ms ceiling. The suite appeared to
   reach a recommendation only because rc.6 persisted one whether the evidence
   supported it or not. The new `arenaPlayer.ts` moves at ~1.2 px/ms toward
   the real target and spaces its clicks clear of the duplicate-click window;
   sessions now produce 30 valid measured drills out of 30.

3. **The setup form read a legitimate `0` as "empty".**
   `Number(input.value) || 2` gave a player who set warm-up trials to 0 — a
   documented, in-range choice — 2 instead. Fixed for every numeric field.

Also fixed: the end-reason sentence could repeat itself ("You ended the
session from the arena controls. You ended the session from the arena
controls."), and the `TRACK COMPLETE` banner was computed on a frame that was
never painted.

---

## 9. Full test results

| Gate | Result |
| --- | --- |
| `npm run lint` | clean |
| `npm run typecheck` (engine + desktop shell) | clean |
| `npx vitest run` | **79 files, 719 tests, all passing** (was 74 / 662) |
| `npx playwright test` | **106 tests, all passing** (was 92) |
| `node scripts/verify-release.mjs` | all gates passed |
| `node scripts/verify-windows-artifacts.mjs --frontend dist-app` | all gates passed |
| `node scripts/audit-no-telemetry.mjs` | CLEAN (sources + shipped bundle) |
| `node scripts/verify-arena-entry.mjs` | all checks passed (capture granted in 340 ms) |
| `node scripts/verify-branding.mjs` | PASS — 13 documented survivals |
| `node scripts/verify-branding.mjs --bundle dist-app` | PASS |
| `npm run desktop:smoke` | pass; migration logged, clean shutdown |

No gate was weakened. Two engine-suite fixtures were **corrected** (they had
been recording the baseline sensitivity for every candidate, which made every
non-baseline candidate's trials fail validation with `CONFIG_MISMATCH`), and
one assertion was updated to the new contract that a cancel carries a reason.

---

## 10. Remaining user-facing "Aldo" strings

Only these, all deliberate and all invisible to a player:

- the `aldo://app` origin and the `aldo-aim-lab` IndexedDB name — renaming
  either destroys existing training history;
- `com.aldoaimlab.desktop` — keeps rc.7 an in-place upgrade of rc.6;
- the legacy `%APPDATA%\AldoAimLab` and localStorage key constants — how the
  migration and the fallbacks find the old data;
- the by-name upgrade note in the install docs, which a player *should* see;
- historical reports, commit messages, and PR #1's title.

The word "Aldo" also remains where it refers to **the person** (the default
player name, comments about his hardware sessions). That is correct.

---

## 11. Windows CI

Three runs on this branch; the first two failed **only** in the new branding
gate's own plumbing, never in product code.

| Run | Commit | Result |
| --- | --- | --- |
| [34138350113](https://github.com/happySNAG/Aldo-Aim-Lab/actions/runs/34138350113) | `204bbc5` | `engine`, `browser`, `native-windows` green. Both Windows jobs failed: `tests/brandingGate.test.ts` imported `scripts/verify-branding.mjs` from TypeScript, which resolved on Linux/macOS and threw `SyntaxError` at suite load on Windows. |
| [34139392087](https://github.com/happySNAG/Aldo-Aim-Lab/actions/runs/34139392087) | `833fe88` | Import replaced with a JSON process boundary. Windows jobs failed again — and revealed a **worse** problem: `if (import.meta.url === \`file://${process.argv[1]}\`) main();` is false on Windows (`file:///D:/a/…` vs `D:\a\…`), so every `node scripts/verify-branding.mjs` step in the Windows jobs had produced **no output and exit code 0**. A release gate that passes by not running. The suite caught it because it asserts the gate's *output*, not only its exit code. |
| **[34140248613](https://github.com/happySNAG/Aldo-Aim-Lab/actions/runs/34140248613)** | **`c741cf9`** | **All five jobs green: `engine`, `browser`, `native-windows`, `windows-release`, `windows-installer`.** |

The `windows-installer` job on `c741cf9` passed, in order: lint + strict
typecheck, the full engine + desktop suite on a Windows host, no-telemetry
audit, frontend build, desktop shell build, **arena-entry gate**, frontend
asset gate, **branding gate (sources + shipped bundle)**, release verification,
`npm audit`, **helper is a genuine x64 PE**, **helper executes**, NSIS build,
**installer exists and is plausible + branding gate on the installer
filename**, **silent install produces a complete application + branding gate on
the installed layout + no legacy-named file anywhere + `trAIMer.exe` present**,
**installed app starts, reaches `helperState: ready`, and shuts down with
nothing surviving**, **the INSTALLED app can start a test** (arena-entry gate
against the installed exe), then publish with checksum.

---

## 12. Release artifacts

| | |
| --- | --- |
| Version | **`1.0.0-rc.7`** |
| Installer | **`trAIMer-Setup-1.0.0-rc.7.exe`** (also published as `trAIMer-Setup.exe`) |
| Size | 100,517,791 bytes |
| SHA-256 | **`3487263dcfb6c2ae5d062b9ad537fcb0b6733a421a0bc5881b11918767bf5d98`** |
| Built by | CI run `34140248613`, job `windows-installer`, commit `c741cf9` |
| Portable zip | `trAIMer-v1.0.0-rc.7-windows-x64.zip` (`windows-release` job) |

Verified after download with `verify-windows-artifacts.mjs --installer` and
`verify-branding.mjs --installer`, then re-verified byte-for-byte after the
copy to the flash drive.

### Flash drive — `/Volumes/NO NAME`

```
trAIMer-Setup-1.0.0-rc.7.exe   3487263d…5d98
trAIMer-Setup.exe              3487263d…5d98   (identical, stable name)
trAIMer-Setup-SHA256.txt       checksums + CI run + commit
READ-ME-FIRST-rc7.txt          install steps, what changed, what to try
```

SHA-256 was re-read **from the drive** after the copy and matches the CI
artifact exactly, for both filenames.

The rc.6 files (`AldoAimLab-Setup*.exe`, its checksum and `READ-ME-FIRST-rc6.txt`)
were removed **after** the new copies verified. Leaving a runnable installer
called *Aldo Aim Lab* beside one called *trAIMer* is the most likely way to get
the wrong build tested. Their provenance is preserved in `PASS-12-REPORT.md`
(SHA-256 `9c967cb2…5c70`, CI run 34070387920) and the artifact is still
reproducible from CI.

---

## 13. Next steps on Aldo's Windows PC

1. Plug in the drive, copy **`trAIMer-Setup.exe`** to the Desktop, run it.
   SmartScreen → *More info* → *Run anyway*. It replaces the existing
   "Aldo Aim Lab" install.
2. Open **trAIMer** from the Desktop icon. Check that History still shows the
   previous sessions — that is the user-data migration working.
3. Start a session and **play through at least two breaks.** The one thing
   that must not happen is the session ending on its own. Progress should read
   `Calibration NN%` and keep climbing past the first block.
4. When a **TRACK** drill appears: do not shoot. Follow it, watch the on-target
   bar, and confirm it ends by itself with `TRACK COMPLETE`.
5. Shoot the other drills and say whether the sound, hit markers and streaks
   feel better.
6. Read the results screen at the end and say whether it makes sense — and
   whether it gave a recommendation or asked for more data.
7. If anything goes wrong: Diagnostics → export the diagnostic bundle.

---

## 14. Remaining release blockers

**None for this test.** Known, accepted, unchanged from rc.6:

- **The build is not code-signed.** SmartScreen shows "unknown publisher" on
  first run. Documented in `docs/INSTALL-WINDOWS.md`; a certificate is not
  purchased.
- **The break/resume path is only partly automatable end to end.** The
  root-cause fix is covered by unit tests against a DOM double that reproduces
  Chromium's exact ordering, and by the interlude guard; a real Windows
  Pointer Lock release inside a running session is still exercised only by
  hand.
- **Windows PR CI runs on `pull_request`.** A push to a branch without an open
  PR would not build an installer.
- The **5-pass multi-game profile campaign has not been started**, as
  instructed.
