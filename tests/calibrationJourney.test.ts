import { describe, expect, it } from "vitest";
import { SessionRunner } from "../src/session/runner.ts";
import { buildExperimentDefinition } from "../src/experiments/protocol.ts";
import { makeExperimentId, makeTrialId } from "../src/domain/ids.ts";
import { LocalJsonStore } from "../src/persistence/store.ts";
import { InMemoryBackend } from "../src/persistence/backends.ts";
import { scenarioById } from "../src/domain/scenario.ts";
import { equalXy } from "../src/domain/settings.ts";
import { LOCK_GRANTED } from "../src/capture/browserSource.ts";
import { POINTER_LOCK_LOSS_REASON, CAPTURE_RELEASED_REASON } from "../src/capture/events.ts";
import {
  isFatalBetweenTrials,
  isFatalDuringTrial,
} from "../app/src/runController.ts";
import {
  assessEvidenceSufficiency,
  buildSessionOutcomeReport,
  summarizePerformance,
} from "../src/results/sessionOutcome.ts";
import type { TrialExecutionPort, SessionRunnerPorts } from "../src/session/types.ts";
import { planCandidateBlocks, type TrialPlanSpec } from "../src/experiments/protocol.ts";
import { planContinuation, type ResumeCheckpoint } from "../src/session/resume.ts";
import type { TrialRecord } from "../src/domain/trial.ts";
import type { ExperimentDefinition } from "../src/domain/experiment.ts";
import type { CalibrationProgressSnapshot } from "../src/results/sessionOutcome.ts";

/**
 * THE CALIBRATION JOURNEY (Pass 13, requirements 1/5/8/10).
 *
 * "It went back to the main screen after about ten challenges and said one
 *  session completed with no recommendation."
 *
 * Ten drills is one candidate block. The session died at the first break and
 * reported it as an ordinary finish. These tests hold the whole journey to
 * account: the plan runs to the end, a break is not an ending, an ending that
 * is not the end says so with a reason, progress is truthful against the real
 * plan, and a block is never counted as a session.
 */

class ManualClock {
  ms = 0;
  nowMs(): number {
    return this.ms;
  }
  advance(by: number): void {
    this.ms += by;
  }
}

/** Produces trials that pass validation for whichever candidate is playing. */
class GoodPlayerPort implements TrialExecutionPort {
  definition: ExperimentDefinition | null = null;
  readonly executed: { candidateId: string; phase: string; round: number }[] = [];
  suspends = 0;
  resumes = 0;
  resumeGranted = true;
  lockGranted = true;
  /** Called before each trial, so a test can interrupt mid-plan. */
  beforeTrial: ((n: number) => void) | null = null;

  constructor(private readonly clock: ManualClock) {}

  async requestLock() {
    return this.lockGranted
      ? LOCK_GRANTED
      : { granted: false as const, reasonCode: "denied" as const, detail: "scripted denial" };
  }
  async releaseCapture(): Promise<void> {}
  async suspendCapture(): Promise<void> {
    this.suspends++;
  }
  async resumeCapture() {
    this.resumes++;
    return this.resumeGranted
      ? LOCK_GRANTED
      : {
          granted: false as const,
          reasonCode: "denied" as const,
          detail: "Windows refused to hand the mouse back",
        };
  }

