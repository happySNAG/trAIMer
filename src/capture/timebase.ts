/**
 * ONE explicit model of time for every capture path.
 *
 * ------------------------------------------------------------------------
 * The bug this module exists to prevent
 * ------------------------------------------------------------------------
 *
 * Three different notions of "when" were being compared as if they were one:
 *
 *  1. OCCURRENCE time — when the input physically happened. In a browser this
 *     is `event.timeStamp`, which Chromium derives from the OS event time and
 *     expresses against the document's `performance.timeOrigin`.
 *  2. OBSERVATION time — `performance.now()` read inside a handler, or read by
 *     application code. Always LATER than the occurrence time of the event
 *     being handled, by the input-delivery lag.
 *  3. HELPER time — the native capture helper's `QueryPerformanceCounter`
 *     milliseconds since ITS OWN process start. A different origin entirely.
 *
 * (1) and (2) share a clock but not a sampling instant; (3) shares neither.
 *
 * rc.7 timestamped pointer samples with (1) and the trial's start with (2),
 * then asserted `sample.tMs >= trial.startedAtMonotonicMs`. Every drill that
 * began while the player's hand was still moving therefore received at least
 * one sample stamped a few milliseconds BEFORE the trial started, and the
 * validator failed the whole trial with IMPOSSIBLE_TIMESTAMPS. On real
 * Windows hardware that excluded 43 of 80 measured drills.
 *
 * Measured directly against Chromium (`.probe` harness, 20 synthetic drills
 * with a continuous 1 kHz pointer stream): 15 of 20 drills received at least
 * one sample whose `event.timeStamp` preceded the drill's `performance.now()`
 * start, the worst by 12.7 ms.
 *
 * ------------------------------------------------------------------------
 * The model
 * ------------------------------------------------------------------------
 *
 * Every capture source declares the DOMAIN its timestamps live in and the
 * maximum amount by which an event's timestamp may precede the moment the
 * application observes it (`leadToleranceMs`). Consumers may then compare
 * timestamps across a trial boundary honestly:
 *
 *     a sample is valid for a trial iff
 *         tMs >= trialStart - source.leadToleranceMs
 *
 * A stream whose timestamps are in a foreign domain produces leads of
 * seconds, not milliseconds, so a bounded tolerance still fails closed on a
 * genuine clock-domain error. Nothing is repaired, interpolated, or shifted:
 * the timestamps recorded are the ones the source reported.
 */

/** Which clock a capture source's timestamps are expressed against. */
export type CaptureTimestampDomain =
  /** The renderer's `performance.timeOrigin` (`performance.now()` domain). */
  | "renderer-monotonic"
  /** The native helper's own QueryPerformanceCounter origin. */
  | "helper-monotonic";

/**
 * How far a DOM event's `timeStamp` may precede the moment its handler runs.
 *
 * Chromium delivers coalesced pointer input aligned to the frame that
 * consumes it, so the lead is bounded by one frame plus main-thread
 * scheduling delay. 40 ms is two and a half frames at 60 Hz (eight at
 * 200 Hz) plus slack — comfortably above every lead measured in Chromium
 * (worst 12.7 ms under a deliberately backlogged input queue), and three
 * orders of magnitude below the lead a genuine clock-domain mix-up produces.
 *
 * A stream more than 40 ms stale is not evidence about the drill that is
 * running now, and trials carrying one are still excluded.
 */
export const DOM_CAPTURE_LEAD_TOLERANCE_MS = 40;

/**
 * Synthetic and replay sources timestamp events with the same clock the
 * caller uses to start a trial, so they get no tolerance at all: a sample
 * before the trial start really is impossible there.
 */
export const SYNTHETIC_CAPTURE_LEAD_TOLERANCE_MS = 0;

/**
 * The same bound for the native helper transport, after its timestamps have
 * been translated into the renderer clock.
 *
 * A native event is stamped inside the helper's WM_INPUT handler and reaches
 * the renderer over a loopback WebSocket, so its lead over the renderer's
 * observation clock is transport latency plus the renderer's own main-thread
 * scheduling delay — the same order as the DOM path, and dominated by the
 * same scheduler. Held equal deliberately: two different numbers here would
 * imply a precision difference the transport has not been shown to have.
 */
export const NATIVE_CAPTURE_LEAD_TOLERANCE_MS = DOM_CAPTURE_LEAD_TOLERANCE_MS;

/**
 * How far a timestamp may sit AHEAD of the observation clock before it is
 * treated as a domain error rather than clock granularity. Chromium reports
 * event times with the same resolution as `performance.now()`, so a genuine
 * event can read a few tens of microseconds ahead through rounding.
 */
const MAX_AHEAD_OF_NOW_MS = 1;

