import type {
  AimDimension,
  DimensionEstimate,
} from "../domain/recommendation.ts";
import type { ExperimentDefinition } from "../domain/experiment.ts";
import type { SensitivityCandidate } from "../domain/candidate.ts";
import { scenarioById } from "../domain/scenario.ts";
import type { TrialRecord } from "../domain/trial.ts";
import { coefficientOfVariation, clamp01, meanAndStandardError } from "../metrics/stats.ts";
import {
  DEFAULT_DIMENSION_SCORING,
  DEFAULT_UTILITY_WEIGHTS,
  scoreTrialDimensions,
  trialUtilityFromDimensions,
  type DimensionScoringConfig,
} from "./scoring.ts";

export interface ExclusionPolicy {
  fatalReasons: readonly string[];
  suspectPolicy: "exclude" | "include-with-flag";
}

export interface CandidateEvaluation {
  candidateId: string;
  candidate: SensitivityCandidate;
  edpi: number;
  log2RatioVsBaseline: number;
  trialsIncluded: TrialRecord[];
  trialsExcluded: number;
  exclusionReasonCounts: Record<string, number>;
  dimensionEstimates: Partial<Record<AimDimension, DimensionEstimate>>;
  perTrialUtilities: number[];
  utilityMean: number;
  utilityStandardError: number;
  consistencyScore: number;
  flaggedSuspectCount: number;
}

export type ScenarioCenterMap = Map<
  string,
  Partial<Record<AimDimension, number>>
>;

function isIncluded(trial: TrialRecord, policy: ExclusionPolicy): boolean {
  if (trial.validity.status === "invalid") return false;
  if (trial.validity.status === "suspect" && policy.suspectPolicy === "exclude") {
    return false;
  }
  return true;
}

export function computeScenarioCenters(
  definition: ExperimentDefinition,
  trialsByCandidate: ReadonlyMap<string, readonly TrialRecord[]>,
  policy: ExclusionPolicy,
  scoring: DimensionScoringConfig = DEFAULT_DIMENSION_SCORING,
): ScenarioCenterMap {
  const sums = new Map<
    string,
    Map<AimDimension, { total: number; count: number }>
  >();
  const consider = (trials: readonly TrialRecord[]): void => {
    for (const trial of trials) {
      if (trial.phase !== "measured") continue;
      if (!isIncluded(trial, policy)) continue;
      const scenario = definition.scenarioCatalog.find(
        (sc) => sc.id === trial.scenarioId,
      );
      const { dimensions } = scoreTrialDimensions(trial, scenario, scoring);
      let perScenario = sums.get(trial.scenarioId);
      if (!perScenario) {
        perScenario = new Map();
        sums.set(trial.scenarioId, perScenario);
      }
      for (const [dim, value] of Object.entries(dimensions)) {
        if (value === undefined) continue;
        const acc =
          perScenario.get(dim as AimDimension) ?? { total: 0, count: 0 };
        acc.total += value;
        acc.count += 1;
        perScenario.set(dim as AimDimension, acc);
      }
    }
  };
  for (const trials of trialsByCandidate.values()) consider(trials);
  const centers: ScenarioCenterMap = new Map();
  for (const [scenarioId, perDim] of sums) {
    const entry: Partial<Record<AimDimension, number>> = {};
    for (const [dim, acc] of perDim) {
      entry[dim] = acc.total / acc.count;
    }
    centers.set(scenarioId, entry);
  }
  return centers;
}

