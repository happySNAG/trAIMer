import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SensitivityOptimizer,
  SyntheticExperimentRunner,
  buildExperimentDefinition,
  playerPreset,
} from "../src/index.ts";
import { estimateCompositeOptimumEdpi as sharedEstimateCompositeOptimumEdpi } from "../src/sim/calibrate.ts";
import { equalXy } from "../src/domain/settings.ts";
import type { SyntheticPlayerConfig } from "../src/sim/player.ts";

const DPI = 800;
const BASELINE_PERCENT = 7;

interface RecoveryCase {
  label: string;
  makePlayer(): SyntheticPlayerConfig;
  sessionSeeds: number[];
}

const RECOVERY_CASES: RecoveryCase[] = [
  {
    label: "consistent-medium @3200",
    makePlayer: () => ({ ...playerPreset("consistent-medium"), trueOptimalEdpi: 3200 }),
    sessionSeeds: [101],
  },
  {
    label: "consistent-medium @5600",
    makePlayer: () => ({ ...playerPreset("consistent-medium"), trueOptimalEdpi: 5600 }),
    sessionSeeds: [101, 202],
  },
  {
    label: "consistent-medium @8800",
    makePlayer: () => ({ ...playerPreset("consistent-medium"), trueOptimalEdpi: 8800 }),
    sessionSeeds: [202],
  },
  {
    label: "jittery-fast @5600",
    makePlayer: () => ({ ...playerPreset("jittery-fast"), trueOptimalEdpi: 5600 }),
    sessionSeeds: [303],
  },
  {
    label: "deliberate-slow @4400",
    makePlayer: () => ({ ...playerPreset("deliberate-slow"), trueOptimalEdpi: 4400 }),
    sessionSeeds: [404],
  },
  {
    label: "noisy-beginner @7000",
    makePlayer: () => ({ ...playerPreset("noisy-beginner"), trueOptimalEdpi: 7000 }),
    sessionSeeds: [505],
  },
];

function estimateCompositeOptimumEdpi(player: SyntheticPlayerConfig): number {
  const calibration = sharedEstimateCompositeOptimumEdpi(player, {
    dpi: DPI,
    baselineSensitivityPercent: BASELINE_PERCENT,
    repsPerCandidatePerRound: 16,
    rounds: 3,
    seedBase: 900001,
  });
  return calibration.compositeOptimumEdpi;
}

function runBlindOptimization(
  player: SyntheticPlayerConfig,
  seed: number,
  overrides: { reps?: number; maxRounds?: number } = {},
): ReturnType<SensitivityOptimizer["recommend"]> {
  const def = buildExperimentDefinition({
    id: "experiment-blind-recovery",
    name: `blind recovery (${seed})`,
    baselineSensitivity: equalXy(BASELINE_PERCENT),
    dpi: DPI,
    orderSeed: seed,
    measuredRepsPerCandidatePerRound: overrides.reps ?? 10,
    warmupTrialsPerCandidateBlock: 2,
  });
  const runner = new SyntheticExperimentRunner(def, player);
  const optimizer = new SensitivityOptimizer(def, {
    maxSearchRounds: overrides.maxRounds ?? 2,
  });
  optimizer.addTrials(runner.runRound(0, seed, "session-blind", def.id));
  for (let guard = 0; guard < 4; guard++) {
    const next = optimizer.needsMoreEvidence();
    if (next.kind === "done") break;
    optimizer.addCandidates(next.candidates);
    optimizer.addTrials(
      runner.runRound(next.round, seed, "session-blind", def.id, next.candidates.map((c) => c.id)),
    );
  }
  return optimizer.recommend();
}

