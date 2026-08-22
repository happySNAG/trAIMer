# Capture architecture

## Ports

```
CaptureSource (interface, unchanged since Pass 1)
  ├── SyntheticExperimentRunner   (headless simulation)
  ├── PointerLockCaptureSource    (browser, Pass 2)
  └── future native source
        ↓ CaptureEvents (monotonic ms)
     TrialRecorder ──► TrialRecord (raw-first persistence)
```

A native high-frequency source can replace the browser source without any
change below the event boundary.

## Event vocabulary

`pointer-sample` (dx/dy at event time), `button`, `target-spawn`,
`target-remove`, `focus-change` (with reason string), plus Pass 2 additions:
`lock-change` (acquired / pointer-lock-loss / denied) and `resize`.

## PointerLockCaptureSource

- Wraps `requestPointerLock()` on the canvas; resolves a promise on
  `pointerlockchange`/`pointerlockerror`, with a hard timeout (default 5 s).
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
