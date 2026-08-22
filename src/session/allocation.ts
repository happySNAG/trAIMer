import type { SensitivityCandidate } from "../domain/candidate.ts";
import type { CandidateEvaluation } from "../optimizer/evaluate.ts";
import { lookupComparison, type PairedComparison } from "../optimizer/paired.ts";

export interface AllocationRequest {
  candidates: readonly SensitivityCandidate[];
  evaluations: readonly CandidateEvaluation[];
  pairedComparisons: ReadonlyMap<string, PairedComparison>;
  minRepsBeforeAdaptive: number;
  repsThisRound: number;
  trialsSoFarPerCandidate: ReadonlyMap<string, number>;
  maxTotalMeasuredTrials: number;
  controlRefreshEveryRounds: number;
  roundIndex: number;
}

export interface AllocationDecision {
  candidateId: string;
  reps: number;
  reason:
    | "initial-balanced-round"
    | "contender-tied-with-best"
    | "ladder-neighbor-control"
    | "control-refresh-dominated"
    | "budget-exhausted";
}

function ladderStepOctaves(
  candidates: readonly SensitivityCandidate[],
): number {
  const xs = candidates
    .map((c) =>
      c.origin.kind === "generated"
        ? Math.log2(c.origin.multiplicativeFactorVsBaseline)
        : 0,
    )
    .filter((x) => x !== 0)
    .sort((a, b) => a - b);
  if (xs.length === 0) return 0.15;
  let minGap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < xs.length; i++) {
    minGap = Math.min(minGap, xs[i]! - xs[i - 1]!);
  }
  return Number.isFinite(minGap) && minGap > 0 ? minGap : 0.15;
}

export function allocateReps(request: AllocationRequest): AllocationDecision[] {
  const {
    candidates,
    evaluations,
    pairedComparisons,
    minRepsBeforeAdaptive,
    repsThisRound,
    trialsSoFarPerCandidate,
    maxTotalMeasuredTrials,
    controlRefreshEveryRounds,
    roundIndex,
  } = request;

  const totalSoFar = [...trialsSoFarPerCandidate.values()].reduce(
    (a, b) => a + b,
    0,
  );
  const sortedEvals = [...evaluations].sort(
    (a, b) => b.utilityMean - a.utilityMean,
  );
  const bestEval = sortedEvals[0] ?? null;

  const allHaveMinimum =
    candidates.every(
      (c) => (trialsSoFarPerCandidate.get(c.id) ?? 0) >= minRepsBeforeAdaptive,
    ) && bestEval !== null;

  if (!allHaveMinimum || !bestEval) {
    return candidates.map((c) => ({
      candidateId: c.id,
      reps: repsThisRound,
      reason: "initial-balanced-round" as const,
    }));
  }

  const step = ladderStepOctaves(candidates);
  const bestX = bestEval.log2RatioVsBaseline;
  const isLadderNeighbor = (x: number): boolean =>
    Math.abs(x - bestX) <= step * 1.05;

  const decisions: AllocationDecision[] = [];
  let budgetRemaining = maxTotalMeasuredTrials - totalSoFar;
  let contenderBudget = 0;

  for (const candidate of candidates) {
    const evaluation = evaluations.find((e) => e.candidateId === candidate.id);

    if (budgetRemaining <= 0) {
      decisions.push({ candidateId: candidate.id, reps: 0, reason: "budget-exhausted" });
      continue;
    }

    if (!evaluation || candidate.id === bestEval.candidateId) {
      const reps = Math.min(repsThisRound, budgetRemaining);
      contenderBudget += reps;
      budgetRemaining -= reps;
      decisions.push({
        candidateId: candidate.id,
        reps,
        reason: "contender-tied-with-best",
      });
      continue;
    }

    const comparison = lookupComparison(
      pairedComparisons,
      bestEval.candidateId,
      candidate.id,
    );
    const significantlyWorse =
      comparison !== null &&
      comparison.pairedCells >= 3 &&
      comparison.diffStandardError > 0 &&
      comparison.z > 2;
    const neighbor = isLadderNeighbor(evaluation.log2RatioVsBaseline);

    let reps: number;
    let reason: AllocationDecision["reason"];
    if (!significantlyWorse) {
      reps = Math.min(repsThisRound, budgetRemaining);
      reason = "contender-tied-with-best";
    } else if (neighbor) {
      reps = Math.min(Math.max(1, Math.ceil(repsThisRound / 2)), budgetRemaining);
      reason = "ladder-neighbor-control";
    } else if (
      controlRefreshEveryRounds > 0 &&
      roundIndex % controlRefreshEveryRounds === 0
    ) {
      reps = Math.min(1, budgetRemaining);
      reason = "control-refresh-dominated";
    } else {
      reps = 0;
      reason = "control-refresh-dominated";
    }
    contenderBudget += reps;
    budgetRemaining -= reps;
    decisions.push({ candidateId: candidate.id, reps, reason });
  }

  void contenderBudget;
  return decisions;
}
