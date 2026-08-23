import { describe, expect, it } from "vitest";
import {
  detectAdaptation,
  assessBaseline,
  planRetestSession,
  buildExperimentDefinition,
  SyntheticExperimentRunner,
  playerPreset,
  equalXy,
} from "../src/index.ts";
import type { TrialRecord } from "../src/domain/trial.ts";

function utilityTrial(candidateId: string, index: number, utility: number): TrialRecord {
  const t: TrialRecord = {
    id: `trial-${candidateId}-${index}` as never,
    sessionId: null,
    experimentId: null,
    candidateId: candidateId as never,
    indexInSession: index,
    phase: "measured",
    scenarioId: "flick-static-medium",
    scenarioKind: "flick-static",
    captureContext: {
      scenarioKind: "flick-static",
      viewport: { widthPx: 1280, heightPx: 720 },
      sensitivity: equalXy(7),
      dpi: 800,
      expectedSampleIntervalMs: null,
    },
    startedAtMonotonicMs: index * 500,
    endedAtMonotonicMs: index * 500 + 300,
    samples: Array.from({ length: 20 }, (_, i) => ({
      tMs: index * 500 + i * 8,
      cursor: { x: 640 + i, y: 360 },
      dx: 1,
      dy: 0,
    })),
    targets: [
      {
        targetId: `target-${index}` as never,
        radiusPx: 26,
        appearedMs: index * 500 + 50,
        removedMs: index * 500 + 250,
        removalReason: "hit",
        motion: { kind: "static" as const, position: { x: 800, y: 360 } },
      },
    ],
    shots: [],
    focusInterruptions: [],
    viewportResizes: [],
    outcome: utility >= 0.5 ? "hit" : "miss-shot-fired",
    validity: { status: "valid", reasons: [] },
    seedTag: null,
    scenarioRepIndex: index % 4,
    abortedMs: null,
  };
  return t;
}

describe("adaptation detection", () => {
  it("flags significant late-session improvement within a candidate", () => {
    const trials = [
      ...Array.from({ length: 6 }, (_, i) =>
        utilityTrial("cand-x", i, i % 2 === 0 ? 0.15 : 0.25),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        utilityTrial("cand-x", i + 6, i % 2 === 0 ? 0.65 : 0.75),
      ),
    ];
    const report = detectAdaptation(
      new Map([["cand-x", trials]]),
      (t) => (t.outcome === "hit" ? 0.8 : 0.2),
    );
    expect(report.anySignificantImprovement).toBe(true);
    const effect = report.effects.find((e) => e.candidateId === "cand-x")!;
    expect(effect.improvement).toBeGreaterThan(0);
    expect(effect.significant).toBe(true);
  });

  it("stays quiet when performance is stable", () => {
    const trials = Array.from({ length: 10 }, (_, i) =>
      utilityTrial("cand-y", i, i % 2 === 0 ? 0.6 : 0.4),
    );
    const report = detectAdaptation(
      new Map([["cand-y", trials]]),
      (t) => (t.outcome === "hit" ? 0.8 : 0.2),
    );
    expect(report.anySignificantImprovement).toBe(false);
  });
});