  async executeTrial(
    spec: TrialPlanSpec,
    round: number,
    repIndex: number | null,
  ): Promise<TrialRecord> {
    this.beforeTrial?.(this.executed.length);
    this.executed.push({ candidateId: spec.candidateId, phase: spec.phase, round });
    const scenario = scenarioById(spec.scenarioId);
    const sensitivity =
      this.definition?.candidates.find((c) => c.id === spec.candidateId)?.sensitivity ??
      equalXy(7);
    const startedAt = this.clock.nowMs();
    this.clock.advance(500);
    // A deterministic quality gradient across candidates so the optimizer has
    // something real to separate: the middle candidate is best.
    const index = this.definition?.candidates.findIndex((c) => c.id === spec.candidateId) ?? 0;
    const middle = ((this.definition?.candidates.length ?? 1) - 1) / 2;
    const penalty = Math.abs(index - middle) * 55;
    const shotT = startedAt + 260 + penalty + (repIndex ?? 0) * 3;
    return {
      id: makeTrialId(`t-${round}-${spec.sequenceNumber}`),
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
        sensitivity,
        dpi: 800,
        expectedSampleIntervalMs: 4,
      },
      startedAtMonotonicMs: startedAt,
      endedAtMonotonicMs: shotT + 40,
      samples: Array.from({ length: 40 }, (_, i) => ({
        tMs: startedAt + i * 8,
        cursor: { x: 640 + i * 4, y: 360 },
        dx: 4,
        dy: 0,
      })),
      targets: [
        {
          targetId: `target-${spec.sequenceNumber}` as never,
          radiusPx: 26,
          appearedMs: startedAt + 100,
          removedMs: shotT,
          removalReason: "hit",
          motion: { kind: "static", position: { x: 800, y: 360 } },
        },
      ],
      shots: [
        {
          tMs: shotT,
          cursorAtShot: { x: 800, y: 360 },
          aimedTargetId: `target-${spec.sequenceNumber}` as never,
          hit: true,
          missDistancePx: 0,
        },
      ],
      focusInterruptions: [],
      viewportResizes: [],
      outcome: "hit",
      validity: { status: "valid", reasons: [] },
      seedTag: null,
      scenarioRepIndex: repIndex,
      abortedMs: null,
    };
  }
}

function makeDefinition(overrides: Record<string, unknown> = {}): ExperimentDefinition {
  return buildExperimentDefinition({
    id: makeExperimentId(`journey-${Math.random().toString(36).slice(2)}`),
    name: "journey",
    baselineSensitivity: equalXy(7),
    dpi: 800,
    scenarioIds: ["flick-static-medium"],
    measuredRepsPerCandidatePerRound: 5,
    warmupTrialsPerCandidateBlock: 1,
    orderSeed: 11,
    restBetweenCandidatesMs: 10,
    stoppingCriteria: { maxSearchRounds: 2 },
    adaptiveAllocation: { enabled: false, minRepsBeforeAdaptive: 4, contenderZThreshold: 2, controlRefreshEveryRounds: 2 },
    ...overrides,
  });
}

function makePorts(
  clock: ManualClock,
  backend: InMemoryBackend,
  execution: TrialExecutionPort,
  progress: CalibrationProgressSnapshot[] = [],
): SessionRunnerPorts {
  return {
    clock,
    sleep: async (ms: number) => {
      clock.advance(ms);
      await Promise.resolve();
    },
    nowIso: () => new Date(2026, 8, 6).toISOString(),
    store: new LocalJsonStore(backend),
    execution,
    onCalibrationProgress: (p) => progress.push(p),
  };
}

describe("a break is not an ending", () => {
  it("a deliberate release during an interlude is never fatal", () => {
    const loss = {
      kind: "lock-change" as const,
      tMs: 10,
      locked: false,
      reason: POINTER_LOCK_LOSS_REASON,
    };
    // THE rc.6 CASE: the session released the mouse for a break, and the user
    // agent reported the resulting change as a loss.
    expect(isFatalBetweenTrials(loss, { started: true, interludeDepth: 1 })).toBe(false);
    // Outside an interlude the same event IS fatal — the next drill would run
    // with no capture at all.
    expect(isFatalBetweenTrials(loss, { started: true, interludeDepth: 0 })).toBe(true);
    // Before the session starts there is nothing to end.
    expect(isFatalBetweenTrials(loss, { started: false, interludeDepth: 0 })).toBe(false);
  });

  it("a release we asked for is never fatal, in or out of a trial", () => {
    const released = {
      kind: "lock-change" as const,
      tMs: 10,
      locked: false,
      reason: CAPTURE_RELEASED_REASON,
    };
    expect(isFatalBetweenTrials(released, { started: true, interludeDepth: 0 })).toBe(false);
    expect(isFatalDuringTrial(released)).toBe(false);
  });

  it("a mid-trial lock loss or focus loss still invalidates the trial", () => {
    expect(
      isFatalDuringTrial({
        kind: "lock-change",
        tMs: 1,
        locked: false,
        reason: POINTER_LOCK_LOSS_REASON,
      }),
    ).toBe(true);
    expect(
      isFatalDuringTrial({ kind: "focus-change", tMs: 1, focused: false, reason: "window-blur" }),
    ).toBe(true);
    expect(
      isFatalDuringTrial({ kind: "focus-change", tMs: 1, focused: true, reason: "window-blur" }),
    ).toBe(false);
  });

  it("the first break does not end the campaign: every planned block runs", async () => {
    const clock = new ManualClock();
    const backend = new InMemoryBackend();
    const port = new GoodPlayerPort(clock);
    const definition = makeDefinition();
    port.definition = definition;
    const runner = new SessionRunner(definition, makePorts(clock, backend, port));
    const outcome = await runner.run();

    expect(outcome.status).toBe("complete");
    expect(port.suspends).toBeGreaterThan(0); // breaks really happened
    expect(port.resumes).toBe(port.suspends);
    const blocksRun = new Set(
      port.executed.map((e) => `${e.round}:${e.candidateId}`),
    );
    expect(blocksRun.size).toBe(definition.candidates.length * 2);
    expect(outcome.outcomeReport.endKind).toBe("completed");
    expect(outcome.outcomeReport.endedEarly).toBe(false);
  });
});

