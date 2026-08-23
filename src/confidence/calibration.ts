import type { ConfidenceCalibrationMetadata } from "../domain/recommendation.ts";
import type { InputQualityReport } from "../diagnostics/inputQuality.ts";

export const HEURISTIC_CONFIDENCE_VERSION = "heuristic-v2";

export interface ConfidenceDiagnosticInput {
  trialsAnalyzed: number;
  candidatesEvaluated: number;
  utilityGapZ: number | null;
  separation: string;
  unresolvedBoundary: boolean;
  searchRoundsRun: number;
  inputQuality: InputQualityReport | null;
}

/**
 * Pass 3 framework: confidence remains heuristic. This module attaches
 * structured diagnostics so a future empirical calibration can map from these
 * diagnostics (plus test/retest outcomes) to calibrated confidence WITHOUT
 * changing the recommendation shape.
 *
 * The heuristic value is NEVER presented as a validated probability.
 */
export function buildConfidenceCalibration(
  input: ConfidenceDiagnosticInput,
): ConfidenceCalibrationMetadata {
  const notes: string[] = [
    "confidence is heuristic; it is NOT an empirically validated probability",
    "empirical calibration becomes available once repeated test/retest sessions provide outcome data",
  ];
  if (input.inputQuality?.warnings.unsuitableForHighConfidence) {
    notes.push("capture quality below threshold; confidence further reduced");
  }
  return {
    basis: "heuristic",
    heuristicVersion: HEURISTIC_CONFIDENCE_VERSION,
    diagnostics: {
      trialsAnalyzed: input.trialsAnalyzed,
      candidatesEvaluated: input.candidatesEvaluated,
      utilityGapZ: input.utilityGapZ,
      separation: input.separation,
      unresolvedBoundary: input.unresolvedBoundary,
      inputQualityScore: input.inputQuality?.score ?? null,
      searchRoundsRun: input.searchRoundsRun,
    },
    empiricalModelVersion: null,
    notes,
  };
}

/**
 * Reserved seam for future empirical mapping. Given reliability outcomes
 * (e.g., test/retest drift), an empirical model will output a calibrated
 * confidence in [0,1] plus its version. Not wired yet by design.
 */
export interface EmpiricalConfidenceMapping {
  modelVersion: string;
  trainedOnSessionPairs: number;
  predict(diagnostics: ConfidenceDiagnosticInput, priorDriftOctaves: number | null): {
    calibratedConfidence: number;
    basis: "empirical";
  };
}

export function applyEmpiricalMappingIfAvailable(
  metadata: ConfidenceCalibrationMetadata,
  _mapping: EmpiricalConfidenceMapping | null,
): ConfidenceCalibrationMetadata {
  void _mapping;
  return metadata;
}
