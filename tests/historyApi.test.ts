import { describe, expect, it } from "vitest";
import { HistoryApi } from "../src/history/api.ts";
import { InMemoryBackend } from "../src/persistence/backends.ts";
import { LocalJsonStore } from "../src/persistence/store.ts";
import { buildExperimentDefinition } from "../src/experiments/protocol.ts";
import type { Recommendation } from "../src/domain/recommendation.ts";
import {
  buildHumanSessionRecord,
  finalizeHumanSessionRecord,
} from "../src/session/humanSession.ts";
import type { TrialRecord } from "../src/domain/trial.ts";

async function seedStore() {
  const backend = new InMemoryBackend();
  const store = new LocalJsonStore(backend);
  const definition = buildExperimentDefinition({
    id: "experiment-hist-1" as never,
    name: "history session one",
    baselineSensitivity: { sensX: 7, sensY: 7 },
    dpi: 800,
    randomizeOrder: false,
    orderSeed: 1,
  });
  await store.saveExperiment(definition);

  const recommendation: Recommendation = {
    experimentId: definition.id,
    primarySensitivity: { sensX: 7.7, sensY: 7.0 },
    recommendedEdpi: 6160,
    sensXRange: { min: 6.9, max: 8.4 },
    edpiRange: { min: 5520, max: 6720 },
    confidence: 0.72,
    confidenceLabel: "moderate",
    dimensionEstimates: {
      accuracy: { mean: 0.8, standardError: 0.02, sampleCount: 24 },
      speed: { mean: 0.6, standardError: 0.03, sampleCount: 24 },
    },
    utilityWeights: {} as never,
    evidence: {
      trialsAnalyzed: 24,
      trialsExcluded: 1,
      exclusionReasonCounts: {},
      candidatesEvaluated: 5,
      validTrialsPerCandidate: { "cand-a": 5, "cand-b": 5, "cand-c": 5, "cand-d": 5, "cand-e": 4 },
      bestCandidateId: "cand-b",
      runnerUpCandidateId: "cand-a",
      utilityGapBestVsRunnerUp: 0.04,
      utilityGapZScore: 2.3,
      separation: "clear",
      searchRoundsRun: 2,
      notes: [],
    },
    warnings: [],
    refusedHighConfidence: false,
    rationaleLines: ["r"],
    unresolvedBoundary: false,
    furtherTestingSuggested: false,
  };
  await store.saveRecommendation(recommendation);
  await store.saveOptimizerRun({
    experimentId: definition.id,
    optimizerVersion: "optimizer-v3",
    schemaVersion: 1,
    utilityWeights: {},
    config: {},
  });

  let hs = buildHumanSessionRecord({
    sessionId: "session-hist-1" as never,
    experimentId: definition.id,
    playerId: "player-aldo" as never,
    displayName: "Aldo",
    dpi: 800,
    startingSensitivity: { sensX: 7, sensY: 7 },
    device: {
      userAgent: "TestAgent/1.0",
      platform: "Win32",
      screenPx: { width: 2560, height: 1440 },
      pointerCoalescingSupported: true,
    },
    startedAtIso: "2026-08-01T10:00:00Z",
    scenarioOrder: ["flick-static-medium"],
    candidateOrderBlinded: ["Candidate A", "Candidate B"],
    candidateReveal: { "Candidate A": "cand-a", "Candidate B": "cand-b" },
    warmupCount: 5,
    measuredCount: 24,
    invalidTrialCount: 1,
    pausePeriods: [],
    fatigueIndicators: { forcedRests: 0, degradationDetected: false, degradationRatio: null },
    optimizerVersion: "optimizer-v3",
    scoringWeights: {},
    calibrationAdequateX: null,
    calibrationAdequateY: null,
    retestOfExperimentId: null,
    sessionIndexForPlayer: 1,
  });
  hs = finalizeHumanSessionRecord(hs, "2026-08-01T11:00:00Z", recommendation, 40 * 60000);
  await store.saveRaw("human-session", `human-sessions/${hs.sessionId}.json`, hs);

  await store.saveRaw("calibration-record", "calibrations/x-1.json", {
    axis: "x",
    createdAtIso: "2026-07-30T09:00:00Z",
    adequate: true,
    degreesPerCountAt100: 0.0559,
    method: "full-rotation",
    measurements: [{ dpi: 800 }],
  });

  // A minimal trial for counts.
  const trial: TrialRecord = {
    id: "trial-t1" as never,
    sessionId: hs.sessionId,
    experimentId: definition.id,
    candidateId: "cand-a" as never,
    indexInSession: 0,
    phase: "measured",
    scenarioId: "flick-static-medium",
    scenarioKind: "flick-static",
    captureContext: {
      scenarioKind: "flick-static",
      viewport: { widthPx: 1280, heightPx: 720 },
      sensitivity: { sensX: 7, sensY: 7 },
      dpi: 800,
      expectedSampleIntervalMs: null,
    },
    startedAtMonotonicMs: 0,
    endedAtMonotonicMs: 100,
    samples: [],
    targets: [],
    shots: [],
    focusInterruptions: [],
    viewportResizes: [],
    outcome: "hit",
    validity: { status: "valid", reasons: [] },
    seedTag: null,
    scenarioRepIndex: 0,
    abortedMs: null,
  };
  await store.saveTrial(definition.id, trial);

  return { store, definition, recommendation };
}

