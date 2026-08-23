import type { NativeFrame } from "../capture/native.ts";
import { median, percentile } from "../metrics/stats.ts";

/**
 * Native capture diagnostic mode (Pass 4, requirement C).
 *
 * Analyzes a recorded native stream (live counters or a fixture) and reports
 * requested vs observed polling rate, interval distribution, jitter, sequence
 * integrity, burst/coalescing behavior, and click/delta ordering — with an
 * explicit pass/warn/fail verdict per check.
 */

export interface NativeStreamDiagnostics {
  requestedRateHz: number | null;
  /** Median-interval rate — robust to sparse drops. */
  observedRateHz: number;
  /** Actual delivered throughput: frames per second over the whole run. */
  throughputRateHz: number;
  observedRateP10Hz: number;
  observedRateP90Hz: number;
  intervalP10Ms: number | null;
  intervalP50Ms: number | null;
  intervalP90Ms: number | null;
  jitterCv: number | null;
  droppedSequences: number;
  duplicateSequences: number;
  nonMonotonicTimestamps: number;
  bursts: { count: number; maxCoalescedEventsPerFrame: number };
  clickAfterDeltaOrderedCorrectly: boolean;
  reconnectEvents: number;
  longestGapMs: number;
  durationTestedMs: number;
  frameCount: number;
  eventCount: number;
  checks: NativeDiagnosticCheck[];
  verdict: "pass" | "warn" | "fail";
}

export interface NativeDiagnosticCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface NativeDiagnosticsOptions {
  /** Tolerance around the nominal interval before jitter warns. */
  maxJitterCv?: number;
  maxDropFraction?: number;
  warnRateDeviationFraction?: number;
}

const DEFAULTS = {
  maxJitterCv: 0.6,
  maxDropFraction: 0.01,
  warnRateDeviationFraction: 0.15,
} as const;

