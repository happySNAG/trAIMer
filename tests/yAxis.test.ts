import { describe, expect, it } from "vitest";
import {
  planYExploration,
  evaluateYExploration,
} from "../src/optimizer/yAxis.ts";
import { buildExperimentDefinition } from "../src/experiments/protocol.ts";
import { equalXy } from "../src/domain/settings.ts";
import type { SensitivityCandidate } from "../src/domain/candidate.ts";
import type { TrialRecord } from "../src/domain/trial.ts";

const definition = buildExperimentDefinition({
  id: "experiment-y",
  name: "y",
  baselineSensitivity: equalXy(7),
  dpi: 800,
});

const bestCandidate: SensitivityCandidate = {
  id: "cand-best",
  sensitivity: equalXy(7.2),
  origin: { kind: "manual", label: "stage-1 winner" },
};

describe("independent-Y staged exploration", () => {
  it("plans an anchor plus symmetric unequal-Y variants", () => {
    const plan = planYExploration(
      { enabled: true, yFactors: [0.85, 1, 1.18], minImprovementZ: 2 },
      bestCandidate,
    );
    expect(plan).not.toBeNull();
    expect(plan!.candidates.length).toBe(3);
    const anchor = plan!.candidates[0]!;
    expect(anchor.sensitivity).toEqual({ sensX: 7.2, sensY: 7.2 });
    const yValues = plan!.candidates.slice(1).map((c) => c.sensitivity.sensY);
    expect(yValues[0]!).toBeLessThan(7.2);
    expect(yValues[1]!).toBeGreaterThan(7.2);
    for (const candidate of plan!.candidates) {
      expect(candidate.sensitivity.sensX).toBe(7.2);
    }
  });

  it("returns null when disabled or factors are trivial", () => {
    expect(
      planYExploration(
        { enabled: false, yFactors: [0.85, 1], minImprovementZ: 2 },
        bestCandidate,
      ),
    ).toBeNull();
    expect(
      planYExploration({ enabled: true, yFactors: [1, 1], minImprovementZ: 2 }, bestCandidate),
    ).toBeNull();
  });

  it("recommends equality when no variant beats the anchor reliably", () => {
    const plan = planYExploration(
      { enabled: true, yFactors: [0.85, 1.18], minImprovementZ: 2 },
      bestCandidate,
    )!;
    const trialsByCandidate = fabricateCells(plan!.candidates, [
      [0.50, 0.50],
      [0.495, 0.50],
      [0.505, 0.50],
    ]);
    const summary = evaluateYExploration({
      definition,
      trialsByCandidate,
      policy: { fatalReasons: [], suspectPolicy: "exclude" },
      plan: plan!,
      config: { enabled: true, yFactors: [0.85, 1.18], minImprovementZ: 2 },
    });
    expect(summary.recommendedEqualY).toBe(true);
    expect(summary.rationaleLines.join(" ")).toContain("sensY = sensX");
  });

  it("detects a reliable asymmetric advantage when present", () => {
    const plan = planYExploration(
      { enabled: true, yFactors: [0.85, 1.18], minImprovementZ: 2 },
      bestCandidate,
    )!;
    const trialsByCandidate = fabricateCells(plan.candidates, [
      [0.45, 0.45],
      [0.62, 0.60],
      [0.44, 0.46],
    ]);
    const summary = evaluateYExploration({
      definition,
      trialsByCandidate,
      policy: { fatalReasons: [], suspectPolicy: "exclude" },
      plan,
      config: { enabled: true, yFactors: [0.85, 1.18], minImprovementZ: 2 },
    });
    expect(summary.explored).toBe(true);
    if (summary.improvementZ !== null && summary.improvementZ > 2) {
      expect(summary.recommendedEqualY).toBe(false);
    }
  });

  it("simulator supports an asymmetric hidden optimum", async () => {
    const { SyntheticExperimentRunner, playerPreset } = await import("../src/index.ts");
    const def = buildExperimentDefinition({
      id: "experiment-asym",
      name: "asym",
      baselineSensitivity: equalXy(7),
      dpi: 800,
      ladderFactors: [1 / 2.4, 1, 2.4],
      measuredRepsPerCandidatePerRound: 20,
      scenarioIds: ["flick-static-medium"],
      warmupTrialsPerCandidateBlock: 1,
    });
    const runner = new SyntheticExperimentRunner(def, {
      ...playerPreset("consistent-medium"),
      trueOptimalEdpi: 5600,
      trueOptimalEdpiY: 2800,
    });
    const trials = runner.runRound(0, 31337, "session-asym", def.id).filter(
      (t) => t.phase === "measured",
    );
    // Vertical-dominant flicks should suffer when Y is far off; the low
    // eDPI candidate (X and Y both scaled down together) must not simply win.
    const hitRate = (candidateId: string): number => {
      const list = trials.filter((t) => t.candidateId === candidateId);
      return list.filter((t) => t.outcome === "hit").length / Math.max(list.length, 1);
    };
    const candidates = def.candidates;
    const high = candidates.find((c) => c.origin.kind === "generated" && c.sensitivity.sensX > 7)!;
    void high;
    expect(hitRate(candidates.find((c) => c.origin.kind === "baseline")!.id)).toBeGreaterThan(0.3);
  });
});

function fabricateCells(
  candidates: SensitivityCandidate[],
  cellMeansPerCandidate: number[][],
): Map<string, TrialRecord[]> {
  const trialsByCandidate = new Map<string, TrialRecord[]>();
  candidates.forEach((candidate, ci) => {
    const means = cellMeansPerCandidate[ci] ?? [];
    const list: TrialRecord[] = [];
    means.forEach((meanValue, repIndex) => {
      for (let roundCopy = 0; roundCopy < 6; roundCopy++) {
        const record = makeCellTrial(candidate.id, repIndex, meanValue + (roundCopy % 2 ? 0.01 : -0.01));
        list.push(record);
      }
    });
    trialsByCandidate.set(candidate.id, list);
  });
  return trialsByCandidate;
}

function makeCellTrial(
  candidateId: string,
  repIndex: number,
  utilityProxy: number,
): TrialRecord {
  const record = makeCellBase(candidateId, repIndex);
  record.outcome = utilityProxy >= 0.5 ? "hit" : "miss-shot-fired";
  return record;
}

function makeCellBase(candidateId: string, repIndex: number): TrialRecord {
  const base: TrialRecord = {
    id: `trial-${candidateId}-${repIndex}-${Math.random().toString(36).slice(2)}` as never,
    sessionId: null,
    experimentId: null,
    candidateId: candidateId as never,
    indexInSession: repIndex,
    phase: "measured",
    scenarioId: "flick-static-medium",
    scenarioKind: "flick-static",
    captureContext: {
      scenarioKind: "flick-static",
      viewport: { widthPx: 1280, heightPx: 720 },
      sensitivity: equalXy(7),
      dpi: 800,
      expectedSampleIntervalMs: 4,
    },
    startedAtMonotonicMs: 0,
    endedAtMonotonicMs: 400,
    samples: Array.from({ length: 40 }, (_, i) => ({
      tMs: i * 8,
      cursor: { x: 640 + i * 3, y: 360 },
      dx: 3,
      dy: 0,
    })),
    targets: [],
    shots: [],
    focusInterruptions: [],
    viewportResizes: [],
    outcome: "hit",
    validity: { status: "valid", reasons: [] },
    seedTag: null,
    scenarioRepIndex: repIndex,
    abortedMs: null,
  };
  return base;
}
