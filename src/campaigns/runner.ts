import type { ExperimentDefinition } from "../domain/experiment.ts";
import type { TrialRecord } from "../domain/trial.ts";
import type { SessionId } from "../domain/ids.ts";
import { buildExperimentDefinition } from "../experiments/protocol.ts";
import { RC_BUILDER_DEFAULTS } from "../experiments/rcDefaults.ts";
import { SensitivityOptimizer } from "../optimizer/optimizer.ts";
import {
  computeCellUtilities,
  computePairedComparisons,
} from "../optimizer/paired.ts";
import {
  DEFAULT_JOINT_XY_CONFIG,
  decideJointXY,
  planJointXYNeighborhood,
  type JointFitPoint,
} from "../optimizer/jointXY.ts";
import { evaluateBudgetDecision, DEFAULT_SESSION_BUDGET } from "../experiments/budget.ts";
import { SyntheticExperimentRunner } from "../sim/simulator.ts";
import type { SyntheticPlayerConfig } from "../sim/player.ts";
import { estimateCompositeOptimumEdpi } from "../sim/calibrate.ts";
import {
  PLAYER_FAMILIES,
  type PlayerFamilyId,
  type FamilyExpectations,
} from "./playerFamilies.ts";

/**
 * Deterministic Monte Carlo campaign runner (Pass 6).
 *
 * Executes full simulate → validate → score → optimize pipelines against
 * synthetic players with KNOWN ground truth and produces structured per-case
 * results for population-level metrics. Everything is a pure function of the
 * case seed and options: identical inputs always produce identical outputs.
 *
 * Ground truth is defined as the Monte-Carlo COMPOSITE optimum of the
 * simulator under the campaign's measurement conventions (estimated on a
 * dense ladder via estimateCompositeOptimumEdpi), NOT the physical hidden
 * parameter. The physical parameter remains hidden from the optimizer either
 * way.
 */

export interface CampaignCaseOptions {
  seed: number;
  family: PlayerFamilyId;
  /** Scenario subset (default: canonical V1 mix). */
  scenarioIds?: readonly string[];
  repsPerCandidatePerRound?: number;
  warmupPerBlock?: number;
  rounds?: number;
  adaptiveAllocation?: boolean;
  sampleHz?: number;
  /** Run the staged independent-Y exploration after stage 1/2 completes. */
  jointXY?: boolean;
  /** Skip ground-truth estimation and reuse a supplied value. */
  groundTruthEdpi?: number;
}

export interface CampaignCaseResult {
  seed: number;
  family: PlayerFamilyId;
  groundTruthEdpi: number;
  groundTruthMethod: string;
  recommendationEdpi: number;
  absoluteErrorEdpi: number;
  relativeErrorFraction: number;
  rangeMinEdpi: number;
  rangeMaxEdpi: number;
  coveredByRange: boolean;
  confidence: number;
  confidenceLabel: string;
  unresolvedBoundary: boolean;
  curveShape: string;
  separation: string;
  furtherTestingSuggested: boolean;
  refusedHighConfidence: boolean;
  measuredTrials: number;
  excludedTrials: number;
  searchRoundsRun: number;
  earlyStopped: boolean;
  budgetActionFinal: string;
  estimatedActiveSeconds: number;
  retestPlanKind: string | null;
  retestTriggers: readonly string[];
  boundaryExpectationCorrect: boolean | null;
  /** unresolved-boundary flagged confidently although truth was inside the span. */
  falseBoundaryFlag: boolean;
  plateauExpectationCorrect: boolean | null;
  falseHighConfidence: boolean;
  jointXYOutcome: string | null;
  jointXYTruthAsymmetric: boolean;
}

export interface CampaignCaseInternal {
  result: CampaignCaseResult;
  definition: ExperimentDefinition;
  trials: TrialRecord[];
}

const DEFAULT_SCENARIOS = RC_BUILDER_DEFAULTS.scenarioIds;

