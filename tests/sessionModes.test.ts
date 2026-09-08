import { describe, expect, it } from "vitest";
import { SessionRunner } from "../src/session/runner.ts";
import { buildExperimentDefinition } from "../src/experiments/protocol.ts";
import { makeExperimentId, makeTrialId } from "../src/domain/ids.ts";
import { LocalJsonStore } from "../src/persistence/store.ts";
import { InMemoryBackend } from "../src/persistence/backends.ts";
import { scenarioById } from "../src/domain/scenario.ts";
import { equalXy } from "../src/domain/settings.ts";
import { LOCK_GRANTED } from "../src/capture/browserSource.ts";
import {
  CALIBRATION_MODES,
  CALIBRATION_MODE_ORDER,
  DEFAULT_CALIBRATION_MODE,
  assessEvidenceShortfall,
  classifyPlan,
  estimateModePlan,
} from "../src/experiments/sessionModes.ts";
import { V1_RC_PROTOCOL_DEFAULTS, DEFAULT_LADDER_FACTORS } from "../src/experiments/protocol.ts";
import { sanitizeSettings, withCalibrationMode, DEFAULT_SETTINGS } from "../app/src/state.ts";
import type { TrialExecutionPort, SessionRunnerPorts, ReplacementBlockNotice } from "../src/session/types.ts";
import type { TrialPlanSpec } from "../src/experiments/protocol.ts";
import type { TrialRecord } from "../src/domain/trial.ts";
import type { ExperimentDefinition } from "../src/domain/experiment.ts";

/**
 * Calibration length is chosen in EVIDENCE, not in drills (Pass 14).
 *
 * The rc.7 default made a player run 100 drills and then told them 37 were
 * usable. These tests hold three things:
 *
 *  1. every mode's plan is derived from the documented statistical model,
 *  2. the session stops when the evidence target is met, not when a drill
 *     counter runs out — and tops up, within hard bounds, when it is not,
 *  3. no mode can reach a stronger conclusion by running fewer drills.
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

/**
 * A scripted player whose trials can be made unusable on demand, so the
 * replacement path can be driven deterministically.
 */
class ScriptedPort implements TrialExecutionPort {
  definition: ExperimentDefinition | null = null;
  readonly executed: { candidateId: string; phase: string; round: number }[] = [];
  /** Returns true when the trial about to run should come back invalid. */
  invalidate: (n: number, spec: TrialPlanSpec) => boolean = () => false;

  constructor(private readonly clock: ManualClock) {}

  async requestLock() {
    return LOCK_GRANTED;
  }
  async releaseCapture(): Promise<void> {}
  async suspendCapture(): Promise<void> {}
  async resumeCapture() {
    return LOCK_GRANTED;
  }

  get validMeasured(): number {
    return this.executed.filter((e) => e.phase === "measured").length;
  }

  async executeTrial(
    spec: TrialPlanSpec,
    round: number,
    repIndex: number | null,
  ): Promise<TrialRecord> {
    const n = this.executed.length;
    const broken = this.invalidate(n, spec);
    this.executed.push({ candidateId: spec.candidateId, phase: spec.phase, round });
    const scenario = scenarioById(spec.scenarioId);
    const sensitivity =
      this.definition?.candidates.find((c) => c.id === spec.candidateId)?.sensitivity ??
      equalXy(7);
    const startedAt = this.clock.nowMs();
    this.clock.advance(500);
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
          targetId: `target-${round}-${spec.sequenceNumber}` as never,
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
          aimedTargetId: `target-${round}-${spec.sequenceNumber}` as never,
          hit: true,
          missDistancePx: 0,
        },
      ],
      focusInterruptions: [],
      viewportResizes: [],
      outcome: "hit",
      validity: broken
        ? {
            status: "invalid",
            reasons: [
              {
                code: "IMPOSSIBLE_TIMESTAMPS",
                severity: "fatal",
                detail: "scripted: unusable measurement",
              },
            ],
          }
        : { status: "valid", reasons: [] },
      seedTag: null,
      scenarioRepIndex: repIndex,
      abortedMs: null,
    };
  }
}

