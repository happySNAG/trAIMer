# Capture architecture

## Ports

```
CaptureSource (interface, unchanged since Pass 1)
  ├── SyntheticExperimentRunner   (headless simulation)
  ├── PointerLockCaptureSource    (browser, Pass 2; coalesced events Pass 3)
  └── NativeTransportCaptureSource (Pass 4: loopback helper, docs/NATIVE-CAPTURE.md)
        ↓ negotiated by CaptureSourceNegotiator (Pass 4)
        ↓ CaptureEvents (monotonic ms)
     TrialRecorder ──► TrialRecord (raw-first persistence)
```

## Capture-source negotiation (Pass 4)

Priority: **1. validated native high-rate → 2. browser coalesced pointer
events → 3. basic mouse events.** Rules enforced in
`src/capture/negotiation.ts`, never in UI code:

- tier-1 requires a PASSING diagnostics run (`analyzeNativeStream`); an
  unvalidated helper is rejected with a reason — never trusted implicitly,
- tier-1 additionally requires that the helper's clock was SYNCHRONIZED with
  the renderer's during that run. The helper counts milliseconds from its own
  process start, so an untranslated helper timestamp cannot be placed on the
  same timeline as the drills at all — see [CLOCK-DOMAINS.md](CLOCK-DOMAINS.md),
- the active source and every transition are recorded
  (`negotiator.transitions`) and persisted on checkpoints/sessions,
- a native disconnect DURING a measured trial emits a structured
  `focus-change{reason:"native-disconnect"}` that invalidates that trial;
  fallback happens only BETWEEN trials,
- mid-trial source mixing without invalidation throws.

## Capture-entry contract (Pass 10)

The session must never be able to sit in a state the player cannot leave:

- a failed or unavailable Pointer Lock aborts the run with a named reason,
  which is written to the audit trail (`capture-unavailable`), the checkpoint
  phase log, and an on-arena diagnostic offering "Try again" / "Back to setup";
- **End session works in every state**, including before the runner exists;
- Pause while capture is being requested withdraws the request rather than
  waiting for a trial boundary that will never arrive;
- Esc cancels a pending request, and (via Chromium's own unlock) ends a running
  session; losing the lock BETWEEN trials also ends the session honestly rather
  than continuing with no capture;
- the arena overlay is `pointer-events: none` — it is information, never a
  shield — and the start click listens on the stage so it is seen wherever in
  the arena it lands;
- the run screen reports the capture path actually in use
  (`app/src/captureTiers.ts`), including why native high-rate capture is not
  carrying the session.

Gates: `tests/captureEntry.test.ts`, `tests/browser/captureEntry.spec.ts`,
`tests/uiContract.test.ts`, and `scripts/verify-arena-entry.mjs` (which drives
the real Electron shell, and the installed application in CI).

## Session capture quality (Pass 4; wired live in Pass 14)

Per-trial `computeInputQuality` reports remain, but confidence gating now
uses the robust SESSION summary (`src/diagnostics/captureQuality.ts`): median
per-trial scores, drop fraction, lock/resize totals, degradation over time,
trial consistency, capture-source transitions, fraction of high-quality
trials. See `docs/OPTIMIZER.md`; one bad trial cannot sink a clean session.

Until Pass 14 nothing in the live path ever CALLED it. `SessionRunner` built
its optimizer without a `captureQualitySession`, so every real session reached
the results page reporting *"Capture quality: not graded for this session — run
the capture check in Diagnostics before your next test"* — advice for a session
that had already happened — and the optimizer's capture-quality confidence cap
was permanently disarmed. The runner now grades the session from its own
recorded stream before analysis, so the grade is a property of the drills that
were actually played.

## Telling the player BEFORE the session (Pass 14)

The setup screen reports the capture path a calibration started now would be
measured on, and what that costs: a lower-rate stream gives coarser aim paths,
so the plausible range around the recommendation comes out wider. It is **not**
a gate — a calibration on browser capture is a real calibration — and the
capture check is offered only when running it could actually change the tier,
so a machine with no helper is never sent to Diagnostics for nothing.

## Event vocabulary

Unchanged since Pass 2 plus the transport-level lifecycle handled inside the
native client (never synthesized into recorded streams).

## PointerLockCaptureSource

- Wraps `requestPointerLock()` on the canvas. **`pointerlockchange` and
  `pointerlockerror` are listened for on the DOCUMENT**, which is where the
  Pointer Lock spec dispatches them — binding them to the canvas (as rc.3 did)
  means they never fire and every request times out. Chromium ≥ 111 also
  returns a Promise from `requestPointerLock()`; it is awaited for the refusal
  reason and always handled, so a denial never surfaces as an unhandled
  rejection.
- `requestLock()` returns a STRUCTURED `LockOutcome`
  (`acquired` | `denied` | `timeout` | `cancelled` | `unsupported` |
  `source-stopped` | `released-before-start`), never a bare boolean, so the
  runner can abort with a diagnostic and the UI can explain it. A hard timeout
  (default 5 s) bounds every request.
- `requestLock()` must be called SYNCHRONOUSLY from a user gesture: Chromium
  requires user activation for a document's first lock. The arena click issues
  it before any `await`, and the session runner's execution gate joins the same
  in-flight request rather than issuing a second, gesture-less one.
- `abortPendingLock()` settles a pending request immediately (Esc, Pause, End
  session) so a cancellation never waits out the timeout.
- `mousemove` handlers read `movementX/movementY`; events are timestamped with
  `performance.now()` **at handler time**, never frame time.
- Button 0 down/up become press/release events; other buttons ignored;
  context menu suppressed while locked.
- Lock loss mid-trial → `lock-change{locked:false, reason:"pointer-lock-loss"}`
  which the recorder converts into a focus interruption; validation marks the
  trial `POINTER_LOCK_LOSS` (fatal). The session runner then aborts rather
  than silently continuing.
- Window blur → `window-blur`; tab hidden → `tab-hidden` (fatal); visible /
  focused again emit matching restore events.
- Window resize → `resize` events carrying current viewport; validation flags
  `RESIZE_DURING_TRIAL` when area changes >10 % mid-trial.

## VirtualReticle

Pointer Lock suppresses the OS cursor; the runtime owns a virtual reticle:

- starts centered each trial,
- integrates raw deltas,
- clamps to viewport bounds and emits only the **applied** delta downstream so
  the recorder's integrated cursor position always equals the rendered reticle
  position (raw cumulative input is kept separately for diagnostics),
- is reset between trials.

Three quantities stay distinct everywhere: raw mouse delta, virtual reticle
position, target position.

## Browser sampling reality

Browsers coalesce pointer events to frame rate (~60–125 Hz) and deliver no
events while the mouse is still. Consequences handled explicitly:

- `expectedSampleIntervalMs` is `null` for this source; gap validation uses
  motion-aware semantics — silence adjacent to stillness is human reaction
  time, not failure (`docs/METRICS.md`); only stalls *during* continuous
  movement or extreme silent gaps are fatal.
- Inter-sample velocity bounds remain generous hardware-glitch guards, not
  physiological claims.