export function evaluateCandidate(
  definition: ExperimentDefinition,
  trials: readonly TrialRecord[],
  policy: ExclusionPolicy,
  scoring: DimensionScoringConfig = DEFAULT_DIMENSION_SCORING,
  scenarioCenters?: ScenarioCenterMap,
): CandidateEvaluation | null {
  const candidateId = trials[0]?.candidateId;
  if (!candidateId) return null;
  const candidate = definition.candidates.find((c) => c.id === candidateId);
  if (!candidate) throw new Error(`candidate ${candidateId} not in definition`);

  const included: TrialRecord[] = [];
  let excluded = 0;
  const reasonCounts: Record<string, number> = {};
  for (const trial of trials) {
    if (trial.phase !== "measured") continue;
    const status = trial.validity.status;
    let exclude = false;
    if (status === "invalid") {
      for (const r of trial.validity.reasons) {
        if (policy.fatalReasons.includes(r.code)) {
          exclude = true;
          reasonCounts[r.code] = (reasonCounts[r.code] ?? 0) + 1;
        }
      }
    } else if (status === "suspect" && policy.suspectPolicy === "exclude") {
      for (const r of trial.validity.reasons) {
        if (policy.fatalReasons.includes(r.code)) continue;
        reasonCounts[r.code] = (reasonCounts[r.code] ?? 0) + 1;
      }
      exclude = true;
    }
    if (exclude) excluded++;
    else included.push(trial);
  }

  const dimsAccum = new Map<AimDimension, number[]>();
  const utilitiesByKind = new Map<string, number[]>();
  for (const trial of included) {
    const scenario = definition.scenarioCatalog.find((s) => s.id === trial.scenarioId) ??
      (() => {
        try {
          return scenarioById(trial.scenarioId);
        } catch {
          return undefined;
        }
      })();
    const { dimensions } = scoreTrialDimensions(trial, scenario, scoring);
    const centered: Partial<Record<AimDimension, number>> = {};
    for (const [dim, value] of Object.entries(dimensions)) {
      if (value === undefined) continue;
      const center = scenarioCenters?.get(trial.scenarioId)?.[dim as AimDimension];
      const adjusted = center === undefined ? value : value - center;
      centered[dim as AimDimension] = Math.max(-1, Math.min(1, adjusted));
    }
    const utility = trialUtilityFromDimensions(centered, DEFAULT_UTILITY_WEIGHTS);
    for (const [dim, value] of Object.entries(centered)) {
      if (value === undefined) continue;
      const list = dimsAccum.get(dim as AimDimension) ?? [];
      list.push(value);
      dimsAccum.set(dim as AimDimension, list);
    }
    if (utility !== null) {
      const kindKey = trial.scenarioKind === "tracking" ? "tracking" : "flick";
      const kindList = utilitiesByKind.get(kindKey) ?? [];
      kindList.push(utility);
      utilitiesByKind.set(kindKey, kindList);
    }
  }

  const dimensionEstimates: Partial<Record<AimDimension, DimensionEstimate>> = {};
  for (const [dim, values] of dimsAccum) {
    const est = meanAndStandardError(values);
    if (est) {
      dimensionEstimates[dim] = {
        mean: est.mean,
        standardError: est.standardError,
        sampleCount: est.sampleCount,
      };
    }
  }

  let weightSum = 0;
  for (const [dim, weight] of Object.entries(DEFAULT_UTILITY_WEIGHTS)) {
    if (dimensionEstimates[dim as AimDimension]) weightSum += weight;
  }
  let weightedMean = 0;
  let varianceSum = 0;
  if (weightSum > 0) {
    for (const [dim, weight] of Object.entries(DEFAULT_UTILITY_WEIGHTS)) {
      const estimate = dimensionEstimates[dim as AimDimension];
      if (!estimate) continue;
      const share = weight / weightSum;
      weightedMean += share * estimate.mean;
      varianceSum +=
        share * share * estimate.standardError * estimate.standardError;
    }
  }

  const largestKindUtilities =
    [...utilitiesByKind.values()].sort((a, b) => b.length - a.length)[0] ?? [];

  return {
    candidateId,
    candidate,
    edpi: definition.dpi * candidate.sensitivity.sensX,
    log2RatioVsBaseline: Math.log2(
      (definition.dpi * candidate.sensitivity.sensX) /
        (definition.dpi * definition.baselineSensitivity.sensX),
    ),
    trialsIncluded: included,
    trialsExcluded: excluded,
    exclusionReasonCounts: reasonCounts,
    dimensionEstimates,
    perTrialUtilities: largestKindUtilities,
    utilityMean: weightSum > 0 ? weightedMean : 0,
    utilityStandardError:
      weightSum > 0 ? Math.sqrt(varianceSum) : Number.POSITIVE_INFINITY,
    consistencyScore:
      largestKindUtilities.length >= 2
        ? clamp01(1 - coefficientOfVariation(largestKindUtilities))
        : 0.5,
    flaggedSuspectCount: included.filter((t) => t.validity.status === "suspect").length,
  };
}
