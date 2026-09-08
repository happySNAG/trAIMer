import { describe, expect, it } from "vitest";
import { InMemoryBackend } from "../src/persistence/backends.ts";
import { LocalJsonStore } from "../src/persistence/store.ts";
import { HistoryApi } from "../src/history/api.ts";
import {
  buildHumanSessionRecord,
  finalizeHumanSessionRecord,
} from "../src/session/humanSession.ts";
import type { Recommendation } from "../src/domain/recommendation.ts";
import { GENERIC_RAW_PROFILE } from "../src/games/profiles/generic.ts";
import { FIXTURE_LINKED_STEPPED, FIXTURE_PER_SCOPE } from "../src/games/fixtures.ts";
import {
  canonicalFromCmPer360,
  canonicalFromGameSettings,
  cmPer360X,
} from "../src/games/index.ts";
import {
  buildGameRecommendationExport,
  importCurrentSensitivity,
} from "../src/games/export.ts";
import {
  applyRecommendationToCanonical,
  canonicalFromCalibration,
  recommendationFactors,
} from "../src/games/measurement.ts";
import {
  GAME_SELECTION_RECORD_VERSION,
  buildSessionGameConversionRecord,
  defaultSelectionFor,
  matchingMethodOf,
  readSessionGameConversionRecord,
  sanitizeGameSelection,
} from "../src/games/selection.ts";
import { calibrationFromEmpiricalMeasurement } from "../src/sensmath/calibration.ts";
import { MATCHING } from "../src/games/matching.ts";
import { DEFAULT_SETTINGS, sanitizeSettings } from "../app/src/state.ts";

const RECOMMENDED = { sensX: 8.4, sensY: 8.4 };
const BASELINE = { sensX: 7, sensY: 7 };

/** A canonical aim + the change the calibration recommends, as the app does it. */
function recommendedAimFor(currentHipfire: number, dpi: number) {
  const current = canonicalFromGameSettings(GENERIC_RAW_PROFILE, dpi, {
    hipfire: currentHipfire,
  });
  const factors = recommendationFactors({
    baselineSensX: BASELINE.sensX,
    baselineSensY: BASELINE.sensY,
    recommendedSensX: RECOMMENDED.sensX,
    recommendedSensY: RECOMMENDED.sensY,
  })!;
  return {
    current,
    recommended: applyRecommendationToCanonical(
      { aim: current, derivation: "game-profile", basis: "your current in-game settings" },
      factors,
    ),
  };
}

describe("current-sensitivity import (requirement 14)", () => {
  it("converts what the player runs today with no calibration and no session", () => {
    const imported = importCurrentSensitivity(GENERIC_RAW_PROFILE, 1600, { hipfire: 1.5 });
    expect(imported.profileId).toBe("generic-raw");
    expect(imported.profileVersion).toBe(1);
    expect(imported.cmPer360X).toBeCloseTo(cmPer360X(imported.aim), 12);
    expect(imported.summary).toContain("1600 DPI");
    expect(imported.summary).toContain("360");
  });

  it("changes when DPI changes, at the same in-game number", () => {
    const at800 = importCurrentSensitivity(GENERIC_RAW_PROFILE, 800, { hipfire: 2 });
    const at1600 = importCurrentSensitivity(GENERIC_RAW_PROFILE, 1600, { hipfire: 2 });
    expect(at800.cmPer360X).toBeCloseTo(at1600.cmPer360X * 2, 9);
  });
});

