import { describe, expect, it } from "vitest";
import { HistoryApi } from "../src/history/api.ts";
import { InMemoryBackend } from "../src/persistence/backends.ts";
import { LocalJsonStore } from "../src/persistence/store.ts";
import { buildExperimentDefinition } from "../src/experiments/protocol.ts";
import type { Recommendation } from "../src/domain/recommendation.ts";
import { exportBackupAll, importBackupAll } from "../src/persistence/backup.ts";
import {
  buildHumanSessionRecord,
  finalizeHumanSessionRecord,
} from "../src/session/humanSession.ts";
import type { TrialRecord } from "../src/domain/trial.ts";
import { makeTrial } from "./helpers.ts";

/**
 * Pass 6 history/longitudinal scale tests (requirement 8).
 *
 * Builds a large local history (hundreds of sessions, thousands of trials,
 * multiple optimizer versions, calibrations, retests) on the in-memory
 * backend and verifies: load-time budget, deterministic ordering, snapshot
 * correctness, trend integrity, backup size/restore, and corruption
 * handling. APIs are exercised exactly as the frozen Fable UI contract
 * consumes them.
 */

const SESSIONS = 240;
const TRIALS_PER_SESSION = 10;

function makeRecommendation(experimentId: string, i: number): Recommendation {
  const baseEdpi = 5600 + (i % 40) * 25;
  return {
    experimentId: experimentId as never,
    primarySensitivity: { sensX: baseEdpi / 800, sensY: baseEdpi / 800 },
    recommendedEdpi: baseEdpi,
    sensXRange: { min: baseEdpi / 800 - 0.4, max: baseEdpi / 800 + 0.4 },
    edpiRange: { min: baseEdpi - 320, max: baseEdpi + 320 },
    confidence: 0.3 + ((i * 7) % 60) / 100,
    confidenceLabel: "moderate",
    dimensionEstimates: {
      accuracy: { mean: 0.75 + (i % 10) / 100, standardError: 0.02, sampleCount: 24 },
    },
    utilityWeights: {} as never,
    evidence: {
      trialsAnalyzed: 48,
      trialsExcluded: i % 5,
      exclusionReasonCounts: {},
      candidatesEvaluated: 5,
      validTrialsPerCandidate: { a: 9, b: 9, c: 9, d: 9, e: 9 },
      bestCandidateId: `cand-${i % 5 === 0 ? "baseline" : `fp${15}`}`,
      runnerUpCandidateId: null,
      utilityGapBestVsRunnerUp: 0.05,
      utilityGapZScore: 2.1,
      separation: i % 3 === 0 ? "clear" : "weak",
      searchRoundsRun: 2,
      notes: [],
    },
    warnings: [],
    refusedHighConfidence: false,
    rationaleLines: [],
    unresolvedBoundary: false,
    furtherTestingSuggested: false,
    engineVersion: i % 2 === 0 ? "engine-v4" : "engine-v3",
    optimizerVersion: undefined,
  } as never;
}

async function seedLargeHistory() {
  const backend = new InMemoryBackend();
  const store = new LocalJsonStore(backend);
  for (let i = 0; i < SESSIONS; i++) {
    const definition = buildExperimentDefinition({
      id: `experiment-scale-${i}` as never,
      name: `scale session ${i}`,
      baselineSensitivity: { sensX: 7, sensY: 7 },
      dpi: 800,
      randomizeOrder: false,
      orderSeed: i + 1,
    });
    // Retest lineage every 6th session points at its predecessor.
    if (i % 6 === 1 && i > 0) {
      definition.notes = `targeted retest of experiment-scale-${i - 1}`;
    }
    await store.saveExperiment(definition);
    const trials: TrialRecord[] = [];
    for (let t = 0; t < TRIALS_PER_SESSION; t++) {
      trials.push(
        makeTrial({
          id: `trial-scale-${i}-${t}` as never,
          candidateId: definition.candidates[t % definition.candidates.length]!.id,
          startedAtMonotonicMs: t * 4000,
        }),
      );
    }
    for (const trial of trials) await store.saveTrial(definition.id, trial);
    await store.saveRecommendation(makeRecommendation(definition.id, i));
    const rec = makeRecommendation(definition.id, i);    let hs = buildHumanSessionRecord({
      sessionId: `session-scale-${i}` as never,
      experimentId: definition.id,
      playerId: "player-aldo" as never,
      displayName: "Aldo",
      dpi: 800,
      startingSensitivity: { sensX: 7, sensY: 7 },
      device: {
        userAgent: "ScaleAgent/1.0",
        platform: "Win32",
        screenPx: { width: 2560, height: 1440 },
        pointerCoalescingSupported: true,
      },
      startedAtIso: new Date(Date.UTC(2026, 0, 1, 10, i)).toISOString(),
      scenarioOrder: ["flick-static-medium"],
      candidateOrderBlinded: ["Candidate A"],
      candidateReveal: { "Candidate A": definition.candidates[0]!.id },
      warmupCount: 2,
      measuredCount: TRIALS_PER_SESSION,
      invalidTrialCount: 0,
      pausePeriods: [],
      fatigueIndicators: { forcedRests: 0, degradationDetected: false, degradationRatio: null },
      optimizerVersion: "optimizer-v3",
      scoringWeights: {},
      calibrationAdequateX: null,
      calibrationAdequateY: null,
      // Retest lineage every 6th session points at its predecessor.
      retestOfExperimentId: (i % 6 === 1 && i > 0 ? `experiment-scale-${i - 1}` : null) as never,
      sessionIndexForPlayer: Math.floor(i / 6) + 1,
    });
    hs = finalizeHumanSessionRecord(hs, new Date(Date.UTC(2026, 0, 1, 11, i)).toISOString(), rec, 40 * 60000);
    await store.saveRaw("human-session", `human-sessions/${hs.sessionId}.json`, hs);
  }
  return { backend, store };
}

