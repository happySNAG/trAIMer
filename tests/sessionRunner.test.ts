import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeExperimentId,
  SessionRunner,
  ManualClock,
  InMemoryBackend,
  LocalJsonStore,
  buildExperimentDefinition,
  scenarioById,
  makeTrialId,
  type TrialExecutionPort,
  type SessionStateName,
} from "../src/index.ts";
import type { TrialPlanSpec } from "../src/experiments/protocol.ts";
import type { TrialRecord } from "../src/domain/trial.ts";
import { equalXy } from "../src/domain/settings.ts";

const fsRoot = await mkdtemp(join(tmpdir(), "aldo-runner-"));
afterAll(async () => {
  await rm(fsRoot, { recursive: true, force: true });
});

interface ScriptedOutcome {
  hit: boolean;
  acquisitionMs: number;
}

class ScriptedExecutionPort implements TrialExecutionPort {
  lockResult = true;
  readonly executed: { candidateId: string; scenarioId: string; phase: string; round: number; repIndex: number | null }[] = [];
  readonly outcomesByCandidate = new Map<string, ScriptedOutcome>();

  constructor(private readonly clock: ManualClock) {}

  setOutcome(candidateId: string, outcome: ScriptedOutcome): void {
    this.outcomesByCandidate.set(candidateId, outcome);
  }

  async requestLock(): Promise<boolean> {
    return this.lockResult;
  }

  async releaseCapture(): Promise<void> {}

  async executeTrial(
    spec: TrialPlanSpec,
    round: number,
    repIndex: number | null,
  ): Promise<TrialRecord> {
    this.executed.push({
      candidateId: spec.candidateId,
      scenarioId: spec.scenarioId,
      phase: spec.phase,
      round,
      repIndex,
    });
    const scenario = scenarioById(spec.scenarioId);
    const outcomeScript =
      this.outcomesByCandidate.get(spec.candidateId) ?? { hit: true, acquisitionMs: 400 };
    const startedAt = this.clock.nowMs();
    const shotT = startedAt + 150 + outcomeScript.acquisitionMs;
    const endedAt = shotT + 30;

    return {
      id: makeTrialId(`${round}-${spec.sequenceNumber}`),
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
        expectedSampleIntervalMs: 4,
      },
      startedAtMonotonicMs: startedAt,
      endedAtMonotonicMs: endedAt,
      samples: Array.from({ length: 30 }, (_, i) => ({
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
                appearedMs: startedAt + 100,
                removedMs: outcomeScript.hit ? shotT : endedAt,
                removalReason: outcomeScript.hit ? "hit" : "trial-end",
                motion: { kind: "static" as const, position: { x: 800, y: 360 } },
              },
            ],
      shots:
        scenario.kind === "tracking"
          ? []
          : [
              {
                tMs: shotT,
                cursorAtShot: { x: 800, y: 360 },
                aimedTargetId: outcomeScript.hit ? (`target-${spec.sequenceNumber}` as never) : null,
                hit: outcomeScript.hit,
                missDistancePx: outcomeScript.hit ? 0 : 60,
              },
            ],
      focusInterruptions: [],
      viewportResizes: [],
      outcome:
        scenario.kind === "tracking"
          ? "tracking-complete"
          : outcomeScript.hit
            ? "hit"
            : "miss-shot-fired",
      validity: { status: "valid", reasons: [] },
      seedTag: `${round}:${spec.sequenceNumber}`,
      scenarioRepIndex: repIndex,
      abortedMs: null,
    };
  }
}

function makePorts(
  clock: ManualClock,
  backend: InMemoryBackend,
  execution: TrialExecutionPort,
  stateLog: SessionStateName[],
) {
  return {
    clock,
    sleep: async (ms: number) => {
      clock.advance(ms);
      await new Promise((resolve) => setImmediate(resolve));
    },
    nowIso: () => new Date(2026, 0, 1).toISOString(),
    store: new LocalJsonStore(backend),
    execution,
    onStateChange: (state: SessionStateName) => {
      if (stateLog[stateLog.length - 1] !== state) stateLog.push(state);
    },
    onProgress: undefined,
    onTrialPersisted: undefined,
  };
}

function buildSmallDefinition(overrides: Record<string, unknown> = {}) {
  return buildExperimentDefinition({
    id: makeExperimentId(`runner-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`),
    name: "runner test",
    baselineSensitivity: equalXy(7),
    dpi: 800,
    ladderFactors: [1 / 1.15, 1, 1.15],
    measuredRepsPerCandidatePerRound: 3,
    warmupTrialsPerCandidateBlock: 1,
    orderSeed: 9,
    scenarioIds: ["flick-static-medium"],
    stoppingCriteria: { maxSearchRounds: 2 },
    adaptiveAllocation: { enabled: true, minRepsBeforeAdaptive: 6 },
    ...overrides,
  });
}

