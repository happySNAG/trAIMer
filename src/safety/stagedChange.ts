import type { Recommendation, SensitivityChangePlan } from "../domain/recommendation.ts";
import type { SensitivityConfiguration } from "../domain/settings.ts";

export interface StagedChangePolicy {
  maxImmediateStepOctaves: number;
  minConfidenceForFullOptimum: number;
  adaptationRetestSessions: number;
}

export const DEFAULT_STAGED_CHANGE_POLICY: StagedChangePolicy = {
  maxImmediateStepOctaves: 0.25,
  minConfidenceForFullOptimum: 0.8,
  adaptationRetestSessions: 1,
};

function clampToPositive(v: number, floor = 0.2): number {
  return Math.max(floor, v);
}

/**
 * Sensitivity-change safety: prevents large immediate jumps from a single
 * noisy session. When the inferred optimum is far from the current setting
 * AND confidence/boundary evidence does not justify a confident jump, the
 * plan recommends a bounded first step toward the optimum, labels the full
 * inferred optimum separately, and requests an adaptation retest.
 */
export function applyStagedChangeSafety(
  recommendation: Recommendation,
  currentSensitivity: SensitivityConfiguration,
  policy: StagedChangePolicy = DEFAULT_STAGED_CHANGE_POLICY,
): Recommendation {
  const currentEdpi = recommendation.recommendedEdpi / recommendation.primarySensitivity.sensX * currentSensitivity.sensX;
  void currentEdpi;

  const octavesAway = Math.abs(
    Math.log2(recommendation.primarySensitivity.sensX / currentSensitivity.sensX),
  );
  const farAway = octavesAway > policy.maxImmediateStepOctaves;
  const confidentJump =
    recommendation.confidence >= policy.minConfidenceForFullOptimum &&
    !recommendation.unresolvedBoundary &&
    !recommendation.refusedHighConfidence;

  const planApplied = farAway && !confidentJump;
  if (!planApplied) return { ...recommendation, sensitivityChangePlan: undefined };

  const direction =
    recommendation.primarySensitivity.sensX > currentSensitivity.sensX ? 1 : -1;
  const stepFactor = Math.pow(2, direction * policy.maxImmediateStepOctaves);
  const recommendedNowSensX = clampToPositive(
    currentSensitivity.sensX * stepFactor,
  );

  const rationaleLines = [
    `full inferred optimum is ${recommendation.primarySensitivity.sensX.toFixed(2)}% X (${(octavesAway * 100).toFixed(0)}% away from your current ${currentSensitivity.sensX.toFixed(2)}%)`,
    `immediate change is capped at ±${(policy.maxImmediateStepOctaves * 100).toFixed(0)}% by the safety policy because confidence is ${recommendation.confidenceLabel}${recommendation.unresolvedBoundary ? " and the search boundary was reached" : ""}`,
    `recommended now: ${recommendedNowSensX.toFixed(2)}% X; play at least ${policy.adaptationRetestSessions} session(s) to adapt`,
    "retest afterwards; if the fuller change still measures better, take the next step",
  ];

  const plan: SensitivityChangePlan = {
    policyApplied: true,
    currentSensX: currentSensitivity.sensX,
    recommendedNowSensX,
    recommendedNowEdpi:
      (recommendation.recommendedEdpi /
        recommendation.primarySensitivity.sensX) *
      recommendedNowSensX,
    fullInferredSensX: recommendation.primarySensitivity.sensX,
    stepOctavesAllowed: policy.maxImmediateStepOctaves,
    rationaleLines,
    retestAfterSessions: policy.adaptationRetestSessions,
  };

  return {
    ...recommendation,
    primarySensitivity: {
      sensX: recommendedNowSensX,
      sensY: recommendedNowSensX,
    },
    recommendedEdpi: plan.recommendedNowEdpi,
    warnings: [
      ...recommendation.warnings,
      "staged-change safety applied: the headline value is a bounded first step, not the full inferred optimum",
    ],
    rationaleLines: [...recommendation.rationaleLines, ...rationaleLines],
    sensitivityChangePlan: plan,
  };
}
