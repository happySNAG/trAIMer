import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildGameRecommendation } from "../app/src/gameConversionBridge.ts";
import { DEFAULT_SETTINGS, type AppSettings } from "../app/src/state.ts";
import { defaultSelectionFor } from "../src/games/selection.ts";
import { GENERIC_RAW_PROFILE } from "../src/games/profiles/generic.ts";
import type { Recommendation } from "../src/domain/recommendation.ts";

/**
 * The app-side bridge from a finished session to game-facing numbers
 * (Game Profile Pass 1, requirements 15, 19).
 *
 * Its job is to decide WHICH engine call applies and to explain, in the
 * player's words, when none does. Every arithmetic assertion in this file is
 * really an assertion that the bridge did not do the arithmetic itself.
 */

const RECOMMENDATION = {
  experimentId: "experiment-bridge-1",
  primarySensitivity: { sensX: 8.4, sensY: 8.4 },
  recommendedEdpi: 6720,
  sensXRange: { min: 7.6, max: 9.2 },
  edpiRange: { min: 6080, max: 7360 },
  confidence: 0.7,
  confidenceLabel: "moderate",
  dimensionEstimates: {},
  utilityWeights: {},
  evidence: {
    trialsAnalyzed: 24,
    trialsExcluded: 0,
    exclusionReasonCounts: {},
    candidatesEvaluated: 5,
    validTrialsPerCandidate: {},
    bestCandidateId: "cand-b",
    runnerUpCandidateId: "cand-a",
    utilityGapBestVsRunnerUp: 0.04,
    utilityGapZScore: 2,
    separation: "clear",
    searchRoundsRun: 2,
    notes: [],
  },
  warnings: [],
  refusedHighConfidence: false,
  rationaleLines: [],
  unresolvedBoundary: false,
  furtherTestingSuggested: false,
} as unknown as Recommendation;

function settingsWith(patch: Partial<AppSettings>): AppSettings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

describe("game recommendation bridge", () => {
  it("says nothing at all when no game is selected", () => {
    const outcome = buildGameRecommendation(settingsWith({}), RECOMMENDATION);
    expect(outcome.kind).toBe("no-profile-selected");
  });

  it("asks for the anchor it needs instead of inventing one", () => {
    const outcome = buildGameRecommendation(
      settingsWith({ gameProfile: defaultSelectionFor(GENERIC_RAW_PROFILE) }),
      RECOMMENDATION,
    );
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") throw new Error("unreachable");
    expect(outcome.reason).toContain("Generic (raw sensitivity)");
    expect(outcome.reason).toContain("Aim Test");
  });

  it("converts a recommendation into the game's numbers", () => {
    const outcome = buildGameRecommendation(
      settingsWith({
        dpi: 800,
        sensX: 7,
        sensY: 7,
        gameProfile: {
          ...defaultSelectionFor(GENERIC_RAW_PROFILE),
          currentHipfire: 2,
        },
      }),
      RECOMMENDATION,
      { calibrationConfidenceLine: "Confidence in the measurement behind this: moderate." },
    );
    expect(outcome.kind).toBe("ready");
    if (outcome.kind !== "ready") throw new Error("unreachable");
    const g = outcome.exported;
    expect(g.profileId).toBe("generic-raw");
    expect(g.current?.hipfire).toBe(2);
    // The session recommends 8.4% against a 7% baseline: a 1.2× change.
    expect(g.recommended.hipfire.value.ui).toBeCloseTo(2.4, 3);
    expect(g.changeFromCurrentPercent!.x).toBeCloseTo(20, 6);
    expect(g.calibrationConfidenceLine).toContain("moderate");
    expect(g.physicalEquivalent.derivation).toBe("game-profile-scaled-by-recommendation");
  });

  it("reports a missing recommendation rather than converting nothing", () => {
    const outcome = buildGameRecommendation(
      settingsWith({
        gameProfile: { ...defaultSelectionFor(GENERIC_RAW_PROFILE), currentHipfire: 2 },
      }),
      null,
    );
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") throw new Error("unreachable");
    expect(outcome.reason).toContain("nothing to convert");
  });

  it("explains a saved selection this build cannot resolve", () => {
    const outcome = buildGameRecommendation(
      settingsWith({
        gameProfile: {
          recordVersion: 1,
          profileId: "a-game-from-a-later-pass",
          profileVersion: 2,
          currentHipfire: 3,
          currentVertical: null,
          fovDegrees: null,
          matchingKind: "physical-360-distance",
          matchingCoefficient: null,
          matchingAxis: null,
        },
      }),
      RECOMMENDATION,
    );
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") throw new Error("unreachable");
    expect(outcome.reason).toContain("a-game-from-a-later-pass");
  });

  it("refuses rather than throwing when the entered sensitivity is impossible", () => {
    const outcome = buildGameRecommendation(
      settingsWith({
        gameProfile: {
          ...defaultSelectionFor(GENERIC_RAW_PROFILE),
          // Past the sanitizer only because it is constructed here directly.
          currentHipfire: Number.MAX_VALUE,
        },
      }),
      RECOMMENDATION,
    );
    expect(["ready", "unavailable"]).toContain(outcome.kind);
    if (outcome.kind === "unavailable") {
      expect(outcome.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("results integration renders engine values (requirement 19)", () => {
  const view = readFileSync("app/src/resultsView.ts", "utf8").replace(/\r\n/g, "\n");

  it("draws the game section from the export, never from its own arithmetic", () => {
    expect(view).toContain("function renderGameRecommendation(");
    expect(view).toContain("g.recommended.hipfire.value.ui");
    expect(view).toContain("g.physicalEquivalent.cmPer360X");
    expect(view).toContain("g.entryLines");
    // The view must not convert anything itself.
    expect(view).not.toContain("gameSettingsFromCanonical");
    expect(view).not.toContain("canonicalFromGameSettings");
    expect(view).not.toContain("degreesPerCm");
  });

  it("shows current, recommended and the physical equivalent together", () => {
    const start = view.indexOf("function renderGameRecommendation(");
    const section = view.slice(start, view.indexOf("function renderFinalResult("));
    expect(section).toContain('"Current"');
    expect(section).toContain('"Recommended"');
    expect(section).toContain('"Physical equivalent"');
  });

  it("never hides rounding loss behind a details block", () => {
    const start = view.indexOf("function renderGameRecommendation(");
    const section = view.slice(start, view.indexOf("function renderFinalResult("));
    const notesAt = section.indexOf("g.precisionNotes");
    const detailsAt = section.indexOf("detailsBlock(");
    expect(notesAt).toBeGreaterThan(0);
    expect(notesAt).toBeLessThan(detailsAt);
  });

  it("refuses to sound more certain than the calibration behind it", () => {
    expect(view).toContain(
      "Converting a recommendation cannot make it more certain than the measurement above.",
    );
    expect(view).toContain("g.calibrationConfidenceLine");
  });

  it("is wired into every results path in the app", () => {
    const main = readFileSync("app/src/main.ts", "utf8").replace(/\r\n/g, "\n");
    const renders = main.match(/renderResultsView\(views\.results, \{/g) ?? [];
    const wired = main.match(/gameRecommendation:/g) ?? [];
    // Every path except the two that have no recommendation to convert.
    expect(wired.length).toBeGreaterThanOrEqual(renders.length - 2);
    expect(main).toContain("function gameRecommendationFor(");
  });
});
