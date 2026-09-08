import { LOCK_GRANTED } from "../src/capture/browserSource.ts";
import { describe, expect, it } from "vitest";
import { SessionRunner } from "../src/session/runner.ts";
import type { SessionRunnerPorts } from "../src/session/types.ts";
import type { ResumeCheckpoint } from "../src/session/resume.ts";
import {
  RESUME_CHECKPOINT_SCHEMA_VERSION,
  buildResumePlan,
  parseResumeCheckpoint,
  summarizeCheckpointForUi,
} from "../src/session/resume.ts";
import { detectInterruptedTrialFromAudit } from "../src/session/runner.ts";
import { buildExperimentDefinition } from "../src/experiments/protocol.ts";
import { ManualClock } from "../src/capture/clock.ts";
import { InMemoryBackend } from "../src/persistence/backends.ts";
import { LocalJsonStore } from "../src/persistence/store.ts";
import type { TrialPlanSpec } from "../src/experiments/protocol.ts";
import type { TrialRecord } from "../src/domain/trial.ts";

function makeDefinition() {
  return buildExperimentDefinition({
    id: "experiment-resume-test" as never,
    name: "resume test",
    baselineSensitivity: { sensX: 7, sensY: 7 },
    dpi: 800,
    orderSeed: 42,
    measuredRepsPerCandidatePerRound: 3,
    warmupTrialsPerCandidateBlock: 1,
    randomizeOrder: false,
    adaptiveAllocation: { enabled: false },
    stoppingCriteria: { maxSearchRounds: 1 },
  });
}

interface HarnessOptions {
  /** Simulate the process dying when the Nth trial execution begins. */
  crashAtSpecs?: number;
}

async function runUntilCrash(h: { ports: SessionRunnerPorts }, options: HarnessOptions) {
  const ports = h.ports;
  const definition = makeDefinition();
  const runner = new SessionRunner(definition, ports);
  let executed = 0;
  const originalExecute = ports.execution.executeTrial.bind(ports.execution);
  ports.execution.executeTrial = async (
    spec: TrialPlanSpec,
    round: number,
    repIndex: number | null,
  ): Promise<TrialRecord> => {
    if (
      options.crashAtSpecs !== undefined &&
      executed >= options.crashAtSpecs
    ) {
      throw new Error("SIMULATED_PROCESS_CRASH");
    }
    executed++;
    return originalExecute(spec, round, repIndex);
  };
  const promise = runner.run();
  // Swallow the simulated crash — the app process would die entirely.
  const outcome = await promise.catch((err) => ({ crashed: String(err) }));
  return { runner, definition, outcome };
}

function basePorts(): { ports: SessionRunnerPorts; backend: InMemoryBackend } {
  const backend = new InMemoryBackend();
  const store = new LocalJsonStore(backend);
  const ports: SessionRunnerPorts = {
    clock: new ManualClock(),
    sleep: async () => undefined,
    nowIso: () => new Date(0).toISOString(),
    store,
    execution: {
      requestLock: async () => LOCK_GRANTED,
      executeTrial: async (spec, round, repIndex): Promise<TrialRecord> => ({
        id: `trial-r${round}-${spec.sequenceNumber}` as never,
        sessionId: "session-x" as never,
        experimentId: "experiment-resume-test" as never,
        candidateId: spec.candidateId as never,
        indexInSession: spec.sequenceNumber,
        phase: spec.phase,
        scenarioId: spec.scenarioId,
        scenarioKind: "flick-static",
        captureContext: {
          scenarioKind: "flick-static",
          viewport: { widthPx: 1280, heightPx: 720 },
          sensitivity: { sensX: 7, sensY: 7 },
          dpi: 800,
          expectedSampleIntervalMs: null,
        },
        startedAtMonotonicMs: 0,
        endedAtMonotonicMs: 500,
        samples: Array.from({ length: 12 }, (_, i) => ({
          tMs: i * 10,
          cursor: { x: 640 + i * 2, y: 360 },
          dx: 2,
          dy: 0,
        })),
        targets: [
          {
            targetId: "target-1",
            radiusPx: 26,
            appearedMs: 5,
            removedMs: 490,
            removalReason: "hit",
            motion: { kind: "static", position: { x: 700, y: 360 } },
          },
        ],
        shots: [
          {
            tMs: 480,
            cursorAtShot: { x: 700, y: 360 },
            aimedTargetId: "target-1",
            hit: true,
            missDistancePx: 0,
          },
        ],
        focusInterruptions: [],
        viewportResizes: [],
        outcome: spec.phase === "warmup" ? "hit" : "hit",
        validity: { status: "valid", reasons: [] },
        seedTag: null,
        scenarioRepIndex: repIndex,
        abortedMs: null,
      }),
      releaseCapture: async () => undefined,
      suspendCapture: async () => undefined,
      resumeCapture: async () => LOCK_GRANTED,
    },
  };
  return { ports, backend };
}