describe("recommendation export (requirement 15)", () => {
  it("carries current, recommended and the physical equivalent", () => {
    const { current, recommended } = recommendedAimFor(2, 800);
    const exported = buildGameRecommendationExport({
      profile: GENERIC_RAW_PROFILE,
      dpi: 800,
      recommended,
      current: { settings: { hipfire: 2 }, aim: current },
    });
    expect(exported.contract).toBe("game-recommendation-v1");
    expect(exported.current?.hipfire).toBe(2);
    expect(exported.current?.cmPer360X).toBeCloseTo(cmPer360X(current), 12);
    // The recommendation is +20% sensitivity, so the recommended value is 1.2×.
    expect(exported.recommended.hipfire.value.ui).toBeCloseTo(2 * (8.4 / 7), 3);
    expect(exported.physicalEquivalent.cmPer360X).toBeCloseTo(
      cmPer360X(current) / (8.4 / 7),
      6,
    );
    expect(exported.changeFromCurrentPercent!.x).toBeCloseTo(20, 6);
  });

  it("produces one entry line per value the player must type", () => {
    const { current, recommended } = recommendedAimFor(2, 800);
    const exported = buildGameRecommendationExport({
      profile: GENERIC_RAW_PROFILE,
      dpi: 800,
      recommended,
      current: { settings: { hipfire: 2 }, aim: current },
    });
    expect(exported.entryLines[0]).toContain("Sensitivity: ");
    expect(exported.entryLines).toHaveLength(2); // horizontal + vertical
  });

  it("names the exact value, the entry value, and the loss between them", () => {
    const exported = buildGameRecommendationExport({
      profile: FIXTURE_LINKED_STEPPED,
      dpi: 800,
      recommended: {
        aim: canonicalFromGameSettings(FIXTURE_LINKED_STEPPED, 800, { hipfire: 6.347 }),
        derivation: "game-profile",
        basis: "test",
      },
      current: null,
    });
    expect(exported.recommended.hipfire.value.exact).toBeCloseTo(6.347, 6);
    expect(exported.recommended.hipfire.value.ui).toBe(6.3);
    expect(exported.precisionNotes.join(" ")).toContain("Exact equivalent 6.347%");
    expect(exported.current).toBeNull();
    expect(exported.changeFromCurrentPercent).toBeNull();
  });

  it("carries every optic's own entry line for a per-scope profile", () => {
    const exported = buildGameRecommendationExport({
      profile: FIXTURE_PER_SCOPE,
      dpi: 800,
      recommended: {
        aim: canonicalFromCmPer360(30),
        derivation: "game-profile",
        basis: "test",
      },
      current: null,
      fovDegrees: 60,
      matching: MATCHING.fovRelative,
    });
    expect(exported.entryLines.length).toBe(5); // hip-fire + four optics
    expect(exported.matchingLabel).toContain("Match what you see");
    expect(exported.matchingDetail.length).toBeGreaterThan(0);
  });

  it("passes the calibration's own confidence wording through untouched", () => {
    const { current, recommended } = recommendedAimFor(2, 800);
    const exported = buildGameRecommendationExport({
      profile: GENERIC_RAW_PROFILE,
      dpi: 800,
      recommended,
      current: { settings: { hipfire: 2 }, aim: current },
      calibrationConfidenceLine: "Confidence in the measurement behind this: moderate.",
    });
    expect(exported.calibrationConfidenceLine).toBe(
      "Confidence in the measurement behind this: moderate.",
    );
  });

  it("carries provenance so a stale profile cannot masquerade as fresh", () => {
    const { current, recommended } = recommendedAimFor(2, 800);
    const exported = buildGameRecommendationExport({
      profile: GENERIC_RAW_PROFILE,
      dpi: 800,
      recommended,
      current: { settings: { hipfire: 2 }, aim: current },
    });
    expect(exported.provenance.verifiedAtIso).toBe(GENERIC_RAW_PROFILE.source.verifiedAtIso);
    expect(exported.provenance.sourceTitle).toBe(GENERIC_RAW_PROFILE.source.title);
    expect(exported.provenance.confidence).toBe("exact");
    expect(exported.provenance.sourceUrl).toBeNull();
  });
});

describe("the calibrated path (requirement 3)", () => {
  it("converts a measured degrees-per-count constant straight to canonical", () => {
    const calibration = calibrationFromEmpiricalMeasurement({
      degreesPerCountAt100X: 0.0559,
      degreesPerCountAt100Y: 0.0559,
      source: "test",
    });
    const aim = canonicalFromCalibration({
      calibration,
      dpi: 800,
      sensXPercent: 7,
      sensYPercent: 7,
    })!;
    expect(aim.degreesPerCmX).toBeCloseTo((0.0559 * 0.07 * 800) / 2.54, 12);
    expect(cmPer360X(aim)).toBeCloseTo(360 / aim.degreesPerCmX, 12);
  });

  it("returns null rather than guessing when the calibration is incomplete", () => {
    expect(
      canonicalFromCalibration({
        calibration: { degreesPerCountAt100X: null, degreesPerCountAt100Y: null, source: "none" },
        dpi: 800,
        sensXPercent: 7,
        sensYPercent: 7,
      }),
    ).toBeNull();
  });

  it("refuses a ratio against a missing baseline", () => {
    expect(
      recommendationFactors({
        baselineSensX: 0,
        baselineSensY: 7,
        recommendedSensX: 8,
        recommendedSensY: 8,
      }),
    ).toBeNull();
  });

  it("scales a canonical aim by the recommended change, per axis", () => {
    const current = canonicalFromCmPer360(30, 30);
    const scaled = applyRecommendationToCanonical(
      { aim: current, derivation: "game-profile", basis: "test" },
      { x: 1.2, y: 0.9 },
    );
    expect(scaled.aim.degreesPerCmX).toBeCloseTo(current.degreesPerCmX * 1.2, 12);
    expect(scaled.aim.degreesPerCmY).toBeCloseTo(current.degreesPerCmY * 0.9, 12);
    expect(scaled.derivation).toBe("game-profile-scaled-by-recommendation");
  });
});

