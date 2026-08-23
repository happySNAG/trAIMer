import type { TrialRecord } from "../domain/trial.ts";
import { median } from "../metrics/stats.ts";
import { computeFlickMetrics } from "../metrics/flick.ts";
import { computeTrackingMetrics } from "../metrics/tracking.ts";

export interface BaselineAssessment {
  trialsUsed: number;
  hitRate: number | null;
  medianAcquisitionMs: number | null;
  trackingOnTargetRatio: number | null;
  suggestedLadderWidthOctaves: number;
  suggestedRepsPerRound: number;
  rationaleLines: string[];
}

export interface BaselineOptions {
  measuredTrialsTarget?: number;
}

/**
 * First-time baseline workflow: a short single-sensitivity assessment taken
 * BEFORE any candidate ladder is generated. Observed performance informs how
 * wide to search and how many reps per round to budget — weaker/noisier
 * players get narrower ladders (their utility curves are flatter and noisier,
 * so wide ladders waste trials at uninformative extremes).
 */
export function assessBaseline(
  trials: readonly TrialRecord[],
  options: BaselineOptions = {},
): BaselineAssessment {
  const flicks = trials.filter((t) => t.scenarioKind.startsWith("flick") && t.validity.status === "valid");
  const trackings = trials.filter((t) => t.scenarioKind === "tracking" && t.validity.status === "valid");

  const acquisitions = flicks
    .map((t) => computeFlickMetrics(t).totalAcquisitionTimeMs)
    .filter((v): v is number => v !== null);
  const hitRate =
    flicks.length > 0
      ? flicks.filter((t) => t.outcome === "hit").length / flicks.length
      : null;
  const medianAcq = acquisitions.length > 0 ? median(acquisitions) : null;
  const onTargetValues: number[] = [];
  for (const t of trackings) {
    const ratio = computeTrackingMetrics(t).timeOnTargetRatio;
    if (ratio !== null) onTargetValues.push(ratio);
  }
  const trackingRatio =
    onTargetValues.length > 0
      ? onTargetValues.reduce((a, b) => a + (b ?? 0), 0) / onTargetValues.length
      : null;

  const target = options.measuredTrialsTarget ?? 10;

  let width = 0.35;
  let reps = 8;
  const rationaleLines: string[] = [];

  if (hitRate === null || trials.length < Math.max(4, target / 2)) {
    rationaleLines.push("baseline data too thin; defaulting to conservative ladder/budget");
    return {
      trialsUsed: trials.length,
      hitRate,
      medianAcquisitionMs: medianAcq,
      trackingOnTargetRatio: trackingRatio,
      suggestedLadderWidthOctaves: width,
      suggestedRepsPerRound: reps,
      rationaleLines,
    };
  }

  if (hitRate < 0.45) {
    width = 0.18;
    reps = 6;
    rationaleLines.push(`baseline hit rate ${(hitRate * 100).toFixed(0)}% is low; narrowing ladder to ±${(width * 100).toFixed(0)}% steps and trimming reps to ${reps}`);
  } else if (hitRate > 0.85 && (medianAcq === null || medianAcq < 600)) {
    width = 0.5;
    reps = 9;
    rationaleLines.push(`strong baseline (hit rate ${(hitRate * 100).toFixed(0)}%); widening ladder to ±${(width * 100).toFixed(0)}% for better coverage`);
  } else {
    rationaleLines.push(`balanced baseline (hit rate ${(hitRate * 100).toFixed(0)}%, median acquisition ${medianAcq?.toFixed(0)} ms); standard ladder retained`);
  }
  if (trackingRatio !== null && trackingRatio < 0.3) {
    rationaleLines.push(`low tracking time-on-target (${(trackingRatio * 100).toFixed(0)}%): tracking scenarios may dominate noise — consider fewer tracking reps`);
  }

  return {
    trialsUsed: trials.length,
    hitRate,
    medianAcquisitionMs: medianAcq,
    trackingOnTargetRatio: trackingRatio,
    suggestedLadderWidthOctaves: width,
    suggestedRepsPerRound: reps,
    rationaleLines,
  };
}
