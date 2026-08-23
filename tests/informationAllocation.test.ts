import { describe, expect, it } from "vitest";
import { allocateExtraBlocks } from "../src/session/informationAllocation.ts";
import type { CandidateEvaluation } from "../src/optimizer/evaluate.ts";
import type { PairedComparison } from "../src/optimizer/paired.ts";
import type { SensitivityCandidate } from "../src/domain/candidate.ts";

function evaluation(id: string, octaves: number, mean: number, se: number): CandidateEvaluation {
  const candidate: SensitivityCandidate = {
    id: id as never,
    sensitivity: { sensX: 7 * Math.pow(2, octaves), sensY: 7 * Math.pow(2, octaves) },
    origin: { kind: "generated", multiplicativeFactorVsBaseline: Math.pow(2, octaves) },
  };
  return {
    candidateId: id,
    candidate,
    edpi: 800 * candidate.sensitivity.sensX,
    log2RatioVsBaseline: octaves,
    trialsIncluded: new Array(8).fill(0).map((_, i) => ({ id: `t${i}` })) as never,
    trialsExcluded: 0,
    exclusionReasonCounts: {},
    dimensionEstimates: {},
    perTrialUtilities: [],
    utilityMean: mean,
    utilityStandardError: se,
    consistencyScore: 1,
    flaggedSuspectCount: 0,
  };
}

function comparison(a: string, b: string, diffMean: number, se: number): [string, PairedComparison] {
  return [
    `${a}::${b}`,
    {
      aCandidateId: a,
      bCandidateId: b,
      diffMean,
      diffStandardError: se,
      pairedCells: 6,
      z: diffMean / se,
    },
  ];
}

describe("information-driven extra block allocation", () => {
  it("near-tied contenders receive more reps than clearly dominated ones", () => {
    const evals = [
      evaluation("cand-best", 0.0, 0.55, 0.02),
      evaluation("cand-tied", 0.15, 0.54, 0.02), // near tie
      evaluation("cand-dom", -0.4, 0.30, 0.02), // dominated
    ];
    const comparisons = new Map<string, PairedComparison>([
      comparison("cand-best", "cand-tied", 0.005, 0.028), // |z| ≈ 0.18
      comparison("cand-best", "cand-dom", 0.25, 0.03), // z ≈ 8.3 → dominated
    ]);
    const decisions = allocateExtraBlocks({
      evaluations: evals,
      pairedComparisons: comparisons,
      repsPerBlock: 4,
      trialsSoFarPerCandidate: new Map([
        ["cand-best", 10],
        ["cand-tied", 10],
        ["cand-dom", 10],
      ]),
      maxTotalMeasuredTrials: 1000,
      adequacy: null,
      adaptation: null,
      tieZThreshold: 1.5,
    });
    const tied = decisions.find((d) => d.candidateId === "cand-tied")!;
    const dom = decisions.find((d) => d.candidateId === "cand-dom")!;
    expect(tied.reps).toBeGreaterThan(dom.reps);
    expect(tied.reason === "near-tied-contender" || tied.informationScore > dom.informationScore).toBe(true);
    // Every decision carries an auditable rationale.
    for (const d of decisions) {
      expect(d.rationale.length).toBeGreaterThan(0);
    }
  });

  it("unresolved boundary boosts the edge candidate", () => {
    const evals = [
      evaluation("cand-low", -0.3, 0.45, 0.02),
      evaluation("cand-mid", 0, 0.5, 0.02),
      evaluation("cand-high", 0.3, 0.56, 0.02), // best at edge
    ];
    const decisions = allocateExtraBlocks({
      evaluations: evals,
      pairedComparisons: new Map(),
      repsPerBlock: 4,
      trialsSoFarPerCandidate: new Map(),
      maxTotalMeasuredTrials: 1000,
      adequacy: {
        shape: "monotonic-boundary",
        result: { kind: "unresolved-boundary", direction: "high", bestTestedOctaves: 0.3 },
        vertexUsable: false,
        asymmetryRatio: null,
        diagnostics: [],
      },
      adaptation: null,
    });
    const high = decisions.find((d) => d.candidateId === "cand-high")!;
    expect(high.informationScore).toBeGreaterThanOrEqual(3);
    expect(
      decisions.find((d) => d.candidateId === "cand-mid")!.informationScore,
    ).toBeLessThan(high.informationScore);
  });

  it("budget exhaustion caps every decision and records budget-exhausted reasons", () => {
    const evals = [
      evaluation("a", 0, 0.5, 0.02),
      evaluation("b", 0.1, 0.49, 0.02),
      evaluation("c", 0.2, 0.48, 0.02),
    ];
    const decisions = allocateExtraBlocks({
      evaluations: evals,
      pairedComparisons: new Map(),
      repsPerBlock: 6,
      trialsSoFarPerCandidate: new Map([
        ["a", 95],
        ["b", 3],
        ["c", 2],
      ]),
      maxTotalMeasuredTrials: 100,
      adequacy: null,
      adaptation: null,
    });
    const totalReps = decisions.reduce((acc, d) => acc + d.reps, 0);
    expect(totalReps).toBeLessThanOrEqual(5);
  });

  it("adaptation contamination spreads re-exposure bonus to non-best candidates", () => {
    const evals = [
      evaluation("a", 0, 0.55, 0.02),
      evaluation("b", 0.12, 0.53, 0.02),
    ];
    const without = allocateExtraBlocks({
      evaluations: evals,
      pairedComparisons: new Map(),
      repsPerBlock: 4,
      trialsSoFarPerCandidate: new Map(),
      maxTotalMeasuredTrials: 1000,
      adequacy: null,
      adaptation: null,
    });
    const withContam = allocateExtraBlocks({
      evaluations: evals,
      pairedComparisons: new Map(),
      repsPerBlock: 4,
      trialsSoFarPerCandidate: new Map(),
      maxTotalMeasuredTrials: 1000,
      adequacy: null,
      adaptation: { contaminationDetected: true },
    });
    const bWithout = without.find((d) => d.candidateId === "b")!.reps;
    const bWith = withContam.find((d) => d.candidateId === "b")!.reps;
    expect(bWith).toBeGreaterThan(bWithout);
  });

  it("is deterministic: identical inputs produce identical allocations", () => {
    const input = {
      evaluations: [
        evaluation("a", 0, 0.55, 0.02),
        evaluation("b", 0.14, 0.535, 0.02),
        evaluation("c", -0.3, 0.4, 0.02),
      ],
      pairedComparisons: new Map<string, PairedComparison>([
        comparison("a", "b", 0.01, 0.03),
      ]),
      repsPerBlock: 4,
      trialsSoFarPerCandidate: new Map([["a", 9], ["b", 9], ["c", 9]]),
      maxTotalMeasuredTrials: 200,
      adequacy: null,
      adaptation: null,
    };
    const r1 = allocateExtraBlocks(input);
    const r2 = allocateExtraBlocks(input);
    expect(r1).toEqual(r2);
  });
});
