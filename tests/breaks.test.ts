import { describe, expect, it } from "vitest";
import { LOCK_GRANTED } from "../src/capture/browserSource.ts";
import { SessionRunner } from "../src/session/runner.ts";
import type { RestNotice, TrialExecutionPort } from "../src/session/types.ts";
import { buildExperimentDefinition } from "../src/experiments/protocol.ts";
import { makeExperimentId, makeTrialId } from "../src/domain/ids.ts";
import type { TrialRecord } from "../src/domain/trial.ts";
import { LocalJsonStore } from "../src/persistence/store.ts";
import { InMemoryBackend } from "../src/persistence/backends.ts";
import { scenarioById } from "../src/domain/scenario.ts";
import { sanitizeSettings, DEFAULT_SETTINGS } from "../app/src/state.ts";

/**
 * Skippable breaks (Pass 11). Real-hardware feedback: an enforced idle wait
 * between candidate blocks felt intrusive. Breaks still exist and still
 * protect measurement quality, but the player can end one at any moment and
 * can turn the automatic ones off.
 */

/** Manual clock + sleep so a "45 s" rest is a value, not a wait. */
function manualTime() {
  let now = 0;
  const pending: { at: number; resolve: () => void }[] = [];
  return {
    clock: { nowMs: () => now },
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        pending.push({ at: now + ms, resolve });
      }),
    /** Advances time and fires every sleep that has come due. */
    async advance(ms: number): Promise<void> {
      now += ms;
      for (const p of [...pending]) {
        if (p.at <= now) {
          pending.splice(pending.indexOf(p), 1);
          p.resolve();
        }
      }
      // Let continuations run.
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
    get pendingSleeps(): number {
      return pending.length;
    },
  };
}

function stubTrial(id: string, scenarioId: string, startedAt: number): TrialRecord {
  const scenario = scenarioById(scenarioId);
  return {
    id: makeTrialId(id),
    sessionId: "session-breaks" as never,
    experimentId: makeExperimentId("breaks-test"),
    candidateId: null,
    indexInSession: 0,
    phase: "measured",
    scenarioId: scenario.id,
    scenarioKind: scenario.kind,
    captureContext: {
      scenarioKind: scenario.kind,
      viewport: { widthPx: 1280, heightPx: 720 },
      sensitivity: { sensX: 7, sensY: 7 },
      dpi: 800,
      expectedSampleIntervalMs: null,
    },
    scenarioRepIndex: 0,
    startedAtMonotonicMs: startedAt,
    endedAtMonotonicMs: startedAt + 500,
    seedTag: "t",
    outcome: "hit",
    samples: Array.from({ length: 40 }, (_, i) => ({
      tMs: startedAt + i * 8,
      cursor: { x: 640 + i, y: 360 },
      dx: 1,
      dy: 0,
    })),
    targets: [
      {
        targetId: "target-x" as never,
        radiusPx: 24,
        appearedMs: startedAt + 50,
        removedMs: startedAt + 480,
        removalReason: "hit",
        motion: { kind: "static", position: { x: 700, y: 360 } },
      },
    ],
    shots: [{ tMs: startedAt + 470, cursorAtShot: { x: 700, y: 360 }, aimedTargetId: "target-x" as never, hit: true, missDistancePx: 0 }],
    focusInterruptions: [],
    viewportResizes: [],
    validity: { status: "valid", reasons: [] },
    abortedMs: null,
  } as unknown as TrialRecord;
}

function makeRunner(restBetweenCandidatesMs: number) {
  const time = manualTime();
  const rests: (RestNotice | null)[] = [];
  const states: string[] = [];
  const definition = buildExperimentDefinition({
    id: makeExperimentId("breaks-test"),
    name: "breaks",
    baselineSensitivity: { sensX: 7, sensY: 7 },
    dpi: 800,
    orderSeed: 3,
    measuredRepsPerCandidatePerRound: 1,
    warmupTrialsPerCandidateBlock: 0,
    stoppingCriteria: { maxSearchRounds: 1 },
    restBetweenCandidatesMs,
  });
  const execution: TrialExecutionPort = {
    requestLock: async () => LOCK_GRANTED,
    executeTrial: async (spec) => stubTrial(`t-${spec.sequenceNumber}`, spec.scenarioId, time.clock.nowMs()),
    releaseCapture: async () => undefined,
  };
  const runner = new SessionRunner(definition, {
    clock: time.clock,
    sleep: time.sleep,
    nowIso: () => "2026-09-06T00:00:00.000Z",
    store: new LocalJsonStore(new InMemoryBackend()),
    execution,
    onStateChange: (state) => states.push(state),
    onRest: (rest) => rests.push(rest),
  });
  return { runner, time, rests, states, definition };
}

