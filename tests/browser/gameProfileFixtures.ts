import type { Recommendation } from "../../src/domain/recommendation.ts";
import type { FinalResult } from "../../src/results/finalResult.ts";

/**
 * A finished session's recommendation and final result, for driving the
 * production results view through the E2E hooks. The recommendation is 8.4%
 * against a 7% baseline: a 1.2× change, which every game-profile assertion
 * in the browser suites is written against.
 */
export function recommendation(): Recommendation {
  return {
    experimentId: "experiment-game-e2e",
    primarySensitivity: { sensX: 8.4, sensY: 8.4 },
    recommendedEdpi: 6720,
    sensXRange: { min: 7.6, max: 9.2 },
    edpiRange: { min: 6080, max: 7360 },
    confidence: 0.66,
    confidenceLabel: "moderate",
    dimensionEstimates: {},
    utilityWeights: {},
    evidence: {
      trialsAnalyzed: 30,
      trialsExcluded: 0,
      exclusionReasonCounts: {},
      candidatesEvaluated: 5,
      validTrialsPerCandidate: {},
      bestCandidateId: "cand-c",
      runnerUpCandidateId: "cand-b",
      utilityGapBestVsRunnerUp: 0.05,
      utilityGapZScore: 2.1,
      separation: "clear",
      searchRoundsRun: 1,
      notes: [],
    },
    warnings: [],
    refusedHighConfidence: false,
    rationaleLines: ["the faster candidate led on accuracy"],
    unresolvedBoundary: false,
    furtherTestingSuggested: false,
  } as unknown as Recommendation;
}

export function finalResult(rec: Recommendation): FinalResult {
  return {
    contractVersion: "final-result-v1",
    appVersion: "test",
    engineVersion: "engine-v4",
    experimentId: rec.experimentId,
    currentSensitivity: { sensXPercent: 7, sensYPercent: 7, edpi: 5600 },
    immediateRecommended: { sensXPercent: 8.4, sensYPercent: 8.4, edpi: 6720 },
    fullInferredSensitivity: null,
    dpi: 800,
    plausibleXRangePercent: { min: 7.6, max: 9.2 },
    plausibleYRangePercent: { min: 7.6, max: 9.2 },
    plausibleEdpiRange: { min: 6080, max: 7360 },
    confidence: rec.confidence,
    confidenceLabel: rec.confidenceLabel,
    confidenceBasis: "heuristic (v1)",
    refusedHighConfidence: false,
    captureQualityGrade: "acceptable",
    captureQualityScore: 0.72,
    searchAdequacyClassification: "clear-optimum",
    boundaryStatus: "resolved",
    adaptationContamination: false,
    rationaleLines: rec.rationaleLines,
    whyThisX: [],
    whyThisY: [],
    contradictoryEvidence: [],
    uncertaintyRemaining: [],
    candidateComparisons: [],
    scenarioContributions: [],
    excludedTrials: { count: 0, reasonsByCode: {} },
    calibrationState: null,
    recommendedNextAction: "apply-recommended-change",
    nextActionRationale: [],
    retestProtocol: null,
    warnings: [],
  } as unknown as FinalResult;
}

