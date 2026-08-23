import { describe, expect, it } from "vitest";
import { runCampaignCase } from "../src/campaigns/runner.ts";
import { SyntheticExperimentRunner } from "../src/sim/simulator.ts";
import { playerPreset } from "../src/sim/player.ts";
import { SensitivityOptimizer } from "../src/optimizer/optimizer.ts";
import { buildExperimentDefinition } from "../src/experiments/protocol.ts";
import { planCandidateBlocks } from "../src/experiments/protocol.ts";
import { allocateExtraBlocks } from "../src/session/informationAllocation.ts";
import { planNextTest } from "../src/session/retest.ts";
import { buildFinalResult } from "../src/results/finalResult.ts";
import { stableStringify } from "../src/persistence/backup.ts";
import type { SessionId, ExperimentId } from "../src/domain/ids.ts";

/**
 * Pass 6 determinism audit (requirement 12).
 *
 * Identical seed + raw trials + calibration + scoring weights + engine
 * version MUST produce byte-identical analysis/recommendation outputs for
 * every designed-deterministic surface. Intentionally non-deterministic
 * metadata (wall-clock timestamps, storage envelopes' savedAtIso) is
 * documented separately and excluded here.
 */

function fullPipeline(seed: number) {
  const definition = buildExperimentDefinition({
    id: `experiment-det-${seed}` as never,
    name: `determinism ${seed}`,
    baselineSensitivity: { sensX: 7, sensY: 7 },
    dpi: 800,
    orderSeed: seed,
    randomizeOrder: true,
    warmupTrialsPerCandidateBlock: 1,
    measuredRepsPerCandidatePerRound: 4,
    adaptiveAllocation: { enabled: false },
    stoppingCriteria: { maxSearchRounds: 2 },
  });
  const runner = new SyntheticExperimentRunner(
    definition,
    playerPreset("deliberate-slow"),
    { sampleHz: 120 },
  );
  const optimizer = new SensitivityOptimizer(definition);
  const allTrials = [];
  for (let round = 0; round < 2; round++) {
    const trials = runner.runRound(
      round,
      seed,
      `session-det-${seed}` as SessionId,
      definition.id as ExperimentId,
    );
    optimizer.addTrials(trials);
    allTrials.push(...trials);
  }
  const recommendation = optimizer.recommend();
  return { definition, trials: allTrials, optimizer, recommendation };
}

function stripNonDeterministic(value: unknown): unknown {
  // savedAtIso-style wall-clock fields are INTENTIONALLY non-deterministic
  // and documented as such (docs/PASS6-DETERMINISM.md).
  if (Array.isArray(value)) return value.map(stripNonDeterministic);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "savedAtIso" || k === "startedAtIso" || k === "endedAtIso") continue;
      out[k] = stripNonDeterministic(v);
    }
    return out;
  }
  return value;
}

describe("engine determinism", () => {
  it("simulator produces byte-identical trials per seed", () => {
    const a = runCampaignCase({ seed: 4242, family: "clean-unimodal" });
    const b = runCampaignCase({ seed: 4242, family: "clean-unimodal" });
    expect(stableStringify(stripNonDeterministic(a))).toBe(
      stableStringify(stripNonDeterministic(b)),
    );
  }, 60_000);

  it("recommendation is byte-stable across recomputation", () => {
    const { optimizer, recommendation } = fullPipeline(313);
    const again = optimizer.recommend();
    expect(stableStringify(stripNonDeterministic(recommendation))).toBe(
      stableStringify(stripNonDeterministic(again)),
    );
    // And across a fully independent re-run.
    const second = fullPipeline(313);
    expect(stableStringify(stripNonDeterministic(recommendation))).toBe(
      stableStringify(stripNonDeterministic(second.recommendation)),
    );
  }, 60_000);

  it("planned trial order is deterministic in (seed, round)", () => {
    const definition = buildExperimentDefinition({
      id: "experiment-plan" as never,
      name: "plan",
      baselineSensitivity: { sensX: 7, sensY: 7 },
      dpi: 800,
      orderSeed: 99,
      randomizeOrder: true,
    });
    const a = planCandidateBlocks(definition, 0);
    const b = planCandidateBlocks(definition, 0);
    expect(a).toEqual(b);
    // Different rounds differ (re-randomized), but each is stable.
    const c = planCandidateBlocks(definition, 1);
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(c));
  });

  it("allocation decisions are pure functions of observations", () => {
    const { optimizer } = fullPipeline(555);
    const evals = optimizer.evaluations();
    const comparisons = optimizer.pairedComparisons();
    const trialsPerCandidate = new Map(
      evals.map((e) => [e.candidateId, e.trialsIncluded.length]),
    );
    const input = {
      evaluations: evals,
      pairedComparisons: comparisons,
      repsPerBlock: 2,
      trialsSoFarPerCandidate: trialsPerCandidate,
      maxTotalMeasuredTrials: 200,
      adequacy: null,
      adaptation: null,
    };
    const a = allocateExtraBlocks(input);
    const b = allocateExtraBlocks(input);
    expect(a).toEqual(b);
  }, 60_000);

  it("candidate ranking and paired fit are stable", () => {
    const a = fullPipeline(777);
    const b = fullPipeline(777);
    const rankOf = (run: ReturnType<typeof fullPipeline>) =>
      run.optimizer.evaluations().map((e) => [e.candidateId, e.utilityMean] as const);
    expect(rankOf(a)).toEqual(rankOf(b));
    const fitA = a.optimizer.pairedEffects()?.estimates.map((e) => [e.candidateId, e.effect]);
    const fitB = b.optimizer.pairedEffects()?.estimates.map((e) => [e.candidateId, e.effect]);
    expect(fitA).toEqual(fitB);
  }, 60_000);

  it("adequacy classification is deterministic", () => {
    const a = fullPipeline(888);
    const b = fullPipeline(888);
    expect(a.optimizer.curveAdequacy()).toEqual(b.optimizer.curveAdequacy());
  }, 60_000);

  it("retest planning is deterministic given identical inputs", () => {
    const { recommendation, definition } = fullPipeline(999);
    const context = { orderSeed: 12345 } as const;
    const a = planNextTest(definition, recommendation, context);
    const b = planNextTest(definition, recommendation, context);
    expect(stableStringify(stripNonDeterministic(a))).toBe(
      stableStringify(stripNonDeterministic(b)),
    );
  }, 60_000);

  it("final result is byte-stable", () => {
    const { recommendation, definition } = fullPipeline(1010);
    const input = {
      recommendation,
      dpi: definition.dpi,
      currentSensXPercent: 7,
      currentSensYPercent: 7,
      calibration: null,
      retestPlan: null,
    } as const;
    const a = buildFinalResult({ ...input });
    const b = buildFinalResult({ ...input });
    expect(stableStringify(stripNonDeterministic(a))).toBe(
      stableStringify(stripNonDeterministic(b)),
    );
  }, 60_000);
});