export interface DomTimestampStats {
  /** Timestamps normalized (all event kinds). */
  observed: number;
  /** Timestamps that were behind the observation clock (the normal case). */
  behind: number;
  /** Largest observed occurrence→observation lead, ms. */
  maxLeadMs: number;
  /** Sum of leads, for a mean. */
  totalLeadMs: number;
  /** Timestamps reading later than the observation clock beyond granularity. */
  aheadOfNow: number;
  /** Timestamps rejected as being in a foreign domain (epoch ms, etc). */
  foreignDomain: number;
  /** Timestamps that were absent or non-finite. */
  missing: number;
}

export function emptyDomTimestampStats(): DomTimestampStats {
  return {
    observed: 0,
    behind: 0,
    maxLeadMs: 0,
    totalLeadMs: 0,
    aheadOfNow: 0,
    foreignDomain: 0,
    missing: 0,
  };
}

export function meanLeadMs(stats: DomTimestampStats): number | null {
  return stats.behind > 0 ? stats.totalLeadMs / stats.behind : null;
}

/**
 * Turns a DOM event's `timeStamp` into a renderer-monotonic timestamp, and
 * records what it had to do to get there.
 *
 * Rules, in order:
 *
 *  - not a finite number → use the observation clock (`missing`);
 *  - further than `foreignDomainThresholdMs` from the observation clock in
 *    EITHER direction → the value is not in this document's time origin (old
 *    user agents reported epoch milliseconds). Use the observation clock and
 *    count it. Never guess an offset: a wrong guess is silent and unbounded;
 *  - ahead of the observation clock by more than clock granularity → clamp to
 *    the observation clock (an event cannot be observed before it happens);
 *  - otherwise → use it unchanged. THIS IS THE NORMAL PATH, and it is the
 *    reason the tolerance in {@link DOM_CAPTURE_LEAD_TOLERANCE_MS} exists.
 */
export class DomTimestampNormalizer {
  readonly #stats: DomTimestampStats = emptyDomTimestampStats();
  readonly #foreignThresholdMs: number;

  constructor(foreignDomainThresholdMs = 60_000) {
    this.#foreignThresholdMs = foreignDomainThresholdMs;
  }