describe("progress is truthful against the real plan", () => {
  it("reaches 100% only when the whole plan has run, and never conflates a block with a session", async () => {
    const clock = new ManualClock();
    const backend = new InMemoryBackend();
    const port = new GoodPlayerPort(clock);
    const definition = makeDefinition();
    port.definition = definition;
    const progress: CalibrationProgressSnapshot[] = [];
    const runner = new SessionRunner(definition, makePorts(clock, backend, port, progress));
    const outcome = await runner.run();

    const stepsPerRound = definition.candidates.length * (1 + 5);
    const totalSteps = stepsPerRound * 2;

    // Monotone, bounded, and it only reads 100% at the end.
    let previous = -1;
    for (const p of progress) {
      expect(p.fraction).toBeGreaterThanOrEqual(0);
      expect(p.fraction).toBeLessThanOrEqual(1);
      expect(p.stepsCompleted).toBeGreaterThanOrEqual(previous);
      previous = p.stepsCompleted;
    }
    const final = outcome.outcomeReport.progress;
    expect(final.stepsPlanned).toBe(totalSteps);
    expect(final.stepsCompleted).toBe(totalSteps);
    expect(final.fraction).toBe(1);

    // A BLOCK is not a SESSION. Ten drills — one block — must never read as a
    // completed calibration, which is exactly what rc.6 reported.
    const afterFirstBlock = progress.find((p) => p.stepsCompleted === 6);
    expect(afterFirstBlock).toBeDefined();
    expect(afterFirstBlock!.fraction).toBeLessThan(0.2);
    expect(afterFirstBlock!.blockIndex).toBe(1);
    expect(afterFirstBlock!.blocksPerRound).toBe(definition.candidates.length);
    expect(afterFirstBlock!.roundIndex).toBe(1);
    expect(afterFirstBlock!.roundsPlanned).toBe(2);
    expect(final.measuredCompleted).toBe(definition.candidates.length * 5 * 2);
    expect(final.measuredCompleted).not.toBe(final.blocksPerRound);
  });

  it("counts blocks within a round rather than accumulating across rounds", async () => {
    const clock = new ManualClock();
    const backend = new InMemoryBackend();
    const port = new GoodPlayerPort(clock);
    const definition = makeDefinition();
    port.definition = definition;
    const progress: CalibrationProgressSnapshot[] = [];
    const runner = new SessionRunner(definition, makePorts(clock, backend, port, progress));
    await runner.run();
    for (const p of progress) {
      expect(p.blockIndex).toBeLessThanOrEqual(p.blocksPerRound);
      expect(p.roundIndex).toBeLessThanOrEqual(p.roundsPlanned);
    }
  });
});