function buildCaseDefinition(options: Required<
  Pick<CampaignCaseOptions, "seed" | "scenarioIds" | "repsPerCandidatePerRound" | "warmupPerBlock" | "rounds" | "adaptiveAllocation" | "jointXY">
> & { tag: string }): ExperimentDefinition {
  return buildExperimentDefinition({
    id: `experiment-mc-${options.tag}-${options.seed}` as never,
    name: `mc ${options.tag} ${options.seed}`,
    baselineSensitivity: { sensX: 7, sensY: 7 },
    dpi: 800,
    orderSeed: options.seed,
    randomizeOrder: true,
    scenarioIds: options.scenarioIds,
    warmupTrialsPerCandidateBlock: options.warmupPerBlock,
    measuredRepsPerCandidatePerRound: options.repsPerCandidatePerRound,
    adaptiveAllocation: options.adaptiveAllocation
      ? { ...RC_BUILDER_DEFAULTS.adaptiveAllocation }
      : { enabled: false },
    stoppingCriteria: {
      maxSearchRounds: options.rounds,
      maxTotalMeasuredTrials: 400,
    },
    yExploration: { enabled: false },
  });
}

/** Runs one full campaign case end-to-end. Deterministic in (seed, options). */
export function runCampaignCase(
  options: CampaignCaseOptions,
): CampaignCaseResult {
  const internal = runCampaignCaseInternal(options);
  return internal.result;
}

