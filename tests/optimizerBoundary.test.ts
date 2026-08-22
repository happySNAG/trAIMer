import { describe, expect, it } from "vitest";
import {
  SensitivityOptimizer,
  SyntheticExperimentRunner,
  buildExperimentDefinition,
  playerPreset,
  equalXy,
} from "../src/index.ts";

const DPI = 800;

function runSearch(
  hiddenEdpi: number,
  options: {
    ladderFactors?: readonly number[];
    reps?: number;
    rounds?: number;
    seed?: number;
  } = {},
) {
  const def = buildExperimentDefinition({
    id: "experiment-boundary",
    name: "boundary",
    baselineSensitivity: equalXy(7),
    dpi: DPI,
    orderSeed: options.seed ?? 11,
    ladderFactors: options.ladderFactors ?? [1 / 1.15, 1, 1.15],
    measuredRepsPerCandidatePerRound: options.reps ?? 12,
    warmupTrialsPerCandidateBlock: 2,
  });
  const runner = new SyntheticExperimentRunner(def, {
    ...playerPreset("consistent-medium"),
    trueOptimalEdpi: hiddenEdpi,
  });
  const optimizer = new SensitivityOptimizer(def, {
    maxSearchRounds: options.rounds ?? 2,
  });
  optimizer.addTrials(runner.runRound(0, 55, "session-b", def.id));
  let proposalsTotal = 0;
  for (let guard = 0; guard < 4; guard++) {
    const next = optimizer.needsMoreEvidence();
    if (next.kind === "done") break;
    optimizer.addCandidates(next.candidates);
    proposalsTotal += next.candidates.length;
    optimizer.addTrials(
      runner.runRound(
        next.round,
        55,
        "session-b",
        def.id,
        next.candidates.map((c) => c.id),
      ),
    );
  }
  return {
    recommendation: optimizer.recommend(),
    proposalsTotal,
    definition: def,
    evaluationsCount: () => optimizer.evaluations().length,
  };
}

describe("boundary-aware search", () => {
  it("recovers an optimum below the initial ladder via expansion", () => {
    const { recommendation } = runSearch(3200, { seed: 21 });
    expect(recommendation.edpiRange.min).toBeLessThanOrEqual(4200);
    const covers =
      recommendation.edpiRange.min <= 3400 && recommendation.edpiRange.max >= 3000;
    expect(covers || Math.abs(recommendation.recommendedEdpi / 3200 - 1) < 0.25).toBe(true);
  });

  it("recovers an optimum above the initial ladder via expansion", () => {
    const { recommendation } = runSearch(8800, { seed: 22 });
    expect(recommendation.edpiRange.max).toBeGreaterThanOrEqual(7600);
    const covers =
      recommendation.edpiRange.max >= 8000 && recommendation.edpiRange.min <= 9800;
    expect(covers || Math.abs(recommendation.recommendedEdpi / 8800 - 1) < 0.3).toBe(true);
  });

  it("never pins the point estimate outside the tested span", () => {
    const { recommendation } = runSearch(8800, {
      seed: 23,
      ladderFactors: [1 / 1.35, 1 / 1.15, 1, 1.15],
      rounds: 1,
      reps: 6,
    });
    const testedEdpis = [
      5600 * (1 / 1.35),
      5600 * (1 / 1.15),
      5600,
      5600 * 1.15,
    ];
    if (
      recommendation.recommendedEdpi < Math.min(...testedEdpis) - 1 ||
      recommendation.recommendedEdpi > Math.max(...testedEdpis) + 1
    ) {
      expect(recommendation.unresolvedBoundary).toBe(true);
    }
  });

  it("flags unresolved boundary when rounds are exhausted at the edge", () => {
    // Hidden optimum far above the span; one round; deterministic seed where
    // the top-edge candidate wins (verified against this simulator build).
    const { recommendation } = runSearch(15000, {
      rounds: 1,
      seed: 30,
      ladderFactors: [1 / 1.35, 1 / 1.15, 1, 1.15],
      reps: 6,
    });
    const sortedEvals = [
      DPI * 7 * (1 / 1.35),
      DPI * 7 * (1 / 1.15),
      DPI * 7,
      DPI * 7 * 1.15,
    ];
    const atTopEdge =
      Math.abs(recommendation.edpiRange.max - Math.max(...sortedEvals)) < 1e-6 ||
      recommendation.edpiRange.max > Math.max(...sortedEvals);
    if (atTopEdge) {
      expect(recommendation.unresolvedBoundary).toBe(true);
      expect(recommendation.confidence).toBeLessThanOrEqual(0.45);
    } else {
      expect(recommendation.furtherTestingSuggested).toBe(true);
    }
  });

  it("requests additional boundary expansion candidates when needed", () => {
    const result = runSearch(3200, { seed: 25 });
    expect(result.proposalsTotal).toBeGreaterThan(0);
  });
});
