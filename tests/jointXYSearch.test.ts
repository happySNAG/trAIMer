import { describe, expect, it } from "vitest";
import {
  DEFAULT_JOINT_XY_CONFIG,
  decideJointXY,
  fitJointXYModel,
  planJointXYNeighborhood,
  type JointFitPoint,
} from "../src/optimizer/jointXY.ts";
import { computeCellUtilities, computePairedComparisons } from "../src/optimizer/paired.ts";
import { SensitivityOptimizer } from "../src/optimizer/optimizer.ts";
import { DEFAULT_EXCLUSION_RULES } from "../src/experiments/protocol.ts";
import type { ExperimentDefinition } from "../src/domain/experiment.ts";
import type { SensitivityCandidate } from "../src/domain/candidate.ts";
import type { TrialRecord } from "../src/domain/trial.ts";
import {
  buildUtilityTrials,
  utilityFromSeedTag,
  type SyntheticTrialSpec,
} from "./syntheticUtilities.ts";

const policy = {
  fatalReasons: DEFAULT_EXCLUSION_RULES.fatalReasons,
  suspectPolicy: "exclude" as const,
};
const BASELINE_EDPI = 5600; // 800 dpi × 7 %

/** Deterministic hash noise in [−scale, +scale]. */
function hashNoise(seed: string, scale: number): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (((h % 20000) / 10000) - 1) * scale;
}

/**
 * Builds a full measurement set: stage-1 equal-X/Y ladder around baseline
 * plus the sparse Y neighborhood at the winning X, with utilities following
 * u = base − kx·lx² − ky·ly² where lx/ly are log2 distances to the hidden
 * optimum. Shared per-cell instance effects cancel in paired contrasts.
 */
function campaign(options: {
  trueOptimalEdpiX: number;
  trueOptimalEdpiY: number;
  k?: number;
  noiseScale?: number;
  repsPerCell?: number;
}): {
  definition: ExperimentDefinition;
  stage1Candidates: SensitivityCandidate[];
  neighborhood: ReturnType<typeof planJointXYNeighborhood>;
  trialsByCandidate: Map<string, TrialRecord[]>;
  comparisons: ReturnType<typeof computePairedComparisons>;
  modelPoints: JointFitPoint[];
} {
  const {
    trueOptimalEdpiX,
    trueOptimalEdpiY,
    k = 2.0,
    noiseScale = 0.008,
    repsPerCell = 4,
  } = options;

  const stage1Factors = [1 / 1.35, 1 / 1.15, 1, 1.15, 1.35];
  const stage1Candidates: SensitivityCandidate[] = stage1Factors.map((f, i) => ({
    id: `cand-x${i}` as never,
    sensitivity: {
      sensX: (BASELINE_EDPI * f) / 800,
      sensY: (BASELINE_EDPI * f) / 800,
    },
    origin: { kind: "generated", multiplicativeFactorVsBaseline: f },
  }));

  // Stage-1 verdict: pick argmax of true utility over the ladder (the engine
  // would measure this; here the geometry is analytic).
  const uOfEdpi = (ex: number, ey: number): number => {
    const lx = Math.log2(ex / trueOptimalEdpiX);
    const ly = Math.log2(ey / trueOptimalEdpiY);
    return 0.55 - k * lx * lx - k * ly * ly;
  };
  const stage1Best = [...stage1Candidates]
    .map((c) => ({ c, u: uOfEdpi(c.sensitivity.sensX * 800, c.sensitivity.sensY * 800) }))
    .sort((a, b) => b.u - a.u)[0]!.c;

  const neighborhood = planJointXYNeighborhood(
    DEFAULT_JOINT_XY_CONFIG,
    stage1Best,
  );
  const allCandidates = [...stage1Candidates, ...neighborhood.candidates];

  const specs: SyntheticTrialSpec[] = [];
  let seq = 0;
  const cells = 6;
  for (const candidate of allCandidates) {
    const ex = candidate.sensitivity.sensX * 800;
    const ey = candidate.sensitivity.sensY * 800;
    for (let cell = 0; cell < cells; cell++) {
      for (let rep = 0; rep < repsPerCell; rep++) {
        const instance = (cell % 2 === 0 ? 1 : -1) * 0.012;
        specs.push({
          candidateId: candidate.id,
          scenarioId: `cell-${cell}`,
          repIndex: rep,
          indexInSession: seq++,
          utility:
            uOfEdpi(ex, ey) +
            instance +
            hashNoise(`${candidate.id}:${cell}:${rep}`, noiseScale),
        });
      }
    }
  }
  const trialsByCandidate = buildUtilityTrials(specs);

  const definition: ExperimentDefinition = {
    id: "experiment-jxy" as never,
    name: "joint xy campaign",
    baselineSensitivity: { sensX: 7, sensY: 7 },
    dpi: 800,
    candidates: allCandidates,
    scenarioMix: [],
    scenarioCatalog: [],
    warmupTrialsPerCandidateBlock: 0,
    measuredRepsPerCandidatePerRound: 24,
    randomizeOrder: false,
    orderSeed: 1,
    restBetweenCandidatesMs: 0,
    exclusionRules: DEFAULT_EXCLUSION_RULES,
    stoppingCriteria: {
      maxTotalMeasuredTrials: 100000,
      minValidTrialsPerCandidate: 2,
      maxSearchRounds: 1,
      targetUtilityCiHalfWidth: null,
    },
    adaptiveAllocation: {
      enabled: false,
      minRepsBeforeAdaptive: 8,
      contenderZThreshold: 2,
      controlRefreshEveryRounds: 2,
    },
    fatigueProtocol: {
      maxContinuousTestingMs: 600000,
      restDurationMs: 1000,
      degradationWindowTrials: 6,
      degradationRatioThreshold: 1.25,
    },
    yExploration: { enabled: false, yFactors: [], minImprovementZ: 2 },
  };

  const cellUtilities = computeCellUtilities(
    definition,
    trialsByCandidate,
    policy,
    undefined,
    utilityFromSeedTag,
  );
  const comparisons = computePairedComparisons(trialsByCandidate, cellUtilities);

  // Model points via real evaluation machinery where possible; fall back to
  // injected utilities for exactness of geometry.
  const optimizer = new SensitivityOptimizer(definition);
  const evalsById = new Map<string, { mean: number; se: number }>();
  for (const [candidateId, cellMap] of cellUtilities) {
    const values = [...cellMap.values()];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sd =
      values.length > 1
        ? Math.sqrt(
            values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1),
          )
        : 0.001;
    evalsById.set(candidateId, { mean, se: sd / Math.sqrt(values.length) });
  }
  void optimizer;
  const modelPoints: JointFitPoint[] = allCandidates.map((c) => ({
    candidateId: c.id,
    xOctaves: Math.log2((c.sensitivity.sensX * 800) / BASELINE_EDPI),
    yLogRatio: Math.log2(c.sensitivity.sensY / c.sensitivity.sensX),
    utilityMean: evalsById.get(c.id)!.mean,
    utilityStandardError: evalsById.get(c.id)!.se,
  }));

  return {
    definition,
    stage1Candidates,
    neighborhood,
    trialsByCandidate,
    comparisons,
    modelPoints,
  };
}