export function runCampaignCaseInternal(
  options: CampaignCaseOptions,
): CampaignCaseInternal {
  const familySpec = PLAYER_FAMILIES[options.family];
  const player = familySpec.build(options.seed);
  const reps = options.repsPerCandidatePerRound ?? 6;
  const rounds = options.rounds ?? 2;
  const warmup = options.warmupPerBlock ?? 1;
  const scenarioIds = options.scenarioIds ?? DEFAULT_SCENARIOS;
  const sampleHz = options.sampleHz ?? 120;

  const definition = buildCaseDefinition({
    seed: options.seed,
    tag: options.family,
    scenarioIds,
    repsPerCandidatePerRound: reps,
    warmupPerBlock: warmup,
    rounds,
    adaptiveAllocation: options.adaptiveAllocation ?? false,
    jointXY: options.jointXY ?? false,
  });

  const runner = new SyntheticExperimentRunner(definition, player, { sampleHz });
  const sessionId = `session-mc-${options.family}-${options.seed}` as SessionId;
  const optimizer = new SensitivityOptimizer(definition);
  const allTrials: TrialRecord[] = [];
  let earlyStopped = false;
  let budgetActionFinal = "max-rounds-reached";

  let measuredSoFar = 0;
  for (let round = 0; round < rounds; round++) {
    const trials = runner.runRound(round, options.seed + round * 100_003, sessionId, definition.id);
    optimizer.addTrials(trials);
    allTrials.push(...trials);
    measuredSoFar += trials.filter(
      (t) => t.phase === "measured" && t.validity.status === "valid",
    ).length;
    if (round >= rounds - 1) break;

    // Execute the REAL search loop: refinement/expansion proposals become
    // round-(r+1) candidates exactly as the production SessionRunner does.
    const next = optimizer.needsMoreEvidence();
    if (next.kind === "collect") {
      optimizer.addCandidates(next.candidates);
      continue;
    }
    // No refinement available → evidence-based early stop decision.
    if (measuredSoFar >= DEFAULT_SESSION_BUDGET.minTrialsBeforeEarlyStop) {
      const preview = optimizer.recommend();
      const adequacy = optimizer.curveAdequacy();
      const adaptation = optimizer.changePointAnalysis();
      const decision = evaluateBudgetDecision({
        config: DEFAULT_SESSION_BUDGET,
        trialsCompletedMeasured: measuredSoFar,
        // Time-based caps are intentionally not enforced here: campaigns
        // evaluate EVIDENCE-based early stopping only.
        activeTestingMsUsed: 0,
        wallClockMsUsed: 0,
        continuousActiveMs: 0,
        recommendationPreview: preview,
        adequacy,
        adaptation,
        captureQuality: null,
      });
      budgetActionFinal = decision.action;
      if (decision.action === "stop-sufficient") {
        earlyStopped = true;
        break;
      }
      budgetActionFinal = "continue";
    }
  }

  const recommendation = optimizer.recommend();

  // Optional staged joint-X/Y exploration on top of the settled stage.
  let jointXYOutcome: string | null = null;
  if (options.jointXY === true) {
    const evals = optimizer.evaluations();
    const bestEval = evals[0];
    if (bestEval) {
      const bestCandidate = definition.candidates.find(
        (c) => c.id === bestEval.candidateId,
      );
      if (bestCandidate) {
        const neighborhood = planJointXYNeighborhood(DEFAULT_JOINT_XY_CONFIG, bestCandidate);
        for (const candidate of neighborhood.candidates) {
          definition.candidates.push(candidate);
        }
        const jxyRound = rounds + 1;
        const jxyTrials = runner.runRound(
          jxyRound,
          options.seed + 700_007,
          sessionId,
          definition.id,
          neighborhood.candidates.map((c) => c.id),
        );
        optimizer.addTrials(jxyTrials);
        allTrials.push(...jxyTrials);

        const trialsByCandidate = new Map<string, TrialRecord[]>();
        for (const trial of allTrials) {
          if (trial.phase !== "measured") continue;
          const key = trial.candidateId ?? "_unassigned";
          const list = trialsByCandidate.get(key) ?? [];
          list.push(trial);
          trialsByCandidate.set(key, list);
        }
        const cellUtilities = computeCellUtilities(
          definition,
          trialsByCandidate,
          { fatalReasons: [], suspectPolicy: "exclude" },
        );
        const comparisons = computePairedComparisons(trialsByCandidate, cellUtilities);
        // Joint surface points across ALL measured candidates (docs:
        // ridge-regularized 4-parameter fit over every evaluation).
        const modelPoints: JointFitPoint[] = [];
        const baselineEdpiJXY = 800 * definition.baselineSensitivity.sensX;
        for (const ev of optimizer.evaluations()) {
          if (
            Number.isFinite(ev.utilityMean) &&
            Number.isFinite(ev.utilityStandardError) &&
            ev.utilityStandardError > 0
          ) {
            modelPoints.push({
              candidateId: ev.candidateId,
              xOctaves: Math.log2(ev.edpi / baselineEdpiJXY),
              yLogRatio: Math.log2(
                definition.candidates.find((c) => c.id === ev.candidateId)!
                  .sensitivity.sensY /
                  definition.candidates.find((c) => c.id === ev.candidateId)!
                    .sensitivity.sensX,
              ),
              utilityMean: ev.utilityMean,
              utilityStandardError: ev.utilityStandardError,
            });
          }
        }
        const summary = decideJointXY({
          plan: neighborhood,
          comparisons,
          trialsByCandidate,
          definition,
          config: DEFAULT_JOINT_XY_CONFIG,
          modelPoints,
        });
        jointXYOutcome = summary.outcome;
      }
    }
  }

  // ---- Ground truth ---------------------------------------------------
  let groundTruthEdpi: number;
  let groundTruthMethod: string;
  if (options.groundTruthEdpi !== undefined) {
    groundTruthEdpi = options.groundTruthEdpi;
    groundTruthMethod = "supplied";
  } else {
    const calibration = estimateGroundTruth(player, options);
    groundTruthEdpi = calibration.compositeOptimumEdpi;
    groundTruthMethod = calibration.method;
  }

  // ---- Derived verdicts ----------------------------------------------
  const testedCandidates = definition.candidates
    .map((c) => 800 * c.sensitivity.sensX)
    .sort((a, b) => a - b);
  const lowestTested = testedCandidates[0]!;
  const highestTested = testedCandidates[testedCandidates.length - 1]!;
  const truthOutsideTestedSpan =
    groundTruthEdpi < lowestTested || groundTruthEdpi > highestTested;

  const relativeError =
    Math.abs(recommendation.recommendedEdpi - groundTruthEdpi) / groundTruthEdpi;

  const expectation: FamilyExpectations = familySpec.expectations;
  // Boundary correctness: when the truth lies beyond the tested span the
  // engine must refuse a confident precise claim; when it lies inside, an
  // unresolved-boundary flag is a false alarm.
  let boundaryExpectationCorrect: boolean | null = null;
  if (truthOutsideTestedSpan) {
    boundaryExpectationCorrect =
      recommendation.unresolvedBoundary ||
      recommendation.furtherTestingSuggested ||
      recommendation.confidence <= 0.7;
  } else if (expectation.boundaryLikely) {
    boundaryExpectationCorrect = !recommendation.unresolvedBoundary || recommendation.confidence <= 0.7;
  }
  const falseBoundaryFlag =
    !truthOutsideTestedSpan && recommendation.unresolvedBoundary && recommendation.confidence > 0.7;
  const plateauExpectationCorrect: boolean | null = expectation.plateauLikely
    ? recommendation.curveAdequacy?.shape === "broad-plateau" ||
      recommendation.curveAdequacy?.shape === "multimodal-inconsistent" ||
      recommendation.edpiRange.max / Math.max(recommendation.edpiRange.min, 1) > 1.05 ||
      recommendation.confidence < 0.8
    : null;

  const estimatedActiveSeconds =
    allTrials.reduce((acc, t) => acc + (t.endedAtMonotonicMs - t.startedAtMonotonicMs), 0) /
      1000 +
    (definition.candidates.length * rounds * definition.restBetweenCandidatesMs) / 1000;

  const triggersNeedingRetest =
    recommendation.unresolvedBoundary ||
    recommendation.furtherTestingSuggested ||
    recommendation.confidence < 0.5;
  const retestTriggers = collectTriggers(recommendation);
  return {
    definition,
    trials: allTrials,
    result: {
      seed: options.seed,
      family: options.family,
      groundTruthEdpi,
      groundTruthMethod,
      recommendationEdpi: recommendation.recommendedEdpi,
      absoluteErrorEdpi: Math.abs(recommendation.recommendedEdpi - groundTruthEdpi),
      relativeErrorFraction: relativeError,
      rangeMinEdpi: recommendation.edpiRange.min,
      rangeMaxEdpi: recommendation.edpiRange.max,
      coveredByRange:
        recommendation.edpiRange.min <= groundTruthEdpi &&
        recommendation.edpiRange.max >= groundTruthEdpi,
      confidence: recommendation.confidence,
      confidenceLabel: recommendation.confidenceLabel,
      unresolvedBoundary: recommendation.unresolvedBoundary,
      curveShape: recommendation.curveAdequacy?.shape ?? "unknown",
      separation: recommendation.evidence.separation,
      furtherTestingSuggested: recommendation.furtherTestingSuggested,
      refusedHighConfidence: recommendation.refusedHighConfidence,
      measuredTrials: allTrials.filter(
        (t) => t.phase === "measured" && t.validity.status === "valid",
      ).length,
      excludedTrials: recommendation.evidence.trialsExcluded,
      searchRoundsRun: recommendation.evidence.searchRoundsRun,
      earlyStopped,
      budgetActionFinal,
      estimatedActiveSeconds,
      retestPlanKind: triggersNeedingRetest ? "recommended" : null,
      retestTriggers,
      boundaryExpectationCorrect,
      falseBoundaryFlag,
      plateauExpectationCorrect,
      falseHighConfidence: recommendation.confidence >= 0.8 && relativeError > 0.15,
      jointXYOutcome,
      jointXYTruthAsymmetric: familySpec.expectations.realAsymmetry,
    },
  };
}

