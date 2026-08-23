import { describe, expect, it } from "vitest";
import {
  analyzeSegmented,
  analyzeSessionAdaptation,
} from "../src/optimizer/changepoint.ts";
import { buildUtilityTrials, utilityFromSeedTag } from "./syntheticUtilities.ts";

describe("formal segmented change-point analysis", () => {
  it("stable series → no significant change point", () => {
    // Deterministic alternating values around a constant mean.
    const values = [0.50, 0.52, 0.48, 0.51, 0.49, 0.52, 0.47, 0.50, 0.51, 0.48, 0.50, 0.49];
    const r = analyzeSegmented(values);
    expect(r.pattern).toBe("stable");
    expect(r.changePointIndex).not.toBeNull();
    expect(Math.abs(r.stepMagnitude!)).toBeLessThan(0.02);
  });

  it("detects warmup learning: poor early segment then stable improvement", () => {
    const values = [
      0.30, 0.32, 0.31, 0.33, // warmup (bad)
      0.50, 0.51, 0.49, 0.52, 0.50, 0.51, 0.49, 0.50, // stable good
    ];
    const r = analyzeSegmented(values);
    expect(r.pattern).toBe("warmup-learning");
    expect(r.changePointIndex).toBeLessThanOrEqual(4);
    expect(r.preMean!).toBeLessThan(0.4);
    expect(r.postMean!).toBeGreaterThan(0.45);
    expect(r.strengthZ!).toBeGreaterThan(2);
  });

  it("detects abrupt degradation", () => {
    const values = [
      0.55, 0.54, 0.56, 0.55, 0.53,
      0.30, 0.28, 0.31, 0.29, 0.30,
    ];
    const r = analyzeSegmented(values);
    expect(["abrupt-degradation", "temporary-collapse"]).toContain(r.pattern);
    expect(r.preMean!).toBeGreaterThan(0.45);
    expect(r.postMean!).toBeLessThan(0.4);
    expect(r.strengthZ!).toBeLessThan(-2);
  });

  it("detects temporary collapse with recovery", () => {
    const values = [
      0.55, 0.54, 0.56, 0.55, // good
      0.25, 0.24, 0.26, 0.25, // collapse
      0.54, 0.55, 0.56, 0.54, // recovered
    ];
    const r = analyzeSegmented(values);
    expect(r.pattern).toBe("temporary-collapse");
    expect(r.recoveryIndex).not.toBeNull();
    expect(r.changePointIndex!).toBeGreaterThanOrEqual(3);
    expect(r.changePointIndex!).toBeLessThanOrEqual(5);
  });

  it("detects gradual fatigue slope without a single jump", () => {
    // Slow linear decline of 0.01 per trial — no single big step.
    const values = Array.from({ length: 16 }, (_, i) => 0.60 - 0.01 * i + (i % 2 === 0 ? 0.005 : -0.005));
    const r = analyzeSegmented(values);
    expect(r.trendPerTrial).not.toBeNull();
    expect(r.trendPerTrial!).toBeLessThan(-0.005);
    expect(["fatigue-slope", "abrupt-degradation"]).toContain(r.pattern);
  });

  it("insufficient data is reported honestly", () => {
    const r = analyzeSegmented([0.5, 0.5]);
    expect(r.pattern).toBe("insufficient-data");
  });

  it("session-level report flags contamination and proposes actions", () => {
    // Candidate A shows warmup learning; candidate B stable.
    let seq = 0;
    const specsA = [0.30, 0.32, 0.31, 0.33, 0.50, 0.51, 0.49, 0.52].map(
      (u, i) => ({
        candidateId: "cand-A",
        scenarioId: `sc-${i % 2}`,
        repIndex: i,
        indexInSession: seq++,
        utility: u,
      }),
    );
    const specsB = [0.40, 0.41, 0.39, 0.42, 0.40, 0.41, 0.39, 0.40].map(
      (u, i) => ({
        candidateId: "cand-B",
        scenarioId: `sc-${i % 2}`,
        repIndex: i + 8,
        indexInSession: seq++,
        utility: u,
      }),
    );
    const trials = buildUtilityTrials([...specsA, ...specsB]);
    const report = analyzeSessionAdaptation(trials, {
      utilityOf: utilityFromSeedTag,
    });
    expect(report.contaminationDetected).toBe(true);
    const aRow = report.perCandidate.find((r) => r.candidateId === "cand-A")!;
    expect(aRow.analysis.pattern).toBe("warmup-learning");
    expect(aRow.mayContaminateComparison).toBe(true);
    expect(report.recommendedActions).toContain("add-extra-warmup");
    expect(report.recommendedActions).toContain("re-expose-candidate");
  });

  it("raw data remains untouched by the analysis", () => {
    const specs = [0.5, 0.5, 0.5, 0.5, 0.9, 0.1, 0.9, 0.1].map((u, i) => ({
      candidateId: "cand-x",
      scenarioId: "sc",
      repIndex: i,
      indexInSession: i,
      utility: u,
    }));
    const trials = buildUtilityTrials(specs);
    const before = JSON.stringify([...trials.values()].flat().map((t) => t.seedTag));
    analyzeSessionAdaptation(trials, { utilityOf: utilityFromSeedTag });
    const after = JSON.stringify([...trials.values()].flat().map((t) => t.seedTag));
    expect(after).toBe(before);
  });
});
