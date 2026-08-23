import { describe, expect, it } from "vitest";
import { compareSessions, type SessionReliabilityInput } from "../src/analysis/reliability.ts";
import type { Recommendation } from "../src/domain/recommendation.ts";
import type { TrialRecord } from "../src/domain/trial.ts";
import { equalXy } from "../src/domain/settings.ts";

function makeRec(options: {
  edpi: number;
  best: string;
  runner: string | null;
  label: "low" | "moderate" | "high";
  confidence: number;
}): Recommendation {
  const validTrials: Record<string, number> =
    options.best === "cand-a"
      ? { "cand-a": 12, "cand-b": 12 }
      : { "cand-b": 12, "cand-a": 12 };
  return {
    experimentId: "experiment-r",
    primarySensitivity: equalXy(options.edpi / 800),
    recommendedEdpi: options.edpi,
    sensXRange: { min: options.edpi / 800 / 1.3, max: (options.edpi / 800) * 1.3 },
    edpiRange: { min: options.edpi / 1.3, max: options.edpi * 1.3 },
    confidence: options.confidence,
    confidenceLabel: options.label,
    dimensionEstimates: {
      accuracy: { mean: 0.6, standardError: 0.03, sampleCount: 24 },
      speed: { mean: 0.5, standardError: 0.04, sampleCount: 24 },
    },
    utilityWeights: {
      speed: 0.14, accuracy: 0.28, overshootControl: 0.11,
      undershootControl: 0.11, correctionEfficiency: 0.12,
      trackingPrecision: 0.14, consistency: 0.1,
    },
    evidence: {
      trialsAnalyzed: 24,
      trialsExcluded: 0,
      exclusionReasonCounts: {},
      candidatesEvaluated: 5,
      validTrialsPerCandidate: validTrials,
      bestCandidateId: options.best,
      runnerUpCandidateId: options.runner,
      utilityGapBestVsRunnerUp: null,
      utilityGapZScore: null,
      separation: "clear",
      searchRoundsRun: 2,
      notes: [],
    },
    warnings: [],
    refusedHighConfidence: false,
    rationaleLines: [],
    unresolvedBoundary: false,
    furtherTestingSuggested: false,
  };
}

function trials(seedUtilityDrift: number): TrialRecord[] {
  const out: TrialRecord[] = [];
  for (const [candidateId, _baseUtility] of [
    ["cand-a", 0.5],
    ["cand-b", 0.45],
  ] as const) {
    for (let i = 0; i < 8; i++) {
      out.push({
        id: `trial-${candidateId}-${i}` as never,
        sessionId: null,
        experimentId: null,
        candidateId: candidateId as never,
        indexInSession: i,
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
        startedAtMonotonicMs: i * 500,
        endedAtMonotonicMs: i * 500 + 400,
        samples: [],
        targets: [],
        shots: [],
        focusInterruptions: [],
        viewportResizes: [],
        outcome: "hit",
        validity: { status: "valid", reasons: [] },
        seedTag: null,
        scenarioRepIndex: i % 4,
        abortedMs: null,
      });
    }
    void seedUtilityDrift;
  }
  return out;
}

function input(
  sessionId: string,
  rec: Recommendation,
  measured: TrialRecord[],
): SessionReliabilityInput {
  return { sessionId, recommendation: rec, measuredTrials: measured };
}

describe("test/retest reliability", () => {
  it("detects stability when the same optimum repeats", () => {
    const prior = input(
      "s1",
      makeRec({ edpi: 5200, best: "cand-a", runner: "cand-b", label: "moderate", confidence: 0.62 }),
      trials(0),
    );
    const next = input(
      "s2",
      makeRec({ edpi: 5300, best: "cand-a", runner: "cand-b", label: "moderate", confidence: 0.66 }),
      trials(0),
    );
    const summary = compareSessions(prior, next);
    expect(summary.recommendationDriftEdpi.octaves).toBeLessThan(0.05);
    expect(summary.priorRecommendationInsideNewRange).toBe(true);
    expect(summary.confidenceConsistency.consistent).toBe(true);
    expect(summary.candidateRankingStability.kendallTau).toBe(1);
    expect(summary.candidateRankingStability.interpretation).toContain("identical");
    expect(summary.caveats.join(" ")).toContain("not a validated reliability coefficient");
  });

  it("detects drift when the optimum changes between sessions", () => {
    const prior = input(
      "s1",
      makeRec({ edpi: 4800, best: "cand-a", runner: "cand-b", label: "moderate", confidence: 0.6 }),
      trials(0),
    );
    const next = input(
      "s2",
      makeRec({ edpi: 7400, best: "cand-b", runner: "cand-a", label: "moderate", confidence: 0.58 }),
      trials(1),
    );
    const summary = compareSessions(prior, next);
    expect(summary.recommendationDriftEdpi.absDelta).toBeGreaterThan(2000);
    expect(summary.priorRecommendationInsideNewRange).toBe(false);
    expect(summary.confidenceConsistency.consistent).toBe(true);
    expect(summary.candidateRankingStability.kendallTau).toBe(-1);
    for (const dim of summary.dimensionStability) {
      void dim;
    }
  });

  it("reports dimension deltas between sessions", () => {
    const prior = input(
      "s1",
      makeRec({ edpi: 5600, best: "cand-a", runner: null, label: "low", confidence: 0.2 }),
      trials(0),
    );
    const next = input(
      "s2",
      makeRec({ edpi: 5600, best: "cand-a", runner: null, label: "low", confidence: 0.22 }),
      trials(0),
    );
    next.recommendation.dimensionEstimates.accuracy!.mean = 0.72;
    const summary = compareSessions(prior, next);
    const accuracy = summary.dimensionStability.find((d) => d.dimension === "accuracy");
    expect(accuracy?.absDeltaMean).toBeCloseTo(0.12);
  });
});
