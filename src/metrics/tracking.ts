import {
  targetPositionAt,
  type PointerSample,
  type TrialRecord,
} from "../domain/trial.ts";
import { clamp01, mean, median, percentile, rootMeanSquare } from "./stats.ts";

export interface TrackingMetricOptions {
  bandMultiples: readonly number[];
  percentileLevels: readonly number[];
  lagScanMinMs: number;
  lagScanMaxMs: number;
}

export const DEFAULT_TRACKING_OPTIONS: TrackingMetricOptions = {
  bandMultiples: [1, 2, 3],
  percentileLevels: [50, 75, 90, 95],
  lagScanMinMs: -250,
  lagScanMaxMs: 250,
};

export interface TrackingTrialMetrics {
  sampleCount: number;
  meanErrorPx: number | null;
  medianErrorPx: number | null;
  rmsErrorPx: number | null;
  percentileErrorsPx: Record<string, number>;
  timeOnTargetRatio: number | null;
  bandRatios: Record<string, number>;
  cursorPathLengthPx: number;
  targetPathLengthPx: number;
  trackingPathEfficiency: number | null;
  directionalLagMs: number | null;
  correctionFrequencyPerSec: number | null;
  lossEvents: number;
  reacquisitionEvents: number;
}

export function computeTrackingMetrics(
  record: TrialRecord,
  options: TrackingMetricOptions = DEFAULT_TRACKING_OPTIONS,
): TrackingTrialMetrics {
  // Pass 6: memoize default-option analyses per record. Trial records are
  // immutable after TrialRecorder.finish(), and the optimizer re-derives
  // trial metrics in several passes (evaluations, centers, change-point,
  // explanation); recomputing a 6 s tracking stream each time dominated
  // analysis runtime. Custom option objects bypass the cache.
  if (options === DEFAULT_TRACKING_OPTIONS) {
    const cached = trackingMetricsCache.get(record);
    if (cached) return cached;
    const computed = computeTrackingMetricsUncached(record, options);
    trackingMetricsCache.set(record, computed);
    return computed;
  }
  return computeTrackingMetricsUncached(record, options);
}

const trackingMetricsCache = new WeakMap<TrialRecord, TrackingTrialMetrics>();

function computeTrackingMetricsUncached(
  record: TrialRecord,
  options: TrackingMetricOptions,
): TrackingTrialMetrics {
  const target = record.targets[0] ?? null;
  const base: TrackingTrialMetrics = {
    sampleCount: record.samples.length,
    meanErrorPx: null,
    medianErrorPx: null,
    rmsErrorPx: null,
    percentileErrorsPx: {},
    timeOnTargetRatio: null,
    bandRatios: {},
    cursorPathLengthPx: 0,
    targetPathLengthPx: 0,
    trackingPathEfficiency: null,
    directionalLagMs: null,
    correctionFrequencyPerSec: null,
    lossEvents: 0,
    reacquisitionEvents: 0,
  };
  if (!target) return base;

  const pairs: { t: number; err: number; cursor: { x: number; y: number }; target: { x: number; y: number } }[] = [];
  for (const s of record.samples) {
    const tc = targetPositionAt(target, s.tMs);
    if (!tc) continue;
    pairs.push({
      t: s.tMs,
      err: Math.hypot(s.cursor.x - tc.x, s.cursor.y - tc.y),
      cursor: s.cursor,
      target: tc,
    });
  }
  if (pairs.length === 0) return base;

  const errors = pairs.map((p) => p.err);
  const durationSec =
    (pairs[pairs.length - 1]!.t - pairs[0]!.t) / 1000;

  let cursorPath = 0;
  let targetPath = 0;
  for (let i = 1; i < pairs.length; i++) {
    cursorPath += Math.hypot(
      pairs[i]!.cursor.x - pairs[i - 1]!.cursor.x,
      pairs[i]!.cursor.y - pairs[i - 1]!.cursor.y,
    );
    targetPath += Math.hypot(
      pairs[i]!.target.x - pairs[i - 1]!.target.x,
      pairs[i]!.target.y - pairs[i - 1]!.target.y,
    );
  }

  const percentileErrorsPx: Record<string, number> = {};
  for (const level of options.percentileLevels) {
    percentileErrorsPx[String(level)] = percentile(errors, level);
  }

  const onTarget = errors.filter((e) => e <= target.radiusPx).length /
    errors.length;

  const bandRatios: Record<string, number> = {};
  for (const k of options.bandMultiples) {
    const within = errors.filter((e) => e <= target.radiusPx * k).length;
    bandRatios[`x${k}`] = within / errors.length;
  }

  let inside = errors[0]! <= target.radiusPx;
  let losses = 0;
  let reacqs = 0;
  for (const e of errors.slice(1)) {
    const nowInside = e <= target.radiusPx;
    if (inside && !nowInside) losses++;
    if (!inside && nowInside) reacqs++;
    inside = nowInside;
  }

  let reversals = 0;
  let prevSign = 0;
  for (let i = 1; i < errors.length; i++) {
    const deriv = errors[i]! - errors[i - 1]!;
    if (Math.abs(deriv) < 1e-9) continue;
    const sign = deriv > 0 ? 1 : -1;
    if (prevSign !== 0 && sign !== prevSign && errors[i]! > target.radiusPx * 0.25) {
      reversals++;
    }
    prevSign = sign;
  }

  const lagMs = estimateDirectionalLag(record.samples, target, options);

  return {
    sampleCount: pairs.length,
    meanErrorPx: mean(errors),
    medianErrorPx: median(errors),
    rmsErrorPx: rootMeanSquare(errors),
    percentileErrorsPx,
    timeOnTargetRatio: onTarget,
    bandRatios,
    cursorPathLengthPx: cursorPath,
    targetPathLengthPx: targetPath,
    trackingPathEfficiency:
      cursorPath > 0 ? clamp01(targetPath / cursorPath) : null,
    directionalLagMs: lagMs,
    correctionFrequencyPerSec:
      durationSec > 0 ? reversals / durationSec : null,
    lossEvents: losses,
    reacquisitionEvents: reacqs,
  };
}