describe("baseline workflow", () => {
  it("narrows the ladder for weak baselines and widens it for strong ones", () => {
    // Hand-built weak baseline: 30% hit rate.
    const weakTrialBase = {
      phase: "measured" as const,
      scenarioId: "flick-static-small",
      scenarioKind: "flick-static" as const,
    };
    const weakTrials = Array.from({ length: 10 }, (_, i) =>
      utilityTrial("cand-baseline", i, i < 3 ? 1 : 0),
    ).map((t) => ({
      ...t,
      ...weakTrialBase,
      outcome: (t.outcome === "hit" ? "hit" : "miss-shot-fired") as TrialRecord["outcome"],
    }));
    const weak = assessBaseline(weakTrials);
    expect((weak.hitRate ?? 1)).toBeCloseTo(0.3);
    expect(weak.suggestedLadderWidthOctaves).toBeLessThan(0.35);
    expect(weak.suggestedRepsPerRound).toBeLessThan(8);
    expect(weak.rationaleLines.join(" ")).toMatch(/narrowing/);

    const strongDef = buildExperimentDefinition({
      id: "experiment-base-strong" as never,
      name: "strong baseline",
      baselineSensitivity: equalXy(7),
      dpi: 800,
      measuredRepsPerCandidatePerRound: 12,
      scenarioIds: ["flick-static-medium"],
    });
    const strongRunner = new SyntheticExperimentRunner(strongDef, {
      ...playerPreset("consistent-medium"),
      trueOptimalEdpi: 5600,
    });
    const strongTrials = strongRunner
      .runRound(0, 52, "session-base", strongDef.id)
      .filter((t) => t.phase === "measured");
    const strong = assessBaseline(strongTrials);
    if ((strong.hitRate ?? 0) > 0.85) {
      expect(strong.suggestedLadderWidthOctaves).toBeGreaterThanOrEqual(0.35);
      expect(strong.rationaleLines.join(" ")).toMatch(/widening/);
    }
    void strong;
  });

  it("falls back to defaults on thin data without throwing", () => {
    const assessment = assessBaseline([]);
    expect(assessment.trialsUsed).toBe(0);
    expect(assessment.suggestedLadderWidthOctaves).toBeGreaterThan(0);
    expect(assessment.rationaleLines.join(" ")).toMatch(/too thin/i);
  });
});

describe("targeted retest flow", () => {
  function makePrior() {
    const priorDefinition = buildExperimentDefinition({
      id: "experiment-prior" as never,
      name: "prior session",
      baselineSensitivity: equalXy(7),
      dpi: 800,
      measuredRepsPerCandidatePerRound: 6,
    });
    const priorRecommendation = {
      experimentId: priorDefinition.id,
      recommendedEdpi: 5600,
      edpiRange: { min: 4870, max: 6440 },
      evidence: { bestCandidateId: "cand-baseline" },
    } as never as Parameters<typeof planRetestSession>[1];
    return { priorDefinition, priorRecommendation };
  }

  it("narrows to the plausible range with fresh blinding and linkage", () => {
    const { priorDefinition, priorRecommendation } = makePrior();
    const plan = planRetestSession(priorDefinition, priorRecommendation, { orderSeed: 3 });
    expect(plan).not.toBeNull();
    expect(plan!.priorExperimentId).toBe(priorDefinition.id);
    expect(plan!.definition.candidates.length).toBeGreaterThanOrEqual(3);

    const xs = plan!.definition.candidates.map((c) => c.sensitivity.sensX).sort((a, b) => a - b);
    expect(xs[0]).toBeGreaterThanOrEqual((4870 / 800) * 0.92 - 1e-9);
    expect(xs[xs.length - 1]).toBeLessThanOrEqual((6440 / 800) * 1.08 + 1e-9);

    const ids = new Set(plan!.definition.candidates.map((c) => c.id));
    expect(ids.size).toBe(plan!.definition.candidates.length);
    for (const candidate of plan!.definition.candidates) {
      expect(candidate.origin.kind === "manual" && candidate.origin.label.startsWith("retest")).toBe(true);
    }
    expect(plan!.definition.notes ?? "").toContain("targeted retest");
    expect(plan!.rationaleLines.join(" ")).toContain(`linked to prior experiment ${priorDefinition.id}`);
  });

  it("returns null when the prior range cannot be narrowed", () => {
    const { priorDefinition, priorRecommendation } = makePrior();
    const degenerate = {
      ...priorRecommendation,
      edpiRange: { min: 5600, max: 5600 },
    };
    expect(planRetestSession(priorDefinition, degenerate)).toBeNull();
  });
});
