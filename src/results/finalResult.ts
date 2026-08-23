import type { Recommendation } from "../domain/recommendation.ts";
import type { CaptureQualitySummary } from "../diagnostics/captureQuality.ts";
import type { NextTestPlan } from "../session/retest.ts";
import { APP_VERSION, ENGINE_VERSION } from "../version.ts";

/**
 * Frozen V1 production results contract (Pass 5, requirement L).
 *
 * `buildFinalResult` assembles THE object a results screen renders. It reads
 * exclusively from engine-produced artifacts (recommendation, capture-quality
 * summary, calibration state, retest plan) — presentation code must never
 * recompute any of these values (docs/UI-CONTRACT.md §4).
 */

export interface CalibrationStateSummary {
  adequate: boolean;
  stale: boolean;
  /** Human-readable context line for display verbatim. */
  detailLine: string;
}

export interface FinalResultInput {
  recommendation: Recommendation;
  dpi: number;
  /** Player's CURRENT configured sensitivity (pre-experiment baseline). */
  currentSensXPercent: number;
  currentSensYPercent: number;
  calibration: CalibrationStateSummary | null;
  /** Engine-built next-test decision (already includes rest limits). */
  retestPlan: NextTestPlan | null;
}

export type RecommendedNextAction =
  | "apply-recommended-change"
  | "apply-staged-change"
  | "run-targeted-retest"
  | "run-clean-repeat"
  | "recalibrate-first"
  | "collect-more-sessions"
  | "keep-current-settings";

export interface FinalResult {
  contractVersion: "final-result-v1";
  appVersion: string;
  engineVersion: string;

  experimentId: string;

  // ---- headline numbers ----
  currentSensitivity: { sensXPercent: number; sensYPercent: number; edpi: number };
  immediateRecommended: { sensXPercent: number; sensYPercent: number; edpi: number };
  /** Present ONLY when staged-change safety bounded the immediate step. */
  fullInferredSensitivity: { sensXPercent: number; sensYPercent: number; edpi: number } | null;
  dpi: number;

  // ---- ranges ----
  plausibleXRangePercent: { min: number; max: number };
  plausibleYRangePercent: { min: number; max: number };
  plausibleEdpiRange: { min: number; max: number };

  // ---- certainty ----
  confidence: number;
  confidenceLabel: string;
  confidenceBasis: string;
  refusedHighConfidence: boolean;

  // ---- quality classifications ----
  captureQualityGrade: string | null;
  captureQualityScore: number | null;
  searchAdequacyClassification: string | null;
  boundaryStatus: "resolved" | "unresolved";
  adaptationContamination: boolean;

  // ---- narrative ----
  rationaleLines: string[];
  whyThisX: string[];
  whyThisY: string[];
  contradictoryEvidence: string[];
  uncertaintyRemaining: string[];

  // ---- evidence tables ----
  candidateComparisons: {
    candidateId: string;
    edpiX: number;
    utilityMean: number | null;
    utilityStandardError: number | null;
    validTrials: number;
    tiedWithBest: boolean | null;
    isBest: boolean;
  }[];
  scenarioContributions: {
    scenarioId: string;
    difficultyTier: string;
    validTrials: number;
    meanUtilityBest: number | null;
    meanUtilityRunnerUp: number | null;
  }[];
  excludedTrials: { count: number; reasonsByCode: Record<string, number> };

  // ---- environment state ----
  calibrationState: CalibrationStateSummary | null;

  // ---- actions ----
  recommendedNextAction: RecommendedNextAction;
  nextActionRationale: string[];
  retestProtocol: NextTestPlan | null;
  warnings: string[];
}

/** Derives the single recommended next action (engine-side, never UI-side). */
function decideNextAction(input: FinalResultInput): {
  action: RecommendedNextAction;
  rationale: string[];
} {
  const rec = input.recommendation;
  const rationale: string[] = [];
  if (input.calibration && (!input.calibration.adequate || input.calibration.stale)) {
    rationale.push("physical calibration is missing or flagged stale");
    return { action: "recalibrate-first", rationale };
  }
  if (input.retestPlan && input.retestPlan.kind === "targeted-retest") {
    rationale.push(...input.retestPlan.rationaleLines);
    return { action: "run-targeted-retest", rationale };
  }
  if (input.retestPlan && input.retestPlan.kind === "repeat-session") {
    rationale.push(...input.retestPlan.rationaleLines);
    return { action: "run-clean-repeat", rationale };
  }
  if (
    rec.sensitivityChangePlan?.policyApplied === true &&
    rec.sensitivityChangePlan.recommendedNowSensX !== rec.sensitivityChangePlan.fullInferredSensX
  ) {
    rationale.push(
      ...rec.sensitivityChangePlan.rationaleLines,
      `retest after ${rec.sensitivityChangePlan.retestAfterSessions} more session(s) before moving to the full inferred value`,
    );
    return { action: "apply-staged-change", rationale };
  }
  if (rec.furtherTestingSuggested || rec.confidence < 0.5) {
    rationale.push(
      "confidence is not yet high enough to justify changing settings",
      ...(rec.explanation?.furtherTestingActions.slice(0, 3) ?? []),
    );
    return { action: "collect-more-sessions", rationale };
  }
  if (rec.primarySensitivity.sensX === input.currentSensXPercent) {
    rationale.push("the measured optimum matches your current setting within resolution");
    return { action: "keep-current-settings", rationale };
  }
  rationale.push(
    ...rec.rationaleLines.slice(0, 3),
    "confidence is sufficient and no boundary/adaptation caveats remain",
  );
  return { action: "apply-recommended-change", rationale };
}

