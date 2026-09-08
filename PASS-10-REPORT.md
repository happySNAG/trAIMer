# Pass 10 — the core shooting test can actually be started on real Windows hardware

**Release candidate:** `1.0.0-rc.4` (was `1.0.0-rc.3`)
**Trigger:** real-hardware validation on Aldo's Windows x64 PC. Install,
desktop shortcut, Electron shell, native helper start and arena render all
worked. **No test session could ever begin.**

---

## 1. What Aldo saw, and what was actually happening

| Observed | Cause |
| --- | --- |
| Clicking the arena did nothing | The overlay swallowed the click |
| Top-right stayed **Preparing** | `start()` was never called, so no engine state existed |
| Overlay stayed "Click to lock in / Candidates are blinded during play…" | That is the *pre-session* overlay; the engine never reached `awaiting-lock` |
| `0 / 500 measured trials` | Correct — nothing ran |
| **Pause** and **End session** did nothing | They forwarded to a `SessionRunner` that is only constructed inside `start()` |
| `browser capture · pointer lock` | A hardcoded caption; the live path never consulted the native helper |

### Root cause 1 (primary, release-blocking) — the overlay ate the click

`app/styles.css`:

```css
.overlay-message {
  position: absolute;
  inset: 0;
  z-index: 5;
  /* pointer-events defaults to auto */
}
```

`.overlay-message` is a **sibling** of `#run-canvas` inside
`.run-stage-inner`, stretched over the whole arena. The listener that starts
the session was bound to the canvas:

```js
canvas.addEventListener("click", () => { pendingStart?.(); pendingStart = null; });
```

Every click aimed at the arena therefore landed on the overlay and stopped
there. Reproduced before the fix with `document.elementFromPoint()` at the
arena centre:

```
BEFORE CLICK { "topEl": "DIV.overlay-title", "overlayPointerEvents": "auto" }
AFTER  CLICK { "state": "(none)", "chip": "Preparing",
               "overlayTitle": "Click to lock in",
               "progress": "0 / ≤15 measured trials" }
```

That is Aldo's screenshot, exactly.

### Root cause 2 (independent, equally fatal) — pointer-lock events on the wrong target

`src/capture/browserSource.ts` registered the lock events **on the canvas**:

```js
this.#listen(element, "pointerlockchange", …);
this.#listen(element, "pointerlockerror",  …);
```

The Pointer Lock spec dispatches both at the **Document**. Verified in the
shipped engine:

```
POINTERLOCK PROBE {
  "fired": [ "document:pointerlockerror" ],   // element listeners: never
  "isPromise": true                           // Chromium >= 111 returns a Promise
}
```

So even with the click fixed, `requestLock()` could only ever hit its 5 s
timeout and report a denial that had not happened — a second hang. The
returned Promise was also discarded, so a genuine refusal surfaced as an
unhandled rejection instead of a reason.

### Root cause 3 — the controls could not work before `start()`

`pause()` / `cancel()` forwarded to `#runner`, which is `null` until `start()`
runs. In the trapped state both were silent no-ops; **End session** even ran
its confirmation dialog and then did nothing.

### Root cause 4 (latent) — the lock was requested outside the user gesture

`requestPointerLock()` was called from the runner's execution gate, *after*
`saveExperiment()` and a checkpoint write. Chromium requires user activation
for a document's first lock, so the request was one storage stall away from
being refused even once 1–3 were fixed.

### Why the test suite was green

The Playwright session suite runs with `?e2e=1`, which sets
`virtualLock: true` (`requestLock → Promise.resolve(true)`) and calls
`start()` directly **without any click**. The unit harness dispatched
`pointerlockchange` on the fake *element* — it encoded the bug. Both mocks
agreed with the defect, so nothing tested the real entry path.

---

## 2. What was fixed

**Capture source (`src/capture/browserSource.ts`)**
- lock events moved to the **document**;
- the Promise returned by `requestPointerLock()` is awaited for the real
  refusal reason and always handled;
- `requestLock()` returns a structured `LockOutcome` — `acquired`, `denied`,
  `timeout`, `cancelled`, `unsupported`, `source-stopped`,
  `released-before-start` — with player-facing guidance per code;
- concurrent callers share one in-flight request, so the gesture-time request
  and the runner's gate cannot issue two;
- `abortPendingLock()` settles a pending request immediately.

**Run controller (`app/src/runController.ts`)**
- the capture source is created in `create()`, so the click can request the
  lock **synchronously inside the gesture** (`requestCaptureFromUserGesture()`);
- the execution gate re-checks `isLocked` before entering running — a lock
  granted at click time but released during setup does not start a session;
- `cancel()` works with no runner (and reports the finish itself, so the UI
  always leaves the arena); `pause()` while preparing withdraws the request;
- losing the lock **between** trials now ends the session honestly instead of
  continuing with no capture.

