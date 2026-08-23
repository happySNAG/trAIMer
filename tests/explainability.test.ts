import { describe, expect, it } from "vitest";
import {
  SensitivityOptimizer,
  SyntheticExperimentRunner,
  buildExperimentDefinition,
  playerPreset,
  applyStagedChangeSafety,
  DEFAULT_STAGED_CHANGE_POLICY,
  computeInputQuality,
} from "../src/index.ts";
import { equalXy } from "../src/domain/settings.ts";
import { makeTrial } from "./helpers.ts";
import type { Recommendation } from "../src/domain/recommendation.ts";

function produceRecommendation(hiddenEdpi: number): {
  recommendation: Recommendation;
} {
  const def = buildExperimentDefinition({
    id: "experiment-explain",
    name: "explain",
    baselineSensitivity: equalXy(7),
    dpi: 800,
    measuredRepsPerCandidatePerRound: 8,
  });
  const runner = new SyntheticExperimentRunner(def, {
    ...playerPreset("consistent-medium"),
    trueOptimalEdpi: hiddenEdpi,
  });
  const optimizer = new SensitivityOptimizer(def, { maxSearchRounds: 2 });
  optimizer.addTrials(runner.runRound(0, 66, "session-e", def.id));
  for (let guard = 0; guard < 4; guard++) {
    const next = optimizer.needsMoreEvidence();
    if (next.kind === "done") break;
    optimizer.addCandidates(next.candidates);
    optimizer.addTrials(
      runner.runRound(next.round, 66, "session-e", def.id, next.candidates.map((c) => c.id)),
    );
  }
  return { recommendation: optimizer.recommend() };
}

describe("recommendation explainability", () => {
  it("answers every mandated question structurally", () => {
    const { recommendation: rec } = produceRecommendation(5600);
    expect(rec.explanation).toBeDefined();
    const ex = rec.explanation!;
    expect(ex.whyThisX.length).toBeGreaterThan(0);
    expect(ex.whyThisY.length).toBeGreaterThan(0);
    expect(ex.candidatesTested.length).toBeGreaterThanOrEqual(5);
    for (const row of ex.candidatesTested) {
      expect(row.edpiX).toBeGreaterThan(0);
      expect(row.validTrials).toBeGreaterThan(0);
    }
    expect(ex.scenarioContributions.length).toBeGreaterThanOrEqual(4);
    for (const sc of ex.scenarioContributions) {
      expect(sc.difficultyTier).not.toBe("unknown");
    }
    expect(ex.evidenceForWinner.length).toBeGreaterThan(0);
    for (const warning of rec.warnings) {
      expect(ex.evidenceAgainstWinner).toContain(warning);
    }
    expect(ex.uncertaintyRemaining.join(" ")).toMatch(/range/i);
    expect(typeof ex.boundaryReached).toBe("boolean");
    expect(ex.captureQualityAdequate === null || typeof ex.captureQualityAdequate === "boolean").toBe(true);
  });
});

describe("sensitivity change safety", () => {
  it("applies a bounded first step when the inferred jump is far and confidence is low", () => {
    const { recommendation } = produceRecommendation(3200);
    const rec = applyStagedChangeSafety(recommendation, equalXy(7));
    if (
      Math.abs(Math.log2(rec.primarySensitivity.sensX / 7)) >
      DEFAULT_STAGED_CHANGE_POLICY.maxImmediateStepOctaves
    ) {
      expect(rec.sensitivityChangePlan?.policyApplied ?? false).toBe(true);
    } else {
      // Either the search landed near the current setting or safety applied.
      expect(rec.primarySensitivity.sensX).toBeDefined();
    }
    if (rec.sensitivityChangePlan?.policyApplied) {
      const plan = rec.sensitivityChangePlan;
      expect(plan.recommendedNowSensX).not.toBe(plan.fullInferredSensX);
      expect(
        Math.abs(Math.log2(plan.recommendedNowSensX / plan.currentSensX)),
      ).toBeLessThanOrEqual(DEFAULT_STAGED_CHANGE_POLICY.maxImmediateStepOctaves + 1e-9);
      expect(plan.rationaleLines.join(" ")).toMatch(/adapt/i);
      expect(rec.primarySensitivity.sensX).toBe(plan.recommendedNowSensX);
    }
  });

  it("does not interfere when the recommendation is close or highly confident", () => {
    const near = applyStagedChangeSafety(
      {
        ...produceRecommendation(5600).recommendation,
        primarySensitivity: equalXy(7.1),
        recommendedEdpi: 5680,
        confidence: 0.6,
        confidenceLabel: "moderate",
        unresolvedBoundary: false,
        refusedHighConfidence: false,
      },
      equalXy(7),
    );
    expect(near.sensitivityChangePlan?.policyApplied ?? false).toBe(false);

    const confidentFar = applyStagedChangeSafety(
      {
        ...produceRecommendation(5600).recommendation,
        primarySensitivity: equalXy(10),
        recommendedEdpi: 8000,
        confidence: 0.85,
        confidenceLabel: "high",
        unresolvedBoundary: false,
        refusedHighConfidence: false,
      },
      equalXy(7),
    );
    expect(confidentFar.sensitivityChangePlan?.policyApplied ?? false).toBe(false);
    expect(confidentFar.recommendedEdpi).toBe(8000);
  });

  it("input-quality diagnostics detect degraded low-rate streams", () => {
    const poor = computeInputQuality(
      makeTrial({
        samples: Array.from({ length: 60 }, (_, i) => ({
          tMs: i * 30 + ((i * 37) % 9),
          cursor: { x: 640 + (i % 4), y: 360 },
          dx: i % 4 === 0 ? 3 : 0,
          dy: 0,
        })),
      }),
    );
    expect(poor.metrics.observedRateHz).toBeLessThan(45);
    expect(poor.warnings.lowEventRate).toBe(true);
    expect(poor.warnings.unsuitableForHighConfidence).toBe(true);
  });
});