export function buildFinalResult(input: FinalResultInput): FinalResult {
  const rec = input.recommendation;
  const dpi = input.dpi;

  const recommendedNowSensX =
    rec.sensitivityChangePlan?.recommendedNowSensX ?? rec.primarySensitivity.sensX;
  const recommendedNowSensY = rec.primarySensitivity.sensY;
  const stagedApplied =
    rec.sensitivityChangePlan?.policyApplied === true &&
    rec.sensitivityChangePlan.fullInferredSensX !== rec.sensitivityChangePlan.recommendedNowSensX;

  const yRatioRange = rec.jointXY?.plausibleYRatioRange ?? null;
  const xMin = rec.sensXRange.min;
  const xMax = rec.sensXRange.max;

  const captureGrade = rec.captureQualitySession?.grade ?? null;
  const captureScore = rec.captureQualitySession?.score ?? null;

  const next = decideNextAction(input);

  return {
    contractVersion: "final-result-v1",
    appVersion: APP_VERSION,
    engineVersion: ENGINE_VERSION,
    experimentId: rec.experimentId,

    currentSensitivity: {
      sensXPercent: input.currentSensXPercent,
      sensYPercent: input.currentSensYPercent,
      edpi: Math.round(dpi * input.currentSensXPercent),
    },
    immediateRecommended: {
      sensXPercent: recommendedNowSensX,
      sensYPercent: recommendedNowSensY,
      edpi: Math.round(dpi * recommendedNowSensX),
    },
    fullInferredSensitivity: stagedApplied
      ? {
          sensXPercent: rec.sensitivityChangePlan!.fullInferredSensX,
          sensYPercent: recommendedNowSensY,
          edpi: Math.round(dpi * rec.sensitivityChangePlan!.fullInferredSensX),
        }
      : null,
    dpi,

    plausibleXRangePercent: { min: xMin, max: xMax },
    plausibleYRangePercent:
      yRatioRange !== null
        ? {
            min: Number((xMin * yRatioRange.min).toFixed(4)),
            max: Number((xMax * yRatioRange.max).toFixed(4)),
          }
        : { min: xMin, max: xMax },
    plausibleEdpiRange: rec.edpiRange,

    confidence: rec.confidence,
    confidenceLabel: rec.confidenceLabel,
    confidenceBasis:
      rec.confidenceCalibration?.basis ??
      `heuristic (${rec.confidenceCalibration?.heuristicVersion ?? "unversioned"})`,
    refusedHighConfidence: rec.refusedHighConfidence,

    captureQualityGrade: captureGrade,
    captureQualityScore: captureScore,
    searchAdequacyClassification: rec.curveAdequacy?.shape ?? null,
    boundaryStatus: rec.unresolvedBoundary ? "unresolved" : "resolved",
    adaptationContamination: rec.changePointAnalysis?.contaminationDetected ?? false,

    rationaleLines: [...rec.rationaleLines],
    whyThisX: [...(rec.explanation?.whyThisX ?? [])],
    whyThisY: [...(rec.explanation?.whyThisY ?? [])],
    contradictoryEvidence: [...(rec.explanation?.evidenceAgainstWinner ?? [])],
    uncertaintyRemaining: [
      ...(rec.explanation?.uncertaintyRemaining ?? []),
      ...(rec.warnings.length > 0 ? ["warnings:"] : []),
      ...rec.warnings,
    ],

    candidateComparisons: (rec.explanation?.candidatesTested ?? []).map((c) => ({
      candidateId: c.candidateId,
      edpiX: c.edpiX,
      utilityMean: c.utilityMean,
      utilityStandardError: c.utilityStandardError,
      validTrials: c.validTrials,
      tiedWithBest: c.tiedWithBest,
      isBest: c.candidateId === rec.evidence.bestCandidateId,
    })),
    scenarioContributions: (rec.explanation?.scenarioContributions ?? []).map((s) => ({
      scenarioId: s.scenarioId,
      difficultyTier: s.difficultyTier,
      validTrials: s.validTrials,
      meanUtilityBest: s.meanUtilityBest,
      meanUtilityRunnerUp: s.meanUtilityRunnerUp,
    })),
    excludedTrials: {
      count: rec.evidence.trialsExcluded,
      reasonsByCode: Object.fromEntries(
        Object.entries(rec.evidence.exclusionReasonCounts).filter(
          (entry): entry is [string, number] => typeof entry[1] === "number",
        ),
      ),
    },

    calibrationState: input.calibration,

    recommendedNextAction: next.action,
    nextActionRationale: next.rationale.filter((l): l is string => typeof l === "string"),
    retestProtocol: input.retestPlan,
    warnings: [...rec.warnings],
  };
}

/** Re-export for consumers that want the summary shape without importing diagnostics. */
export type { CaptureQualitySummary };