describe("history API", () => {
  it("lists sessions with typed summaries", async () => {
    const { store } = await seedStore();
    const api = new HistoryApi(store);
    const sessions = await api.listSessions();
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.experimentId).toBe("experiment-hist-1");
    expect(s.playerName).toBe("Aldo");
    expect(s.measuredTrials).toBe(24);
    expect(s.recommendedEdpi).toBe(6160);
    expect(s.confidence).toBeCloseTo(0.72, 6);
    expect(s.optimizerVersion).toBe("optimizer-v3");
    expect(s.edpiRange).toEqual({ min: 5520, max: 6720 });
  });

  it("derives X/Y/eDPI/confidence trends from stored recommendations", async () => {
    const { store } = await seedStore();
    const api = new HistoryApi(store);
    const t = await api.trends();
    expect(t.xSensPercent[0]!.value).toBeCloseTo(7.7, 6);
    expect(t.ySensPercent[0]!.value).toBeCloseTo(7.0, 6);
    expect(t.edpi[0]!.value).toBe(6160);
    expect(t.confidence[0]!.value).toBeCloseTo(0.72, 6);
  });

  it("exposes ranking history with the winner ranked first", async () => {
    const { store } = await seedStore();
    const api = new HistoryApi(store);
    const rankings = await api.rankingHistory();
    expect(rankings).toHaveLength(1);
    const rows = rankings[0]!.rows;
    expect(rows.find((r) => r.candidateId === "cand-b")!.rank).toBe(1);
    expect(rows.filter((r) => r.rank === 1)).toHaveLength(1);
  });

  it("tracks dimension estimates across sessions", async () => {
    const { store } = await seedStore();
    const api = new HistoryApi(store);
    const dims = await api.dimensionTrend();
    expect(dims[0]!.dimensions.accuracy).toBeDefined();
    expect(dims[0]!.dimensions.speed).toBeDefined();
  });

  it("returns calibration history ordered by time", async () => {
    const { store } = await seedStore();
    const api = new HistoryApi(store);
    const calib = await api.calibrationHistory();
    expect(calib).toHaveLength(1);
    expect(calib[0]).toMatchObject({
      axis: "x",
      adequate: true,
      dpi: 800,
      method: "full-rotation",
    });
  });

  it("links retest lineage when present", async () => {
    const { store } = await seedStore();
    // Add a retest session pointing at hist-1.
    let hs = buildHumanSessionRecord({
      sessionId: "session-hist-2" as never,
      experimentId: "experiment-hist-2" as never,
      playerId: "player-aldo" as never,
      displayName: "Aldo",
      dpi: 800,
      startingSensitivity: { sensX: 7.7, sensY: 7 },
      device: {
        userAgent: "TestAgent/1.0",
        platform: "Win32",
        screenPx: { width: 2560, height: 1440 },
        pointerCoalescingSupported: true,
      },
      startedAtIso: "2026-08-05T10:00:00Z",
      scenarioOrder: [],
      candidateOrderBlinded: [],
      candidateReveal: {},
      warmupCount: 0,
      measuredCount: 12,
      invalidTrialCount: 0,
      pausePeriods: [],
      fatigueIndicators: { forcedRests: 0, degradationDetected: false, degradationRatio: null },
      optimizerVersion: "optimizer-v3",
      scoringWeights: {},
      calibrationAdequateX: null,
      calibrationAdequateY: null,
      retestOfExperimentId: "experiment-hist-1",
      sessionIndexForPlayer: 2,
    });
    hs = finalizeHumanSessionRecord(hs, "2026-08-05T11:00:00Z", null, 30 * 60000);
    await store.saveRaw("human-session", `human-sessions/${hs.sessionId}.json`, hs);

    const api = new HistoryApi(store);
    const lineage = await api.retestLineage();
    expect(lineage).toHaveLength(1);
    expect(lineage[0]).toMatchObject({
      priorExperimentId: "experiment-hist-1",
      retestExperimentId: "experiment-hist-2",
    });
  });

  it("records device history and optimizer versions", async () => {
    const { store } = await seedStore();
    const api = new HistoryApi(store);
    const devices = await api.deviceHistory();
    expect(devices[0]).toMatchObject({
      userAgent: "TestAgent/1.0",
      platform: "Win32",
      pointerCoalescingSupported: true,
    });
    const versions = await api.optimizerVersionHistory();
    expect(versions[0]!.optimizerVersion).toBe("optimizer-v3");
  });

  it("snapshot aggregates everything in one call", async () => {
    const { store } = await seedStore();
    const api = new HistoryApi(store);
    const snap = await api.snapshot();
    expect(snap.sessions.length).toBeGreaterThan(0);
    expect(snap.trends.edpi.length).toBe(snap.sessions.length);
    expect(Array.isArray(snap.calibrationHistory)).toBe(true);
  });
});