function decide(camp: ReturnType<typeof campaign>) {
  return decideJointXY({
    plan: camp.neighborhood,
    comparisons: camp.comparisons,
    trialsByCandidate: camp.trialsByCandidate,
    definition: camp.definition,
    config: DEFAULT_JOINT_XY_CONFIG,
    modelPoints: camp.modelPoints,
  });
}

describe("joint X/Y search against hidden synthetic optima", () => {
  it("X=5600, Y=5600 → equality (never confident inequality)", () => {
    const camp = campaign({ trueOptimalEdpiX: 5600, trueOptimalEdpiY: 5600 });
    const summary = decide(camp);
    expect(["recommend-equal", "asymmetry-unresolved"]).toContain(summary.outcome);
    expect(summary.recommendedYRatio).toBe(1);
  });

  it("X=5600, Y=5000 → reliable mild asymmetry detected", () => {
    const camp = campaign({ trueOptimalEdpiX: 5600, trueOptimalEdpiY: 5000 });
    const summary = decide(camp);
    expect(["slightly-asymmetric", "clearly-asymmetric"]).toContain(summary.outcome);
    expect(summary.recommendedYRatio).toBeLessThan(1);
    expect(summary.plausibleYRatioRange).not.toBeNull();
  });

  it("X=5600, Y=4000 → clearly asymmetric, low-Y recommendation", () => {
    const camp = campaign({ trueOptimalEdpiX: 5600, trueOptimalEdpiY: 4000, k: 3 });
    const summary = decide(camp);
    expect(summary.outcome).toBe("clearly-asymmetric");
    expect(summary.recommendedYRatio).toBeLessThan(0.95);
    if (summary.plausibleYRatioRange) {
      expect(summary.recommendedYRatio).toBeGreaterThanOrEqual(
        summary.plausibleYRatioRange.min,
      );
      expect(summary.recommendedYRatio).toBeLessThanOrEqual(
        summary.plausibleYRatioRange.max,
      );
    }
  });

  it("X=5000, Y=6500 → clearly asymmetric, high-Y recommendation", () => {
    const camp = campaign({ trueOptimalEdpiX: 5000, trueOptimalEdpiY: 6500, k: 3 });
    const summary = decide(camp);
    expect(summary.outcome).toBe("clearly-asymmetric");
    expect(summary.recommendedYRatio).toBeGreaterThan(1.05);
  });

  it("noisy false asymmetry MUST resolve to equality/unresolved — never confidently unequal", () => {
    // True optimum equal; tiny k makes any real Y-effect negligible while
    // deterministic noise produces spurious positive trends.
    const camp = campaign({
      trueOptimalEdpiX: 5600,
      trueOptimalEdpiY: 5600,
      k: 0.35,
      noiseScale: 0.03,
    });
    const summary = decide(camp);
    expect(["recommend-equal", "asymmetry-unresolved", "insufficient-evidence"]).toContain(
      summary.outcome,
    );
    expect(summary.recommendedYRatio).toBe(1);
  });

  it("sparse 2D model recovers the Y-gradient direction for strong asymmetry", () => {
    const camp = campaign({ trueOptimalEdpiX: 5600, trueOptimalEdpiY: 4000, k: 3 });
    const model = fitJointXYModel(camp.modelPoints)!;
    expect(model).not.toBeNull();
    expect(model.converged).toBe(true);
    // Optimum lies below the equal line ⇒ utility DECREASES as ly rises:
    // local Y gradient must be negative.
    expect(model.betaY).toBeLessThan(0);
  });

  it("model refuses to fit degenerate designs", () => {
    expect(fitJointXYModel([])).toBeNull();
    expect(
      fitJointXYModel([
        {
          candidateId: "a",
          xOctaves: 0,
          yLogRatio: 0,
          utilityMean: 0.5,
          utilityStandardError: 0.01,
        },
      ]),
    ).toBeNull();
  });
});
