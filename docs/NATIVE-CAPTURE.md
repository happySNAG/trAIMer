# Native high-frequency capture

Windows is the primary platform. The helper is an
independent, local-only mouse telemetry reader — it never injects into,
reads, or communicates with any game or anti-cheat system.

## Architecture

```
[traimer_capture_helper.exe]  ← Raw Input (WM_INPUT), QPC timestamps
        │  loopback WebSocket (127.0.0.1 only), versioned handshake
        ▼
NativeTransportCaptureSource (src/capture/nativeClient.ts)
        ↓ CaptureEvents (identical vocabulary to browser capture)
TrialRecorder → validation → metrics → optimizer   (unchanged pipeline)
```

## Wire protocol (v1)

- client → helper: `{"type":"hello","protocolVersion":1,"sessionToken":T,"appVersion":V}`
- client → helper: `{"type":"time-sync","id":"N"}`
- helper → client: `{"type":"time-sync-reply","id":"N","helperMonotonicMs":T}`
- helper → client: `welcome` (protocolVersion, deviceId/description,
  nominalRateHz, timeOriginNote, helperVersion) **or** `reject{reason}`
- helper → client: frames
  `{"type":"frame","sequence":Q,"tMonotonicMs":t,"events":[...]}`
  plus `lifecycle{phase}` and `ping`
- Fail-closed rules: malformed JSON/events/timestamps, duplicate or
  non-monotonic sequences, protocol mismatch → the stream aborts loudly.
  No fabricated or interpolated samples ever enter the recorder.

## Guarantees

| Requirement | Mechanism |
| --- | --- |
| physical raw counts | RAWMOUSE lLastX/lLastY (relative devices only; absolute skipped) |
| 125/250/500/1000 Hz | event-driven WM_INPUT — delivers whatever the hardware/OS deliver |
| monotonic timestamps | QueryPerformanceCounter, ms since helper start — **translated into the renderer clock before any event is emitted** (see [CLOCK-DOMAINS.md](CLOCK-DOMAINS.md)) |
| sequence numbers | per-connection epoch, continuity checked client-side |
| buttons | RI_MOUSE_BUTTON_1/2/3 down/up mapped to press/release |
| device metadata | GetRawInputDeviceInfo (interface path → stable hashed id) |
| drops | missing-sequence accounting + `analyzeNativeStream` verdicts |
| reconnects | helper stays resident; client exponential backoff; epoch resets on welcome |
| cross-talk protection | one accepted sessionToken at a time; second client rejected |

## Why live sessions still measure through Pointer Lock (Pass 10)

The run screen reports `browser capture · pointer lock` on a Windows machine
whose helper is `ready`. That is accurate, and it is not the whole story:

- the live run path builds a `PointerLockCaptureSource` directly; the
  negotiator and `NativeTransportCaptureSource` are wired to the Diagnostics
  probe only, so tier 1 was never even evaluated for a session;
- `app/src/captureTiers.ts` now evaluates it for real and prints the reason
  tier 1 is not carrying the session (no shell / unsupported platform / helper
  not ready / helper unvalidated / clock origins unaligned);
- the remaining blocker is **clock-origin alignment**. The helper timestamps
  frames in milliseconds since its own start (QueryPerformanceCounter origin);
  the recorder compares sample times against target spawn times taken from the
  renderer's `performance.now()` origin. Feeding one clock's samples into the
  other's timeline shifts every reaction time by an unknown constant, silently.
  Aligning the origins is a measurement change, not a UI change.

Even once native frames carry the samples, Pointer Lock stays mandatory: the
helper reads Raw Input globally, so without a lock the OS cursor would leave
the arena and click other windows.

## Diagnostics mode

Diagnostics tab → "Run native capture probe". Reports requested vs observed
rate, throughput, p10/p50/p90 intervals, jitter CV, dropped/duplicate
sequences, non-monotonic timestamps, burst/coalescing counts, click/delta
ordering, reconnects, longest gap, duration tested — each with
pass/warn/fail. Fixture-based regression tests cover 125/250/500/1000 Hz,
jittery 1000 Hz, dropped 1000 Hz, bursty streams
(`tests/nativeDiagnosticsFixtures.test.ts`).

## macOS status (deferred, architecture ready)

The transport (`nativeClient.ts`) and negotiation tiers are OS-neutral. A
macOS helper would implement the identical protocol over IOKit HID reads of
attached pointing devices (legitimate documented API; no event synthesis,
no injection). Missing work: helper binary + entitlements for HID monitoring,
device metadata mapping, packaging (launchd agent or manual run), fixture
capture on real Apple hardware for latency parity tests.

## Building / running (Windows)

See `native/windows/BUILD.md`. Short form:

```bat
cl /O2 /W4 traimer_capture_helper.c /Fe:traimer_capture_helper.exe ws2_32.lib user32.lib
traimer_capture_helper.exe --port 48765 --token <secret>
```

Then open Aim Lab → Diagnostics → Run native capture probe with the same
token. Negotiation (`src/capture/negotiation.ts`) selects the helper ONLY
after a diagnostics run has validated it; otherwise the browser coalesced
path remains active and the downgrade is explicit in the UI.
