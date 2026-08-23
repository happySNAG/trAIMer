import { describe, expect, it } from "vitest";
import { runCampaignCase } from "../src/campaigns/runner.ts";
import { aggregateCases, auditConfidenceHonesty, scoreAsymmetryVerdicts } from "../src/campaigns/metrics.ts";
import { ALL_PLAYER_FAMILIES, PLAYER_FAMILIES } from "../src/campaigns/playerFamilies.ts";

/**
 * Pass 6 Monte Carlo campaign infrastructure tests. These run SMALL
 * deterministic slices to prove the harness itself is sound; population-level
 * conclusions live in docs/pass6-data/*.json and docs/PASS6-*.md.
 */

describe("player families", () => {
  it("covers every mandated geometry", () => {
    expect(ALL_PLAYER_FAMILIES.length).toBeGreaterThanOrEqual(17);
    expect(ALL_PLAYER_FAMILIES).toContain("boundary-optimum");
    expect(ALL_PLAYER_FAMILIES).toContain("outside-ladder");
    expect(ALL_PLAYER_FAMILIES).toContain("real-xy-asymmetry");
    expect(ALL_PLAYER_FAMILIES).toContain("false-xy-asymmetry");
  });

  it("is deterministic per seed", () => {
    const a = PLAYER_FAMILIES["clean-unimodal"].build(1234);
    const b = PLAYER_FAMILIES["clean-unimodal"].build(1234);
    expect(a).toEqual(b);
    const c = PLAYER_FAMILIES["clean-unimodal"].build(1235);
    expect(c.trueOptimalEdpi).not.toEqual(a.trueOptimalEdpi);
  });

  it("keeps every parameter finite across many seeds", () => {
    for (const family of ALL_PLAYER_FAMILIES) {
      for (let seed = 1; seed <= 40; seed++) {
        const p = PLAYER_FAMILIES[family].build(seed);
        for (const [key, value] of Object.entries(p)) {
          if (typeof value === "number") {
            expect(Number.isFinite(value), `${family}#${seed} ${key}`).toBe(true);
          }
        }
      }
    }
  });
});

describe("campaign runner", () => {
  it("produces identical results for identical seeds", () => {
    const options = { seed: 777, family: "clean-unimodal" } as const;
    const a = runCampaignCase(options);
    const b = runCampaignCase(options);
    expect(a).toEqual(b);
  }, 60_000);

  it("measures finite errors and coverage against estimated ground truth", () => {
    const r = runCampaignCase({ seed: 31, family: "low-motor-noise" });
    expect(Number.isFinite(r.groundTruthEdpi)).toBe(true);
    expect(Number.isFinite(r.recommendationEdpi)).toBe(true);
    expect(r.relativeErrorFraction).toBeGreaterThanOrEqual(0);
    expect(r.measuredTrials).toBeGreaterThan(20);
  }, 60_000);

  it("flags out-of-ladder optima honestly instead of confidently missing them", () => {
    const r = runCampaignCase({ seed: 55, family: "outside-ladder", rounds: 2 });
    if (!r.coveredByRange) {
      expect(
        r.unresolvedBoundary ||
          r.furtherTestingSuggested ||
          r.confidence <= 0.7,
      ).toBe(true);
      // Never a confident miss.
      expect(r.confidence).toBeLessThanOrEqual(0.7);
    }
  }, 60_000);
});