function makeDefinition(
  modeId: (typeof CALIBRATION_MODE_ORDER)[number],
  overrides: Record<string, unknown> = {},
): ExperimentDefinition {
  const mode = CALIBRATION_MODES[modeId];
  return buildExperimentDefinition({
    id: makeExperimentId(`modes-${Math.random().toString(36).slice(2)}`),
    name: "modes",
    baselineSensitivity: equalXy(7),
    dpi: 800,
    scenarioIds: ["flick-static-medium"],
    measuredRepsPerCandidatePerRound: mode.measuredRepsPerCandidatePerRound,
    warmupTrialsPerCandidateBlock: mode.warmupTrialsPerCandidateBlock,
    orderSeed: 11,
    restBetweenCandidatesMs: 0,
    stoppingCriteria: { maxSearchRounds: mode.rounds },
    adaptiveAllocation: {
      enabled: false,
      minRepsBeforeAdaptive: 8,
      contenderZThreshold: 2,
      controlRefreshEveryRounds: 2,
    },
    ...overrides,
  });
}

function makePorts(
  clock: ManualClock,
  backend: InMemoryBackend,
  execution: TrialExecutionPort,
  notices: ReplacementBlockNotice[] = [],
): SessionRunnerPorts {
  return {
    clock,
    sleep: async (ms: number) => {
      clock.advance(ms);
      await Promise.resolve();
    },
    nowIso: () => new Date(2026, 8, 7).toISOString(),
    store: new LocalJsonStore(backend),
    execution,
    onReplacementBlock: (n) => notices.push(n),
  };
}

async function runMode(
  modeId: (typeof CALIBRATION_MODE_ORDER)[number],
  invalidate: ScriptedPort["invalidate"] = () => false,
): Promise<{
  runner: SessionRunner;
  port: ScriptedPort;
  notices: ReplacementBlockNotice[];
  outcome: Awaited<ReturnType<SessionRunner["run"]>>;
}> {
  const clock = new ManualClock();
  const port = new ScriptedPort(clock);
  port.invalidate = invalidate;
  const definition = makeDefinition(modeId);
  port.definition = definition;
  const notices: ReplacementBlockNotice[] = [];
  const mode = CALIBRATION_MODES[modeId];
  const runner = new SessionRunner(
    definition,
    makePorts(clock, new InMemoryBackend(), port, notices),
    {
      evidenceTarget: {
        modeId,
        targetValidTrialsPerCandidate: mode.targetValidTrialsPerCandidate,
        maxReplacementBlocks: mode.maxReplacementBlocks,
      },
    },
  );
  const outcome = await runner.run();
  return { runner, port, notices, outcome };
}

// ---------------------------------------------------------------------------