/** Runs the session, advancing manual time in `stepMs` chunks until it finishes. */
async function drive(
  runner: SessionRunner,
  time: ReturnType<typeof manualTime>,
  onTick?: (elapsed: number) => void,
  stepMs = 100,
): Promise<Awaited<ReturnType<SessionRunner["run"]>>> {
  let result: Awaited<ReturnType<SessionRunner["run"]>> | null = null;
  const done = runner.run().then((r) => (result = r));
  let elapsed = 0;
  while (result === null && elapsed < 600_000) {
    await time.advance(stepMs);
    elapsed += stepMs;
    onTick?.(elapsed);
  }
  await done;
  return result!;
}

describe("breaks between candidate blocks", () => {
  it("run to their full length when nobody skips", async () => {
    const { runner, time, rests } = makeRunner(10_000);
    const outcome = await drive(runner, time);
    expect(outcome.status).toBe("complete");
    const started = rests.filter((r) => r !== null);
    // Five candidates ⇒ four transitions.
    expect(started).toHaveLength(4);
    for (const r of started) expect(r).toMatchObject({ durationMs: 10_000, skippable: true });
    const ended = runner.auditEntries().filter((e) => e.category === "rest-ended");
    expect(ended).toHaveLength(4);
    for (const e of ended) expect(e.detail).toMatchObject({ skipped: 0, plannedMs: 10_000 });
    expect(ended.every((e) => Number(e.detail.usedMs) >= 10_000)).toBe(true);
  });

  it("end immediately when skipped, and the audit trail says so", async () => {
    const { runner, time, rests } = makeRunner(30_000);
    const outcome = await drive(runner, time, () => {
      // The instant a rest is reported, the player skips it.
      if (runner.resting) runner.skipRest();
    });
    expect(outcome.status).toBe("complete");
    const ended = runner.auditEntries().filter((e) => e.category === "rest-ended");
    expect(ended).toHaveLength(4);
    for (const e of ended) {
      expect(e.detail.skipped).toBe(1);
      // Skipped within one tick — never waited out the 30 s.
      expect(Number(e.detail.usedMs)).toBeLessThan(1000);
      expect(e.detail.plannedMs).toBe(30_000);
    }
    // The UI is told when each break ends (null) so its countdown stops.
    expect(rests.filter((r) => r === null)).toHaveLength(4);
  });

  it("report `resting` only while a break is in progress", async () => {
    const { runner, time } = makeRunner(5_000);
    let sawResting = false;
    let restingOutsideRestState = false;
    await drive(runner, time, () => {
      if (runner.resting) {
        sawResting = true;
        if (runner.state !== "rest") restingOutsideRestState = true;
      }
    });
    expect(sawResting).toBe(true);
    expect(restingOutsideRestState).toBe(false);
  });

  it("do not exist at all when automatic breaks are off (0 ms)", async () => {
    const { runner, time, rests, states } = makeRunner(0);
    const outcome = await drive(runner, time);
    expect(outcome.status).toBe("complete");
    expect(rests).toHaveLength(0);
    expect(states).not.toContain("rest");
    expect(runner.auditEntries().some((e) => e.category === "rest-started")).toBe(false);
  });

  it("skipRest() outside a break is a harmless no-op", () => {
    const { runner } = makeRunner(5_000);
    expect(() => runner.skipRest()).not.toThrow();
    expect(runner.resting).toBe(false);
  });

  it("ending the session during a break does not wait the break out", async () => {
    const { runner, time } = makeRunner(60_000);
    let cancelledAt: number | null = null;
    const outcome = await drive(runner, time, (elapsed) => {
      if (cancelledAt === null && runner.resting) {
        cancelledAt = elapsed;
        runner.cancel();
      }
    });
    expect(outcome.status).toBe("aborted");
    expect(cancelledAt).not.toBeNull();
    const ended = runner.auditEntries().find((e) => e.category === "rest-ended");
    expect(Number(ended?.detail.usedMs)).toBeLessThan(1000);
  });
});

describe("break settings", () => {
  it("default to automatic 10 s breaks", () => {
    expect(DEFAULT_SETTINGS.autoBreaks).toBe(true);
    expect(DEFAULT_SETTINGS.breakSeconds).toBe(10);
  });

  it("keep breaks ON for settings saved before the option existed", () => {
    const legacy = sanitizeSettings({ playerName: "Aldo", dpi: 800 });
    expect(legacy.autoBreaks).toBe(true);
    expect(legacy.breakSeconds).toBe(10);
  });

  it("honour an explicit off and clamp the length to 5–60 s", () => {
    expect(sanitizeSettings({ autoBreaks: false }).autoBreaks).toBe(false);
    expect(sanitizeSettings({ breakSeconds: 1 }).breakSeconds).toBe(5);
    expect(sanitizeSettings({ breakSeconds: 500 }).breakSeconds).toBe(60);
    expect(sanitizeSettings({ breakSeconds: "x" }).breakSeconds).toBe(10);
  });
});