**Session runner (`src/session/runner.ts`)**
- the gate honours a cancel before and during the request;
- a refusal aborts with a named `abortReason`, an audit entry
  (`capture-unavailable`) and a phase-log line — never a bare "denied".

**Run screen (`app/src/main.ts`, `app/styles.css`)**
- `.overlay-message { pointer-events: none }`; only `.overlay-actions` accepts
  clicks;
- the start click listens on the **stage**, so it is seen wherever in the arena
  it lands, overlay text included;
- the arena shows "Preparing the arena" until the capture source exists, then
  "Click to lock in", then "Capturing your mouse…" — three distinguishable
  states instead of one;
- a refusal renders an on-arena diagnostic with **Try again** / **Back to
  setup**;
- Esc cancels a pending capture and leaves the arena;
- `Esc releases the mouse` is stated in the bottom bar, because while the
  pointer is locked the arena owns the cursor and the buttons are (inherently)
  not mouse-reachable.

---

## 3. `browser capture · pointer lock` — intentional, or the wrong path?

**It is evidence that the real capture path was never selected — and the
caption could not have said so.** It was a hardcoded string in the view.

`BrowserRunController.start()` constructs a `PointerLockCaptureSource`
directly. `CaptureSourceNegotiator` and `NativeTransportCaptureSource` are
referenced only by tests and the Diagnostics probe, so tier 1 was never
evaluated for a session — on any machine, ready helper or not.

Fixed as far as this pass safely can: `app/src/captureTiers.ts` now evaluates
the tiers for real (shell present → platform supported → helper `ready` →
validated by a passing capture self-test) and the run screen renders the
result, including the reason tier 1 is not carrying the session. Observed in
the real shell:

```
browser capture · pointer lock
  ↳ Measured samples come from browser Pointer Lock (pointermove-coalesced).
    Native high-rate capture is not carrying this session:
    no native capture helper for this platform.
```

**Native capture is deliberately NOT switched on for live measurement in this
pass, and the report says so.** The blocker is real and is not a UI problem:
the helper timestamps frames in milliseconds since **its own** start
(QueryPerformanceCounter origin), while the recorder compares sample times
against target spawn times taken from the renderer's `performance.now()`
origin. Feeding one clock's samples into the other's timeline shifts every
reaction time by an unknown constant — silently, and undetectably downstream.
Aligning the two origins is a measurement change that needs its own pass and
its own hardware validation; shipping it untested into the RC that is supposed
to make the test *reliable* would be the wrong trade. Pointer Lock also stays
mandatory either way: the helper reads Raw Input globally, so without a lock
the OS cursor would leave the arena.

The tier-1 selection logic is implemented and tested (including the
helper-ready Windows path), so enabling it later is a one-flag change plus the
clock work — see `docs/NATIVE-CAPTURE.md`.

---

## 4. Regression tests added

`tests/captureEntry.test.ts` — 25 tests
- successful entry (document event, Chromium promise, shared in-flight
  request, already-held lock);
- **the bug in one assertion**: lock listeners exist on the document and *not*
  on the element;
- rejection (`pointerlockerror`, rejected promise carrying `NotAllowedError`,
  a throwing `requestPointerLock`), and "never leaves the promise pending";
- timeout (fake timers: not settled at 3999 ms, settled at 4001 ms);
- cancellation while pending — settles **without advancing any timer**;
- runner gate: denial aborts with the structured reason + audit entry; cancel
  before the gate never asks for the mouse; a not-ready path runs zero trials;
- capture-tier selection, including **native-helper-ready Windows** → tier 1,
  ready-but-unvalidated → rejected, browser self-test never counts as native
  validation.

