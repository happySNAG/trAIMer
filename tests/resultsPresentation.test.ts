import { describe, expect, it } from "vitest";
import {
  classifyRecommendation,
  describeAimTendency,
  DIRECTIONAL_ONLY_CONFIDENCE,
  RANGE_FIRST_CONFIDENCE,
  RECOMMENDATION_STATE_TITLES,
  TENDENCY_MIN_SEPARATION,
} from "../src/results/recommendationState.ts";
import {
  explainExclusions,
  summarizeExclusions,
  summarizePerformance,
} from "../src/results/sessionOutcome.ts";
import { CONFIDENCE_LABEL_THRESHOLDS } from "../src/optimizer/confidence.ts";
import { RECOMMENDATION_STATES } from "../src/experiments/sessionModes.ts";
import type { Recommendation } from "../src/domain/recommendation.ts";
import type { TrialRecord } from "../src/domain/trial.ts";

/**
 * How a result is PRESENTED is an engine decision (Pass 14).
 *
 * The rc.7 results page rendered the same hero number, at the same size, for
 * 24 % evidence strength and for 90 %. These tests pin the tiers, pin the
 * rule that a weak result leads with its range rather than its point
 * estimate, and pin the refusal to make a claim the numbers do not support.
 */

function rec(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    confidence: 0.85,
    confidenceLabel: "high",
    refusedHighConfidence: false,
    ...overrides,
  } as unknown as Recommendation;
}

describe("recommendation states", () => {
  it("refuses any state at all without sufficient evidence", () => {
    const p = classifyRecommendation({
      recommendation: rec(),
      evidenceSufficient: false,
    });
    expect(p.state).toBe("insufficient");
    expect(p.title).toBe(RECOMMENDATION_STATE_TITLES.insufficient);
    expect(p.summary).toMatch(/will not name a sensitivity it cannot defend/);
  });

  it("names every tier the engine can reach, weakest to strongest", () => {
    const cases: [number, string, string][] = [
      [0.1, "low", "directional-estimate"],
      [0.4, "low", "preliminary"],
      [0.65, "moderate", "moderate-confidence"],
      [0.9, "high", "high-confidence"],
    ];
    for (const [confidence, confidenceLabel, expected] of cases) {
      const p = classifyRecommendation({
        recommendation: rec({ confidence, confidenceLabel: confidenceLabel as never }),
        evidenceSufficient: true,
      });
      expect(p.state, `${confidence}`).toBe(expected);
      expect(RECOMMENDATION_STATES).toContain(p.state);
      expect(p.title).toBe(RECOMMENDATION_STATE_TITLES[p.state]);
    }
  });

  it("takes its boundaries from the engine's own confidence labels", () => {
    // Not a second set of thresholds invented for the UI.
    expect(RANGE_FIRST_CONFIDENCE).toBe(CONFIDENCE_LABEL_THRESHOLDS.moderate);
    expect(DIRECTIONAL_ONLY_CONFIDENCE).toBeLessThan(RANGE_FIRST_CONFIDENCE);
  });

  it("leads with the RANGE whenever the point estimate is not defensible", () => {
    for (const confidence of [0.05, 0.24, 0.35, 0.49]) {
      const p = classifyRecommendation({
        recommendation: rec({ confidence, confidenceLabel: "low" }),
        evidenceSufficient: true,
      });
      expect(p.emphasizeRange, `${confidence}`).toBe(true);
    }
    for (const confidence of [0.55, 0.85]) {
      const p = classifyRecommendation({
        recommendation: rec({
          confidence,
          confidenceLabel: confidence >= 0.8 ? "high" : "moderate",
        }),
        evidenceSufficient: true,
      });
      expect(p.emphasizeRange, `${confidence}`).toBe(false);
    }
  });

  it("the real rc.7 session — 24 % evidence — is a directional estimate, not a recommendation", () => {
    const p = classifyRecommendation({
      recommendation: rec({ confidence: 0.24, confidenceLabel: "low", refusedHighConfidence: true }),
      evidenceSufficient: true,
    });
    expect(p.state).toBe("directional-estimate");
    expect(p.emphasizeRange).toBe(true);
    expect(p.tone).toBe("danger");
    expect(p.title).not.toMatch(/High|Moderate/);
  });

  it("a strong number the engine declined to back never reads as high confidence", () => {
    const p = classifyRecommendation({
      recommendation: rec({ confidence: 0.92, confidenceLabel: "high" }),
      evidenceSufficient: true,
      refusedHighConfidence: true,
    });
    expect(p.state).toBe("moderate-confidence");
  });
});