describe("session runner", () => {
  it("executes the full plan with correct candidate/scenario attribution", async () => {
    const clock = new ManualClock();
    const backend = new InMemoryBackend();
    const execution = new ScriptedExecutionPort(clock);
    const definition = buildSmallDefinition();
    for (const candidate of definition.candidates) {
      execution.setOutcome(candidate.id, { hit: true, acquisitionMs: 380 });
    }
    const stateLog: SessionStateName[] = [];
    const runner = new SessionRunner(definition, makePorts(clock, backend, execution, stateLog));

    const result = await runner.run();
    expect(result.status).toBe("complete");

    const measured = execution.executed.filter((e) => e.phase === "measured");
    expect(measured.length).toBe(18);
    for (const entry of measured) {
      expect(entry.scenarioId).toBe("flick-static-medium");
      expect(entry.repIndex).not.toBeNull();
    }
    const perCandidate = new Map<string, number>();
    for (const entry of measured) {
      perCandidate.set(entry.candidateId, (perCandidate.get(entry.candidateId) ?? 0) + 1);
    }
    for (const count of perCandidate.values()) expect(count).toBeGreaterThanOrEqual(3);

    const store = new LocalJsonStore(backend);
    const persisted = await store.loadAllTrials(definition.id);
    expect(persisted.length).toBe(execution.executed.length);

    expect(stateLog).toContain("awaiting-lock");
    expect(stateLog).toContain("trial-active");
    expect(stateLog).toContain("analyzing");
    expect(stateLog[stateLog.length - 1]).toBe("complete");

    const recommendation = await store.loadRecommendation(definition.id);
    expect(recommendation).not.toBeNull();
  });

  it("aborts cleanly when pointer lock is denied and persists nothing as valid trials", async () => {
    const clock = new ManualClock();
    const backend = new InMemoryBackend();
    const execution = new ScriptedExecutionPort(clock);
    execution.lockResult = false;
    const stateLog: SessionStateName[] = [];
    const definition = buildSmallDefinition();
    const runner = new SessionRunner(definition, makePorts(clock, backend, execution, stateLog));
    const result = await runner.run();
    expect(result.status).toBe("aborted");
    expect(execution.executed.length).toBe(0);
    expect(runner.state).toBe("aborted");
    void fsRoot;
  });

  it("enforces fatigue rests during long stretches of measured trials", async () => {
    const clock = new ManualClock();
    const backend = new InMemoryBackend();
    const execution = new ScriptedExecutionPort(clock);
    const definition = buildSmallDefinition({
      fatigueProtocol: {
        maxContinuousTestingMs: 5000,
        restDurationMs: 45000,
        degradationWindowTrials: 3,
        degradationRatioThreshold: 1.25,
      },
      measuredRepsPerCandidatePerRound: 4,
    });
    const trialCounter = 0;
    for (const candidate of definition.candidates) {
      execution.setOutcome(candidate.id, { hit: true, acquisitionMs: 300 });
      void trialCounter;
    }
    // Simulate degradation: later candidates get slower acquisitions.
    definition.candidates.forEach((candidate, index) => {
      execution.setOutcome(candidate.id, { hit: true, acquisitionMs: 250 + index * 120 });
    });
    const stateLog: SessionStateName[] = [];
    const runner = new SessionRunner(definition, makePorts(clock, backend, execution, stateLog));
    await runner.run();
    expect(stateLog).toContain("rest");
  });

  it("supports pause/resume and cancel mid-session", async () => {
    const clock = new ManualClock();
    const backend = new InMemoryBackend();
    const execution = new ScriptedExecutionPort(clock);
    const definition = buildSmallDefinition({ stoppingCriteria: { maxSearchRounds: 1 } });
    for (const candidate of definition.candidates) {
      execution.setOutcome(candidate.id, { hit: true, acquisitionMs: 320 });
    }
    const stateLog: SessionStateName[] = [];
    const runner = new SessionRunner(definition, makePorts(clock, backend, execution, stateLog));

    const runPromise = runner.run();
    await new Promise((resolve) => setTimeout(resolve, 10));
    runner.pause();
    await new Promise((resolve) => setTimeout(resolve, 10));
    runner.resume();
    const result = await runPromise;
    expect(result.status).toBe("complete");

    const secondBackend = new InMemoryBackend();
    const execution2 = new ScriptedExecutionPort(clock);
    const definition2 = buildSmallDefinition({ stoppingCriteria: { maxSearchRounds: 3 } });
    for (const candidate of definition2.candidates) {
      execution2.setOutcome(candidate.id, { hit: true, acquisitionMs: 330 });
    }
    const runner2 = new SessionRunner(definition2, makePorts(clock, secondBackend, execution2, []));
    const runPromise2 = runner2.run();
    runner2.cancel();
    const result2 = await runPromise2;
    expect(result2.status).toBe("aborted");
  });

  it("persists checkpoints with completed sequence keys as trials finish", async () => {
    const clock = new ManualClock();
    const backend = new InMemoryBackend();
    const execution = new ScriptedExecutionPort(clock);
    const definition = buildSmallDefinition({ stoppingCriteria: { maxSearchRounds: 1 } });
    for (const candidate of definition.candidates) {
      execution.setOutcome(candidate.id, { hit: true, acquisitionMs: 340 });
    }
    const runner = new SessionRunner(definition, makePorts(clock, backend, execution, []));
    await runner.run();

    const sessionId = runner.sessionId!;
    const checkpointRaw = await backend.readFile(`sessions/checkpoints/${sessionId}.json`);
    expect(checkpointRaw).not.toBeNull();
    const envelope = JSON.parse(checkpointRaw!) as {
      payload: { completedSequenceKeys: string[]; status: string };
    };
    expect(envelope.payload.completedSequenceKeys.length).toBe(execution.executed.length);
    expect(envelope.payload.status).toBe("complete");
  });
});