  get stats(): Readonly<DomTimestampStats> {
    return { ...this.#stats };
  }

  /** @param nowMs the observation clock reading for this event. */
  normalize(rawTimeStamp: unknown, nowMs: number): number {
    this.#stats.observed++;
    if (typeof rawTimeStamp !== "number" || !Number.isFinite(rawTimeStamp)) {
      this.#stats.missing++;
      return nowMs;
    }
    const delta = nowMs - rawTimeStamp;
    if (Math.abs(delta) > this.#foreignThresholdMs) {
      this.#stats.foreignDomain++;
      return nowMs;
    }
    if (delta < -MAX_AHEAD_OF_NOW_MS) {
      this.#stats.aheadOfNow++;
      return nowMs;
    }
    if (delta > 0) {
      this.#stats.behind++;
      this.#stats.totalLeadMs += delta;
      if (delta > this.#stats.maxLeadMs) this.#stats.maxLeadMs = delta;
    }
    return rawTimeStamp;
  }
}

// ---------------------------------------------------------------------------
// Helper ↔ renderer clock synchronization
// ---------------------------------------------------------------------------

/**
 * One completed sync exchange.
 *
 * `t0` and `t2` are renderer-monotonic (`performance.now()`); `helperMs` is
 * the helper's own monotonic reading taken between them.
 */
export interface ClockSyncSample {
  t0: number;
  helperMs: number;
  t2: number;
}

export interface ClockSyncEstimate {
  /** helperMs + offsetMs ≈ rendererMs. */
  offsetMs: number;
  /** Half the round trip of the sample the estimate came from. */
  uncertaintyHalfWidthMs: number;
  /** Round-trip time of the chosen sample. */
  minRoundTripMs: number;
  samples: number;
  /**
   * Estimated relative rate error between the two clocks, parts per million,
   * from a least-squares fit over the retained samples. Null until at least
   * three samples spanning a usable interval exist.
   */
  driftPpm: number | null;
  /** Renderer time of the most recent exchange. */
  lastSyncedAtMs: number;
}

/**
 * Maximum half-round-trip uncertainty a sync estimate may carry and still be
 * trusted for measurement.
 *
 * The transport is a loopback WebSocket on the same machine; a healthy
 * exchange round-trips in well under a millisecond. 2 ms leaves room for a
 * busy machine while staying far below the smallest interval any measurement
 * resolves (reaction times are reported to the millisecond and compared in
 * tens of milliseconds).
 */
export const MAX_CLOCK_SYNC_UNCERTAINTY_MS = 2;

/** Minimum exchanges before an estimate is offered at all. */
export const MIN_CLOCK_SYNC_SAMPLES = 5;

/**
 * Estimates the offset between the helper's monotonic clock and the
 * renderer's, using Cristian's algorithm with minimum-round-trip selection.
 *
 * For one exchange (client sends at `t0`, helper reads its clock at `helperMs`
 * and replies, client receives at `t2`):
 *
 *     offset = helperMs - (t0 + (t2 - t0) / 2)      [helper → renderer: negate]
 *     |error| <= (t2 - t0) / 2
 *
 * The bound is exact: the helper's reading happened somewhere inside
 * [t0, t2], so the mid-point estimate cannot be wrong by more than half the
 * round trip, whatever the asymmetry. Taking the sample with the SMALLEST
 * round trip therefore takes the sample with the tightest proven bound —
 * which is why this is preferred to averaging, and why no arbitrary constant
 * offset appears anywhere in this file.
 *
 * Drift is estimated separately by regressing (rendererMid - helperMs) on
 * rendererMid across retained samples. It is REPORTED, never applied: two
 * QueryPerformanceCounter-class clocks on one machine share a hardware time
 * source, and a correction fitted over a few seconds would add more noise
 * than it removes. A drift estimate that grows beyond the sync uncertainty is
 * a diagnostic that something is wrong, not a number to compensate with.
 */
export class HelperClockSync {
  readonly #samples: ClockSyncSample[] = [];
  readonly #maxSamples: number;
  #best: ClockSyncSample | null = null;

  constructor(maxSamples = 32) {
    this.#maxSamples = Math.max(4, maxSamples);
  }

  get sampleCount(): number {
    return this.#samples.length;
  }

  /** Records one completed exchange. Rejects impossible orderings. */
  addSample(sample: ClockSyncSample): boolean {
    if (
      !Number.isFinite(sample.t0) ||
      !Number.isFinite(sample.t2) ||
      !Number.isFinite(sample.helperMs) ||
      sample.t2 < sample.t0
    ) {
      return false;
    }
    this.#samples.push(sample);
    if (this.#samples.length > this.#maxSamples) this.#samples.shift();
    const rtt = sample.t2 - sample.t0;
    if (this.#best === null || rtt < this.#best.t2 - this.#best.t0) {
      this.#best = sample;
    } else if (!this.#samples.includes(this.#best)) {
      // The retained window rolled past the best sample; re-select.
      this.#best = null;
      for (const s of this.#samples) {
        if (this.#best === null || s.t2 - s.t0 < this.#best.t2 - this.#best.t0) {
          this.#best = s;
        }
      }
    }
    return true;
  }

  /** Null until {@link MIN_CLOCK_SYNC_SAMPLES} exchanges have completed. */
  estimate(): ClockSyncEstimate | null {
    const best = this.#best;
    if (best === null || this.#samples.length < MIN_CLOCK_SYNC_SAMPLES) return null;
    const rtt = best.t2 - best.t0;
    const rendererMid = best.t0 + rtt / 2;
    const last = this.#samples[this.#samples.length - 1]!;
    return {
      offsetMs: rendererMid - best.helperMs,
      uncertaintyHalfWidthMs: rtt / 2,
      minRoundTripMs: rtt,
      samples: this.#samples.length,
      driftPpm: this.#driftPpm(),
      lastSyncedAtMs: last.t2,
    };
  }

  /** True when an estimate exists and its proven bound is tight enough. */
  isTrustworthy(
    maxUncertaintyMs: number = MAX_CLOCK_SYNC_UNCERTAINTY_MS,
  ): boolean {
    const est = this.estimate();
    return est !== null && est.uncertaintyHalfWidthMs <= maxUncertaintyMs;
  }

  /** helperMs → renderer-monotonic ms. Throws when no estimate exists. */
  toRendererMs(helperMs: number, estimate?: ClockSyncEstimate | null): number {
    const est = estimate ?? this.estimate();
    if (est === null) {
      throw new Error("clock sync not established; refusing to translate");
    }
    return helperMs + est.offsetMs;
  }

  #driftPpm(): number | null {
    if (this.#samples.length < 3) return null;
    const points = this.#samples.map((s) => {
      const mid = s.t0 + (s.t2 - s.t0) / 2;
      return { x: mid, y: mid - s.helperMs };
    });
    const n = points.length;
    const meanX = points.reduce((a, p) => a + p.x, 0) / n;
    const meanY = points.reduce((a, p) => a + p.y, 0) / n;
    let sxx = 0;
    let sxy = 0;
    for (const p of points) {
      sxx += (p.x - meanX) ** 2;
      sxy += (p.x - meanX) * (p.y - meanY);
    }
    // Need a real time span; a burst inside one millisecond says nothing.
    if (sxx < 1) return null;
    return (sxy / sxx) * 1e6;
  }
}

/** Machine-readable sync state for Diagnostics and the results instrumentation. */
export interface ClockSyncStatus {
  state: "not-attempted" | "syncing" | "established" | "untrusted" | "failed";
  detail: string;
  estimate: ClockSyncEstimate | null;
  maxUncertaintyMs: number;
}

export function describeClockSync(
  sync: HelperClockSync | null,
  state: ClockSyncStatus["state"],
  detail: string,
  maxUncertaintyMs: number = MAX_CLOCK_SYNC_UNCERTAINTY_MS,
): ClockSyncStatus {
  return {
    state,
    detail,
    estimate: sync?.estimate() ?? null,
    maxUncertaintyMs,
  };
}