describe("aim tendency is a claim, and is refused when unsupported", () => {
  it("names an overshoot tendency only when the gap is real", () => {
    const over = describeAimTendency({
      overshootTendency: 0.18,
      undershootTendency: 0.06,
      validTrials: 30,
    });
    expect(over.headline).toBe("Slight overshoot tendency");
    expect(over.claimSupported).toBe(true);
  });

  it("calls a near-tie balanced rather than inventing a direction", () => {
    const balanced = describeAimTendency({
      overshootTendency: 0.12,
      undershootTendency: 0.12 - TENDENCY_MIN_SEPARATION / 2,
      validTrials: 30,
    });
    expect(balanced.headline).toBe("Balanced");
    expect(balanced.detail).toMatch(/nothing in your aim path argues/);
  });

  it("refuses to call a tendency from too few drills", () => {
    const weak = describeAimTendency({
      overshootTendency: 0.3,
      undershootTendency: 0.01,
      validTrials: 3,
    });
    expect(weak.claimSupported).toBe(false);
    expect(weak.headline).toBe("Too few drills to call");
  });

  it("says nothing at all when there is no measurement", () => {
    const none = describeAimTendency({
      overshootTendency: null,
      undershootTendency: null,
      validTrials: 40,
    });
    expect(none.claimSupported).toBe(false);
    expect(none.headline).toBe("Not measured yet");
  });
});

describe("exclusions are explained in words, and attributed honestly", () => {
  it("translates the exact rc.7 failure without using the word 'timestamp'", () => {
    const [top] = explainExclusions({ IMPOSSIBLE_TIMESTAMPS: 43 });
    expect(top!.count).toBe(43);
    expect(top!.plain).toMatch(/timing of the mouse data/);
    expect(top!.plain).not.toMatch(/timestamp/i);
    // It was the app's fault, so the player is asked to do nothing.
    expect(top!.softwareFault).toBe(true);
    expect(top!.action).toBeNull();
    // The technical code stays available beside the sentence.
    expect(top!.code).toBe("IMPOSSIBLE_TIMESTAMPS");
  });

  it("asks the player to act only where acting would help", () => {
    const rows = explainExclusions({
      IMPOSSIBLE_MOVEMENT: 2,
      POINTER_LOCK_LOSS: 1,
      MISSING_TARGET_APPEARANCE: 1,
    });
    const byCode = new Map(rows.map((r) => [r.code, r]));
    expect(byCode.get("IMPOSSIBLE_MOVEMENT")!.action).toMatch(/macros|smoothing/);
    expect(byCode.get("POINTER_LOCK_LOSS")!.action).toMatch(/focused/);
    expect(byCode.get("MISSING_TARGET_APPEARANCE")!.action).toBeNull();
    expect(byCode.get("MISSING_TARGET_APPEARANCE")!.softwareFault).toBe(true);
  });

  it("orders the breakdown by how much each cost, and stays readable for unknown codes", () => {
    const rows = explainExclusions({ POINTER_LOCK_LOSS: 1, IMPOSSIBLE_TIMESTAMPS: 9, WEIRD_NEW_CODE: 4 });
    expect(rows.map((r) => r.count)).toEqual([9, 4, 1]);
    const unknown = rows.find((r) => r.code === "WEIRD_NEW_CODE")!;
    expect(unknown.label).toBe("Weird new code");
    expect(unknown.plain).toMatch(/weird new code/);
  });

  it("summarises the whole thing in one sentence a player can read", () => {
    const sentence = summarizeExclusions(43, 80, { IMPOSSIBLE_TIMESTAMPS: 43 });
    expect(sentence).toMatch(/43 of 80/);
    expect(sentence).toMatch(/could not be used for scoring/);
    expect(summarizeExclusions(0, 80, {})).toMatch(/Every measured drill produced usable data/);
    expect(summarizeExclusions(0, 0, {})).toMatch(/No measured drills were completed/);
  });
});

describe("exclusion counts sum to the excluded total", () => {
  function trial(status: "valid" | "invalid", codes: string[]): TrialRecord {
    return {
      phase: "measured",
      scenarioKind: "flick-static",
      shots: [],
      samples: [],
      targets: [],
      validity: {
        status,
        reasons: codes.map((code) => ({ code, severity: "fatal", detail: "" })),
      },
    } as unknown as TrialRecord;
  }

  it("attributes a multi-reason exclusion to exactly one category", () => {
    const summary = summarizePerformance([
      trial("valid", []),
      trial("invalid", ["IMPOSSIBLE_TIMESTAMPS", "LARGE_SAMPLE_GAP"]),
      trial("invalid", ["LARGE_SAMPLE_GAP"]),
    ]);
    expect(summary.excludedTrials).toBe(2);
    const total = Object.values(summary.exclusionsByReason).reduce((a, b) => a + b, 0);
    expect(total).toBe(summary.excludedTrials);
    expect(summary.exclusionsByReason.IMPOSSIBLE_TIMESTAMPS).toBe(1);
    expect(summary.exclusionsByReason.LARGE_SAMPLE_GAP).toBe(1);
  });

  it("reports nothing when nothing was excluded", () => {
    const summary = summarizePerformance([trial("valid", []), trial("valid", [])]);
    expect(summary.excludedTrials).toBe(0);
    expect(summary.exclusionsByReason).toEqual({});
  });
});