describe("an early ending explains itself", () => {
  it("a failed resume aborts with a named reason, never as a completion", async () => {
    const clock = new ManualClock();
    const backend = new InMemoryBackend();
    const port = new GoodPlayerPort(clock);
    const definition = makeDefinition();
    port.definition = definition;
    port.resumeGranted = false;
    const runner = new SessionRunner(definition, makePorts(clock, backend, port));
    const outcome = await runner.run();

    expect(outcome.status).toBe("aborted");
    expect(outcome.abortReason).toBeDefined();
    expect(outcome.abortReason!.detail).toContain("refused");
    expect(outcome.outcomeReport.endKind).toBe("resume-failed");
    expect(outcome.outcomeReport.endedEarly).toBe(true);
    expect(outcome.outcomeReport.endReasonText).toContain("could not take the mouse back");
    // Completed drills survive.
    expect(outcome.trials.length).toBeGreaterThan(0);
    expect(outcome.outcomeReport.progress.stepsCompleted).toBe(outcome.trials.length);
    expect(outcome.outcomeReport.progress.fraction).toBeLessThan(1);
  });

  it("an engine abort mid-plan is reported as capture-lost, with completed data preserved", async () => {
    const clock = new ManualClock();
    const backend = new InMemoryBackend();
    const port = new GoodPlayerPort(clock);
    const definition = makeDefinition();
    port.definition = definition;
    const runner = new SessionRunner(definition, makePorts(clock, backend, port));
    port.beforeTrial = (n) => {
      if (n === 8) {
        runner.abort({
          code: "pointer-lock-lost",
          detail: "Windows took the mouse back between drills",
        });
      }
    };
    const outcome = await runner.run();
    expect(outcome.status).toBe("aborted");
    expect(outcome.abortReason!.code).toBe("pointer-lock-lost");
    expect(outcome.outcomeReport.endKind).toBe("capture-lost");
    expect(outcome.outcomeReport.endReasonText).toContain("Windows took the mouse back");
    expect(outcome.trials.length).toBeGreaterThan(0);
    expect(
      outcome.auditTrail.some((e) => e.category === "session-aborted"),
    ).toBe(true);
  });

  it("a player cancel still carries an explicit reason", async () => {
    const clock = new ManualClock();
    const backend = new InMemoryBackend();
    const port = new GoodPlayerPort(clock);
    const definition = makeDefinition();
    port.definition = definition;
    const runner = new SessionRunner(definition, makePorts(clock, backend, port));
    port.beforeTrial = (n) => {
      if (n === 4) runner.cancel();
    };
    const outcome = await runner.run();
    expect(outcome.status).toBe("aborted");
    expect(outcome.abortReason!.code).toBe("cancelled");
    expect(outcome.outcomeReport.endKind).toBe("ended-by-player");
  });
});

describe("evidence sufficiency is decided on the engine's own floor", () => {
  it("Aldo's session — one block of ten drills — is NOT enough for a recommendation", async () => {
    const clock = new ManualClock();
    const backend = new InMemoryBackend();
    const port = new GoodPlayerPort(clock);
    const definition = makeDefinition();
    port.definition = definition;
    const runner = new SessionRunner(definition, makePorts(clock, backend, port));
    port.beforeTrial = (n) => {
      // Stop after the first candidate block: 1 warm-up + 5 measured.
      if (n === 6) {
        runner.abort({ code: "pointer-lock-lost", detail: "the mouse was lost" });
      }
    };
    const outcome = await runner.run();

    expect(outcome.outcomeReport.recommendationAvailable).toBe(false);
    const s = outcome.outcomeReport.sufficiency;
    expect(s.sufficient).toBe(false);
    expect(s.reasons.join(" ")).toMatch(/candidate/i);
    expect(s.additionalMeasuredTrialsNeeded).toBeGreaterThan(0);
    expect(s.estimatedAdditionalMinutes).toBeGreaterThan(0);
    expect(s.nextSteps.join(" ")).toContain("Continue calibration");
    // And no recommendation was persisted: History must not gain a number the
    // evidence does not support.
    const store = new LocalJsonStore(backend);
    expect(await store.loadRecommendation(definition.id)).toBeNull();
    expect(
      outcome.auditTrail.some((e) => e.category === "evidence-insufficient"),
    ).toBe(true);
  });

  it("a completed plan IS enough, and persists the recommendation", async () => {
    const clock = new ManualClock();
    const backend = new InMemoryBackend();
    const port = new GoodPlayerPort(clock);
    const definition = makeDefinition();
    port.definition = definition;
    const runner = new SessionRunner(definition, makePorts(clock, backend, port));
    const outcome = await runner.run();

    expect(outcome.status).toBe("complete");
    expect(outcome.outcomeReport.sufficiency.sufficient).toBe(true);
    expect(outcome.outcomeReport.recommendationAvailable).toBe(true);
    expect(outcome.recommendation).not.toBeNull();
    const store = new LocalJsonStore(backend);
    expect(await store.loadRecommendation(definition.id)).not.toBeNull();
  });

  it("names exactly which candidates are short, and by how much", () => {
    const definition = makeDefinition();
    const sufficiency = assessEvidenceSufficiency(definition, [], null);
    expect(sufficiency.sufficient).toBe(false);
    expect(sufficiency.reasons[0]).toContain("No measured drill finished");
    expect(sufficiency.additionalMeasuredTrialsNeeded).toBe(
      definition.candidates.length * definition.stoppingCriteria.minValidTrialsPerCandidate,
    );
  });
});