`tests/browser/captureEntry.spec.ts` — 11 tests, real DOM, **without** `?e2e=1`
- the arena centre hit-target is the canvas; overlay `pointer-events: none`;
- Pause and End session are hit-testable (overlay does not cover controls);
- the click always **resolves** within 6 s — live or diagnosed — which is the
  host-agnostic contract (macOS headless refuses Pointer Lock, the Linux CI
  runner grants it, Aldo's PC grants it; the rc.3 symptom was neither);
- a refusal and a never-answered request are **forced** by overriding
  `Element.prototype.requestPointerLock`, so both diagnostics are exercised
  identically on every host rather than depending on the runner's mood;
- a refusal is not silently treated as a cancellation (it stays on the arena
  and explains itself); both diagnostic exits work; retry re-arms the arena;
- End session, Pause and Esc all work while preparing;
- the capture caption is derived and carries a reason.

`tests/uiContract.test.ts` — 4 new static gates
- `.overlay-message` must declare `pointer-events: none`, `.overlay-actions`
  `auto`; the start click must listen on the stage and lock inside the gesture;
  the caption must be derived; the controls must not forward blindly.

`scripts/verify-arena-entry.mjs` — **new release gate**, drives the real
Electron shell (and the *installed* application in CI): configure a session,
click the arena, and require that it resolves — either the session goes live,
or a diagnostic with working exits appears. Sitting on "Click to lock in" is a
failure. Also checks End session while preparing, and that losing the lock ends
the session visibly.

Both defects were verified to be *caught* by re-introducing them: restoring
`pointer-events: auto` fails the browser gate, and rebinding the lock events to
the element fails 8 of the 25 unit tests.

---

## 5. Results

| Gate | Result |
| --- | --- |
| `npm run lint` | clean |
| `npm run typecheck` (engine + desktop) | clean |
| `npx vitest run` | **68 files, 595 tests passed** (was 67/566) |
| `npm run test:browser` | **85 passed** (was 74) |
| `npm run build` / `build:desktop` | clean |
| `node scripts/verify-release.mjs` | all gates passed |
| `node scripts/audit-no-telemetry.mjs` | CLEAN |
| `node scripts/verify-windows-artifacts.mjs --frontend dist-app` | all gates passed |
| Electron `--smoke-test` | `pass: true` |
| `node scripts/verify-arena-entry.mjs` | all checks passed |

No gate was weakened or skipped.

The decisive evidence — the real Electron shell, the same one shipped to
Aldo, on `aldo://app`:

```
arena entry gate: development tree
  ok   arena centre receives clicks — run-canvas
  ok   overlay does not take pointer events — none
  ok   control is clickable: Pause
  ok   control is clickable: End session
  ok   End session works while the arena is preparing
  ok   the arena click resolves instead of hanging
         state="trial-active" locked=true after 205 ms
  ok   losing the pointer lock ends the session visibly
  note capture GRANTED — the session went live in 205 ms
```

Before this pass the same click produced `state="(none)" chip="Preparing"`
forever.

---

## 6. CI

Two new release gates in `.github/workflows/ci.yml` → `windows-installer`:

1. **the arena can actually be started (dev tree)** — after the desktop build;
2. **the INSTALLED app can start a test** — after the silent-install and
   startup gates, driving `C:\aldo-install-test\Aldo Aim Lab.exe`.

Both accept a granted lock *or* a fast, diagnosed refusal (a CI runner may not
grant Pointer Lock); what they refuse to accept is the hang that shipped in
rc.3.

### CI result — run 34063084266 (commit `5282e17`), all five jobs green

| Job | Result |
| --- | --- |
| engine | ✓ 1m22s |
| browser | ✓ 3m52s |
| native-windows | ✓ 1m0s |
| windows-release | ✓ 2m50s |
| windows-installer | ✓ 5m6s |

The **installed** Windows application — real Windows, native helper running,
launched from `C:\aldo-install-test\Aldo Aim Lab.exe`:

```
arena entry gate: installed app at C:\aldo-install-test\Aldo Aim Lab.exe
  ok   arena centre receives clicks — run-canvas
  ok   overlay does not take pointer events — none
  ok   control is clickable: Pause
  ok   control is clickable: End session
  ok   capture path is reported — browser capture · pointer lock ::
         Measured samples come from browser Pointer Lock (pointermove-coalesced).
         Native high-rate capture is not carrying this session:
         helper is ready but unvalidated — run the capture check in Diagnostics.
  ok   End session works while the arena is preparing
  ok   the arena click resolves instead of hanging
         state="trial-active" locked=true after 213 ms
  ok   losing the pointer lock ends the session visibly
  note capture GRANTED — the session went live in 213 ms
```

That caption line is also the tier logic answering §3 against a genuinely
ready Windows helper: it is present and ready, it is *not* carrying the
session, and it says why.

### Installer

The build shipped to the flash drive:

| | |
| --- | --- |
| File | `AldoAimLab-Setup-1.0.0-rc.4.exe` (also copied as `AldoAimLab-Setup.exe`) |
| Size | 100,456,019 bytes |
| SHA-256 | `c2e34ce7fd2ebf76cb298e7bb2b9b267065d9eba067bec21c303b073f4072ca0` |
| Built by | CI run **34063592565**, commit `67b61aa` (all five jobs green) |
| Flash drive | `/Volumes/NO NAME` — both names re-hashed **after** the copy; each matches the CI-published checksum byte for byte |

`electron-builder` output is not byte-reproducible (build timestamps), so the
SHA-256 above names **one specific CI build**, not the source tree. A later
docs-only commit produces a different hash for identical application code;
the hash on the drive is the one recorded here.

Aldo's PC should be told to uninstall rc.3 first (Settings → Apps → Aldo Aim
Lab), then run this installer. The previous rc.3 installer was no longer
present on the drive when this copy was made.

---

## 7. Not done in this pass, deliberately

- **Native raw-input capture as the live measurement transport.** Blocked on
  helper/renderer clock-origin alignment (§3). Tier selection and its tests are
  in place; the transport is not enabled.
- **The trAIMer game-profile campaign.** Out of scope, as instructed.
