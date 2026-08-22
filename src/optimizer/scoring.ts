import type { AimDimension } from "../domain/recommendation.ts";
import type { ScenarioDefinition } from "../domain/scenario.ts";
import type { TrialRecord } from "../domain/trial.ts";
import { computeFlickMetrics } from "../metrics/flick.ts";
import { computeTrackingMetrics } from "../metrics/tracking.ts";
import { clamp01 } from "../metrics/stats.ts";

export interface DimensionScoringConfig {
  speedFloorMs: number;
  speedTauMs: number;
  errorRadiusPenaltyFraction: number;
  missAccuracyFloor: number;
  axialDeviationZeroPointRatio: number;
  correctionEfficiencyFloorPathEfficiency: number;
  trackingOnTargetWeight: number;
  trackingRmsRadiusMultiple: number;
}

export const DEFAULT_DIMENSION_SCORING: DimensionScoringConfig = {
  speedFloorMs: 200,
  speedTauMs: 220,
  errorRadiusPenaltyFraction: 0.5,
  missAccuracyFloor: 0.05,
  axialDeviationZeroPointRatio: 0.25,
  correctionEfficiencyFloorPathEfficiency: 0.55,
  trackingOnTargetWeight: 0.6,
  trackingRmsRadiusMultiple: 2,
};

export const DEFAULT_UTILITY_WEIGHTS: Record<AimDimension, number> = {
  speed: 0.14,
  accuracy: 0.28,
  overshootControl: 0.11,
  undershootControl: 0.11,
  correctionEfficiency: 0.12,
  trackingPrecision: 0.14,
  consistency: 0.1,
};

export interface TrialDimensionScores {
  dimensions: Partial<Record<AimDimension, number>>;
}

export function scoreTrialDimensions(
  record: TrialRecord,
  scenario: ScenarioDefinition | undefined,
  config: DimensionScoringConfig = DEFAULT_DIMENSION_SCORING,
): TrialDimensionScores {
  if (record.scenarioKind === "tracking") {
    return { dimensions: scoreTrackingTrial(record, config) };
  }
  return { dimensions: scoreFlickTrial(record, scenario, config) };
}

function scoreFlickTrial(
  record: TrialRecord,
  scenario: ScenarioDefinition | undefined,
  config: DimensionScoringConfig,
): Partial<Record<AimDimension, number>> {
  const m = computeFlickMetrics(record);
  const speed =
    m.totalAcquisitionTimeMs === null
      ? null
      : clamp01(
          Math.exp(
            -Math.max(0, m.totalAcquisitionTimeMs - config.speedFloorMs) /
              config.speedTauMs,
          ),
        );

  let accuracy: number;
  if (record.outcome === "hit") {
    const ratio = m.finalErrorRadiusRatio ?? 0;
    accuracy = clamp01(
      1 - config.errorRadiusPenaltyFraction * Math.min(1, ratio),
    );
  } else {
    accuracy = config.missAccuracyFloor;
  }

  const zeroPoint = config.axialDeviationZeroPointRatio;
  const overshootControl = 1 - clamp01(m.overshootRatio / zeroPoint);
  const undershootControl = 1 - clamp01(m.undershootRatio / zeroPoint);

  const correctionEfficiency =
    m.pathEfficiency === null
      ? null
      : clamp01(
          (m.pathEfficiency -
            config.correctionEfficiencyFloorPathEfficiency) /
            (1 - config.correctionEfficiencyFloorPathEfficiency),
        );

  const dims: Partial<Record<AimDimension, number>> = {
    accuracy,
    overshootControl,
    undershootControl,
  };
  if (speed !== null) dims.speed = speed;
  if (correctionEfficiency !== null) dims.correctionEfficiency = correctionEfficiency;
  return dims;
}

function scoreTrackingTrial(
  record: TrialRecord,
  config: DimensionScoringConfig,
): Partial<Record<AimDimension, number>> {
  const t = computeTrackingMetrics(record);
  if (t.timeOnTargetRatio === null || t.rmsErrorPx === null) return {};
  const target = record.targets[0];
  const radius = target?.radiusPx ?? 30;
  const rmsScore = clamp01(1 - t.rmsErrorPx / (radius * config.trackingRmsRadiusMultiple));
  const trackingPrecision = clamp01(
    config.trackingOnTargetWeight * t.timeOnTargetRatio +
      (1 - config.trackingOnTargetWeight) * rmsScore,
  );
  return { trackingPrecision };
}

export function trialUtilityFromDimensions(
  dimensions: Partial<Record<AimDimension, number>>,
  weights: Record<AimDimension, number>,
): number | null {
  let acc = 0;
  let weightSum = 0;
  for (const [dim, value] of Object.entries(dimensions)) {
    if (value === undefined) continue;
    acc += weights[dim as AimDimension] * value;
    weightSum += weights[dim as AimDimension];
  }
  if (weightSum <= 0) return null;
  return acc / weightSum;
}
