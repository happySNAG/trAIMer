import { describe, expect, it } from "vitest";
import {
  arrangeWithoutAdjacentRepeats,
  buildExperimentDefinition,
  drawBalancedScenarios,
  planCandidateBlocks,
} from "../src/experiments/protocol.ts";
import { makeExperimentId } from "../src/domain/ids.ts";
import { Rng } from "../src/util/rng.ts";

/**
 * Drill sequencing (Pass 11). "The same few tests over and over" came from
 * eight independent weighted draws over five drill families: blocks with
 * three of one family and none of another were common, and consecutive
 * repeats were routine. Draws are now balanced and de-repeated. What must NOT
 * change: every candidate in a round still sees the identical multiset, and
 * the plan stays a pure function of the seed.
 */

function definition(reps: number, seed = 42) {
  return buildExperimentDefinition({
    id: makeExperimentId("sequencing"),
    name: "sequencing",
    baselineSensitivity: { sensX: 7, sensY: 7 },
    dpi: 800,
    orderSeed: seed,
    measuredRepsPerCandidatePerRound: reps,
    warmupTrialsPerCandidateBlock: 0,
  });
}

function countBy(list: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of list) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}

describe("balanced scenario draws", () => {
  it("cover every drill family when reps ≥ families, with counts differing by at most one", () => {
    const def = definition(8);
    for (const seed of [1, 2, 3, 4, 5]) {
      const draws = drawBalancedScenarios(def, 8, new Rng(seed));
      expect(draws).toHaveLength(8);
      const counts = countBy(draws);
      expect(counts.size).toBe(5);
      const values = [...counts.values()];
      expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
    }
  });

  it("respect unequal weights proportionally", () => {
    const def = definition(10);
    const weighted = {
      ...def,
      scenarioMix: [
        { scenarioId: "flick-static-medium", weight: 0.5 },
        { scenarioId: "tracking-smooth-sine", weight: 0.5 },
      ],
    };
    const counts = countBy(drawBalancedScenarios(weighted, 10, new Rng(7)));
    expect(counts.get("flick-static-medium")).toBe(5);
    expect(counts.get("tracking-smooth-sine")).toBe(5);
  });

  it("are deterministic for a seed", () => {
    const def = definition(8);
    expect(drawBalancedScenarios(def, 8, new Rng(9))).toEqual(drawBalancedScenarios(def, 8, new Rng(9)));
  });
});

describe("no-adjacent-repeat arrangement", () => {
  it("separates repeats whenever the multiset allows", () => {
    const rng = new Rng(3);
    const out = arrangeWithoutAdjacentRepeats(["a", "a", "b", "b", "c", "c", "d", "e"], rng);
    expect(out).toHaveLength(8);
    expect(countBy(out)).toEqual(countBy(["a", "a", "b", "b", "c", "c", "d", "e"]));
    for (let i = 1; i < out.length; i++) expect(out[i]).not.toBe(out[i - 1]);
  });

  it("degrades gracefully when one family dominates", () => {
    const out = arrangeWithoutAdjacentRepeats(["a", "a", "a", "a", "b"], new Rng(1));
    expect(out).toHaveLength(5);
    expect(countBy(out).get("a")).toBe(4);
    // At most the unavoidable repeats.
    let adjacent = 0;
    for (let i = 1; i < out.length; i++) if (out[i] === out[i - 1]) adjacent++;
    expect(adjacent).toBe(2);
  });
});

describe("planned candidate blocks", () => {
  it("give every candidate the identical drill multiset within a round", () => {
    const def = definition(8);
    for (const round of [0, 1]) {
      const plan = planCandidateBlocks(def, round);
      const perCandidate = new Map<string, string[]>();
      for (const spec of plan) {
        if (spec.phase !== "measured") continue;
        const list = perCandidate.get(spec.candidateId) ?? [];
        list.push(spec.scenarioId);
        perCandidate.set(spec.candidateId, list);
      }
      const signatures = new Set(
        [...perCandidate.values()].map((l) => [...countBy(l).entries()].sort().join("|")),
      );
      expect(signatures.size, `round ${round}`).toBe(1);
    }
  });

  it("never run the same drill twice in a row inside a block (8 reps over 5 families)", () => {
    for (const seed of [1, 11, 111, 2026]) {
      const plan = planCandidateBlocks(definition(8, seed), 0);
      let previous: { candidateId: string; scenarioId: string } | null = null;
      for (const spec of plan) {
        if (spec.phase !== "measured") {
          previous = null;
          continue;
        }
        if (previous && previous.candidateId === spec.candidateId) {
          expect(spec.scenarioId, `seed ${seed}`).not.toBe(previous.scenarioId);
        }
        previous = spec;
      }
    }
  });

  it("include every drill family in every block", () => {
    const plan = planCandidateBlocks(definition(8), 0);
    const perCandidate = new Map<string, Set<string>>();
    for (const spec of plan) {
      if (spec.phase !== "measured") continue;
      const set = perCandidate.get(spec.candidateId) ?? new Set();
      set.add(spec.scenarioId);
      perCandidate.set(spec.candidateId, set);
    }
    for (const [candidate, families] of perCandidate) {
      expect(families.size, candidate).toBe(5);
    }
  });

  it("remain a pure function of the seed", () => {
    const def = definition(8, 77);
    expect(planCandidateBlocks(def, 0)).toEqual(planCandidateBlocks(def, 0));
    expect(planCandidateBlocks(def, 1)).not.toEqual(planCandidateBlocks(def, 0));
  });
});
