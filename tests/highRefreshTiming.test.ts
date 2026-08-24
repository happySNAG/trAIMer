import { describe, expect, it } from "vitest";
import {
  ScenarioDirector,
  plannedTargetPositionAt,
  createInstanceRng,
  planScenarioInstance,
  scenarioById,
} from "../src/index.ts";

/**
 * High-refresh display readiness (Pass 7, requirement E).
 *
 * The engine must not change speed with the monitor: target spawn timestamps,
 * motion, and trial completion are functions of ELAPSED time only. These
 * tests drive the real ScenarioDirector with frame cadences matching common
 * refresh rates (60/120/144/165/200/240 Hz) and require identical recorded
 * data at every cadence — a trial run on a 60 Hz panel and a 240 Hz panel
 * must produce the same measurement.
 *
 * NOTE: this validates the simulation/timing contract only. It is NOT a
 * claim that any physical high-refresh monitor was tested — that requires
 * Aldo's hardware (see docs/MANUAL-TEST.md).
 */

const VIEWPORT = { widthPx: 1280, heightPx: 720 };

const FRAME_INTERVAL_MS: Record<string, number> = {
  "60 Hz": 1000 / 60,
  "120 Hz": 1000 / 120,
  "144 Hz": 1000 / 144,
  "165 Hz": 1000 / 165,
  "200 Hz": 1000 / 200,
  "240 Hz": 1000 / 240,
};

const SCENARIOS = [
  "flick-static-medium",
  "flick-static-small",
  "flick-dynamic-horizontal",
  "target-switch-triple",
  "tracking-smooth-sine",
] as const;

function makeRequest(scenarioId: string) {
  const def = scenarioById(scenarioId);
  return {
    id: `trial-refresh-${scenarioId}` as never,
    sessionId: null,
    experimentId: null,
    candidateId: null,
    indexInSession: 0,
    phase: "measured" as const,
    scenarioId,
    scenarioKind: def.kind,
    scenarioRepIndex: 0,
    viewport: VIEWPORT,
    sensitivity: { sensX: 7, sensY: 7 },
    dpi: 800,
    expectedSampleIntervalMs: null,
    startedAtMonotonicMs: 0,
    seedTag: "refresh-test",
  };
}

interface CadenceRun {
  /** targetId -> absolute scheduled spawn timestamp (must be EXACTLY equal across cadences) */
  appearTimes: string;
  /** targetId -> absolute removal timestamp (equal within one 60 Hz frame) */
  removeTimes: [string, number][];
  finishedAtElapsedMs: number;
}

/** Runs one director at a fixed frame cadence with no user input. */
function runAtCadence(scenarioId: string, intervalMs: number): CadenceRun {
  const def = scenarioById(scenarioId);
  const instance = planScenarioInstance(
    def,
    VIEWPORT,
    createInstanceRng({ experimentSeed: 4242, round: 0, scenarioId, repIndex: 1 }),
  );
  const director = new ScenarioDirector(makeRequest(scenarioId), instance);
  const t0 = 100_000; // arbitrary monotonic start
  director.start(t0);
  let now = t0;
  for (let frame = 0; frame < 20_000; frame++) {
    now += intervalMs;
    if (director.tick(now).finished) break;
  }
  const record = director.recorder.finish(
    director.outcome ?? "timeout-no-shot",
    now,
  );
  return {
    appearTimes: JSON.stringify(
      record.targets.map((t) => [t.targetId, t.appearedMs]),
    ),
    removeTimes: record.targets.map((t) => [t.targetId, t.removedMs ?? -1]),
    finishedAtElapsedMs: now - t0,
  };
}

describe("high-refresh display readiness (timing is elapsed-time based)", () => {
  for (const scenarioId of SCENARIOS) {
    it(`recorded timeline is identical across 60–240 Hz for ${scenarioId}`, () => {
      const runs = Object.entries(FRAME_INTERVAL_MS).map(([label, ms]) => ({
        label,
        run: runAtCadence(scenarioId, ms),
      }));
      // Spawn timestamps are scheduled absolute times — EXACTLY identical
      // no matter how many frames were shown between events.
      const referenceAppears = runs[0]!.run.appearTimes;
      for (const { label, run } of runs.slice(1)) {
        expect(run.appearTimes, `${scenarioId} @ ${label}`).toBe(referenceAppears);
      }
      // Trial-end expiry lands on the first frame after the deadline, so it
      // may differ by up to one reference frame — never more.
      const referenceRemovals = new Map(runs[0]!.run.removeTimes);
      for (const { label, run } of runs.slice(1)) {
        for (const [targetId, removedMs] of run.removeTimes) {
          const ref = referenceRemovals.get(targetId)!;
          expect(
            Math.abs(removedMs - ref),
            `${scenarioId} @ ${label} removal of ${targetId}`,
          ).toBeLessThanOrEqual(1000 / 60);
        }
      }
      // Wall-clock completion differs by at most one reference frame.
      const finishTimes = runs.map((r) => r.run.finishedAtElapsedMs);
      const spread = Math.max(...finishTimes) - Math.min(...finishTimes);
      expect(spread, "completion spread across refresh rates").toBeLessThanOrEqual(
        1000 / 60,
      );
    });
  }

  it("moving-target positions at matched elapsed times are cadence-independent", () => {
    const def = scenarioById("flick-dynamic-horizontal");
    const instance = planScenarioInstance(
      def,
      VIEWPORT,
      createInstanceRng({ experimentSeed: 777, round: 0, scenarioId: def.id, repIndex: 2 }),
    );
    // Sample the planner's position-at-time function — the exact function
    // every render-loop frame reads — at fixed elapsed times.
    const sampleAt = (tMs: number): string => {
      const pos = plannedTargetPositionAt(instance.targets[0]!, tMs);
      return pos ? `${pos.x.toFixed(4)},${pos.y.toFixed(4)}` : "none";
    };
    const samples = [100, 250, 500, 750, 1000].map(sampleAt);
    expect(instance.targets[0]!.kind).toBe("path");
    expect(samples.every((s) => s !== "none")).toBe(true);
    // Motion progresses over time (not static), and each position is a pure
    // function of elapsed time — no frame count input exists in the API.
    expect(new Set(samples).size).toBe(samples.length);
  });

  it("session wall-clock budget does not depend on refresh rate", () => {
    // A full tracking trial takes the same simulated time regardless of how
    // many frames the display would have shown.
    const durations = Object.values(FRAME_INTERVAL_MS).map((ms) =>
      runAtCadence("tracking-smooth-sine", ms).finishedAtElapsedMs,
    );
    const spread = Math.max(...durations) - Math.min(...durations);
    expect(spread).toBeLessThanOrEqual(1000 / 60);
  });
});
