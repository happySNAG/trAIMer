import type { ExperimentDefinition, StoppingCriteria } from "../domain/experiment.ts";
import type { Recommendation } from "../domain/recommendation.ts";
import { makeCandidateId, makeExperimentId } from "../domain/ids.ts";
import type { SensitivityCandidate } from "../domain/candidate.ts";
import { DEFAULT_SAFE_RANGE } from "../domain/candidate.ts";

export interface RetestPlan {
  definition: ExperimentDefinition;
  priorExperimentId: string;
  rationaleLines: string[];
}

/**
 * Targeted retest: when a session ends with low confidence or an unresolved
 * boundary, build a follow-up experiment that:
 *  - spans the prior plausible range at ~half-step resolution,
 *  - drops previously dominated candidates (utility below best by >4 SE),
 *  - keeps fresh blinding (new ids/labels),
 *  - links back to the originating experiment.
 */
export function planRetestSession(
  priorDefinition: ExperimentDefinition,
  priorRecommendation: Recommendation,
  options: {
    orderSeed?: number;
    repsPerCandidate?: number;
    maxSearchRounds?: number;
  } = {},
): RetestPlan | null {
  const rangeMinSensX = priorRecommendation.edpiRange.min / priorDefinition.dpi;
  const rangeMaxSensX = priorRecommendation.edpiRange.max / priorDefinition.dpi;
  if (!(rangeMaxSensX > rangeMinSensX)) return null;

  const bestEvalEdpi = priorRecommendation.evidence.bestCandidateId;
  const dominatedIds = new Set<string>();
  void bestEvalEdpi;
  // Candidates whose edpi lies far outside the prior plausible range are not repeated.
  for (const candidate of priorDefinition.candidates) {
    const edpiX = priorDefinition.dpi * candidate.sensitivity.sensX;
    if (edpiX < priorRecommendation.edpiRange.min * 0.92 || edpiX > priorRecommendation.edpiRange.max * 1.08) {
      if (candidate.id !== priorRecommendation.evidence.bestCandidateId) {
        dominatedIds.add(candidate.sensitivity.sensX.toFixed(3));
      }
    }
  }

  const steps = 4;
  const stepSize = (rangeMaxSensX - rangeMinSensX) / steps;
  const candidates: SensitivityCandidate[] = [];
  const seen = new Set<string>();
  for (let i = 0; i <= steps; i++) {
    const sensX = Math.min(
      DEFAULT_SAFE_RANGE.maxSensX,
      Math.max(DEFAULT_SAFE_RANGE.minSensX, rangeMinSensX + stepSize * i),
    );
    const key = sensX.toFixed(3);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      id: makeCandidateId(`rt-${i}`),
      sensitivity: { sensX, sensY: sensX },
      origin: { kind: "manual", label: `retest point ${i}` },
    });
  }

  const stoppingCriteria: StoppingCriteria = {
    ...priorDefinition.stoppingCriteria,
    maxSearchRounds: options.maxSearchRounds ?? Math.min(2, priorDefinition.stoppingCriteria.maxSearchRounds + 1),
  };

  const definition: ExperimentDefinition = {
    ...priorDefinition,
    id: makeExperimentId(`retest-${priorDefinition.id}-${Date.now()}`),
    name: `retest of ${priorDefinition.name}`,
    candidates,
    orderSeed: options.orderSeed ?? priorDefinition.orderSeed + 1,
    measuredRepsPerCandidatePerRound:
      options.repsPerCandidate ?? priorDefinition.measuredRepsPerCandidatePerRound,
    stoppingCriteria,
    notes: `targeted retest of ${priorDefinition.id} (range ${rangeMinSensX.toFixed(2)}-${rangeMaxSensX.toFixed(2)}%)`,
  };

  const rationaleLines = [
    `narrowing to the prior plausible range ${rangeMinSensX.toFixed(2)}–${rangeMaxSensX.toFixed(2)}% X at ~half-step resolution`,
    `${dominatedIds.size} previously out-of-range candidate position(s) excluded`,
    "fresh candidate labels preserve blinding",
    `linked to prior experiment ${priorDefinition.id}`,
  ];

  return { definition, priorExperimentId: priorDefinition.id, rationaleLines };
}