function collectTriggers(rec: ReturnType<SensitivityOptimizer["recommend"]>): string[] {
  const triggers: string[] = [];
  if (rec.unresolvedBoundary) triggers.push("unresolved-boundary");
  if (rec.curveAdequacy?.shape === "broad-plateau") triggers.push("broad-plateau");
  if (rec.curveAdequacy?.shape === "multimodal-inconsistent") triggers.push("multimodal-inconsistent");
  if (rec.captureQualitySession?.retestingNecessary) triggers.push("capture-quality-weak");
  if (rec.changePointAnalysis?.contaminationDetected) triggers.push("adaptation-contamination");
  if (rec.confidence < 0.5 || rec.refusedHighConfidence) triggers.push("insufficient-evidence");
  return triggers;
}

/**
 * Dense-ladder ground-truth estimation. Runs a WIDER, DENSER protocol around
 * the player's own operating point with more reps than the evaluated session,
 * so it is strictly better-informed than the engine under test. Uses a
 * deterministic seed derived from the case seed.
 */
function estimateGroundTruth(
  player: SyntheticPlayerConfig,
  options: CampaignCaseOptions,
): ReturnType<typeof estimateCompositeOptimumEdpi> {
  return estimateCompositeOptimumEdpi(player, {
    dpi: 800,
    baselineSensitivityPercent: 7,
    repsPerCandidatePerRound: 14,
    rounds: 1,
    sampleHz: 120,
    seedBase: 4_000_000 + (options.seed % 1_000_000),
  });
}
