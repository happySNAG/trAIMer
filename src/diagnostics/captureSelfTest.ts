import type { CaptureEvent } from "../capture/events.ts";
import type { ClockSyncStatus } from "../capture/timebase.ts";
import { median, percentile } from "../metrics/stats.ts";

/**
 * Guided capture self-test (Pass 5, requirement F).
 *
 * Before an experiment, the player is asked to move the mouse and click for a
 * few seconds. The recorded event stream — from ANY capture source (native
 * helper or browser pointer lock) — is analyzed here:
 *
 *   - effective event rate (median-interval AND active-motion rate),
 *   - timing stability (interval CV),
 *   - dropped / duplicate / non-monotonic sequences,
 *   - clicks registered,
 *   - movement volume,
 *   - reconnect behavior,
 *   - source identity.
 *
 * HONESTY RULE: a device advertising "1000 Hz" is NOT validated at 1000 Hz
 * merely because the descriptor says so. The verdict comes from OBSERVED
 * data; when the claimed nominal rate is not demonstrated, the result says so
 * explicitly and native capture stays unvalidated.
 */

export interface CaptureSelfTestMeta {
  startedAtIso: string;
  endedAtIso: string;
  durationMs: number;
  sourceKind: string;
  deviceId: string | null;
  deviceDescription: string | null;
  /** Nominal rate CLAIMED by the device/helper welcome, if any. */
  nominalRateHz: number | null;
  /**
   * Where helper↔renderer clock synchronization stood during the test.
   *
   * Native capture cannot carry measurement without it: the helper counts
   * milliseconds from its own process start, and an untranslated helper
   * timestamp compared against a renderer timestamp is off by an unknown
   * constant. Absent for browser capture (already in the renderer clock) and
   * for results recorded before the sync protocol existed.
   */
  clockSync?: ClockSyncStatus | null;
  /** Sequence counters from the transport layer, when native. */
  transportCounters?: {
    framesReceived: number;
    duplicateSequences: number;
    missingSequences: number;
    nonMonotonicTimestamps: number;
    reconnects: number;
  };
}

export interface CaptureSelfTestCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface CaptureSelfTestResult extends CaptureSelfTestMeta {
  kind: "capture-self-test";
  schemaVersion: 1;
  appVersion: string;
  engineVersion: string;

  observedRateHz: number | null;
  activeMotionRateHz: number | null;
  intervalP10Ms: number | null;
  intervalP50Ms: number | null;
  intervalP90Ms: number | null;
  jitterCv: number | null;
  movementSamples: number;
  totalDx: number;
  totalDy: number;
  clickPresses: number;
  clickReleases: number;
  zeroMotionFraction: number;
  longestStillnessMs: number | null;
  largestGapMs: number | null;
  droppedSequences: number;
  duplicateSequences: number;
  nonMonotonicTimestamps: number;
  reconnects: number;

  checks: CaptureSelfTestCheck[];
  verdict: "pass" | "warn" | "fail";
  reasonCodes: string[];
}

export const CAPTURE_SELF_TEST_THRESHOLDS = {
  /** Minimum movement samples for ANY verdict other than fail. */
  minMovementSamples: 30,
  /** Minimum active-motion rate for a pass. */
  minActiveRateHz: 40,
  /** Observed active rate below this fraction of nominal fails validation. */
  minFractionOfNominalForPass: 0.5,
  /** Below this fraction of nominal → warn but not fail. */
  minFractionOfNominalForWarn: 0.8,
  /** Interval CV above this on a high-rate stream warns. */
  maxJitterCv: 0.6,
  /** Any duplicate or non-monotonic sequence fails the stream. */
} as const;

