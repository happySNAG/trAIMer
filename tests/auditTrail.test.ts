import { LOCK_GRANTED } from "../src/capture/browserSource.ts";
import { describe, expect, it } from "vitest";
import {
  SessionRunner,
  ManualClock,
  InMemoryBackend,
  LocalJsonStore,
  buildExperimentDefinition,
  scenarioById,
  makeTrialId,
  makeExperimentId,
} from "../src/index.ts";
import type { TrialExecutionPort, SessionStateName } from "../src/session/types.ts";
import type { TrialPlanSpec } from "../src/experiments/protocol.ts";
import type { TrialRecord } from "../src/domain/trial.ts";
import { equalXy } from "../src/domain/settings.ts";

class QuickPort implements TrialExecutionPort {
  constructor(private clock: ManualClock) {}
  async requestLock() {
    return LOCK_GRANTED;
  }
  async releaseCapture() {}
  async executeTrial(spec: TrialPlanSpec, _round: number, repIndex: number | null): Promise<TrialRecord> {
    void repIndex;
    const scenario = scenarioById(spec.scenarioId);
    const startedAt = this.clock.nowMs();
    return {
      id: makeTrialId(`q-${spec.sequenceNumber}`),
      sessionId: null,
      experimentId: null,
      candidateId: spec.candidateId as never,
      indexInSession: spec.sequenceNumber,
      phase: spec.phase,
      scenarioId: spec.scenarioId,
      scenarioKind: scenario.kind,
      captureContext: {
        scenarioKind: scenario.kind,
        viewport: { widthPx: 1280, heightPx: 720 },
        sensitivity: equalXy(7),
        dpi: 800,
        expectedSampleIntervalMs: null,
      },
      startedAtMonotonicMs: startedAt,
      endedAtMonotonicMs: startedAt + 300,
      samples: Array.from({ length: 20 }, (_, i) => ({
        tMs: startedAt + i * 8,
        cursor: { x: 640 + i, y: 360 },
        dx: 1,
        dy: 0,
      })),
      targets:
        scenario.kind === "tracking"
          ? []
          : [
              {
                targetId: `target-${spec.sequenceNumber}`,
                radiusPx: 26,
                appearedMs: startedAt + 50,
                removedMs: startedAt + 250,
                removalReason: "hit",
                motion: { kind: "static" as const, position: { x: 800, y: 360 } },
              },
            ],
      shots:
        scenario.kind === "tracking"
          ? []
          : [
              {
                tMs: startedAt + 240,
                cursorAtShot: { x: 800, y: 360 },
                aimedTargetId: `target-${spec.sequenceNumber}` as never,
                hit: true,
                missDistancePx: 0,
              },
            ],
      focusInterruptions: [],
      viewportResizes: [],
      outcome: scenario.kind === "tracking" ? "tracking-complete" : "hit",
      validity: { status: "valid", reasons: [] },
      seedTag: `${spec.sequenceNumber}`,
      scenarioRepIndex: repIndex,
      abortedMs: null,
    };
  }
}

describe("session audit trail", () => {
  it("records the full decision trail for a completed session", async () => {
    const clock = new ManualClock();
    const backend = new InMemoryBackend();
    const definition = buildExperimentDefinition({
      id: makeExperimentId("audit-test"),
      name: "audit",
      baselineSensitivity: equalXy(7),
      dpi: 800,
      ladderFactors: [1 / 1.15, 1, 1.15],
      measuredRepsPerCandidatePerRound: 4,
      warmupTrialsPerCandidateBlock: 1,
      orderSeed: 17,
      adaptiveAllocation: { enabled: true, minRepsBeforeAdaptive: 4 },
      stoppingCriteria: { maxSearchRounds: 2 },
    });
    const runner = new SessionRunner(definition, {
      clock,
      sleep: async (ms) => {
        clock.advance(ms);
        await new Promise((resolve) => setImmediate(resolve));
      },
      nowIso: () => new Date(2026, 5, 1).toISOString(),
      store: new LocalJsonStore(backend),
      execution: new QuickPort(clock),
      onStateChange: (_state: SessionStateName) => {},
    });

    const result = await runner.run();
    expect(result.status).toBe("complete");

    const categories = new Set(result.auditTrail.map((e) => e.category));
    expect(categories.has("experiment-created")).toBe(true);
    expect(categories.has("trial-started")).toBe(true);
    expect(categories.has("trial-ended")).toBe(true);
    expect(categories.has("recommendation-created")).toBe(true);

    const seqs = result.auditTrail.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

    // Adaptive decisions appear once allocation kicks in (round >= 1).
    const adaptive = result.auditTrail.filter(
      (e) => e.category === "adaptive-allocation-decision",
    );
    expect(adaptive.length).toBeGreaterThan(0);
    for (const entry of adaptive) {
      expect(entry.detail.reason).toBeDefined();
    }
  });
});