describe("selected-profile persistence (requirement 17)", () => {
  it("stores an id and a version, never a display name", () => {
    const selection = defaultSelectionFor(GENERIC_RAW_PROFILE);
    expect(selection.profileId).toBe("generic-raw");
    expect(selection.profileVersion).toBe(1);
    expect(JSON.stringify(selection)).not.toContain(GENERIC_RAW_PROFILE.displayName);
  });

  it("survives a JSON round trip through the settings sanitizer", () => {
    const selection = {
      ...defaultSelectionFor(FIXTURE_PER_SCOPE),
      currentHipfire: 2.5,
      fovDegrees: 75,
    };
    const restored = sanitizeGameSelection(JSON.parse(JSON.stringify(selection)));
    expect(restored).toEqual(selection);
    expect(matchingMethodOf(restored!).kind).toBe("monitor-distance");
  });

  it("keeps a selection naming a profile this build does not ship", () => {
    const restored = sanitizeGameSelection({
      profileId: "a-game-from-a-later-pass",
      profileVersion: 4,
      currentHipfire: 3,
    });
    expect(restored?.profileId).toBe("a-game-from-a-later-pass");
    expect(restored?.profileVersion).toBe(4);
  });

  it("clamps hostile or nonsense values instead of trusting them", () => {
    const restored = sanitizeGameSelection({
      profileId: "x".repeat(500),
      profileVersion: -7,
      currentHipfire: -3,
      currentVertical: Number.NaN,
      fovDegrees: 900,
      matchingKind: "telepathy",
      matchingCoefficient: 12,
    })!;
    expect(restored.profileId.length).toBe(64);
    expect(restored.profileVersion).toBe(1);
    expect(restored.currentHipfire).toBeNull();
    expect(restored.currentVertical).toBeNull();
    expect(restored.fovDegrees).toBeNull();
    expect(restored.matchingKind).toBe("physical-360-distance");
    expect(restored.matchingCoefficient).toBeNull();
    expect(restored.recordVersion).toBe(GAME_SELECTION_RECORD_VERSION);
  });

  it("returns null for anything that is not a selection", () => {
    expect(sanitizeGameSelection(null)).toBeNull();
    expect(sanitizeGameSelection("generic-raw")).toBeNull();
    expect(sanitizeGameSelection({})).toBeNull();
    expect(sanitizeGameSelection({ profileId: "" })).toBeNull();
  });
});

describe("app settings migration (requirement 17)", () => {
  it("reads a settings blob written before game profiles existed", () => {
    const rc8Blob = {
      playerName: "Aldo",
      dpi: 800,
      sensX: 7,
      sensY: 7,
      experimentSeed: 20260822,
      rounds: 2,
      repsPerCandidate: 8,
      warmupTrials: 2,
      yExploration: false,
      autoBreaks: true,
      breakSeconds: 10,
    };
    const settings = sanitizeSettings(rc8Blob);
    // Everything the player had is preserved...
    expect(settings.playerName).toBe("Aldo");
    expect(settings.dpi).toBe(800);
    expect(settings.sensX).toBe(7);
    expect(settings.breakSeconds).toBe(10);
    // ...and "no game selected" is a normal state, not an error.
    expect(settings.gameProfile).toBeNull();
  });

  it("keeps a stored selection across a save/load cycle", () => {
    const withGame = {
      ...DEFAULT_SETTINGS,
      gameProfile: { ...defaultSelectionFor(GENERIC_RAW_PROFILE), currentHipfire: 1.75 },
    };
    const restored = sanitizeSettings(JSON.parse(JSON.stringify(withGame)));
    expect(restored.gameProfile?.profileId).toBe("generic-raw");
    expect(restored.gameProfile?.currentHipfire).toBe(1.75);
  });

  it("drops a corrupt selection without losing the rest of the settings", () => {
    const restored = sanitizeSettings({
      ...DEFAULT_SETTINGS,
      dpi: 1600,
      gameProfile: { garbage: true },
    });
    expect(restored.gameProfile).toBeNull();
    expect(restored.dpi).toBe(1600);
  });
});