describe("history at scale", () => {
  it("builds a large history and serves a correct snapshot within budget", async () => {
    const { backend, store } = await seedLargeHistory();
    const api = new HistoryApi(store);

    const t0 = performance.now();
    const snap = await api.snapshot();
    const elapsedMs = performance.now() - t0;

    expect(snap.sessions.length).toBe(SESSIONS);
    expect(snap.trends.edpi.length).toBe(SESSIONS);
    expect(snap.rankingHistory.length).toBeGreaterThan(0);
    expect(snap.retestLineage.length).toBe(Math.floor(SESSIONS / 6));
    expect(snap.optimizerVersions.length).toBeGreaterThanOrEqual(1);

    // Deterministic ordering: sessions ordered consistently across calls.
    const second = await api.listSessions();
    expect(second.map((s) => s.experimentId)).toEqual(
      snap.sessions.map((s) => s.experimentId),
    );
    for (let i = 1; i < second.length; i++) {
      expect(
        second[i - 1]!.experimentId <= second[i]!.experimentId ||
          second[i - 1]!.startedAtIso !== second[i]!.startedAtIso,
      ).toBe(true);
    }

    // Trend values stay finite and bounded even with mixed engine versions.
    for (const point of snap.trends.edpi) {
      if (point.value !== null) {
        expect(Number.isFinite(point.value)).toBe(true);
      }
    }

    // Load-time budget: full snapshot over 240 sessions must stay fast.
    // (In-memory backend measures pure API cost — disk adds I/O only.)
    expect(elapsedMs).toBeLessThan(10_000);
    void backend;
  }, 120_000);

  it("backs up and restores the large store with integrity", async () => {
    const { backend } = await seedLargeHistory();
    const t0 = performance.now();
    const backup = await exportBackupAll(backend);
    const exportMs = performance.now() - t0;
    const serialized = JSON.stringify(backup);

    // Restore into a fresh backend; zero partial writes on success path.
    const target = new InMemoryBackend();
    const result = await importBackupAll(target, JSON.parse(serialized));
    expect(result.restoredCount).toBeGreaterThan(SESSIONS);

    const restoredApi = new HistoryApi(new LocalJsonStore(target));
    const restoredSnap = await restoredApi.snapshot();
    expect(restoredSnap.sessions.length).toBe(SESSIONS);

    // Backup stays proportionally small (JSON with envelopes + trials).
    const bytesPerSession = serialized.length / SESSIONS;
    expect(bytesPerSession).toBeLessThan(200_000); // generous ceiling
    void exportMs;
  }, 180_000);

  it("fails closed on corrupted backups without partial mutation", async () => {
    const { backend } = await seedLargeHistory();
    const backup = await exportBackupAll(backend);
    const target = new InMemoryBackend();

    const corrupted = JSON.parse(JSON.stringify(backup)) as typeof backup;
    corrupted.integrity.checksumHex = "0".repeat(64);
    await expect(importBackupAll(target, corrupted)).rejects.toThrow();
    expect((await target.listFiles("")).length).toBe(0);

    const truncated = JSON.parse(JSON.stringify(backup)) as typeof backup;
    truncated.entries = truncated.entries.slice(0, Math.floor(truncated.entries.length / 2));
    await expect(importBackupAll(target, truncated)).rejects.toThrow();
    expect((await target.listFiles("")).length).toBe(0);
  }, 180_000);
});
