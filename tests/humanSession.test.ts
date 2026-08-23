import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHumanSessionRecord,
  finalizeHumanSessionRecord,
  serializeHumanSession,
  createLocalJsonStore,
  equalXy,
} from "../src/index.ts";
import type { Recommendation } from "../src/domain/recommendation.ts";
import { unwrapEnvelope } from "../src/persistence/migrations.ts";

const fsRoot = await mkdtemp(join(tmpdir(), "aldo-human-"));
afterAll(async () => {
  await rm(fsRoot, { recursive: true, force: true });
});

function sampleRecommendation(edpi: number): Recommendation {
  return {
    experimentId: "experiment-hs",
    primarySensitivity: equalXy(edpi / 800),
    recommendedEdpi: edpi,
    sensXRange: { min: edpi / 800 / 1.2, max: edpi / 800 * 1.2 },
    edpiRange: { min: edpi / 1.2, max: edpi * 1.2 },
    confidence: 0.62,
    confidenceLabel: "moderate",
    dimensionEstimates: {},
    utilityWeights: {
      speed: 0.14, accuracy: 0.28, overshootControl: 0.11,
      undershootControl: 0.11, correctionEfficiency: 0.12,
      trackingPrecision: 0.14, consistency: 0.1,
    },
    evidence: {
      trialsAnalyzed: 40,
      trialsExcluded: 2,
      exclusionReasonCounts: {},
      candidatesEvaluated: 5,
      validTrialsPerCandidate: {},
      bestCandidateId: "cand-a",
      runnerUpCandidateId: "cand-b",
      utilityGapBestVsRunnerUp: null,
      utilityGapZScore: null,
      separation: "weak",
      searchRoundsRun: 2,
      notes: [],
    },
    warnings: [],
    refusedHighConfidence: false,
    rationaleLines: [],
    unresolvedBoundary: false,
    furtherTestingSuggested: true,
  } as unknown as Recommendation;
}

describe("human validation session records", () => {
  const base = {
    sessionId: "session-hs-1" as never,
    experimentId: "experiment-hs" as never,
    playerId: "player-aldo" as never,
    displayName: "Aldo",
    dpi: 800,
    startingSensitivity: equalXy(7),
    device: {
      userAgent: "TestAgent/1.0",
      platform: "MacIntel",
      screenPx: { width: 2560, height: 1440 },
      pointerCoalescingSupported: true,
    },
    startedAtIso: "2026-08-22T18:00:00.000Z",
    scenarioOrder: ["flick-static-medium", "tracking-smooth-sine"],
    candidateOrderBlinded: ["Candidate A", "Candidate B"],
    candidateReveal: { "cand-x": "Candidate A", "cand-y": "Candidate B" },
    warmupCount: 10,
    measuredCount: 40,
    invalidTrialCount: 3,
    pausePeriods: [{ startIso: "2026-08-22T18:05:00.000Z", endIso: null, reason: "user" }],
    fatigueIndicators: { forcedRests: 1, degradationDetected: true, degradationRatio: 1.31 },
    optimizerVersion: "optimizer-v2",
    scoringWeights: { accuracy: 0.28, speed: 0.14 },
    calibrationAdequateX: true,
    calibrationAdequateY: false,
    sessionIndexForPlayer: 2,
  };

  it("captures every required human-validation field", () => {
    let record = buildHumanSessionRecord(base);
    expect(record.version).toBe(1);
    expect(record.dpi).toBe(800);
    expect(record.startingSensitivity).toEqual(equalXy(7));
    expect(record.device.userAgent).toContain("TestAgent");
    expect(record.scenarioOrder.length).toBe(2);
    expect(record.candidateOrderBlinded).toEqual(["Candidate A", "Candidate B"]);
    expect(Object.keys(record.candidateReveal)).toHaveLength(2);
    expect(record.warmupCount).toBe(10);
    expect(record.measuredCount).toBe(40);
    expect(record.invalidTrialCount).toBe(3);
    expect(record.fatigueIndicators.degradationDetected).toBe(true);
    expect(record.optimizerVersion).toBe("optimizer-v2");
    expect(record.scoringWeights.accuracy).toBeCloseTo(0.28);
    expect(record.calibrationAdequateY).toBe(false);
    expect(record.sessionIndexForPlayer).toBe(2);
    void record;
    record = buildHumanSessionRecord(base);
  });

  it("finalizes duration and recommendation linkage", () => {
    let record = buildHumanSessionRecord(base);
    const rec = sampleRecommendation(5600);
    record = finalizeHumanSessionRecord(
      record,
      "2026-08-22T18:30:00.000Z",
      rec,
      21 * 60 * 1000,
    );
    expect(record.wallClockMs).toBe(30 * 60 * 1000);
    expect(record.activeTestingMs).toBe(21 * 60 * 1000);
    expect(record.recommendationEdpi).toBe(5600);
    expect(record.recommendationRangeEdpi?.min).toBeCloseTo(5600 / 1.2, 0);
    expect(record.recommendationConfidence).toBeCloseTo(0.62);

    record = finalizeHumanSessionRecord(
      buildHumanSessionRecord(base),
      "2026-08-22T18:30:00.000Z",
      null,
      0,
    );
    expect(record.recommendationEdpi).toBeNull();
  });

  it("round-trips through the store with envelope guarantees", async () => {
    const store = createLocalJsonStore(fsRoot);
    const record = finalizeHumanSessionRecord(
      buildHumanSessionRecord(base),
      "2026-08-22T18:30:00.000Z",
      sampleRecommendation(5200),
      5000,
    );
    await store.saveRaw("human-session", "human-sessions/session-hs-1.json", record);
    const loaded = await store.loadRaw<typeof record>(
      "human-session",
      "human-sessions/session-hs-1.json",
    );
    expect(loaded?.payload.recommendationEdpi).toBe(5200);
    expect(loaded?.migratedFrom).toBeNull();

    const parsed = JSON.parse(serializeHumanSession(record));
    const unwrapped = unwrapEnvelope<typeof record>("human-session", parsed);
    expect(unwrapped.payload.measuredCount).toBe(40);
  });
});