describe("blind optimum recovery", () => {
  const truths = new Map<string, number>();

  beforeAll(() => {
    for (const testCase of RECOVERY_CASES) {
      const cacheKey = testCase.label;
      const existing = truths.get(cacheKey);
      if (existing !== undefined) continue;
      truths.set(cacheKey, estimateCompositeOptimumEdpi(testCase.makePlayer()));
    }
  }, 400000);

  afterAll(() => {
    truths.clear();
  });

  it.each(RECOVERY_CASES.map((c) => [c.label, c] as const))(
    "%s: recovers the composite optimum without seeing it",
    (label, testCase) => {
      const hiddenTruth = truths.get(label)!;
      const nominalKnob = testCase.makePlayer().trueOptimalEdpi;
      for (const seed of testCase.sessionSeeds) {
        const recommendation = runBlindOptimization(testCase.makePlayer(), seed);

        const octaveError = Math.log2(recommendation.recommendedEdpi / hiddenTruth);
        const confident =
          recommendation.confidence >= 0.5 &&
          recommendation.evidence.separation === "clear";
        if (confident) {
          expect(
            Math.abs(octaveError),
            `${label} seed=${seed}: confident point estimate ${recommendation.recommendedEdpi.toFixed(0)} vs composite optimum ${hiddenTruth.toFixed(0)} (${(octaveError * 100).toFixed(1)}%)`,
          ).toBeLessThanOrEqual(0.35);
        } else {
          const slackFactor = 1.08;
          const coversTruthWithSlack =
            hiddenTruth >= recommendation.edpiRange.min / slackFactor &&
            hiddenTruth <= recommendation.edpiRange.max * slackFactor;
          expect(
            coversTruthWithSlack && Math.abs(octaveError) <= 0.55,
            `${label} seed=${seed}: low-confidence run must still bracket the composite optimum ${hiddenTruth.toFixed(0)}; got range [${recommendation.edpiRange.min.toFixed(0)}, ${recommendation.edpiRange.max.toFixed(0)}], point ${recommendation.recommendedEdpi.toFixed(0)}`,
          ).toBe(true);
          expect(
            recommendation.refusedHighConfidence ||
              recommendation.warnings.length > 0,
            `${label} seed=${seed}: expected explicit low-confidence signalling`,
          ).toBe(true);
        }

        const containsTruth =
          hiddenTruth >= recommendation.edpiRange.min &&
          hiddenTruth <= recommendation.edpiRange.max;
        const containsNominal =
          nominalKnob >= recommendation.edpiRange.min &&
          nominalKnob <= recommendation.edpiRange.max;
        const rangeWidthOctaves = Math.log2(
          recommendation.edpiRange.max / recommendation.edpiRange.min,
        );
        expect(
          containsTruth ||
            containsNominal ||
            (rangeWidthOctaves <= 0.25 && Math.abs(octaveError) <= 0.22),
          `${label} seed=${seed}: range [${recommendation.edpiRange.min.toFixed(0)}, ${recommendation.edpiRange.max.toFixed(0)}] (${rangeWidthOctaves.toFixed(2)} oct) neither covers truth nor is tightly centered on it`,
        ).toBe(true);

        const serializedTrialsAndDefs = JSON.stringify({
          edpi: recommendation.recommendedEdpi,
          evidence: recommendation.evidence,
        });
        expect(serializedTrialsAndDefs).not.toContain("trueOptimal");
      }
    },
    120000,
  );

  it("refuses high confidence when trial budget is deliberately starved", () => {
    const player = { ...playerPreset("consistent-medium"), trueOptimalEdpi: 5600 };
    const recommendation = runBlindOptimization(player, 777, { reps: 2, maxRounds: 1 });
    expect(recommendation.refusedHighConfidence).toBe(true);
    expect(recommendation.confidenceLabel).toBe("low");
    expect(recommendation.evidence.separation === "insufficient" || recommendation.confidence < 0.5).toBe(true);
  }, 60000);

  it("never leaks the hidden optimum through the public pipeline", () => {
    const player = { ...playerPreset("consistent-medium"), trueOptimalEdpi: 4423 };
    const def = buildExperimentDefinition({
      id: "experiment-leak-check",
      name: "leak",
      baselineSensitivity: equalXy(BASELINE_PERCENT),
      dpi: DPI,
      measuredRepsPerCandidatePerRound: 3,
    });
    const runner = new SyntheticExperimentRunner(def, player);
    const optimizer = new SensitivityOptimizer(def, { maxSearchRounds: 1 });
    const trials = runner.runRound(0, 31, "session-leak", def.id);
    optimizer.addTrials(trials);
    const leakProbe = JSON.stringify({ def, trials, rec: optimizer.recommend() });
    expect(leakProbe).not.toContain('"trueOptimalEdpi"');
    expect(leakProbe.toLowerCase()).not.toContain("optimalEdpi".toLowerCase());
  }, 30000);
});