describe("the outcome report always exists", () => {
  it("reports zeroed evidence honestly rather than as measurements of zero", () => {
    const definition = makeDefinition();
    const performance = summarizePerformance([]);
    expect(performance.hitAccuracy).toBeNull();
    expect(performance.reactionTimeMs).toBeNull();
    expect(performance.trackingTimeOnTarget).toBeNull();
    expect(performance.trialsCompleted).toBe(0);

    const report = buildSessionOutcomeReport({
      definition,
      trials: [],
      endKind: "capture-unavailable",
      abortReason: { code: "denied", detail: "the window did not have focus" },
      progress: {
        stepsCompleted: 0,
        stepsPlanned: 60,
        fraction: 0,
        roundIndex: 1,
        roundsPlanned: 2,
        blockIndex: 1,
        blocksPerRound: 5,
        measuredCompleted: 0,
        measuredPlanned: 50,
      },
    });
    expect(report.endedEarly).toBe(true);
    expect(report.endReasonText).toContain("never got control of your mouse");
    expect(report.endReasonText).toContain("The window did not have focus.");
    expect(report.recommendationAvailable).toBe(false);
  });
});

describe("Continue calibration resumes the SAME calibration", () => {
  it("picks up the remaining plan without repeating a completed drill, and reaches a recommendation", async () => {
    const clock = new ManualClock();
    const backend = new InMemoryBackend();
    const definition = makeDefinition();

    // --- first attempt: dies partway through ---
    const first = new GoodPlayerPort(clock);
    first.definition = definition;
    const runnerA = new SessionRunner(definition, makePorts(clock, backend, first));
    first.beforeTrial = (n) => {
      if (n === 14) {
        runnerA.abort({ code: "pointer-lock-lost", detail: "the mouse was lost" });
      }
    };
    const outcomeA = await runnerA.run();
    expect(outcomeA.status).toBe("aborted");
    expect(outcomeA.outcomeReport.recommendationAvailable).toBe(false);
    const completedFirst = outcomeA.trials.length;
    expect(completedFirst).toBeGreaterThan(0);

    // --- Continue calibration ---
    const store = new LocalJsonStore(backend);
    const paths = await store.listByPrefix("sessions/checkpoints");
    expect(paths.length).toBeGreaterThan(0);
    let checkpoint: unknown = null;
    let newest = "";
    for (const path of paths) {
      const loaded = await store.loadRawAt<{ experimentId: string; updatedAtIso: string }>(
        "session-checkpoint",
        path,
      );
      const payload = loaded?.payload;
      if (!payload || payload.experimentId !== String(definition.id)) continue;
      if (payload.updatedAtIso >= newest) {
        newest = payload.updatedAtIso;
        checkpoint = payload;
      }
    }
    expect(checkpoint).not.toBeNull();

    const restored = await store.loadAllTrials(definition.id);
    expect(restored.length).toBe(completedFirst);

    const second = new GoodPlayerPort(clock);
    second.definition = definition;
    const runnerB = SessionRunner.resumeFrom(
      checkpoint,
      definition,
      makePorts(clock, backend, second),
      restored,
    );
    const outcomeB = await runnerB.run();

    expect(outcomeB.status).toBe("complete");
    // Nothing already measured was measured again: the two attempts together
    // execute the plan EXACTLY once.
    const totalPlanned = definition.candidates.length * (1 + 5) * 2;
    expect(first.executed.length + second.executed.length).toBe(totalPlanned);
    expect(second.executed.length).toBe(totalPlanned - first.executed.length);
    expect(outcomeB.trials.length).toBe(totalPlanned);
    expect(outcomeB.trials.length).toBeGreaterThan(completedFirst);
    // The SAME experiment, and the same blinding.
    expect(outcomeB.outcomeReport.experimentId).toBe(String(definition.id));
    // Continuing produced the evidence the first attempt was short of.
    expect(outcomeB.outcomeReport.sufficiency.sufficient).toBe(true);
    expect(outcomeB.outcomeReport.recommendationAvailable).toBe(true);
    expect(await store.loadRecommendation(definition.id)).not.toBeNull();
    expect(
      outcomeB.auditTrail.some((e) => e.category === "session-resumed"),
    ).toBe(true);
  });
});

