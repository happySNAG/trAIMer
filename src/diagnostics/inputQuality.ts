import type { TrialRecord } from "../domain/trial.ts";
import { median, percentile } from "../metrics/stats.ts";

export interface InputQualityMetrics {
  sampleCount: number;
  observedRateHz: number;
  rateP10Hz: number;
  rateP90Hz: number;
  intervalJitterCv: number | null;
  activeMotionIntervals: number;
  largeGapCount: number;
  largestGapMs: number;
  zeroMotionFraction: number;
  longestZeroMotionMs: number;
  clickLatencyAfterMotionMs: number | null;
  lockLossCount: number;
  resizeCount: number;
}

export interface InputQualityWarnings {
  lowEventRate: boolean;
  unstableTiming: boolean;
  excessiveLockLoss: boolean;
  viewportUnstable: boolean;
  unsuitableForHighConfidence: boolean;
}

export interface InputQualityReport {
  score: number;
  metrics: InputQualityMetrics;
  warnings: InputQualityWarnings;
  warningLines: string[];
}

export const INPUT_QUALITY_THRESHOLDS = {
  minActiveMotionRateHz: 40,
  maxJitterCv: 0.9,
  maxLockLosses: 0,
  maxResizes: 0,
  zeroMotionFractionSoftCap: 0.6,
} as const;

const ACTIVE_MOTION_EPSILON_PX = 0.3;