describe("history integration (requirement 18)", () => {
  const recommendation = {
    experimentId: "experiment-game-1",
    primarySensitivity: RECOMMENDED,
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

  async function seed(withGame: boolean) {
    const store = new LocalJsonStore(new InMemoryBackend());
    await store.saveRecommendation(recommendation);
    let hs = buildHumanSessionRecord({
      sessionId: (withGame ? "session-with-game" : "session-no-game") as never,
      experimentId: recommendation.experimentId as never,
      playerId: "player-aldo" as never,
      displayName: "Aldo",
      dpi: 800,
      startingSensitivity: BASELINE,
      device: {
        userAgent: "TestAgent/1.0",
        platform: "Win32",
        screenPx: { width: 2560, height: 1440 },
        pointerCoalescingSupported: true,
      },
      startedAtIso: "2026-09-07T10:00:00Z",
      scenarioOrder: [],
      candidateOrderBlinded: [],
      candidateReveal: {},
      warmupCount: 0,
      measuredCount: 24,
      invalidTrialCount: 0,
      pausePeriods: [],
      fatigueIndicators: { forcedRests: 0, degradationDetected: false, degradationRatio: null },
      optimizerVersion: "optimizer-v3",
      scoringWeights: {},
      calibrationAdequateX: null,
      calibrationAdequateY: null,
      retestOfExperimentId: null,
      sessionIndexForPlayer: 1,
    });
    let record = null;
    if (withGame) {
      const { current, recommended } = recommendedAimFor(2, 800);
      const exported = buildGameRecommendationExport({
        profile: GENERIC_RAW_PROFILE,
        dpi: 800,
        recommended,
        current: { settings: { hipfire: 2 }, aim: current },
      });
      record = buildSessionGameConversionRecord(exported, "2026-09-07T11:00:00Z");
    }
    hs = finalizeHumanSessionRecord(hs, "2026-09-07T11:00:00Z", recommendation, 1000, record);
    await store.saveRaw("human-session", `human-sessions/${hs.sessionId}.json`, hs);
    return { store, hs };
  }

  it("records the profile, its version, DPI, both values and the physical equivalent", async () => {
    const { store } = await seed(true);
    const sessions = await new HistoryApi(store).listSessions();
    const game = sessions[0]!.gameConversion!;
    expect(game.profileId).toBe("generic-raw");
    expect(game.profileVersion).toBe(1);
    expect(game.profileStatus).toBe("verified");
    expect(game.dpi).toBe(800);
    expect(game.currentHipfire).toBe(2);
    expect(game.recommendedHipfire).toBeCloseTo(2 * (8.4 / 7), 3);
    expect(game.cmPer360X).toBeGreaterThan(0);
    expect(game.conversionMethod).toContain("physical-360-distance");
    expect(game.derivation).toBe("game-profile-scaled-by-recommendation");
    expect(game.roundingAppliedFraction).toBeLessThan(1e-3);
    expect(game.convertedAtIso).toBe("2026-09-07T11:00:00Z");
  });

  it("leaves a session with no game profile completely readable", async () => {
    const { store, hs } = await seed(false);
    // The field is not merely null — it is absent, exactly like an rc.8 record.
    expect("gameConversion" in hs).toBe(false);
    const sessions = await new HistoryApi(store).listSessions();
    expect(sessions[0]!.gameConversion).toBeNull();
    expect(sessions[0]!.recommendedEdpi).toBe(6720);
    expect(sessions[0]!.confidenceLabel).toBe("moderate");
  });

  it("never lets an unreadable game record break a historical session", async () => {
    const store = new LocalJsonStore(new InMemoryBackend());
    await store.saveRecommendation(recommendation);
    await store.saveRaw("human-session", "human-sessions/session-corrupt.json", {
      sessionId: "session-corrupt",
      experimentId: recommendation.experimentId,
      startedAtIso: "2026-09-07T10:00:00Z",
      endedAtIso: "2026-09-07T11:00:00Z",
      measuredCount: 12,
      gameConversion: { recordVersion: 99, wat: true },
    });
    const sessions = await new HistoryApi(store).listSessions();
    expect(sessions[0]!.gameConversion).toBeNull();
    expect(sessions[0]!.measuredTrials).toBe(12);
  });

  it("does not mutate a stored rc.8 session when it is read back", async () => {
    const { store } = await seed(false);
    const before = JSON.stringify(
      (await store.loadRawAt<unknown>("human-session", "human-sessions/session-no-game.json"))
        ?.payload,
    );
    await new HistoryApi(store).snapshot();
    const after = JSON.stringify(
      (await store.loadRawAt<unknown>("human-session", "human-sessions/session-no-game.json"))
        ?.payload,
    );
    expect(after).toBe(before);
  });

  it("reads back exactly what was written, version included", () => {
    const { current, recommended } = recommendedAimFor(2, 800);
    const exported = buildGameRecommendationExport({
      profile: GENERIC_RAW_PROFILE,
      dpi: 800,
      recommended,
      current: { settings: { hipfire: 2 }, aim: current },
    });
    const record = buildSessionGameConversionRecord(exported, "2026-09-07T11:00:00Z");
    const parsed = readSessionGameConversionRecord(JSON.parse(JSON.stringify(record)));
    expect(parsed).toEqual(record);
    expect(readSessionGameConversionRecord({ ...record, recordVersion: 2 })).toBeNull();
    expect(readSessionGameConversionRecord(undefined)).toBeNull();
  });
});
