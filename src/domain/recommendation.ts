import type { SensitivityConfiguration } from "./settings.ts";
import type { InputQualityReport } from "../diagnostics/inputQuality.ts";
import type { AdaptationReport } from "../optimizer/adaptation.ts";
import type { CurveAdequacy } from "../optimizer/adequacy.ts";
import type { SessionAdaptationReport } from "../optimizer/changepoint.ts";
import type { JointXYSummary } from "../optimizer/jointXY.ts";
import type { PairedEffectsResult } from "../optimizer/pairedFit.ts";
import type { CaptureQualitySummary } from "../diagnostics/captureQuality.ts";

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
  confidenceCalibration?: ConfidenceCalibrationMetadata | undefined;
  explanation?: RecommendationExplanation | undefined;
  sensitivityChangePlan?: SensitivityChangePlan | undefined;
  inputQuality?: InputQualityReport | null | undefined;
  adaptationEffects?: AdaptationReport | undefined;
  /** Pass 4 additions — all additive and optional for backward compatibility. */
  curveAdequacy?: CurveAdequacy | undefined;
  changePointAnalysis?: SessionAdaptationReport | undefined;
  jointXY?: JointXYSummary | undefined;
  pairedFit?: PairedEffectsResult["diagnostics"] | undefined;
  captureQualitySession?: CaptureQualitySummary | undefined;
  engineVersion?: string | undefined;
  appVersion?: string | undefined;
}



export interface ConfidenceCalibrationMetadata {
  basis: "heuristic";
  heuristicVersion: string;
  diagnostics: {
    trialsAnalyzed: number;
    candidatesEvaluated: number;
    utilityGapZ: number | null;
    separation: string;
    unresolvedBoundary: boolean;
    inputQualityScore: number | null;
    searchRoundsRun: number;
  };
  empiricalModelVersion: null;
  notes: string[];
}

export interface CandidateExplanationRow {
  candidateId: string;
  edpiX: number;
  utilityMean: number | null;
  utilityStandardError: number | null;
  validTrials: number;
  tiedWithBest: boolean | null;
}

export interface ScenarioContribution {
  scenarioId: string;
  difficultyTier: string;
  validTrials: number;
  meanUtilityBest: number | null;
  meanUtilityRunnerUp: number | null;
}

export interface RecommendationExplanation {
  whyThisX: string[];
  whyThisY: string[];
  candidatesTested: CandidateExplanationRow[];
  scenarioContributions: ScenarioContribution[];
  evidenceForWinner: string[];
  evidenceAgainstWinner: string[];
  uncertaintyRemaining: string[];
  furtherTestingActions: string[];
  boundaryReached: boolean;
  captureQualityAdequate: boolean | null;
}

export interface SensitivityChangePlan {
  policyApplied: boolean;
  currentSensX: number;
  recommendedNowSensX: number;
  recommendedNowEdpi: number;
  fullInferredSensX: number;
  stepOctavesAllowed: number;
  rationaleLines: string[];
  retestAfterSessions: number;
}

export interface YExplorationSummary {
  explored: boolean;
  recommendedEqualY: boolean;
  bestUnequalYCandidateId: string | null;
  improvementZ: number | null;
  rationaleLines: string[];
}
