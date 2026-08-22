import type { SensitivityCandidate } from "../domain/candidate.ts";
import { DEFAULT_SAFE_RANGE } from "../domain/candidate.ts";
import { makeCandidateId } from "../domain/ids.ts";
import type { ExperimentDefinition, YExplorationConfig } from "../domain/experiment.ts";
import type { TrialRecord } from "../domain/trial.ts";
import { clampToSafeRange } from "../sensmath/candidates.ts";
import type { ExclusionPolicy } from "./evaluate.ts";
import {
  computeCellUtilities,
  computePairedComparisons,
  lookupComparison,
} from "./paired.ts";
import type { YExplorationSummary } from "../domain/recommendation.ts";

export interface YStagePlan {
  anchorCandidateId: string;
  candidates: SensitivityCandidate[];
}

export function planYExploration(
  config: YExplorationConfig,
  bestCandidate: SensitivityCandidate,
): YStagePlan | null {
  if (!config.enabled) return null;
  const varying = config.yFactors.filter((f) => Math.abs(f - 1) > 1e-9);
  if (varying.length === 0) return null;
  const anchorX = bestCandidate.sensitivity.sensX;
  const candidates: SensitivityCandidate[] = [
    {
      id: makeCandidateId("y-anchor-equal"),
      sensitivity: clampToSafeRange(
        { sensX: anchorX, sensY: anchorX },
        DEFAULT_SAFE_RANGE,
      ),
      origin: { kind: "manual", label: "y-exploration equal-Y anchor" },
    },
  ];
  for (const factor of [...varying].sort((a, b) => a - b)) {
    const sensY = clampToSafeRange(
      { sensX: anchorX, sensY: anchorX * factor },
      DEFAULT_SAFE_RANGE,
    ).sensY;
    const percentLabel = Math.round((factor - 1) * 100);
    candidates.push({
      id: makeCandidateId(`y-var-${percentLabel >= 0 ? "p" : "m"}${Math.abs(percentLabel)}`),
      sensitivity: { sensX: anchorX, sensY },
      origin: {
        kind: "manual",
        label: `y-exploration Y×${factor.toFixed(3)}`,
      },
    });
  }
  return { anchorCandidateId: candidates[0]!.id, candidates };
}

export interface YEvaluationInput {
  definition: ExperimentDefinition;
  trialsByCandidate: ReadonlyMap<string, readonly TrialRecord[]>;
  policy: ExclusionPolicy;
  plan: YStagePlan;
  config: YExplorationConfig;
}

export function evaluateYExploration(input: YEvaluationInput): YExplorationSummary {
  const { definition, trialsByCandidate, policy, plan, config } = input;
  const cellUtilities = computeCellUtilities(definition, trialsByCandidate, policy);
  const comparisons = computePairedComparisons(trialsByCandidate, cellUtilities);

  const anchorTrials = trialsByCandidate.get(plan.anchorCandidateId);
  let bestUnequalId: string | null = null;
  let bestZ = Number.NEGATIVE_INFINITY;
  for (const candidate of plan.candidates) {
    if (candidate.id === plan.anchorCandidateId) continue;
    if ((anchorTrials?.length ?? 0) < 2) continue;
    const comparison = lookupComparison(
      comparisons,
      candidate.id,
      plan.anchorCandidateId,
    );
    if (!comparison || comparison.pairedCells < 3) continue;
    if (comparison.z > bestZ) {
      bestZ = comparison.z;
      bestUnequalId = candidate.id;
    }
  }

  const recommendedEqualY =
    bestUnequalId === null || bestZ < config.minImprovementZ;

  const rationaleLines: string[] = [
    `independent-Y exploration tested ${plan.candidates.length - 1} unequal-Y variants against an equal-Y anchor at fixed X`,
  ];
  if (bestUnequalId === null) {
    rationaleLines.push(
      "insufficient paired data to compare unequal-Y variants; recommending sensY = sensX",
    );
  } else {
    rationaleLines.push(
      `best unequal-Y variant improved utility by z=${bestZ.toFixed(2)} against threshold ${config.minImprovementZ}`,
    );
    rationaleLines.push(
      recommendedEqualY
        ? "no reliable independent-Y advantage found; recommending sensY = sensX"
        : "reliable independent-Y advantage found; recommending sensY ≠ sensX within the tested range",
    );
  }

  return {
    explored: true,
    recommendedEqualY,
    bestUnequalYCandidateId: bestUnequalId,
    improvementZ: bestUnequalId === null ? null : bestZ,
    rationaleLines,
  };
}
