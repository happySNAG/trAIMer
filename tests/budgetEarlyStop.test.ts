import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_BUDGET,
  evaluateBudgetDecision,
  summarizeDurationCampaign,
} from "../src/experiments/budget.ts";
import type { Recommendation } from "../src/domain/recommendation.ts";
import type { CaptureQualitySummary } from "../src/diagnostics/captureQuality.ts";

function preview(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    experimentId: "e" as never,
    primarySensitivity: { sensX: 7, sensY: 7 },
    recommendedEdpi: 5600,
    sensXRange: { min: 6.5, max: 7.5 },
    edpiRange: { min: 5200, max: 6000 },
    confidence: 0.75,
    confidenceLabel: "moderate",
    dimensionEstimates: {},
    utilityWeights: {} as never,
    evidence: {
      trialsAnalyzed: 40,
      trialsExcluded: 0,
      exclusionReasonCounts: {},
      candidatesEvaluated: 5,
      validTrialsPerCandidate: { a: 8, b: 8, c: 8, d: 8, e: 8 },
      bestCandidateId: "a",
      runnerUpCandidateId: "b",
      utilityGapBestVsRunnerUp: 0.06,
      utilityGapZScore: 2.6,
      separation: "clear",
      searchRoundsRun: 1,
      notes: [],
    },
    warnings: [],
    refusedHighConfidence: false,
    rationaleLines: [],
    unresolvedBoundary: false,
    furtherTestingSuggested: false,
    ...overrides,
  };
}

function poorQuality(): CaptureQualitySummary {
  return {
    sourceKind: "browser-basic",
    typicalEventRateHz: 30,
    rateDistributionHz: { p10: 20, p90: 45 },
    timingJitterCvMedian: null,
    dropRateFraction: 0.5,
    lockInterruptionsTotal: 3,
    viewportUnstableTrials: 1,
    degradationSlopePer100Trials: null,
    trialConsistency: 0.3,
    sourceTransitions: [],
    fractionHighQualityTrials: 0.2,
    worstIssues: [],
    score: 0.35,
    grade: "poor",
    reasonCodes: ["LOW_EVENT_RATE"],
    recommendationSuitability: "not-suitable-retest-required",
    retestingNecessary: true,
    trialsAnalyzed: 10,
    perTrial: [],
  };
}

function decide(overrides: Record<string, unknown>) {
  return evaluateBudgetDecision({
    config: DEFAULT_SESSION_BUDGET,
    trialsCompletedMeasured: 40,
    activeTestingMsUsed: 12 * 60000,
    wallClockMsUsed: 20 * 60000,
    continuousActiveMs: 3 * 60000,
    recommendationPreview: preview(),
    adequacy: null,
    adaptation: null,
    captureQuality: null,
    ...overrides,
  });
}

describe("experiment duration optimization", () => {
  it("stops early when evidence is clearly sufficient and nothing is open", () => {
    const d = decide({});
    expect(d.action).toBe("stop-sufficient");
    if (d.action === "stop-sufficient") expect(d.savedTrialsEstimate).toBeGreaterThan(0);
  });

  it("continues when contenders remain statistically tied", () => {
    const p = preview();
    const d = decide({
      recommendationPreview: preview({
        evidence: { ...p.evidence, separation: "weak", utilityGapZScore: 0.4 },
        confidence: 0.55,
      }),
    });
    expect(d.action).toBe("continue");
    if (d.action === "continue") expect(d.continueBecause).toContain("contenders-tied");
  });

  it("continues when the boundary is unresolved", () => {
    const d = decide({
      trialsCompletedMeasured: 60,
      recommendationPreview: preview({ unresolvedBoundary: true }),
    });
    expect(d.action).toBe("continue");
    if (d.action === "continue") expect(d.continueBecause).toContain("boundary-unresolved");
  });

  it("continues when capture quality is weak", () => {
    const d = decide({ captureQuality: poorQuality() });
    expect(d.action).toBe("continue");
    if (d.action === "continue") expect(d.continueBecause).toContain("capture-quality-weak");
  });

  it("defers to the next session at the wall-clock cap instead of chasing confidence", () => {
    const p = preview();
    const d = decide({
      wallClockMsUsed: DEFAULT_SESSION_BUDGET.maxTotalSessionMs + 1,
      recommendationPreview: preview({
        confidence: 0.5,
        furtherTestingSuggested: true,
        evidence: { ...p.evidence, separation: "weak" as const, utilityGapZScore: 1.1 },
      }),
    });
    expect(d.action).toBe("defer-to-next-session");
  });

  it("never early-stops below the minimum trial floor", () => {
    const d = decide({ trialsCompletedMeasured: 10 });
    expect(d.action).toBe("continue");
    if (d.action === "continue") expect(d.continueBecause).toContain("below-minimum-trials");
  });

  it("duration campaign summarization aggregates tradeoff rows deterministically", () => {
    const rows = [
      { repsPerCandidatePerRound: 4, rounds: 1, measuredTrials: 20, activeMs: 9 * 60000, errorEdpi: 300, rangeWidthEdpi: 1400, confidence: 0.55, earlyStopped: false },
      { repsPerCandidatePerRound: 4, rounds: 1, measuredTrials: 22, activeMs: 10 * 60000, errorEdpi: 500, rangeWidthEdpi: 1600, confidence: 0.6, earlyStopped: false },
      { repsPerCandidatePerRound: 8, rounds: 2, measuredTrials: 80, activeMs: 30 * 60000, errorEdpi: 120, rangeWidthEdpi: 900, confidence: 0.75, earlyStopped: true },
      { repsPerCandidatePerRound: 8, rounds: 2, measuredTrials: 76, activeMs: 28 * 60000, errorEdpi: 160, rangeWidthEdpi: 1000, confidence: 0.72, earlyStopped: true },
    ];
    const summary = summarizeDurationCampaign(rows);
    expect(summary).toHaveLength(2);
    const light = summary.find((r) => r.repsPerCandidatePerRound === 4)!;
    const heavy = summary.find((r) => r.repsPerCandidatePerRound === 8)!;
    // More trials ⇒ less error, narrower range, more confidence, more minutes.
    expect(light.medianAbsoluteErrorEdpi!).toBeGreaterThan(heavy.medianAbsoluteErrorEdpi!);
    expect(light.meanRangeWidthEdpi!).toBeGreaterThan(heavy.meanRangeWidthEdpi!);
    expect(light.meanConfidence!).toBeLessThan(heavy.meanConfidence!);
    expect(light.measuredTrials).toBeCloseTo(21, 6);
    expect(heavy.earlyStoppedSessions).toBe(2);
    // Deterministic: same input → same output.
    const again = summarizeDurationCampaign(rows);
    expect(again).toEqual(summary);
  });
});