function interpolateCursor(
  samples: readonly PointerSample[],
  tMs: number,
): { x: number; y: number } | null {
  if (samples.length === 0) return null;
  if (tMs <= samples[0]!.tMs) return samples[0]!.cursor;
  if (tMs >= samples[samples.length - 1]!.tMs) {
    return samples[samples.length - 1]!.cursor;
  }
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.tMs <= tMs) lo = mid;
    else hi = mid;
  }
  const a = samples[lo]!;
  const b = samples[hi]!;
  const f = b.tMs === a.tMs ? 0 : (tMs - a.tMs) / (b.tMs - a.tMs);
  return {
    x: a.cursor.x + (b.cursor.x - a.cursor.x) * f,
    y: a.cursor.y + (b.cursor.y - a.cursor.y) * f,
  };
}

function estimateDirectionalLag(
  samples: readonly PointerSample[],
  target: NonNullable<TrialRecord["targets"][number]>,
  options: TrackingMetricOptions,
): number | null {
  // Target position depends ONLY on the sample timestamp, never on the
  // candidate lag — compute it once per sample instead of once per lag
  // (Pass 6 performance fix: this scan is O(lags × samples)).
  const refSamples: PointerSample[] = [];
  const targetPositions: { x: number; y: number }[] = [];
  for (const s of samples) {
    const tc = targetPositionAt(target, s.tMs);
    if (tc !== null) {
      refSamples.push(s);
      targetPositions.push(tc);
    }
  }
  if (refSamples.length < 10) return null;
  const stepMs = Math.max(
    4,
    Math.round((refSamples[refSamples.length - 1]!.tMs - refSamples[0]!.tMs) / refSamples.length),
  );
  let bestLag: number | null = null;
  let bestErr = Number.POSITIVE_INFINITY;
  for (
    let lag = options.lagScanMinMs;
    lag <= options.lagScanMaxMs;
    lag += stepMs
  ) {
    let acc = 0;
    let n = 0;
    for (let i = 0; i < refSamples.length; i++) {
      const shifted = interpolateCursor(samples, refSamples[i]!.tMs + lag);
      if (!shifted) continue;
      acc += Math.hypot(shifted.x - targetPositions[i]!.x, shifted.y - targetPositions[i]!.y);
      n++;
    }
    if (n === 0) continue;
    const avg = acc / n;
    if (avg < bestErr) {
      bestErr = avg;
      bestLag = lag;
    }
  }
  return bestLag;
}
