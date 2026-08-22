import { describe, expect, it } from "vitest";
import { buildExperimentDefinition, planCandidateBlocks } from "../src/experiments/protocol.ts";
import { equalXy } from "../src/domain/settings.ts";

const def = buildExperimentDefinition({
  id: "experiment-protocol-test",
  name: "protocol test",
  baselineSensitivity: equalXy(7),
  dpi: 800,
});

describe("experiment protocol", () => {
  it("creates a candidate ladder around the baseline", () => {
    expect(def.candidates.length).toBeGreaterThanOrEqual(5);
    expect(def.candidates.some((c) => c.origin.kind === "baseline")).toBe(true);
  });

  it("produces warmup and measured phases per candidate", () => {
    const plan = planCandidateBlocks(def, 0);
    for (const candidate of def.candidates) {
      const block = plan.filter((s) => s.candidateId === candidate.id);
      expect(block.filter((s) => s.phase === "warmup").length).toBe(
        def.warmupTrialsPerCandidateBlock,
      );
      expect(block.filter((s) => s.phase === "measured").length).toBe(
        def.measuredRepsPerCandidatePerRound,
      );
      const firstMeasured = block.findIndex((s) => s.phase === "measured");
      expect(block.slice(0, firstMeasured).every((s) => s.phase === "warmup")).toBe(true);
    }
  });

  it("is deterministic for a given seed and round", () => {
    expect(planCandidateBlocks(def, 3)).toEqual(planCandidateBlocks(def, 3));
  });

  it("varies candidate ordering across rounds to counter learning bias", () => {
    const orderOf = (round: number) =>
      planCandidateBlocks(def, round)
        .map((s) => s.candidateId)
        .filter((v, i, arr) => i === 0 || arr[i - 1] !== v)
        .join(",");
    const orders = new Set([0, 1, 2].map(orderOf));
    expect(orders.size).toBe(3);
  });

  it("gives every candidate the same scenario multiset per round (paired design)", () => {
    const plan = planCandidateBlocks(def, 2);
    const sortedScenarios = (candidateId: string) =>
      plan
        .filter((s) => s.candidateId === candidateId && s.phase === "measured")
        .map((s) => s.scenarioId)
        .sort()
        .join(",");
    const first = sortedScenarios(def.candidates[0]!.id);
    for (const candidate of def.candidates.slice(1)) {
      expect(sortedScenarios(candidate.id)).toBe(first);
    }
  });

  it("supports filtering candidates for refinement rounds", () => {
    const only = [def.candidates[0]!.id];
    const plan = planCandidateBlocks(def, 4, only);
    expect(new Set(plan.map((s) => s.candidateId))).toEqual(new Set(only));
  });
});