describe("mode plans come from the documented statistical model", () => {
  const CANDIDATES = DEFAULT_LADDER_FACTORS.length;

  it("Quick sits one rep above the optimizer's own floor", () => {
    const floor = V1_RC_PROTOCOL_DEFAULTS.minValidTrialsPerCandidate.value;
    expect(CALIBRATION_MODES.quick.targetValidTrialsPerCandidate).toBe(floor);
    expect(CALIBRATION_MODES.quick.measuredRepsPerCandidatePerRound).toBe(floor + 1);
    expect(CALIBRATION_MODES.quick.rounds).toBe(1);
    const plan = estimateModePlan(CALIBRATION_MODES.quick, { candidateCount: CANDIDATES });
    expect(plan.totalDrills).toBe(30);
    expect(plan.measuredDrills).toBe(25);
  });

  it("Standard is one full documented round", () => {
    const productive = V1_RC_PROTOCOL_DEFAULTS.measuredRepsPerCandidatePerRound.value;
    expect(CALIBRATION_MODES.standard.measuredRepsPerCandidatePerRound).toBe(productive);
    expect(CALIBRATION_MODES.standard.rounds).toBe(1);
    const plan = estimateModePlan(CALIBRATION_MODES.standard, { candidateCount: CANDIDATES });
    expect(plan.totalDrills).toBe(50);
    expect(plan.measuredDrills).toBe(40);
  });

  it("Precision is the rc.7 plan, unchanged", () => {
    const plan = estimateModePlan(CALIBRATION_MODES.precision, { candidateCount: CANDIDATES });
    expect(plan.totalDrills).toBe(100);
    expect(plan.measuredDrills).toBe(80);
    expect(CALIBRATION_MODES.precision.rounds).toBe(2);
  });

  it("Standard is the default, and evidence targets increase with length", () => {
    expect(DEFAULT_CALIBRATION_MODE).toBe("standard");
    const targets = CALIBRATION_MODE_ORDER.map(
      (id) => CALIBRATION_MODES[id].targetValidTrialsPerCandidate,
    );
    expect(targets).toEqual([...targets].sort((a, b) => a - b));
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("every mode reaches the optimizer's floor, and none claims more than its evidence", () => {
    const floor = V1_RC_PROTOCOL_DEFAULTS.minValidTrialsPerCandidate.value;
    for (const id of CALIBRATION_MODE_ORDER) {
      const mode = CALIBRATION_MODES[id];
      expect(mode.targetValidTrialsPerCandidate).toBeGreaterThanOrEqual(floor);
      // The plan must be able to REACH its own target without replacements.
      expect(
        mode.measuredRepsPerCandidatePerRound * mode.rounds,
      ).toBeGreaterThanOrEqual(mode.targetValidTrialsPerCandidate);
    }
    // No mode promises a confidence percentage in advance.
    for (const id of CALIBRATION_MODE_ORDER) {
      expect(CALIBRATION_MODES[id].claim).not.toMatch(/\d+\s*%/);
    }
  });

  it("estimates a duration and never reports zero minutes", () => {
    for (const id of CALIBRATION_MODE_ORDER) {
      const plan = estimateModePlan(CALIBRATION_MODES[id], {
        candidateCount: CANDIDATES,
        restBetweenCandidatesMs: 10_000,
      });
      expect(plan.estimatedMinutes).toBeGreaterThan(0);
      expect(plan.estimatedMinutesRange.min).toBeLessThanOrEqual(plan.estimatedMinutes);
    }
  });

  it("classifies a plan back to the mode that produced it", () => {
    for (const id of CALIBRATION_MODE_ORDER) {
      const mode = CALIBRATION_MODES[id];
      expect(
        classifyPlan({
          rounds: mode.rounds,
          measuredRepsPerCandidatePerRound: mode.measuredRepsPerCandidatePerRound,
          warmupTrialsPerCandidateBlock: mode.warmupTrialsPerCandidateBlock,
        }),
      ).toBe(id);
    }
    expect(
      classifyPlan({
        rounds: 3,
        measuredRepsPerCandidatePerRound: 7,
        warmupTrialsPerCandidateBlock: 2,
      }),
    ).toBe("custom");
  });
});

describe("mode selection persists and never contradicts the plan", () => {
  it("remembers the selected mode across a save/load round trip", () => {
    for (const id of CALIBRATION_MODE_ORDER) {
      const saved = withCalibrationMode(DEFAULT_SETTINGS, id);
      const loaded = sanitizeSettings(JSON.parse(JSON.stringify(saved)));
      expect(loaded.calibrationMode).toBe(id);
      expect(loaded.rounds).toBe(CALIBRATION_MODES[id].rounds);
      expect(loaded.repsPerCandidate).toBe(
        CALIBRATION_MODES[id].measuredRepsPerCandidatePerRound,
      );
      expect(loaded.warmupTrials).toBe(
        CALIBRATION_MODES[id].warmupTrialsPerCandidateBlock,
      );
    }
  });

  it("a stored blob whose label disagrees with its plan is renamed, not obeyed", () => {
    // The dangerous case: a Quick session's plan carrying a "precision" label
    // would tell the player they ran the full search.
    const lying = {
      ...withCalibrationMode(DEFAULT_SETTINGS, "quick"),
      calibrationMode: "precision",
    };
    const loaded = sanitizeSettings(lying);
    expect(loaded.calibrationMode).toBe("quick");
    expect(loaded.rounds).toBe(CALIBRATION_MODES.quick.rounds);
  });

  it("settings from before modes existed are classified from their plan", () => {
    const legacy = {
      playerName: "Aldo",
      dpi: 800,
      sensX: 7,
      sensY: 7,
      experimentSeed: 1,
      rounds: 2,
      repsPerCandidate: 8,
      warmupTrials: 2,
      yExploration: false,
      autoBreaks: true,
      breakSeconds: 10,
    };
    expect(sanitizeSettings(legacy).calibrationMode).toBe("precision");
  });

  it("an advanced-form plan that matches no mode is custom, and keeps its numbers", () => {
    const custom = sanitizeSettings({
      ...DEFAULT_SETTINGS,
      rounds: 3,
      repsPerCandidate: 11,
      warmupTrials: 1,
    });
    expect(custom.calibrationMode).toBe("custom");
    expect(custom.rounds).toBe(3);
    expect(custom.repsPerCandidate).toBe(11);
    expect(custom.warmupTrials).toBe(1);
  });
});

describe("the session plan matches the selected mode", () => {
  it("Quick runs 30 drills, Standard 50, Precision 100", async () => {
    const expected: Record<string, number> = { quick: 30, standard: 50, precision: 100 };
    for (const id of CALIBRATION_MODE_ORDER) {
      const { port } = await runMode(id);
      expect(port.executed.length, id).toBe(expected[id]);
    }
  }, 60_000);

  it("every candidate is represented in every mode", async () => {
    for (const id of CALIBRATION_MODE_ORDER) {
      const { port } = await runMode(id);
      const byCandidate = new Set(port.executed.map((e) => e.candidateId));
      expect(byCandidate.size, id).toBe(DEFAULT_LADDER_FACTORS.length);
    }
  }, 60_000);
});

describe("completion is decided by evidence, not by a drill counter", () => {
  it("a clean session adds nothing", async () => {
    const { runner, notices } = await runMode("standard");
    expect(notices).toHaveLength(0);
    expect(runner.replacementSummary.blocksRun).toBe(0);
    expect(runner.replacementSummary.drillsRun).toBe(0);
  }, 30_000);

  it("a few lost measurements are replaced, and only a few", async () => {
    // Break three measured drills; the session should ask for exactly the
    // drills that puts each candidate back on target, and no more.
    let broken = 0;
    const { runner, notices, outcome } = await runMode("standard", (_n, spec) => {
      if (spec.phase !== "measured") return false;
      if (broken >= 3) return false;
      broken++;
      return true;
    });
    expect(notices.length).toBeGreaterThan(0);
    expect(runner.replacementSummary.drillsRun).toBeGreaterThan(0);
    expect(runner.replacementSummary.drillsRun).toBeLessThanOrEqual(
      runner.replacementSummary.maxDrills,
    );
    // The notice is in the player's units.
    expect(notices[0]!.reason).toMatch(/additional drill/);
    expect(notices[0]!.drills).toBeGreaterThan(0);
    // And the mode's evidence target is actually met afterwards.
    const shortfall = assessEvidenceShortfall(
      makeDefinitionFrom(outcome),
      outcome.trials,
      CALIBRATION_MODES.standard.targetValidTrialsPerCandidate,
    );
    expect(shortfall.satisfied).toBe(true);
  }, 60_000);

  it("cannot loop forever when nothing the player does produces usable data", async () => {
    // Every measured drill comes back unusable. The session must stop after
    // one replacement block that proved no progress — never keep asking.
    const { runner, notices } = await runMode("quick", (_n, spec) => spec.phase === "measured");
    expect(runner.replacementSummary.blocksRun).toBeLessThanOrEqual(
      CALIBRATION_MODES.quick.maxReplacementBlocks,
    );
    expect(notices.length).toBeLessThanOrEqual(
      CALIBRATION_MODES.quick.maxReplacementBlocks,
    );
    // Progress rule: a block that gained nothing ends the phase immediately.
    expect(runner.replacementSummary.blocksRun).toBe(1);
  }, 60_000);

  it("replacement work is capped at half the plan the player agreed to", async () => {
    const { runner } = await runMode("quick", (_n, spec) => spec.phase === "measured");
    const cap = runner.replacementSummary.maxDrills;
    expect(cap).toBe(Math.ceil((DEFAULT_LADDER_FACTORS.length * 5 * 1) / 2));
    expect(runner.replacementSummary.drillsRun).toBeLessThanOrEqual(cap);
  }, 60_000);

  it("a custom plan is never extended — nothing named it, so nothing may grow it", async () => {
    const clock = new ManualClock();
    const port = new ScriptedPort(clock);
    port.invalidate = (_n, spec) => spec.phase === "measured";
    const definition = buildExperimentDefinition({
      id: makeExperimentId("custom-plan"),
      name: "custom",
      baselineSensitivity: equalXy(7),
      dpi: 800,
      scenarioIds: ["flick-static-medium"],
      measuredRepsPerCandidatePerRound: 11,
      warmupTrialsPerCandidateBlock: 1,
      orderSeed: 3,
      restBetweenCandidatesMs: 0,
      stoppingCriteria: { maxSearchRounds: 1 },
      adaptiveAllocation: { enabled: false, minRepsBeforeAdaptive: 8, contenderZThreshold: 2, controlRefreshEveryRounds: 2 },
    });
    port.definition = definition;
    const notices: ReplacementBlockNotice[] = [];
    const runner = new SessionRunner(
      definition,
      makePorts(clock, new InMemoryBackend(), port, notices),
    );
    await runner.run();
    expect(notices).toHaveLength(0);
    expect(runner.replacementSummary.blocksRun).toBe(0);
  }, 30_000);
});

describe("the evidence shortfall is computed per candidate", () => {
  it("counts only valid measured drills, per candidate", () => {
    const definition = makeDefinition("quick");
    const trials = definition.candidates.flatMap((c, i) =>
      Array.from({ length: 5 }, (_, r) => ({
        phase: "measured",
        candidateId: c.id,
        validity: { status: r < i ? "invalid" : "valid" },
      })),
    );
    const shortfall = assessEvidenceShortfall(definition, trials, 4);
    expect(shortfall.validByCandidate.get(definition.candidates[0]!.id)).toBe(5);
    expect(shortfall.validByCandidate.get(definition.candidates[4]!.id)).toBe(1);
    expect(shortfall.deficits.get(definition.candidates[4]!.id)).toBe(3);
    expect(shortfall.satisfied).toBe(false);
    expect(shortfall.belowFloor).toContain(definition.candidates[4]!.id);
  });

  it("is satisfied when every candidate is on target", () => {
    const definition = makeDefinition("quick");
    const trials = definition.candidates.flatMap((c) =>
      Array.from({ length: 4 }, () => ({
        phase: "measured",
        candidateId: c.id,
        validity: { status: "valid" },
      })),
    );
    expect(assessEvidenceShortfall(definition, trials, 4).satisfied).toBe(true);
  });

  it("ignores warm-ups entirely", () => {
    const definition = makeDefinition("quick");
    const trials = definition.candidates.flatMap((c) =>
      Array.from({ length: 9 }, () => ({
        phase: "warmup",
        candidateId: c.id,
        validity: { status: "valid" },
      })),
    );
    const shortfall = assessEvidenceShortfall(definition, trials, 4);
    expect(shortfall.satisfied).toBe(false);
    expect(shortfall.totalDeficit).toBe(4 * definition.candidates.length);
  });
});

function makeDefinitionFrom(
  outcome: Awaited<ReturnType<SessionRunner["run"]>>,
): ExperimentDefinition {
  // The runner does not hand its definition back; rebuild the shape the
  // shortfall check needs from the trials themselves.
  const candidateIds = [
    ...new Set(outcome.trials.map((t) => t.candidateId).filter((id): id is NonNullable<typeof id> => id !== null)),
  ];
  return {
    candidates: candidateIds.map((id) => ({ id, sensitivity: equalXy(7) })),
    stoppingCriteria: { minValidTrialsPerCandidate: 4 },
    dpi: 800,
  } as unknown as ExperimentDefinition;
}
