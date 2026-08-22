import type { FatigueProtocolConfig } from "../domain/experiment.ts";
import type { TrialRecord } from "../domain/trial.ts";
import { computeFlickMetrics } from "../metrics/flick.ts";
import { median } from "../metrics/stats.ts";

export interface FatigueAssessment {
  shouldRest: boolean;
  reason: string | null;
  continuousTestingMs: number;
  degradationRatio: number | null;
}

export function assessFatigue(
  config: FatigueProtocolConfig,
  measuredTrialsSinceLastRest: readonly TrialRecord[],
  continuousTestingMs: number,
): FatigueAssessment {
  if (continuousTestingMs >= config.maxContinuousTestingMs) {
    return {
      shouldRest: true,
      reason: `continuous testing reached ${Math.round(continuousTestingMs / 1000)}s (limit ${Math.round(config.maxContinuousTestingMs / 1000)}s)`,
      continuousTestingMs,
      degradationRatio: null,
    };
  }

  const flickAcquisitions = measuredTrialsSinceLastRest
    .filter((t) => t.scenarioKind.startsWith("flick") && t.validity.status === "valid")
    .map((t) => computeFlickMetrics(t).totalAcquisitionTimeMs)
    .filter((v): v is number => v !== null);

  const window = config.degradationWindowTrials;
  if (flickAcquisitions.length >= window * 2) {
    const early = flickAcquisitions.slice(0, window);
    const recent = flickAcquisitions.slice(-window);
    const earlyMedian = median(early);
    const recentMedian = median(recent);
    if (earlyMedian > 0) {
      const ratio = recentMedian / earlyMedian;
      if (ratio >= config.degradationRatioThreshold) {
        return {
          shouldRest: true,
          reason: `median acquisition slowed ${((ratio - 1) * 100).toFixed(0)}% over last ${window} flicks (fatigue pattern)`,
          continuousTestingMs,
          degradationRatio: ratio,
        };
      }
      return {
        shouldRest: false,
        reason: null,
        continuousTestingMs,
        degradationRatio: ratio,
      };
    }
  }

  return {
    shouldRest: false,
    reason: null,
    continuousTestingMs,
    degradationRatio: null,
  };
}

export interface ShortSessionGuardInput {
  activeTestingMs: number;
  totalMeasuredTrials: number;
  minActiveTestingMsForLargeChanges: number;
  minMeasuredTrialsForLargeChanges: number;
  maxAdvisableChangeOctaves: number;
  baselineSensX: number;
}

export interface SessionGuardResult {
  applied: boolean;
  cappedToSensX: number | null;
  rationaleLine: string;
}

export function guardShortSessionRecommendation(
  input: ShortSessionGuardInput,
): SessionGuardResult {
  const shortSession =
    input.activeTestingMs < input.minActiveTestingMsForLargeChanges ||
    input.totalMeasuredTrials < input.minMeasuredTrialsForLargeChanges;
  return {
    applied: shortSession,
    cappedToSensX: null,
    rationaleLine: shortSession
      ? `short session (${(input.activeTestingMs / 60000).toFixed(1)} min active, ${input.totalMeasuredTrials} trials): large sensitivity changes are not advisable from this evidence alone; re-test before committing to a big change`
      : "",
  };
}