export function analyzeCaptureSelfTest(
  events: readonly CaptureEvent[],
  meta: CaptureSelfTestMeta,
  appVersion: string,
  engineVersion: string,
): CaptureSelfTestResult {
  const checks: CaptureSelfTestCheck[] = [];
  const t = CAPTURE_SELF_TEST_THRESHOLDS;

  // ---- sample stream analysis ----
  const samples = events.filter((e): e is Extract<CaptureEvent, { kind: "pointer-sample" }> => e.kind === "pointer-sample");
  const presses = events.filter((e) => e.kind === "button" && e.action === "press").length;
  const releases = events.filter((e) => e.kind === "button" && e.action === "release").length;

  const intervals: number[] = [];
  let nonMonotonic = 0;
  let longestStillnessMs: number | null = null;
  let largestGapMs: number | null = null;
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i]!.tMs - samples[i - 1]!.tMs;
    if (dt < 0) {
      nonMonotonic++;
      continue;
    }
    intervals.push(dt);
    if (largestGapMs === null || dt > largestGapMs) largestGapMs = dt;
    // Stillness = no cursor change between consecutive samples.
    if (samples[i]!.dx === 0 && samples[i]!.dy === 0) {
      if (longestStillnessMs === null || dt > longestStillnessMs) longestStillnessMs = dt;
    }
  }

  const observedRateHz =
    intervals.length > 1
      ? 1000 / Math.max(median(intervals), Number.EPSILON)
      : null;

  // Active-motion windows: intervals where either endpoint moved.
  const activeIntervals: number[] = [];
  let zeroMotionCount = 0;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!;
    const cur = samples[i]!;
    const dt = cur.tMs - prev.tMs;
    if (dt < 0) continue;
    const moved = cur.dx !== 0 || cur.dy !== 0 || prev.dx !== 0 || prev.dy !== 0;
    if (moved) activeIntervals.push(dt);
    else zeroMotionCount++;
  }
  const activeMotionRateHz =
    activeIntervals.length > 1
      ? 1000 / Math.max(median(activeIntervals), Number.EPSILON)
      : null;

  const p10 = intervals.length > 0 ? percentile(intervals, 10) : null;
  const p50 = intervals.length > 0 ? median(intervals) : null;
  const p90 = intervals.length > 0 ? percentile(intervals, 90) : null;
  let jitterCv: number | null = null;
  if (intervals.length >= 5 && p50 !== null && p50 > 0 && Number.isFinite(p50)) {
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance = intervals.reduce((acc, v) => acc + (v - mean) ** 2, 0) / intervals.length;
    jitterCv = Math.sqrt(variance) / mean;
  }

  const totalDx = samples.reduce((a, s) => a + s.dx, 0);
  const totalDy = samples.reduce((a, s) => a + s.dy, 0);
  const zeroMotionFraction =
    samples.length > 1 ? zeroMotionCount / (samples.length - 1) : 0;

  const tc = meta.transportCounters ?? {
    framesReceived: events.length,
    duplicateSequences: 0,
    missingSequences: 0,
    nonMonotonicTimestamps: nonMonotonic,
    reconnects: 0,
  };

  // ---- checks ----
  if (samples.length < t.minMovementSamples || Math.abs(totalDx) + Math.abs(totalDy) === 0) {
    checks.push({ name: "movement", status: "fail", detail: `only ${samples.length} sample(s), |Σdx|+|Σdy|=${Math.abs(totalDx) + Math.abs(totalDy)} — move the mouse during the test` });
  } else {
    checks.push({ name: "movement", status: "pass", detail: `${samples.length} samples, Σ|dx|+|dy|=${Math.abs(totalDx) + Math.abs(totalDy)}` });
  }

  if (presses === 0) {
    checks.push({ name: "clicks", status: "warn", detail: "no button presses registered — click during the test to validate shot capture" });
  } else if (releases !== presses) {
    checks.push({ name: "clicks", status: "warn", detail: `${presses} presses vs ${releases} releases` });
  } else {
    checks.push({ name: "clicks", status: "pass", detail: `${presses} press/release pair(s)` });
  }

  const rateCheckName = "effective-rate";
  const effective = activeMotionRateHz ?? observedRateHz;
  if (effective === null) {
    checks.push({ name: rateCheckName, status: "fail", detail: "not enough samples to estimate a rate" });
  } else if (meta.nominalRateHz !== null && meta.nominalRateHz > 0) {
    const frac = effective / meta.nominalRateHz;
    if (frac < t.minFractionOfNominalForPass) {
      checks.push({
        name: rateCheckName,
        status: "fail",
        detail: `device claims ${meta.nominalRateHz} Hz but delivered ≈${Math.round(effective)} Hz (${(frac * 100).toFixed(0)}%) — the nominal label is NOT validated`,
      });
    } else if (frac < t.minFractionOfNominalForWarn) {
      checks.push({
        name: rateCheckName,
        status: "warn",
        detail: `delivered ≈${Math.round(effective)} Hz of the claimed ${meta.nominalRateHz} Hz (${(frac * 100).toFixed(0)}%)`,
      });
    } else {
      checks.push({ name: rateCheckName, status: "pass", detail: `${Math.round(effective)} Hz observed vs ${meta.nominalRateHz} Hz claimed` });
    }
  } else {
    checks.push({
      name: rateCheckName,
      status: effective >= t.minActiveRateHz ? "pass" : "fail",
      detail:
        effective >= t.minActiveRateHz
          ? `${Math.round(effective)} Hz observed`
          : `${Math.round(effective)} Hz < ${CAPTURE_SELF_TEST_THRESHOLDS.minActiveRateHz} Hz minimum`,
    });
  }

  if (jitterCv !== null && jitterCv > t.maxJitterCv) {
    checks.push({ name: "timing-stability", status: "warn", detail: `interval CV ${jitterCv.toFixed(2)} above ${t.maxJitterCv}` });
  } else {
    checks.push({ name: "timing-stability", status: "pass", detail: jitterCv !== null ? `interval CV ${jitterCv.toFixed(2)}` : "insufficient intervals" });
  }

  let seqFail = false;
  if (tc.duplicateSequences > 0) {
    checks.push({ name: "sequence-integrity", status: "fail", detail: `${tc.duplicateSequences} duplicate sequence(s)` });
    seqFail = true;
  }
  if (tc.nonMonotonicTimestamps > 0 || nonMonotonic > 0) {
    checks.push({ name: "sequence-integrity", status: "fail", detail: `${Math.max(tc.nonMonotonicTimestamps, nonMonotonic)} non-monotonic timestamp(s)` });
    seqFail = true;
  }
  if (!seqFail) {
    const dropFrac = tc.framesReceived > 0 ? tc.missingSequences / (tc.framesReceived + tc.missingSequences) : 0;
    if (dropFrac > 0.01) {
      checks.push({ name: "sequence-integrity", status: "fail", detail: `${(dropFrac * 100).toFixed(2)}% sequences missing` });
      seqFail = true;
    } else if (tc.missingSequences > 0) {
      checks.push({ name: "sequence-integrity", status: "warn", detail: `${tc.missingSequences} missing sequence(s) (${(dropFrac * 100).toFixed(2)}%)` });
    } else {
      checks.push({ name: "sequence-integrity", status: "pass", detail: "continuous" });
    }
  }

  if (tc.reconnects > 2) {
    checks.push({ name: "reconnect-behavior", status: "warn", detail: `${tc.reconnects} reconnect(s) during the test` });
  } else {
    checks.push({ name: "reconnect-behavior", status: "pass", detail: tc.reconnects === 0 ? "no reconnects" : `${tc.reconnects} reconnect(s)` });
  }

  if (meta.sourceKind === "") {
    checks.push({ name: "source-identity", status: "fail", detail: "capture source did not identify itself" });
  } else {
    checks.push({ name: "source-identity", status: "pass", detail: `${meta.sourceKind}${meta.deviceId ? ` · ${meta.deviceId}` : ""}` });
  }

  // Clock domain. A native stream whose timestamps have not been translated
  // into the renderer clock is not usable for measurement at any rate.
  if (meta.sourceKind.includes("native")) {
    const sync = meta.clockSync ?? null;
    if (sync === null) {
      checks.push({
        name: "clock-sync",
        status: "fail",
        detail:
          "the helper clock was never synchronized to this window's clock, so its timestamps cannot be placed on the same timeline as the drills",
      });
    } else if (sync.state !== "established") {
      checks.push({
        name: "clock-sync",
        status: "fail",
        detail: `helper clock synchronization is ${sync.state}: ${sync.detail}`,
      });
    } else {
      const est = sync.estimate;
      checks.push({
        name: "clock-sync",
        status: "pass",
        detail:
          est !== null
            ? `offset ${est.offsetMs.toFixed(3)} ms bounded to ±${est.uncertaintyHalfWidthMs.toFixed(3)} ms over ${est.samples} exchanges`
            : "established",
      });
    }
  }

  const hasFail = checks.some((c) => c.status === "fail");
  const hasWarn = checks.some((c) => c.status === "warn");

  return {
    kind: "capture-self-test",
    schemaVersion: 1,
    appVersion,
    engineVersion,
    ...meta,
    observedRateHz,
    activeMotionRateHz,
    intervalP10Ms: p10,
    intervalP50Ms: p50,
    intervalP90Ms: p90,
    jitterCv,
    movementSamples: samples.length,
    totalDx,
    totalDy,
    clickPresses: presses,
    clickReleases: releases,
    zeroMotionFraction,
    longestStillnessMs,
    largestGapMs,
    droppedSequences: tc.missingSequences,
    duplicateSequences: tc.duplicateSequences,
    nonMonotonicTimestamps: Math.max(tc.nonMonotonicTimestamps, nonMonotonic),
    reconnects: tc.reconnects,
    checks,
    verdict: hasFail ? "fail" : hasWarn ? "warn" : "pass",
    reasonCodes: checks
      .filter((c) => c.status !== "pass")
      .map((c) => `${c.name}:${c.status}`),
  };
}
