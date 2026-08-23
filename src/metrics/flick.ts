import {
  targetPositionAt,
  type PointerSample,
  type TargetSpan,
  type TrialRecord,
} from "../domain/trial.ts";
import { clamp01, percentile } from "./stats.ts";

export interface FlickMetricOptions {
  onsetMinPx: number;
  onsetDistanceFraction: number;
  directionWindowMs: number;
  correctionEpsilonRadiusFraction: number;
}

export const DEFAULT_FLICK_OPTIONS: FlickMetricOptions = {
  onsetMinPx: 1,
  onsetDistanceFraction: 0.02,
  directionWindowMs: 40,
  correctionEpsilonRadiusFraction: 0.25,
};

export interface FlickTrialMetrics {
  reactionTimeMs: number | null;
  movementTimeMs: number | null;
  totalAcquisitionTimeMs: number | null;
  initialDirectionErrorDeg: number | null;
  pathLengthPx: number;
  straightLineDistancePx: number;
  pathEfficiency: number | null;
  peakAxialProgressPx: number;
  overshootPx: number;
  overshootRatio: number;
  undershootPx: number;
  undershootRatio: number;
  correctionCount: number;
  correctionDistancePx: number;
  finalErrorPx: number | null;
  finalErrorRadiusRatio: number | null;
  shotsFired: number;
  hitAccuracy: number | null;
}

export function primaryTargetSpan(record: TrialRecord): TargetSpan | null {
  return record.targets[0] ?? null;
}

function cursorAtOrBefore(samples: readonly PointerSample[], tMs: number) {
  let found: PointerSample | null = null;
  for (const s of samples) {
    if (s.tMs <= tMs) found = s;
    else break;
  }
  return found ?? samples[0] ?? null;
}