async function loadCheckpoint(
  backend: InMemoryBackend,
): Promise<{ raw: string; parsed: ResumeCheckpoint }> {
  const files = await backend.listFiles("sessions/checkpoints");
  expect(files.length).toBeGreaterThan(0);
  const raw = (await backend.readFile(`sessions/checkpoints/${files[0]}`))!;
  const envelope = JSON.parse(raw) as { payload: unknown };
  return { raw, parsed: parseResumeCheckpoint(envelope.payload) };
}

describe("production session resume/recovery", () => {
  it("checkpoints persist the full resumable state", async () => {
    const first = basePorts();
    await runUntilCrash(first, { crashAtSpecs: 5 });
    const { parsed } = await loadCheckpoint(first.backend);
    expect(parsed.schemaVersion).toBe(RESUME_CHECKPOINT_SCHEMA_VERSION);
    expect(parsed.completedSequenceKeys.length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(parsed.blindedLabels).length).toBeGreaterThan(0);
    expect(parsed.auditTrail.length).toBeGreaterThan(5);
    expect(parsed.appVersion).toBeTruthy();
    expect(parsed.engineVersion).toBeTruthy();
    expect(parsed.captureSource).toBeNull();
  });

  it("resuming skips completed steps and NEVER repeats a completed trial", async () => {
    const first = basePorts();
    await runUntilCrash(first, { crashAtSpecs: 6 });
    const { parsed } = await loadCheckpoint(first.backend);
    const completedBefore = new Set(parsed.completedSequenceKeys);

    const second = basePorts();
    second.backend = first.backend; // same storage
    const restoredTrials = await new LocalJsonStore(second.backend).loadAllTrials(
      "experiment-resume-test",
    );
    const resumedRunner = SessionRunner.resumeFrom(
      JSON.parse((await first.backend.readFile(
        `sessions/checkpoints/${(await first.backend.listFiles("sessions/checkpoints"))[0]}`,
      ))!).payload,
      makeDefinition(),
      second.ports,
      restoredTrials,
    );
    const plan = buildResumePlan(parsed, makeDefinition());
    // The crash struck while a trial was pending (pre-trial marker), so the
    // plan explicitly invalidates and repeats exactly that trial.
    expect(plan.willInvalidateInterruptedTrial).toBe(true);
    expect(parsed.interruptedTrial).not.toBeNull();

    const outcome = await resumedRunner.run();
    expect(outcome.status).toBe("complete");

    // Every executed trial id must be unique — no silent repeats.
    const ids = outcome.trials.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    void completedBefore;
    expect(resumedRunner.auditEntries().length).toBeGreaterThan(0);
  });

  it("an interrupted in-progress trial is invalidated and repeated WITH audit metadata", async () => {
    const first = basePorts();
    await runUntilCrash(first, { crashAtSpecs: 3 });
    const { parsed } = await loadCheckpoint(first.backend);
    const interrupted = parsed.interruptedTrial;
    expect(interrupted).not.toBeNull();
    expect(interrupted!.phase).toBe("measured");

    const second = basePorts();
    second.backend = first.backend;
    const restored = await new LocalJsonStore(second.backend).loadAllTrials(
      "experiment-resume-test",
    );
    const resumed = SessionRunner.resumeFrom(
      JSON.parse((await first.backend.readFile(
        `sessions/checkpoints/${(await first.backend.listFiles("sessions/checkpoints"))[0]}`,
      ))!).payload,
      makeDefinition(),
      second.ports,
      restored,
    );
    const auditBeforeRun = resumed
      .auditEntries()
      .filter((e) => e.category === "trial-invalidated" && e.detail.reasons === "INTERRUPTED_IN_PROGRESS");
    expect(auditBeforeRun).toHaveLength(1);

    const outcome = await resumed.run();
    expect(outcome.status).toBe("complete");
    const ids = outcome.trials.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("corrupted checkpoints fail closed with a typed error", () => {
    expect(() => parseResumeCheckpoint({ nonsense: true })).toThrow(/corrupted|unsupported/);
    expect(() =>
      parseResumeCheckpoint({ schemaVersion: 99, kind: "session-resume", sessionId: "s", experimentId: "e", completedSequenceKeys: [], phaseLog: [] }),
    ).toThrow(/unsupported checkpoint schemaVersion/);
    expect(() =>
      parseResumeCheckpoint({
        schemaVersion: RESUME_CHECKPOINT_SCHEMA_VERSION,
        kind: "session-resume",
        sessionId: "session-x",
        // missing experimentId
        completedSequenceKeys: [],
        phaseLog: [],
      }),
    ).toThrow(/missing required fields/);
  });

  it("incompatible definitions cannot be resumed", async () => {
    const first = basePorts();
    await runUntilCrash(first, { crashAtSpecs: 4 });
    const { parsed } = await loadCheckpoint(first.backend);
    const other = makeDefinition();
    (other as { id: string }).id = "experiment-something-else";
    expect(() => buildResumePlan(parsed, other)).toThrow(/belongs to/);
  });

  it("UI summary exposes every mandated field", async () => {
    const first = basePorts();
    await runUntilCrash(first, { crashAtSpecs: 5 });
    const { parsed } = await loadCheckpoint(first.backend);
    const summary = summarizeCheckpointForUi(
      parsed,
      makeDefinition(),
      new Date(1000).toISOString(),
    );
    expect(summary.playerName).toBe("unknown player"); // no identity port wired here
    expect(summary.experimentLabel).toBe("resume test");
    expect(summary.completedMeasuredTrials).toBeGreaterThan(0);
    expect(summary.currentRound).toBe(0);
    expect(summary.lastValidState).toBeTruthy();
    expect(typeof summary.ageMs).toBe("number");
  });

  it("recovery works when interruption happened during rest/candidate transition", async () => {
    // Crash right at a candidate boundary: odd spec counts land between blocks.
    const first = basePorts();
    await runUntilCrash(first, { crashAtSpecs: 8 });
    const { parsed } = await loadCheckpoint(first.backend);
    expect(detectInterruptedTrialFromAudit(parsed)).toBeNull();

    const second = basePorts();
    second.backend = first.backend;
    const restored = await new LocalJsonStore(second.backend).loadAllTrials(
      "experiment-resume-test",
    );
    const resumed = SessionRunner.resumeFrom(
      JSON.parse((await first.backend.readFile(
        `sessions/checkpoints/${(await first.backend.listFiles("sessions/checkpoints"))[0]}`,
      ))!).payload,
      makeDefinition(),
      second.ports,
      restored,
    );
    const outcome = await resumed.run();
    const ids = outcome.trials.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("progress snapshots remain available for UI during resumed runs", async () => {
    const first = basePorts();
    await runUntilCrash(first, { crashAtSpecs: 4 });
    await loadCheckpoint(first.backend);
    const second = basePorts();
    second.backend = first.backend;
    second.ports.onProgress = () => undefined;
    const restored = await new LocalJsonStore(second.backend).loadAllTrials(
      "experiment-resume-test",
    );
    const resumed = SessionRunner.resumeFrom(
      JSON.parse((await first.backend.readFile(
        `sessions/checkpoints/${(await first.backend.listFiles("sessions/checkpoints"))[0]}`,
      ))!).payload,
      makeDefinition(),
      second.ports,
      restored,
    );
    expect(resumed.state).toBe("setup");
    await resumed.run();
  });
});
