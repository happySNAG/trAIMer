import type {
  Recommendation,
  RecommendationExplanation,
  CandidateExplanationRow,
  ScenarioContribution,
} from "../domain/recommendation.ts";
import type { ExperimentDefinition } from "../domain/experiment.ts";
import type { CandidateEvaluation } from "./evaluate.ts";
import type { InputQualityReport } from "../diagnostics/inputQuality.ts";

function difficultyOf(definition: ExperimentDefinition, scenarioId: string): string {
  const scenario = definition.scenarioCatalog.find((s) => s.id === scenarioId);
  if (!scenario) return "unknown";
  if (scenario.kind === "tracking") return "hard (continuous pursuit)";
  if (scenario.kind === "target-switch") return "medium-hard (sequential load)";
  if (scenario.targetRadiusPx <= 18) return "hard (small target)";
  if ((scenario.targetSpeedPxPerSec?.max ?? 0) > 0) return "medium-hard (moving target)";
  return "medium (static target)";
}

export function buildExplanation(input: {
  definition: ExperimentDefinition;
  evaluations: readonly CandidateEvaluation[];
  recommendation: Recommendation;
  inputQuality: InputQualityReport | null;
}): RecommendationExplanation {
  const { definition, evaluations, recommendation, inputQuality } = input;
  const best = recommendation.evidence.bestCandidateId;
  const bestEval = evaluations.find((e) => e.candidateId === best) ?? null;
  const runnerUpId = recommendation.evidence.runnerUpCandidateId;
  const runnerUpEval = evaluations.find((e) => e.candidateId === runnerUpId) ?? null;

  const candidatesTested: CandidateExplanationRow[] = evaluations.map((e) => ({
    candidateId: e.candidateId,
    edpiX: Math.round(e.edpi),
    utilityMean: Number.isFinite(e.utilityMean) ? e.utilityMean : null,
    utilityStandardError: Number.isFinite(e.utilityStandardError)
      ? e.utilityStandardError
      : null,
    validTrials: e.trialsIncluded.length,
    tiedWithBest: null,
  }));

  const scenarioIds = [...new Set(evaluations.flatMap((e) => e.trialsIncluded.map((t) => t.scenarioId)))];
  const scenarioContributions: ScenarioContribution[] = scenarioIds.map((scenarioId) => {
    const bestTrials = bestEval?.trialsIncluded.filter((t) => t.scenarioId === scenarioId) ?? [];
    const runnerTrials =
      runnerUpEval?.trialsIncluded.filter((t) => t.scenarioId === scenarioId) ?? [];
    const meanOf = (values: number[]): number | null =>
      values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
    return {
      scenarioId,
      difficultyTier: difficultyOf(definition, scenarioId),
      validTrials: bestTrials.length + runnerTrials.length,
      meanUtilityBest:
        bestEval?.dimensionEstimates.accuracy && bestTrials.length > 0
          ? meanOf(bestTrials.map(() => bestEval.utilityMean))
          : null,
      meanUtilityRunnerUp:
        runnerUpEval?.dimensionEstimates.accuracy && runnerTrials.length > 0
          ? meanOf(runnerTrials.map(() => runnerUpEval.utilityMean))
          : null,
    };
  });

  const whyThisX: string[] = [
    `recommended ${recommendation.recommendedEdpi.toFixed(0)} eDPI lies inside the statistically supported range ${recommendation.edpiRange.min.toFixed(0)}–${recommendation.edpiRange.max.toFixed(0)} eDPI`,
    `best tested candidate ${best} at ${bestEval?.edpi.toFixed(0)} eDPI with utility ${bestEval?.utilityMean.toFixed(3)} ± ${bestEval?.utilityStandardError?.toFixed(3)}`,
  ];
  if (recommendation.evidence.separation === "clear") {
    whyThisX.push(
      `separation from the runner-up is statistically clear (gap z = ${recommendation.evidence.utilityGapZScore?.toFixed(2)})`,
    );
  }
  if (recommendation.unresolvedBoundary) {
    whyThisX.push(
      "search reached the tested boundary; the value is the best TESTED option, not a confirmed optimum",
    );
  }

  const evidenceAgainstWinner: string[] = [];
  if (
    runnerUpEval &&
    recommendation.evidence.utilityGapBestVsRunnerUp !== null &&
    recommendation.evidence.utilityGapBestVsRunnerUp < 0.05
  ) {
    evidenceAgainstWinner.push(
      `runner-up ${runnerUpEval.candidateId} trails by only ${recommendation.evidence.utilityGapBestVsRunnerUp.toFixed(3)} utility — practically indistinguishable`,
    );
  }
  if (recommendation.warnings.length > 0) {
    evidenceAgainstWinner.push(...recommendation.warnings);
  }

  const furtherTestingActions: string[] = [];
  if (recommendation.furtherTestingSuggested || recommendation.confidence < 0.8) {
    furtherTestingActions.push("repeat one more session and compare against this result (test/retest)");
  }
  if (recommendation.unresolvedBoundary) {
    furtherTestingActions.push(
      "run a targeted retest spanning the region beyond the tested boundary",
    );
  }
  if (inputQuality && !isQualityAdequate(inputQuality)) {
    furtherTestingActions.push(
      "improve capture conditions (close background apps, avoid resizing) before trusting high-confidence output",
    );
  }

  const captureAdequate = inputQuality ? isQualityAdequate(inputQuality) : null;

  return {
    whyThisX,
    whyThisY: [
      recommendation.yExploration?.explored
        ? recommendation.yExploration.recommendedEqualY
          ? "independent-Y testing found no reliable advantage for sensY ≠ sensX"
          : "independent-Y testing found a reliable advantage; sensY differs within the tested range"
        : "sensY was held equal to sensX; independent-Y exploration was not enabled",
    ],
    candidatesTested,
    scenarioContributions,
    evidenceForWinner: [
      `utility gap vs runner-up: ${recommendation.evidence.utilityGapBestVsRunnerUp?.toFixed(3) ?? "n/a"} (z=${recommendation.evidence.utilityGapZScore?.toFixed(2) ?? "n/a"})`,
      ...recommendation.rationaleLines.slice(0, 4),
    ],
    evidenceAgainstWinner,
    uncertaintyRemaining: [
      `plausible range spans ${(Math.log2(recommendation.edpiRange.max / recommendation.edpiRange.min) * 100).toFixed(1)}% (${recommendation.edpiRange.min.toFixed(0)}–${recommendation.edpiRange.max.toFixed(0)} eDPI)`,
      `confidence ${recommendation.confidence.toFixed(2)} (${recommendation.confidenceLabel}, heuristic)`,
      ...(recommendation.unresolvedBoundary
        ? ["optimum may lie beyond the tested range"]
        : []),
    ],
    furtherTestingActions:
      furtherTestingActions.length > 0 ? furtherTestingActions : ["none required"],
    boundaryReached: recommendation.unresolvedBoundary,
    captureQualityAdequate: captureAdequate,
  };
}

export function isQualityAdequate(report: InputQualityReport): boolean {
  return !report.warnings.unsuitableForHighConfidence && report.score >= 0.7;
}