export function computeInputQuality(record: TrialRecord): InputQualityReport {
  const samples = record.samples;
  const intervals: number[] = [];
  let zeroMotionSamples = 0;
  let longestZeroRunMs = 0;
  let currentZeroRunStart: number | null = null;
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i]!.tMs - samples[i - 1]!.tMs;
    if (dt > 0) intervals.push(dt);
    const moved =
      Math.abs(samples[i]!.dx) + Math.abs(samples[i]!.dy);
    if (moved < ACTIVE_MOTION_EPSILON_PX) {
      zeroMotionSamples++;
      if (currentZeroRunStart === null) currentZeroRunStart = samples[i - 1]!.tMs;
      longestZeroRunMs = Math.max(
        longestZeroRunMs,
        samples[i]!.tMs - currentZeroRunStart,
      );
    } else {
      currentZeroRunStart = null;
    }
  }
  void currentZeroRunStart;

  const activeMotionSteps: number[] = [];
  const movedFlags: boolean[] = samples.map(
    (s) => Math.abs(s.dx) + Math.abs(s.dy) >= ACTIVE_MOTION_EPSILON_PX,
  );
  // Pass 6 fix: timing stability is a property of CONTINUOUS streaming while
  // the hand is moving. Intervals are collected only inside maximal runs of
  // consecutive moving samples, so deliberate micro-pauses between
  // submovements (and post-reaction resumptions) cannot masquerade as timing
  // instability, while a true stall inside a motion run still shows up as a
  // large interval.
  const MIN_RUN_LENGTH = 6;
  let runStart = -1;
  for (let i = 0; i <= samples.length; i++) {
    const moving = i < samples.length && movedFlags[i] === true;
    if (moving && runStart < 0) {
      runStart = i;
    } else if (!moving && runStart >= 0) {
      if (i - runStart >= MIN_RUN_LENGTH) {
        for (let j = runStart + 1; j < i; j++) {
          activeMotionSteps.push(samples[j]!.tMs - samples[j - 1]!.tMs);
        }
      }
      runStart = -1;
    }
  }

  const medianInterval = intervals.length > 0 ? median(intervals) : Number.NaN;
  const observedRateHz = Number.isFinite(medianInterval)
    ? 1000 / Math.max(medianInterval, 0.001)
    : 0;
  const rateP10Hz =
    intervals.length > 0 ? 1000 / Math.max(percentile(intervals, 90), 0.001) : 0;
  const rateP90Hz =
    intervals.length > 0 ? 1000 / Math.max(percentile(intervals, 10), 0.001) : 0;

  let jitterCv: number | null = null;
  if (activeMotionSteps.length >= 5 && medianInterval > 0) {
    // Pass 6: ROBUST (median/MAD) coefficient of variation. The earlier
    // mean/SD version let one or two natural micro-pauses inside an otherwise
    // regular stream inflate CV past any threshold, capping honest sessions'
    // confidence at 0.45. Isolated stalls remain covered by largeGapCount /
    // largestGapMs and by trial-level validation.
    const med = median(activeMotionSteps);
    const absDeviations = activeMotionSteps
      .map((v) => Math.abs(v - med))
      .sort((a, b) => a - b);
    const mad = percentile(absDeviations, 50);
    jitterCv = med > 0 ? (1.4826 * mad) / med : null;
  }

  let largeGapCount = 0;
  let largestGapMs = 0;
  for (let i = 1; i < samples.length; i++) {
    const gap = samples[i]!.tMs - samples[i - 1]!.tMs;
    largestGapMs = Math.max(largestGapMs, gap);
    if (gap > 100) largeGapCount++;
  }

  const clickLatencyAfterMotionMs = (() => {
    if (record.shots.length === 0 || record.samples.length < 2) return null;
    const firstShot = record.shots[0]!;
    let latestMotionBeforeShot: number | null = null;
    for (let i = samples.length - 1; i >= 0; i--) {
      const s = samples[i]!;
      if (s.tMs > firstShot.tMs) continue;
      if (Math.abs(s.dx) + Math.abs(s.dy) >= ACTIVE_MOTION_EPSILON_PX) {
        latestMotionBeforeShot = s.tMs;
        break;
      }
    }
    return latestMotionBeforeShot === null
      ? null
      : Math.max(0, firstShot.tMs - latestMotionBeforeShot);
  })();

  const lockLossCount = record.focusInterruptions.filter(
    (f) => f.reason === "pointer-lock-loss",
  ).length;
  const resizeCount = record.viewportResizes.length;

  const zeroMotionFraction = zeroMotionSamples / Math.max(samples.length, 1);

  const warnings: InputQualityWarnings = {
    lowEventRate:
      samples.length >= 20 &&
      observedRateHz < INPUT_QUALITY_THRESHOLDS.minActiveMotionRateHz &&
      movedFlags.some(Boolean),
    unstableTiming:
      jitterCv !== null && jitterCv > INPUT_QUALITY_THRESHOLDS.maxJitterCv,
    excessiveLockLoss: lockLossCount > INPUT_QUALITY_THRESHOLDS.maxLockLosses,
    viewportUnstable: resizeCount > INPUT_QUALITY_THRESHOLDS.maxResizes,
    unsuitableForHighConfidence: false,
  };
  warnings.unsuitableForHighConfidence =
    warnings.lowEventRate ||
    warnings.unstableTiming ||
    warnings.excessiveLockLoss ||
    warnings.viewportUnstable;

  const warningLines: string[] = [];
  if (warnings.lowEventRate) {
    warningLines.push(
      `pointer event rate ${observedRateHz.toFixed(0)} Hz is below the ${INPUT_QUALITY_THRESHOLDS.minActiveMotionRateHz} Hz comfort threshold; high-confidence recommendations are not supported`,
    );
  }
  if (warnings.unstableTiming) {
    warningLines.push(
      `event timing jitter CV ${(jitterCv ?? 0).toFixed(2)} exceeds ${(INPUT_QUALITY_THRESHOLDS.maxJitterCv).toFixed(2)}; timing unstable`,
    );
  }
  if (warnings.excessiveLockLoss) {
    warningLines.push(`${lockLossCount} pointer-lock loss(es) during trial`);
  }
  if (warnings.viewportUnstable) {
    warningLines.push(`${resizeCount} viewport resize(s) during trial`);
  }

  let score = 1;
  if (warnings.lowEventRate) score -= 0.45;
  if (warnings.unstableTiming) score -= 0.25;
  if (warnings.excessiveLockLoss) score -= 0.4;
  if (warnings.viewportUnstable) score -= 0.2;
  if (zeroMotionFraction > INPUT_QUALITY_THRESHOLDS.zeroMotionFractionSoftCap) {
    score -= 0.05;
    warningLines.push("long zero-motion periods dominated the trial");
  }
  if (largestGapMs > 400) {
    score -= 0.1;
    warningLines.push(`largest inter-sample gap ${largestGapMs.toFixed(0)} ms`);
  }

  return {
    score: Math.max(0, Math.min(1, score)),
    metrics: {
      sampleCount: samples.length,
      observedRateHz,
      rateP10Hz,
      rateP90Hz,
      intervalJitterCv: jitterCv,
      activeMotionIntervals: activeMotionSteps.length,
      largeGapCount,
      largestGapMs,
      zeroMotionFraction,
      longestZeroMotionMs: longestZeroRunMs,
      clickLatencyAfterMotionMs,
      lockLossCount,
      resizeCount,
    },
    warnings,
    warningLines,
  };
}
