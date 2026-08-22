import { describe, expect, it } from "vitest";
import {
  allocateReps,
} from "../src/session/allocation.ts";
import type { CandidateEvaluation } from "../src/optimizer/evaluate.ts";
import type { SensitivityCandidate } from "../src/domain/candidate.ts";
import { makeCandidateId } from "../src/domain/ids.ts";
import type { PairedComparison } from "../src/optimizer/paired.ts";

function candidate(suffix: string, factor: number): SensitivityCandidate {
  return {
    id: makeCandidateId(suffix),
    sensitivity: { sensX: 7 * factor, sensY: 7 * factor },
    origin: { kind: "generated", multiplicativeFactorVsBaseline: factor },
  };
}

function evaluation(
  candidate: SensitivityCandidate,
  utilityMean: number,
  utilityStandardError = 0.02,
): CandidateEvaluation {
  return {
    candidateId: candidate.id,
    candidate,
    edpi: 800 * candidate.sensitivity.sensX,
    log2RatioVsBaseline: Math.log2(candidate.sensitivity.sensX / 7),
    trialsIncluded: [],
    trialsExcluded: 0,
    exclusionReasonCounts: {},
    dimensionEstimates: {},
    perTrialUtilities: [],
    utilityMean,
    utilityStandardError,
    consistencyScore: 0.8,
    flaggedSuspectCount: 0,
  };
}

function pairComparison(
  aId: string,
  bId: string,
  diffMean: number,
  diffStandardError: number,
): PairedComparison {
  return {
    aCandidateId: aId,
    bCandidateId: bId,
    diffMean,
    diffStandardError,
    pairedCells: 10,
    z: diffStandardError > 0 ? diffMean / diffStandardError : 0,
  };
}

const CANDIDATES = [
  candidate("base", 1),
  candidate("low", 1 / 1.35),
  candidate("high", 1.35),
];

describe("adaptive repetition allocation", () => {
  it("allocates uniformly before the minimum sample is reached", () => {
    const evaluations = [evaluation(CANDIDATES[0]!, 0.5), evaluation(CANDIDATES[1]!, 0.3), evaluation(CANDIDATES[2]!, 0.1)];
    const decisions = allocateReps({
      candidates: CANDIDATES,
      evaluations,
      pairedComparisons: new Map(),
      minRepsBeforeAdaptive: 8,
      repsThisRound: 4,
      trialsSoFarPerCandidate: new Map([
        [CANDIDATES[0]!.id, 5],
        [CANDIDATES[1]!.id, 5],
        [CANDIDATES[2]!.id, 2],
      ]),
      maxTotalMeasuredTrials: 500,
      controlRefreshEveryRounds: 2,
      roundIndex: 1,
    });
    for (const decision of decisions) {
      expect(decision.reps).toBe(4);
      expect(decision.reason).toBe("initial-balanced-round");
    }
  });

  it("concentrates reps on contenders and reduces dominated candidates", () => {
    const best = CANDIDATES[0];
    const neighbor = CANDIDATES[1];
    const far = CANDIDATES[2];
    const evaluations = [
      evaluation(best!, 0.50),
      evaluation(neighbor!, 0.49),
      evaluation(far!, 0.20),
    ];
    const comparisons = new Map<string, PairedComparison>([
      [
        `${best!.id}::${neighbor!.id}`,
        pairComparison(best!.id, neighbor!.id, 0.01, 0.02),
      ],
      [
        `${best!.id}::${far!.id}`,
        pairComparison(best!.id, far!.id, 0.30, 0.02),
      ],
    ]);
    const decisions = allocateReps({
      candidates: CANDIDATES,
      evaluations,
      pairedComparisons: comparisons,
      minRepsBeforeAdaptive: 8,
      repsThisRound: 6,
      trialsSoFarPerCandidate: new Map([
        [best!.id, 10],
        [neighbor!.id, 10],
        [far!.id, 10],
      ]),
      maxTotalMeasuredTrials: 500,
      controlRefreshEveryRounds: 2,
      roundIndex: 2,
    });
    const byId = new Map(decisions.map((d) => [d.candidateId, d]));
    expect(byId.get(best!.id)!.reps).toBe(6);
    expect(byId.get(best!.id)!.reason).toBe("contender-tied-with-best");
    expect(byId.get(neighbor!.id)!.reps).toBeGreaterThan(0);
    const farDecision = byId.get(far!.id)!;
    expect(farDecision.reps).toBeLessThan(byId.get(neighbor!.id)!.reps);
    expect(["ladder-neighbor-control", "control-refresh-dominated"]).toContain(
      farDecision.reason,
    );
  });

  it("is deterministic given identical inputs", () => {
    const build = () =>
      allocateReps({
        candidates: CANDIDATES,
        evaluations: [evaluation(CANDIDATES[0]!, 0.5), evaluation(CANDIDATES[1]!, 0.48), evaluation(CANDIDATES[2]!, 0.2)],
        pairedComparisons: new Map(),
        minRepsBeforeAdaptive: 8,
        repsThisRound: 5,
        trialsSoFarPerCandidate: new Map([
          [CANDIDATES[0]!.id, 9],
          [CANDIDATES[1]!.id, 9],
          [CANDIDATES[2]!.id, 9],
        ]),
        maxTotalMeasuredTrials: 500,
        controlRefreshEveryRounds: 2,
        roundIndex: 1,
      });
    expect(build()).toEqual(build());
  });

  it("stops allocating once the total trial budget is exhausted", () => {
    const decisions = allocateReps({
      candidates: CANDIDATES,
      evaluations: [evaluation(CANDIDATES[0]!, 0.5), evaluation(CANDIDATES[1]!, 0.49), evaluation(CANDIDATES[2]!, 0.48)],
      pairedComparisons: new Map(),
      minRepsBeforeAdaptive: 8,
      repsThisRound: 5,
      trialsSoFarPerCandidate: new Map([
        [CANDIDATES[0]!.id, 90],
        [CANDIDATES[1]!.id, 90],
        [CANDIDATES[2]!.id, 90],
      ]),
      maxTotalMeasuredTrials: 270,
      controlRefreshEveryRounds: 2,
      roundIndex: 3,
    });
    for (const decision of decisions) {
      expect(decision.reps).toBe(0);
      expect(decision.reason).toBe("budget-exhausted");
    }
  });
});
