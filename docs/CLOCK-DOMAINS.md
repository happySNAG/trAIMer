# Clock domains

> Every timestamp in trAIMer belongs to exactly one clock, and the module that
> produces it says which. This document is the contract.

## Why this document exists

A completed real-hardware session on `1.0.0-rc.7` produced **80 measured
drills, 37 usable, 43 thrown away** as `IMPOSSIBLE_TIMESTAMPS` — surfaced to
the player as *"Broken timestamps"*.

Nothing was broken. Three different notions of "when" were being compared as
if they were one:

| # | Notion | Where it came from in rc.7 |
| --- | --- | --- |
| 1 | **Occurrence** — when the input physically happened | `event.timeStamp` on a pointer sample |
| 2 | **Observation** — when application code read the clock | `performance.now()` for a trial's start, a button press, a lock change |
| 3 | **Helper** — ms since the capture helper's own process start | `QueryPerformanceCounter` in `traimer_capture_helper.exe` |

(1) and (2) share a clock but not a sampling instant. (3) shares neither.

rc.7 stamped pointer samples with (1) and a trial's start with (2), then
asserted `sample.tMs >= trial.startedAtMonotonicMs`. Chromium delivers
coalesced pointer input aligned to the frame that consumes it, so the first
batch after a drill begins legitimately carries samples from a few
milliseconds earlier. Every drill that began while the player's hand was still
moving therefore failed.

Measured directly against Chromium: **15 of 20** synthetic drills with a
continuous 1 kHz pointer stream received at least one sample whose
`event.timeStamp` preceded the drill's `performance.now()` start; the worst
lead was **12.7 ms**.

## The model

### One timeline per session: the renderer's `performance.timeOrigin`

Everything that reaches a `TrialRecord` — pointer samples, button presses,
target spawns, lock and focus changes, trial start and end — is expressed
against the renderer's monotonic clock. Nothing downstream ever sees another
domain.

### Sources declare their domain and their lead

`CaptureSource.descriptor` carries:

- `timestampDomain: "renderer-monotonic"` — the domain of every event emitted;
- `leadToleranceMs` — how far an emitted event's timestamp may precede the
  moment the application observes it.

| Source | Domain | Lead tolerance | Why |
| --- | --- | --- | --- |
| `PointerLockCaptureSource` | renderer-monotonic | `DOM_CAPTURE_LEAD_TOLERANCE_MS` = **40 ms** | occurrence time, delivered on the consuming frame |
| `NativeTransportCaptureSource` | renderer-monotonic *(after translation)* | `NATIVE_CAPTURE_LEAD_TOLERANCE_MS` = **40 ms** | loopback transport plus the renderer's own main-thread scheduling |
| synthetic / replay | renderer-monotonic | **0 ms** | stamped with the same clock reading the caller uses to start a trial |

40 ms is two and a half frames at 60 Hz (eight at 200 Hz) plus scheduling
slack — comfortably above every lead measured in Chromium, and three orders of
magnitude below the lead a genuine clock-domain mix-up produces.

### The validator uses the source's declared lead, and caps it

`TrialRecord.captureContext.timestampLeadToleranceMs` records the source's
tolerance **in the trial**, so validation is reproducible from stored data:

```
a sample is valid for a trial iff
    tMs >= trial.startedAtMonotonicMs - leadToleranceMs
```

- The field is **optional**. Absent — every record written by rc.7 and
  earlier — is read as `0`, the historical rule, so a stored session is
  validated exactly as it was when it was recorded.
- `ValidationConfig.maxTimestampLeadToleranceMs` caps what a source may claim,
  so no future source can widen the rule by declaring its way out of it.
- A helper-domain timestamp fed into a renderer-domain trial produces a lead
  of **seconds**. It is still excluded, and the failure detail now names the
  lead and the tolerance it broke.

### Occurrence time everywhere it exists

rc.7 stamped pointer samples with occurrence time but buttons, lock changes,
focus changes and resizes with observation time. Mixing two sampling instants
of one clock is the same class of error as mixing two clocks: it put every
shot one input-delivery lag (up to 12.7 ms) later than the motion stream it is
compared against, inflating acquisition times and shifting hit detection on
moving targets to where the target was *after* the click.

`DomTimestampNormalizer` (`src/capture/timebase.ts`) now turns every DOM
`event.timeStamp` into a renderer-monotonic timestamp, and records what it had
to do:

| Input | Result | Counted as |
| --- | --- | --- |
| finite, behind the observation clock | used unchanged (**the normal path**) | `behind`, with the lead |
| non-finite or absent | observation clock | `missing` |
| further than 60 s from the observation clock in either direction | observation clock | `foreignDomain` |
| ahead of the observation clock by > 1 ms | observation clock | `aheadOfNow` |