export function analyzeNativeStream(
  frames: readonly NativeFrame[],
  options: {
    requestedRateHz?: number | null;
    reconnectEvents?: number;
    thresholds?: NativeDiagnosticsOptions;
  } = {},
): NativeStreamDiagnostics {
  const t = { ...DEFAULTS, ...options.thresholds };
  const checks: NativeDiagnosticCheck[] = [];

  // --- intervals ---
  const intervals: number[] = [];
  let nonMonotonic = 0;
  let longestGapMs = 0;
  for (let i = 1; i < frames.length; i++) {
    const dt = frames[i]!.tMonotonicMs - frames[i - 1]!.tMonotonicMs;
    if (dt < 0) nonMonotonic++;
    else {
      intervals.push(dt);
      if (dt > longestGapMs) longestGapMs = dt;
    }
  }
  const medianInterval = intervals.length > 0 ? median(intervals) : Number.NaN;
  const p10 = intervals.length > 0 ? percentile(intervals, 10) : Number.NaN;
  const p50 = medianInterval;
  const p90 = intervals.length > 0 ? percentile(intervals, 90) : Number.NaN;
  const mean =
    intervals.length > 0
      ? intervals.reduce((a, b) => a + b, 0) / intervals.length
      : Number.NaN;
  let jitterCv: number | null = null;
  if (intervals.length >= 5 && mean > 0) {
    const variance =
      intervals.reduce((acc, v) => acc + (v - mean) ** 2, 0) / intervals.length;
    jitterCv = Math.sqrt(variance) / mean;
  }

  const durationTestedMs =
    frames.length >= 2
      ? frames[frames.length - 1]!.tMonotonicMs - frames[0]!.tMonotonicMs
      : 0;
  const observedRateHz =
    Number.isFinite(p50) && p50 > 0 ? 1000 / p50 : 0;
  const observedRateP10Hz = Number.isFinite(p90) && p90 > 0 ? 1000 / p90 : 0;
  const observedRateP90Hz = Number.isFinite(p10) && p10 > 0 ? 1000 / p10 : 0;

  // --- sequence integrity ---
  let dropped = 0;
  let duplicates = 0;
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1]!.sequence;
    const cur = frames[i]!.sequence;
    if (cur === prev) duplicates++;
    else if (cur > prev + 1) dropped += cur - prev - 1;
    else if (cur < prev) {
      // Out-of-order delivery counts as both a drop indicator and instability.
      dropped += 1;
    }
  }
  const totalExpected = Math.max(dropped + frames.length, 1);
  const dropFraction = dropped / totalExpected;

  // --- burst / coalescing ---
  let burstFrames = 0;
  let maxCoalesced = 0;
  for (const frame of frames) {
    if (frame.events.length > 1) burstFrames++;
    maxCoalesced = Math.max(maxCoalesced, frame.events.length);
  }

  // --- click ordering: every button press must follow at least one delta ---
  let clickOrderingOk = true;
  let sawDeltaSinceLastClick = false;
  outer: for (const frame of frames) {
    for (const ev of frame.events as { kind?: string }[]) {
      if (ev.kind === "pointer-sample") sawDeltaSinceLastClick = true;
      else if (ev.kind === "button" && (ev as { action?: string }).action === "press") {
        if (!sawDeltaSinceLastClick && clickOrderingOk === true) {
          clickOrderingOk = false;
          break outer;
        }
        sawDeltaSinceLastClick = false;
      }
    }
  }

  // --- verdicts ---
  const requestedRateHz = options.requestedRateHz ?? null;
  if (requestedRateHz !== null) {
    const deviation = Math.abs(observedRateHz - requestedRateHz) / requestedRateHz;
    if (deviation <= t.warnRateDeviationFraction) {
      checks.push({
        name: "effective-rate",
        status: "pass",
        detail: `observed ${observedRateHz.toFixed(0)} Hz vs requested ${requestedRateHz} Hz`,
      });
    } else {
      checks.push({
        name: "effective-rate",
        status: dropped > 0 || dropFraction > t.maxDropFraction ? "warn" : "warn",
        detail: `observed ${observedRateHz.toFixed(0)} Hz deviates ${(deviation * 100).toFixed(0)}% from requested ${requestedRateHz} Hz`,
      });
    }
  } else {
    checks.push({
      name: "effective-rate",
      status: observedRateHz > 0 ? "pass" : "fail",
      detail: `no nominal rate supplied; observed ${observedRateHz.toFixed(0)} Hz`,
    });
  }

  if (jitterCv !== null) {
    checks.push({
      name: "timing-jitter",
      status:
        jitterCv <= t.maxJitterCv
          ? "pass"
          : jitterCv <= t.maxJitterCv * 2
            ? "warn"
            : "fail",
      detail: `inter-event interval CV ${jitterCv.toFixed(3)} (limit ${t.maxJitterCv})`,
    });
  } else {
    checks.push({ name: "timing-jitter", status: "fail", detail: "not enough intervals" });
  }

  checks.push({
    name: "sequence-integrity",
    status: dropped === 0 && duplicates === 0 && nonMonotonic === 0
      ? "pass"
      : dropFraction <= t.maxDropFraction
        ? "warn"
        : "fail",
    detail: `${dropped} missing / ${duplicates} duplicate / ${nonMonotonic} non-monotonic over ${frames.length} frames`,
  });

  checks.push({
    name: "burst-behavior",
    status: burstFrames === 0 ? "pass" : burstFrames / Math.max(frames.length, 1) < 0.2 ? "warn" : "fail",
    detail:
      burstFrames === 0
        ? "no coalesced/bursty frames"
        : `${burstFrames} frame(s) carried multiple events (max ${maxCoalesced})`,
  });

  checks.push({
    name: "click-ordering",
    status: clickOrderingOk ? "pass" : "warn",
    detail: clickOrderingOk
      ? "clicks consistently ordered after motion deltas"
      : "click(s) observed without preceding motion delta",
  });

  checks.push({
    name: "stream-stability",
    status:
      nonMonotonic === 0 &&
      longestGapMs < 250 &&
      (options.reconnectEvents ?? 0) === 0
        ? "pass"
        : nonMonotonic > 0 || longestGapMs >= 1500 || (options.reconnectEvents ?? 0) > 5
          ? "fail"
          : "warn",
    detail: `longest gap ${longestGapMs.toFixed(1)} ms, ${options.reconnectEvents ?? 0} reconnect(s), ${nonMonotonic} timestamp regressions`,
  });

  const verdict: NativeStreamDiagnostics["verdict"] = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "warn")
      ? "warn"
      : "pass";

  return {
    requestedRateHz,
    observedRateHz,
    throughputRateHz:
      durationTestedMs > 0 ? ((frames.length - 1) * 1000) / durationTestedMs : 0,
    observedRateP10Hz,
    observedRateP90Hz,
    intervalP10Ms: Number.isFinite(p10) ? p10 : null,
    intervalP50Ms: Number.isFinite(p50) ? p50 : null,
    intervalP90Ms: Number.isFinite(p90) ? p90 : null,
    jitterCv,
    droppedSequences: dropped,
    duplicateSequences: duplicates,
    nonMonotonicTimestamps: nonMonotonic,
    bursts: { count: burstFrames, maxCoalescedEventsPerFrame: maxCoalesced },
    clickAfterDeltaOrderedCorrectly: clickOrderingOk,
    reconnectEvents: options.reconnectEvents ?? 0,
    longestGapMs,
    durationTestedMs,
    frameCount: frames.length,
    eventCount: frames.reduce((a, f) => a + f.events.length, 0),
    checks,
    verdict,
  };
}
