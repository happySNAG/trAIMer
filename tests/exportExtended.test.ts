import { describe, expect, it } from "vitest";
import {
  compactAnalysisSummary,
  exportExperimentBundle,
  importExperimentBundle,
  InMemoryBackend,
  LocalJsonStore,
  buildHumanSessionRecord,
  finalizeHumanSessionRecord,
  buildExperimentDefinition,
  SyntheticExperimentRunner,
  playerPreset,
  equalXy,
} from "../src/index.ts";
import type { TrialRecord } from "../src/domain/trial.ts";

describe("extended analysis export", () => {
  async function makeStoreWithSession() {
    const backend = new InMemoryBackend();
    const store = new LocalJsonStore(backend);
    const definition = buildExperimentDefinition({
      id: "experiment-export" as never,
      name: "export",
      baselineSensitivity: equalXy(7),
      dpi: 800,
      measuredRepsPerCandidatePerRound: 4,
    });
    await store.saveExperiment(definition);
    const runner = new SyntheticExperimentRunner(definition, {
      ...playerPreset("consistent-medium"),
      trueOptimalEdpi: 5600,
    });
    const trials = runner.runRound(0, 88, "session-exp" as never, definition.id);
    for (const trial of trials) await store.saveTrial(definition.id, trial);

    let humanSession = buildHumanSessionRecord({
      sessionId: "session-exp" as never,
      experimentId: definition.id,
      playerId: "player-aldo" as never,
      displayName: "Aldo",
      dpi: 800,
      startingSensitivity: equalXy(7),
      device: {
        userAgent: "Vitest",
        platform: "test",
        screenPx: { width: 1280, height: 720 },
        pointerCoalescingSupported: false,
      },
      startedAtIso: "2026-08-22T10:00:00.000Z",
      scenarioOrder: ["flick-static-medium"],
      candidateOrderBlinded: ["A", "B"],
      candidateReveal: {},
      warmupCount: 2,
      measuredCount: trials.filter((t) => t.phase === "measured").length,
      invalidTrialCount: 0,
      pausePeriods: [],
      fatigueIndicators: { forcedRests: 0, degradationDetected: false, degradationRatio: null },
      optimizerVersion: "optimizer-v2",
      scoringWeights: { accuracy: 0.28 },
      calibrationAdequateX: null,
      calibrationAdequateY: null,
      retestOfExperimentId: null,
      sessionIndexForPlayer: 1,
    });
    humanSession = finalizeHumanSessionRecord(
      humanSession,
      "2026-08-22T10:25:00.000Z",
      null,
      20 * 60 * 1000,
    );
    await store.saveRaw("human-session", `human-sessions/session-exp.json`, humanSession);

    const inputQualityByTrialId: Record<string, { score: number }> = {};
    for (const t of trials as TrialRecord[]) {
      inputQualityByTrialId[t.id] = { score: 0.95 };
    }

    const bundle = await exportExperimentBundle(store, definition.id);
    bundle.payload.humanSession = humanSession;
    bundle.payload.inputQualityByTrialId = inputQualityByTrialId;
    bundle.payload.auditTrail = [
      { seq: 0, tIso: "2026-08-22T10:00:00.000Z", category: "experiment-created", detail: {} },
      { seq: 1, tIso: "2026-08-22T10:24:00.000Z", category: "recommendation-created", detail: {} },
    ];
    return { store, backend, bundle, definition };
  }

  it("carries human session, audit trail and input-quality artifacts", async () => {
    const { bundle } = await makeStoreWithSession();
    expect(bundle.payload.humanSession).not.toBeNull();
    expect(Array.isArray(bundle.payload.auditTrail)).toBe(true);
    const iq = bundle.payload.inputQualityByTrialId ?? {};
    expect(Object.keys(iq).length).toBeGreaterThan(0);
  });

  it("re-imports extended bundles without loss", async () => {
    const { bundle } = await makeStoreWithSession();
    const target = new LocalJsonStore(new InMemoryBackend());
    const result = await importExperimentBundle(target, JSON.parse(JSON.stringify(bundle)));
    expect(result.trialsImported).toBeGreaterThan(10);
    const hsRaw = await (target as unknown as {
      loadRaw: (k: string, p: string) => Promise<{ payload: unknown } | null>;
    }).loadRaw("human-session", "human-sessions/session-exp.json");
    expect(hsRaw?.payload).not.toBeNull();
  });

  it("produces a compact machine-readable summary", async () => {
    const { bundle } = await makeStoreWithSession();
    const summary = compactAnalysisSummary(bundle);
    expect(summary.bundleKind).toBe("session-bundle");
    expect(summary.experimentId).toBe("experiment-export");
    expect(summary.session?.durationMin).toBeCloseTo(25, 1);
    expect(summary.session?.measuredTrials).toBeGreaterThan(10);
    expect(summary.recommendation?.recommendedEdpi).not.toBeNull();
    expect(summary.inputQualityWorstScore).toBeCloseTo(0.95);
    expect([false, null]).toContain(summary.adaptationDetected);
    expect(summary.retestOfExperimentId).toBeNull();
  });
});