No offset is ever *guessed*: a wrong guess is silent and unbounded. The
observed lead distribution is surfaced in Advanced results and in the session
instrumentation, so the tolerance above is checked against the machine rather
than assumed.

## Helper ↔ renderer synchronization

The helper counts milliseconds from **its own process start**. That origin is
unrelated to the renderer's, so an untranslated helper timestamp is off by an
unknown constant — silently, and in a direction nothing downstream could
detect.

### Protocol

```
client → helper : {"type":"time-sync","id":"N"}
helper → client : {"type":"time-sync-reply","id":"N","helperMonotonicMs":T}
```

The helper reads QPC as late as possible and sends the reply immediately, with
no formatting work in between: everything between the client's two clock
readings widens the bound the client can prove.

### Estimator — Cristian's algorithm, minimum round trip

For one exchange (client sends at `t0`, helper reads its clock at `helperMs`,
client receives at `t2`):

```
offset = (t0 + (t2 - t0) / 2) - helperMs        [helper → renderer]
|error| <= (t2 - t0) / 2
```

The bound is **exact**: the helper's reading happened somewhere inside
`[t0, t2]`, so the mid-point estimate cannot be wrong by more than half the
round trip, whatever the asymmetry between the legs. The estimate is therefore
taken from the exchange with the **smallest** round trip — the tightest proven
bound — rather than from an average, and no arbitrary constant offset appears
anywhere.

### Rules

| Rule | Mechanism |
| --- | --- |
| no event is emitted before the offset exists | frames received during synchronization are held in a bounded buffer (2000 events) and flushed, translated, on establishment |
| the offset is **frozen** for the stream epoch | translation is then a single affine map, so a later estimate can never reorder two already-emitted events |
| monotonic ordering is preserved | guaranteed by construction from the frozen affine map |
| a loose bound is refused | `MAX_CLOCK_SYNC_UNCERTAINTY_MS` = **2 ms**; beyond it the stream fails rather than measuring |
| drift is measured, never applied | least-squares slope over retained exchanges, reported in ppm. Two QPC-class clocks on one machine share a hardware time source; a correction fitted over seconds would add more noise than it removes |
| divergence fails closed | if a later exchange proves an offset outside both bounds plus the tolerance, the epoch is aborted |
| a reconnect starts a new epoch | sequence continuity, frame timing and the offset all reset; an offset is never carried across a connection it was not measured for |
| an old helper is refused | `EXPECTED_HELPER_VERSION` is pinned; a helper that cannot answer `time-sync` never streams |

### Sequential, never bursted

Probes run as a chain — one exchange, then the next — so each measures a quiet
round trip. A burst would queue and inflate every round trip after the first.
`syncProbeCount` defaults to 8; `MIN_CLOCK_SYNC_SAMPLES` (5) is the floor
below which no estimate is offered at all.

## Is native Raw Input trustworthy for scoring?

**Its timestamps are.** The clock-domain blocker is gone: the offset is
measured with a proven bound, translation is affine and order-preserving, and
the capture check refuses to validate a native stream whose clock was never
synchronized (`clock-sync` check in `analyzeCaptureSelfTest`).

**It is not yet the live measurement transport.** The remaining blocker is
integration, not correctness: the arena's capture source owns Pointer Lock,
window focus and the virtual reticle every drill is drawn against, so running
native motion through it means suppressing the browser's own `pointermove` for
the same physical movement. A single missed suppression applies every mouse
movement twice and silently doubles the sensitivity the player is measured at.
That composite has never run on real hardware.

`decideCaptureTier` therefore reports tier 2/3 with the exact reason, and the
evidence is labelled honestly rather than as tier 1. See
`NATIVE_LIVE_BLOCKER` in `app/src/captureTiers.ts`.

## Where this is enforced

| File | Holds |
| --- | --- |
| `src/capture/timebase.ts` | the domains, the tolerances, the normalizer, `HelperClockSync` |
| `src/capture/browserSource.ts` | occurrence time for every DOM event; the declared descriptor |
| `src/capture/nativeClient.ts` | the sync chain, the buffer, the freeze, divergence detection |
| `native/windows/traimer_capture_helper.c` | `time-sync` reply, QPC read taken last |
| `src/validation/validateTrial.ts` | the per-trial rule and its cap |
| `src/diagnostics/captureSelfTest.ts` | the `clock-sync` check |
| `tests/clockSync.test.ts` | offset recovery, bounds, asymmetry, drift, ordering, fail-closed |
| `tests/timestampDomain.test.ts` | the rc.7 exclusion regression, both directions |
