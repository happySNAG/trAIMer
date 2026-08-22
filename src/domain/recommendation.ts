import type { SensitivityConfiguration } from "./settings.ts";

export type AimDimension =
  | "speed"
  | "accuracy"
  | "overshootControl"
  | "undershootControl"
  | "correctionEfficiency"
  | "trackingPrecision"
  | "consistency";

export const AIM_DIMENSIONS: readonly AimDimension[] = [
  "speed",
  "accuracy",
  "overshootControl",
  "undershootControl",
  "correctionEfficiency",
  "trackingPrecision",
  "consistency",
];

export type ConfidenceLabel = "low" | "moderate" | "high";

export interface DimensionEstimate {
  mean: number;
  standardError: number;
  sampleCount: number;
}

export interface Evidence {
  trialsAnalyzed: number;
  trialsExcluded: number;
  exclusionReasonCounts: Partial<Record<string, number>>;
  candidatesEvaluated: number;
  validTrialsPerCandidate: Record<string, number>;
  bestCandidateId: string;
  runnerUpCandidateId: string | null;
  utilityGapBestVsRunnerUp: number | null;
  utilityGapZScore: number | null;
  separation: "clear" | "weak" | "insufficient";
  searchRoundsRun: number;
  notes: string[];
}

export interface Recommendation {
  experimentId: string;
  primarySensitivity: SensitivityConfiguration;
  recommendedEdpi: number;
  sensXRange: { min: number; max: number };
  edpiRange: { min: number; max: number };
  confidence: number;
  confidenceLabel: ConfidenceLabel;
  dimensionEstimates: Partial<Record<AimDimension, DimensionEstimate>>;
  utilityWeights: Record<AimDimension, number>;
  evidence: Evidence;
  warnings: string[];
  refusedHighConfidence: boolean;
  rationaleLines: string[];
  unresolvedBoundary: boolean;
  yExploration?: YExplorationSummary | undefined;
  furtherTestingSuggested: boolean;
}

export interface YExplorationSummary {
  explored: boolean;
  recommendedEqualY: boolean;
  bestUnequalYCandidateId: string | null;
  improvementZ: number | null;
  rationaleLines: string[];
}
