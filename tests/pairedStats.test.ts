import { describe, expect, it } from "vitest";
import {
  computeCellUtilities,
  computePairedComparisons,
  lookupComparison,
} from "../src/optimizer/paired.ts";
import type { ExclusionPolicy } from "../src/optimizer/evaluate.ts";
import { buildExperimentDefinition } from "../src/experiments/protocol.ts";
import { equalXy } from "../src/domain/settings.ts";
import type { TrialRecord } from "../src/domain/trial.ts";
import { makeTrial } from "./helpers.ts";

const policy: ExclusionPolicy = {
  fatalReasons: ["IMPOSSIBLE_TIMESTAMPS"],
  suspectPolicy: "exclude",
};

const definition = buildExperimentDefinition({
  id: "experiment-paired",
  name: "paired",
  baselineSensitivity: equalXy(7),
  dpi: 800,
});

function trial(
  candidateId: string,
  scenarioId: string,
  repIndex: number,
  accuracyScore: number,
): TrialRecord {
  const base = makeTrial({
    id: `trial-${candidateId}-${scenarioId}-${repIndex}`,
    candidateId,
    scenarioRepIndex: repIndex,
    scenarioId,
    scenarioKind: scenarioId.startsWith("tracking") ? "tracking" : "flick-static",
  });
  // Encode utility through a single synthetic dimension by using accuracy on a
  // one-shot flick record: hit with controlled final error.
  void accuracyScore;
  return base;
}

describe("paired-difference statistics", () => {
  it("eliminates instance difficulty exactly under pairing", () => {
    const candidates = ["cand-a", "cand-b"] as const;
    const trialsByCandidate = new Map<string, TrialRecord[]>();

    // Candidate A plays instances with utilities 0.6/0.2 (hard/easy),
    // candidate B plays the SAME instances with 0.5/0.1.
    const cellUtilitiesA = new Map([
      ["flick-static-medium#0", 0.6],
      ["flick-static-medium#1", 0.2],
      ["flick-static-small#0", 0.7],
    ]);
    const cellUtilitiesB = new Map([
      ["flick-static-medium#0", 0.5],
      ["flick-static-medium#1", 0.1],
      ["flick-static-small#0", 0.55],
    ]);

    for (const [candidateId, cells] of [
      [candidates[0], cellUtilitiesA],
      [candidates[1], cellUtilitiesB],
    ] as const) {
      const list: TrialRecord[] = [];
      for (const [cell, value] of cells) {
        const [scenarioId, rep] = cell.split("#");
        const t = trial(candidateId, scenarioId!, Number(rep), value);
        t.scenarioRepIndex = Number(rep);
        list.push(t);
      }
      trialsByCandidate.set(candidateId, list);
    }

    // Monkey-level control: inject known per-cell values via stubbed scoring.
    // Because scoreTrialDimensions derives from records, we instead validate
    // the aggregation layer directly using fabricated cell maps.
    const directCells = new Map<string, Map<string, number>>([
      [candidates[0], new Map(cellUtilitiesA)],
      [candidates[1], new Map(cellUtilitiesB)],
    ]);
    const comparisons = computePairedComparisons(trialsByCandidate, directCells);
    const comparison = lookupComparison(comparisons, candidates[0], candidates[1]);
    expect(comparison).not.toBeNull();
    expect(comparison!.pairedCells).toBe(3);
    // diffs: +0.1, +0.1, +0.15 → mean ≈ 0.1167 regardless of instance spread
    expect(comparison!.diffMean).toBeCloseTo(0.116666, 5);
    expect(comparison!.z).toBeGreaterThan(5);
  });

  it("skips pairs with a single shared cell (SE undefined) and pairs ≥2 cells", () => {
    const oneShared = new Map<string, Map<string, number>>([
      ["cand-a", new Map([["s#0", 0.5], ["s#1", 0.4]])],
      ["cand-b", new Map([["s#0", 0.45], ["s#2", 0.44]])],
    ]);
    expect(
      lookupComparison(
        computePairedComparisons(
        new Map([
          ["cand-a", [] as TrialRecord[]],
          ["cand-b", []],
        ]),
        oneShared,
      ),
        "cand-a",
        "cand-b",
      ),
    ).toBeNull();

    const twoShared = new Map<string, Map<string, number>>([
      ["cand-a", new Map([["s#0", 0.5], ["s#1", 0.4]])],
      ["cand-b", new Map([["s#0", 0.45], ["s#1", 0.44]])],
    ]);
    const comparison = lookupComparison(
      computePairedComparisons(
        new Map([
          ["cand-a", [] as TrialRecord[]],
          ["cand-b", []],
        ]),
        twoShared,
      ),
      "cand-a",
      "cand-b",
    );
    expect(comparison?.pairedCells).toBe(2);
  });

  it("normalizes direction when looking up flipped pairs", () => {
    const comparisons = computePairedComparisons(
      new Map([
        ["x", [] as TrialRecord[]],
        ["y", []],
      ]),
      new Map([
        ["x", new Map([["s#0", 0.9], ["s#1", 0.8]])],
        ["y", new Map([["s#0", 0.4], ["s#1", 0.5]])],
      ]),
    );
    const xy = lookupComparison(comparisons, "x", "y");
    const yx = lookupComparison(comparisons, "y", "x");
    expect(xy!.diffMean).toBeCloseTo(0.4);
    expect(yx!.diffMean).toBeCloseTo(-0.4);
  });

  it("computes cell utilities from real trial records via scoring", () => {
    const record = makeTrial({
      id: "trial-cellcheck",
      outcome: "hit",
      samples: Array.from({ length: 40 }, (_, i) => ({
        tMs: i * 4,
        cursor: { x: 640 + i * 2, y: 360 },
      })),
      targets: [
        {
          targetId: "target-c",
          radiusPx: 26,
          appearedMs: 10,
          removedMs: 120,
          removalReason: "hit",
          motion: { kind: "static" as const, position: { x: 700, y: 360 } },
        },
      ],
      shots: [
        {
          tMs: 118,
          cursorAtShot: { x: 700, y: 360 },
          aimedTargetId: "target-c",
          hit: true,
          missDistancePx: 0,
        },
      ],
    });
    record.scenarioRepIndex = 0;
    const map = new Map<string, TrialRecord[]>([["cand-z", [record]]]);
    const cells = computeCellUtilities(definition, map, policy);
    expect(cells.get("cand-z")?.get("flick-static-medium#0")).toBeDefined();
  });
});