describe("continuing a plan that is complete but under-powered", () => {
  it("adds one more round rather than replaying nothing", async () => {
    const clock = new ManualClock();
    const backend = new InMemoryBackend();
    // Three reps per candidate: a COMPLETE plan that is still below the
    // engine's floor of four valid measured trials per candidate — exactly
    // the shape that made "Continue calibration" a dead button.
    const definition = makeDefinition({ measuredRepsPerCandidatePerRound: 3, stoppingCriteria: { maxSearchRounds: 1 } });
    const port = new GoodPlayerPort(clock);
    port.definition = definition;
    const runner = new SessionRunner(definition, makePorts(clock, backend, port));
    const outcome = await runner.run();
    expect(outcome.status).toBe("complete");
    expect(outcome.outcomeReport.progress.fraction).toBe(1);
    expect(outcome.outcomeReport.recommendationAvailable).toBe(false);

    const store = new LocalJsonStore(backend);
    const paths = await store.listByPrefix("sessions/checkpoints");
    let checkpoint: ResumeCheckpoint | null = null;
    for (const path of paths) {
      const loaded = await store.loadRawAt<ResumeCheckpoint>("session-checkpoint", path);
      if (loaded?.payload?.experimentId === String(definition.id)) checkpoint = loaded.payload;
    }
    expect(checkpoint).not.toBeNull();

    const continuation = planContinuation(checkpoint!, definition, (round) =>
      planCandidateBlocks(definition, round),
    );
    expect(continuation.remainingSteps).toBe(0);
    expect(continuation.addedRound).toBe(true);
    expect(continuation.definition.stoppingCriteria.maxSearchRounds).toBe(2);
    // The original definition is untouched.
    expect(definition.stoppingCriteria.maxSearchRounds).toBe(1);

    // Continuing actually runs new drills and reaches a recommendation.
    const second = new GoodPlayerPort(clock);
    second.definition = continuation.definition;
    const runnerB = SessionRunner.resumeFrom(
      checkpoint,
      continuation.definition,
      makePorts(clock, backend, second),
      await store.loadAllTrials(definition.id),
    );
    const outcomeB = await runnerB.run();
    expect(second.executed.length).toBeGreaterThan(0);
    expect(outcomeB.outcomeReport.sufficiency.sufficient).toBe(true);
    expect(outcomeB.outcomeReport.recommendationAvailable).toBe(true);
  });

  it("does NOT add a round when steps are still outstanding", async () => {
    const clock = new ManualClock();
    const backend = new InMemoryBackend();
    const definition = makeDefinition();
    const port = new GoodPlayerPort(clock);
    port.definition = definition;
    const runner = new SessionRunner(definition, makePorts(clock, backend, port));
    port.beforeTrial = (n) => {
      if (n === 9) runner.abort({ code: "pointer-lock-lost", detail: "the mouse was lost" });
    };
    await runner.run();
    const store = new LocalJsonStore(backend);
    const paths = await store.listByPrefix("sessions/checkpoints");
    let checkpoint: ResumeCheckpoint | null = null;
    for (const path of paths) {
      const loaded = await store.loadRawAt<ResumeCheckpoint>("session-checkpoint", path);
      if (loaded?.payload?.experimentId === String(definition.id)) checkpoint = loaded.payload;
    }
    const continuation = planContinuation(checkpoint!, definition, (round) =>
      planCandidateBlocks(definition, round),
    );
    expect(continuation.remainingSteps).toBeGreaterThan(0);
    expect(continuation.addedRound).toBe(false);
    expect(continuation.definition).toBe(definition);
  });
});
