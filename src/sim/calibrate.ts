import type { ExperimentDefinition } from "../domain/experiment.ts";
import { buildExperimentDefinition } from "../experiments/protocol.ts";
import {
  DEFAULT_OPTIMIZER_CONFIG,
  computeScenarioCenters,
  evaluateCandidate,
} from "../optimizer/index-helpers.ts";
import { fitQuadraticWeighted } from "../optimizer/quadratic.ts";
import type { SyntheticPlayerConfig } from "./player.ts";
import { SyntheticExperimentRunner } from "./simulator.ts";
import type { TrialRecord } from "../domain/trial.ts";

export interface CalibrationOptions {
  dpi: number;
  baselineSensitivityPercent: number;
  repsPerCandidatePerRound?: number;
  rounds?: number;
  seedBase?: number;
}

const CALIBRATION_LADDER = [
  1 / 2.2,
  1 / 1.6,
  1 / 1.25,
  1 / 1.08,
  1,
  1.08,
  1.25,
  1.6,
  2.2,
];

function buildCalibrationDefinition(
  options: CalibrationOptions,
): ExperimentDefinition {
  return buildExperimentDefinition({
    id: "experiment-calibration",
    name: "monte-carlo calibration",
    baselineSensitivity: {
      sensX: options.baselineSensitivityPercent,
      sensY: options.baselineSensitivityPercent,
    },
    dpi: options.dpi,
    ladderFactors: CALIBRATION_LADDER,
    measuredRepsPerCandidatePerRound: options.repsPerCandidatePerRound ?? 16,
    warmupTrialsPerCandidateBlock: 1,
  });
}

export interface CalibrationResult {
  compositeOptimumEdpi: number;
  method: "quadratic-vertex" | "raw-best-grid-point";
  bestGridEdpi: number;
}

export function estimateCompositeOptimumEdpi(
  player: SyntheticPlayerConfig,
  options: CalibrationOptions,
): CalibrationResult {
  const def = buildCalibrationDefinition(options);
  const runner = new SyntheticExperimentRunner(def, player);
  const trialsByCandidate = new Map<string, TrialRecord[]>();
  const rounds = options.rounds ?? 3;
  const seedBase = options.seedBase ?? 900001;
  for (let round = 0; round < rounds; round++) {
    const trials = runner.runRound(round, seedBase + round, "session-mc", def.id);
    for (const trial of trials) {
      if (trial.phase !== "measured") continue;
      const list = trialsByCandidate.get(trial.candidateId!) ?? [];
      list.push(trial);
      trialsByCandidate.set(trial.candidateId!, list);
    }
  }
  const centers = computeScenarioCenters(
    def,
    trialsByCandidate,
    DEFAULT_OPTIMIZER_CONFIG.exclusionPolicy,
  );
  const points: { x: number; y: number; weight: number }[] = [];
  let bestEdpi = Number.NaN;
  let bestUtility = Number.NEGATIVE_INFINITY;
  let bestX = 0;
  for (const [, trials] of trialsByCandidate) {
    const evaluation = evaluateCandidate(
      def,
      trials,
      DEFAULT_OPTIMIZER_CONFIG.exclusionPolicy,
      undefined,
      centers,
    )!;
    if (evaluation.utilityMean > bestUtility) {
      bestUtility = evaluation.utilityMean;
      bestEdpi = evaluation.edpi;
      bestX = evaluation.log2RatioVsBaseline;
    }
    if (Math.abs(evaluation.log2RatioVsBaseline) <= 0.55) {
      points.push({
        x: evaluation.log2RatioVsBaseline,
        y: evaluation.utilityMean,
        weight: 1 / Math.max(evaluation.utilityStandardError, 1e-4) ** 2,
      });
    }
  }
  if (Number.isNaN(bestEdpi)) {
    throw new Error("calibration failed to identify any candidate utility");
  }
  const baselineEdpi = options.dpi * options.baselineSensitivityPercent;
  const fit = fitQuadraticWeighted(points);
  if (
    fit?.vertexX != null &&
    Math.abs(fit.vertexX - bestX) <= 0.3
  ) {
    const vertexEdpi = baselineEdpi * Math.pow(2, fit.vertexX);
    if (vertexEdpi >= options.dpi && vertexEdpi <= 16000) {
      return {
        compositeOptimumEdpi: vertexEdpi,
        method: "quadratic-vertex",
        bestGridEdpi: bestEdpi,
      };
    }
  }
  return {
    compositeOptimumEdpi: bestEdpi,
    method: "raw-best-grid-point",
    bestGridEdpi: bestEdpi,
  };
}