function interpolatePosition(
  a: { x: number; y: number },
  b: { x: number; y: number },
  f: number,
) {
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

export function computeFlickMetrics(
  record: TrialRecord,
  options: FlickMetricOptions = DEFAULT_FLICK_OPTIONS,
): FlickTrialMetrics {
  // Pass 6: memoize default-option analyses per record (records are
  // immutable after TrialRecorder.finish()); custom options bypass cache.
  if (options === DEFAULT_FLICK_OPTIONS) {
    const cached = flickMetricsCache.get(record);
    if (cached) return cached;
    const computed = computeFlickMetricsUncached(record, options);
    flickMetricsCache.set(record, computed);
    return computed;
  }
  return computeFlickMetricsUncached(record, options);
}

const flickMetricsCache = new WeakMap<TrialRecord, FlickTrialMetrics>();

function computeFlickMetricsUncached(
  record: TrialRecord,
  options: FlickMetricOptions,
): FlickTrialMetrics {
  const target = primaryTargetSpan(record);
  const empty: FlickTrialMetrics = {
    reactionTimeMs: null,
    movementTimeMs: null,
    totalAcquisitionTimeMs: null,
    initialDirectionErrorDeg: null,
    pathLengthPx: 0,
    straightLineDistancePx: 0,
    pathEfficiency: null,
    peakAxialProgressPx: 0,
    overshootPx: 0,
    overshootRatio: 0,
    undershootPx: 0,
    undershootRatio: 0,
    correctionCount: 0,
    correctionDistancePx: 0,
    finalErrorPx: null,
    finalErrorRadiusRatio: null,
    shotsFired: record.shots.length,
    hitAccuracy:
      record.shots.length === 0
        ? null
        : record.shots.filter((s) => s.hit).length / record.shots.length,
  };
  if (!target) return empty;

  const tApp = target.appearedMs;
  const startSample = cursorAtOrBefore(record.samples, tApp);
  if (!startSample) return empty;
  const p0 = startSample.cursor;
  const targetCenterAtApp =
    targetPositionAt(target, tApp) ?? targetPositionAt(target, tApp + 1);
  if (!targetCenterAtApp) return empty;

  const dx0 = targetCenterAtApp.x - p0.x;
  const dy0 = targetCenterAtApp.y - p0.y;
  const d0 = Math.hypot(dx0, dy0);
  const ux = d0 > 0 ? dx0 / d0 : 1;
  const uy = d0 > 0 ? dy0 / d0 : 0;

  const onsetThresholdPx = Math.max(
    options.onsetMinPx,
    options.onsetDistanceFraction * d0,
  );

  let onsetIdx = -1;
  for (let i = 0; i < record.samples.length; i++) {
    const s = record.samples[i]!;
    if (s.tMs < tApp) continue;
    if (Math.hypot(s.cursor.x - p0.x, s.cursor.y - p0.y) >= onsetThresholdPx) {
      onsetIdx = i;
      break;
    }
  }
  const reactionTimeMs = onsetIdx >= 0 ? record.samples[onsetIdx]!.tMs - tApp : null;

  const firstShotAfterOnset =
    record.shots.find((sh) => sh.tMs >= tApp && (onsetIdx < 0 || sh.tMs >= record.samples[onsetIdx]!.tMs)) ??
    record.shots.find((sh) => sh.tMs >= tApp) ??
    null;

  let arrivalTimeMs: number | null = null;
  for (const s of record.samples) {
    if (onsetIdx >= 0 && s.tMs < record.samples[onsetIdx]!.tMs) continue;
    const tc = targetPositionAt(target, s.tMs);
    if (
      tc &&
      Math.hypot(tc.x - s.cursor.x, tc.y - s.cursor.y) <= target.radiusPx
    ) {
      arrivalTimeMs = s.tMs;
      break;
    }
  }

  const acquisitionEndTimeMs =
    firstShotAfterOnset?.tMs ??
    arrivalTimeMs ??
    target.removedMs ??
    record.endedAtMonotonicMs;

  const movementTimeMs =
    reactionTimeMs === null
      ? null
      : Math.max(0, acquisitionEndTimeMs - tApp - reactionTimeMs);

  const windowSamples = record.samples.filter(
    (s) => s.tMs >= tApp && s.tMs <= acquisitionEndTimeMs,
  );
  let pathLengthPx = 0;
  for (let i = 1; i < windowSamples.length; i++) {
    pathLengthPx += Math.hypot(
      windowSamples[i]!.cursor.x - windowSamples[i - 1]!.cursor.x,
      windowSamples[i]!.cursor.y - windowSamples[i - 1]!.cursor.y,
    );
  }

  let peakAxialProgressPx = 0;
  for (const s of windowSamples) {
    const axial = (s.cursor.x - p0.x) * ux + (s.cursor.y - p0.y) * uy;
    peakAxialProgressPx = Math.max(peakAxialProgressPx, axial);
  }
  const overshootPx = Math.max(0, peakAxialProgressPx - d0);
  const undershootPx = Math.max(0, d0 - peakAxialProgressPx);

  let directionErrorDeg: number | null = null;
  if (onsetIdx >= 0 && d0 > 0) {
    const onsetSample = record.samples[onsetIdx]!;
    const windowEndT = onsetSample.tMs + options.directionWindowMs;
    let endSample = onsetSample;
    for (const s of record.samples) {
      if (s.tMs <= onsetSample.tMs) continue;
      if (s.tMs > windowEndT) break;
      endSample = s;
    }
    const mvx = endSample.cursor.x - onsetSample.cursor.x;
    const mvy = endSample.cursor.y - onsetSample.cursor.y;
    const mvLen = Math.hypot(mvx, mvy);
    if (mvLen > 0) {
      const cos = (mvx * dx0 + mvy * dy0) / (mvLen * d0);
      directionErrorDeg = (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
    }
  }

  const epsilonPx = target.radiusPx * options.correctionEpsilonRadiusFraction;
  let correctionCount = 0;
  let prevDerivSign = 0;
  for (let i = 1; i < windowSamples.length; i++) {
    const prev = windowSamples[i - 1]!;
    const cur = windowSamples[i]!;
    const tcPrev = targetPositionAt(target, prev.tMs) ?? targetCenterAtApp;
    const tcCur = targetPositionAt(target, cur.tMs) ?? targetCenterAtApp;
    const errPrev = Math.hypot(prev.cursor.x - tcPrev.x, prev.cursor.y - tcPrev.y);
    const errCur = Math.hypot(cur.cursor.x - tcCur.x, cur.cursor.y - tcCur.y);
    const deriv = errCur - errPrev;
    if (Math.abs(deriv) < epsilonPx / 10) continue;
    const sign = deriv > 0 ? 1 : -1;
    if (prevDerivSign !== 0 && sign !== prevDerivSign && errCur > epsilonPx) {
      correctionCount++;
    }
    prevDerivSign = sign;
  }

  const shotForFinalError = firstShotAfterOnset;
  const finalErrorPx = shotForFinalError
    ? shotForFinalError.missDistancePx ?? 0
    : (() => {
        const last = windowSamples.at(-1) ?? startSample;
        const tc = targetPositionAt(target, last!.tMs);
        return tc ? Math.hypot(tc.x - last!.cursor.x, tc.y - last!.cursor.y) : null;
      })();

  return {
    reactionTimeMs,
    movementTimeMs,
    totalAcquisitionTimeMs:
      firstShotAfterOnset || arrivalTimeMs
        ? (firstShotAfterOnset?.tMs ?? arrivalTimeMs!) - tApp
        : null,
    initialDirectionErrorDeg: directionErrorDeg,
    pathLengthPx,
    straightLineDistancePx: d0,
    pathEfficiency: pathLengthPx > 0 ? clamp01(d0 / pathLengthPx) : null,
    peakAxialProgressPx,
    overshootPx,
    overshootRatio: d0 > 0 ? clamp01(overshootPx / d0) : 0,
    undershootPx,
    undershootRatio: d0 > 0 ? clamp01(undershootPx / d0) : 0,
    correctionCount,
    correctionDistancePx: Math.max(0, pathLengthPx - d0),
    finalErrorPx,
    finalErrorRadiusRatio:
      finalErrorPx === null ? null : finalErrorPx / target.radiusPx,
    shotsFired: record.shots.length,
    hitAccuracy: empty.hitAccuracy,
  };
}

export interface TargetSwitchLatencyMetrics {
  latenciesMs: number[];
  meanLatencyMs: number | null;
  medianLatencyMs: number | null;
  p90LatencyMs: number | null;
}

export function computeTargetSwitchLatency(
  record: TrialRecord,
  options: FlickMetricOptions = DEFAULT_FLICK_OPTIONS,
): TargetSwitchLatencyMetrics {
  const latenciesMs: number[] = [];
  for (let i = 1; i < record.targets.length; i++) {
    const next = record.targets[i]!;
    const spawn = next.appearedMs;
    const nextPos = targetPositionAt(next, spawn);
    if (!nextPos) continue;
    const before = cursorAtOrBefore(record.samples, spawn);
    if (!before) continue;
    const threshold = Math.max(
      options.onsetMinPx,
      options.onsetDistanceFraction *
        Math.hypot(nextPos.x - before.cursor.x, nextPos.y - before.cursor.y),
    );
    for (const s of record.samples) {
      if (s.tMs < spawn) continue;
      const moved = Math.hypot(s.cursor.x - before.cursor.x, s.cursor.y - before.cursor.y);
      if (moved >= threshold) {
        latenciesMs.push(s.tMs - spawn);
        break;
      }
    }
  }
  return {
    latenciesMs,
    meanLatencyMs:
      latenciesMs.length === 0
        ? null
        : latenciesMs.reduce((a, b) => a + b, 0) / latenciesMs.length,
    medianLatencyMs: latenciesMs.length === 0 ? null : percentile(latenciesMs, 50),
    p90LatencyMs: latenciesMs.length === 0 ? null : percentile(latenciesMs, 90),
  };
}

export { interpolatePosition };