describe("metrics aggregation", () => {
  it("computes deterministic aggregates", () => {
    const base = {
      seed: 1,
      family: "f",
      groundTruthEdpi: 5000,
      groundTruthMethod: "supplied",
      recommendationEdpi: 5100,
      absoluteErrorEdpi: 100,
      relativeErrorFraction: 0.02,
      rangeMinEdpi: 4800,
      rangeMaxEdpi: 5300,
      coveredByRange: true,
      confidence: 0.8,
      confidenceLabel: "high",
      unresolvedBoundary: false,
      curveShape: "single-smooth-optimum",
      separation: "clear",
      furtherTestingSuggested: false,
      refusedHighConfidence: false,
      measuredTrials: 50,
      excludedTrials: 0,
      searchRoundsRun: 2,
      earlyStopped: false,
      budgetActionFinal: "continue",
      estimatedActiveSeconds: 300,
      retestPlanKind: null,
      retestTriggers: [],
      boundaryExpectationCorrect: null,
      falseBoundaryFlag: false,
      plateauExpectationCorrect: null,
      falseHighConfidence: false,
      jointXYOutcome: null,
      jointXYTruthAsymmetric: false,
    };
    const fake = [
      base,
      { ...base, seed: 2, recommendationEdpi: 6000, relativeErrorFraction: 0.2, coveredByRange: false, confidence: 0.85, falseHighConfidence: true },
    ];
    const agg = aggregateCases("test", fake as never);
    expect(agg.cases).toBe(2);
    expect(agg.coverageRate).toBeCloseTo(0.5, 5);
    expect(agg.falseHighConfidenceRate).toBeCloseTo(0.5, 5);
  });

  it("detects honesty violations on constructed bad populations", () => {
    const mk = (over: Record<string, unknown>) => ({
      seed: 1,
      family: "f",
      groundTruthEdpi: 5000,
      recommendationEdpi: 5000,
      absoluteErrorEdpi: 0,
      relativeErrorFraction: 0,
      rangeMinEdpi: 4900,
      rangeMaxEdpi: 5100,
      coveredByRange: true,
      confidence: 0.3,
      confidenceLabel: "low",
      unresolvedBoundary: false,
      curveShape: "single-smooth-optimum",
      separation: "clear",
      furtherTestingSuggested: false,
      refusedHighConfidence: false,
      measuredTrials: 50,
      excludedTrials: 0,
      searchRoundsRun: 2,
      earlyStopped: false,
      budgetActionFinal: "continue",
      estimatedActiveSeconds: 300,
      retestPlanKind: null,
      retestTriggers: [],
      boundaryExpectationCorrect: null,
      falseBoundaryFlag: false,
      plateauExpectationCorrect: null,
      falseHighConfidence: false,
      jointXYOutcome: null,
      jointXYTruthAsymmetric: false,
      ...over,
    });
    const bad = [
      mk({ confidence: 0.9, coveredByRange: false }),
      mk({ confidence: 0.85, relativeErrorFraction: 0.3 }),
      mk({ unresolvedBoundary: true, confidence: 0.6 }),
      mk({ curveShape: "multimodal-inconsistent", confidence: 0.5 }),
    ];
    const findings = auditConfidenceHonesty(bad as never);
    const byKind = new Map(findings.map((f) => [f.kind, f]));
    expect(byKind.get("high-confidence-uncovered-truth")!.cases).toBe(1);
    expect(byKind.get("high-confidence-large-error")!.cases).toBe(1);
    expect(byKind.get("confidence-above-cap-at-unresolved-boundary")!.cases).toBe(1);
    expect(byKind.get("confidence-above-cap-on-multimodal")!.cases).toBe(1);
  });

  it("scores asymmetry verdicts symmetric-vs-asymmetric correctly", () => {
    const rows = [
      { jointXYTruthAsymmetric: false, jointXYOutcome: "recommend-equal" },
      { jointXYTruthAsymmetric: false, jointXYOutcome: "clearly-asymmetric" },
      { jointXYTruthAsymmetric: true, jointXYOutcome: "clearly-asymmetric" },
      { jointXYTruthAsymmetric: true, jointXYOutcome: "insufficient-evidence" },
    ] as never[];
    const score = scoreAsymmetryVerdicts(rows);
    expect(score.symmetricCases).toBe(2);
    expect(score.asymmetricCases).toBe(2);
    expect(score.falsePositiveRate).toBeCloseTo(0.5, 5);
    expect(score.truePositiveRate).toBeCloseTo(0.5, 5);
  });
});
