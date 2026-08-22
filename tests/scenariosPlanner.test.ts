import { describe, expect, it } from "vitest";
import {
  createInstanceRng,
  planScenarioInstance,
  plannedTargetPositionAt,
  scenarioById,
} from "../src/index.ts";

const VIEWPORT = { widthPx: 1280, heightPx: 720 };

describe("scenario instance planner", () => {
  it("is deterministic for identical instance seeds", () => {
    const def = scenarioById("flick-static-medium");
    const a = planScenarioInstance(def, VIEWPORT, createInstanceRng({ experimentSeed: 42, round: 0, scenarioId: def.id, repIndex: 3 }));
    const b = planScenarioInstance(def, VIEWPORT, createInstanceRng({ experimentSeed: 42, round: 0, scenarioId: def.id, repIndex: 3 }));
    expect(a).toEqual(b);
  });

  it("produces identical instances across candidates (paired design)", () => {
    const instances = [0, 1, 2].map(() =>
      planScenarioInstance(
        scenarioById("tracking-smooth-sine"),
        VIEWPORT,
        createInstanceRng({ experimentSeed: 99, round: 1, scenarioId: "tracking-smooth-sine", repIndex: 5 }),
      ),
    );
    for (const instance of instances) {
      expect(instance).toEqual(instances[0]);
    }
  });

  it("varies instances across rep indices", () => {
    const a = planScenarioInstance(scenarioById("flick-static-medium"), VIEWPORT, createInstanceRng({ experimentSeed: 7, round: 0, scenarioId: "flick-static-medium", repIndex: 0 }));
    const b = planScenarioInstance(scenarioById("flick-static-medium"), VIEWPORT, createInstanceRng({ experimentSeed: 7, round: 0, scenarioId: "flick-static-medium", repIndex: 1 }));
    expect(a).not.toEqual(b);
  });

  it("keeps static flick targets inside viewport margins", () => {
    for (let repIndex = 0; repIndex < 50; repIndex++) {
      const instance = planScenarioInstance(
        scenarioById("flick-static-small"),
        VIEWPORT,
        createInstanceRng({ experimentSeed: 1234, round: 0, scenarioId: "flick-static-small", repIndex }),
      );
      const target = instance.targets[0]!;
      if (target.kind !== "static") throw new Error("expected static");
      expect(target.position.x).toBeGreaterThanOrEqual(24);
      expect(target.position.x).toBeLessThanOrEqual(VIEWPORT.widthPx - 24);
      expect(target.position.y).toBeGreaterThanOrEqual(24);
      expect(target.position.y).toBeLessThanOrEqual(VIEWPORT.heightPx - 24);
    }
  });

  it("builds cumulative switch sequences with ordered spawn delays", () => {
    const instance = planScenarioInstance(
      scenarioById("target-switch-triple"),
      VIEWPORT,
      createInstanceRng({ experimentSeed: 5, round: 0, scenarioId: "target-switch-triple", repIndex: 2 }),
    );
    expect(instance.targets.length).toBe(3);
    const delays = instance.targets.map((t) => t.spawnDelayMs);
    expect(delays[1]!).toBeGreaterThan(delays[0]!);
    expect(delays[2]!).toBeGreaterThan(delays[1]!);
  });

  it("produces tracking paths spanning the configured duration", () => {
    const instance = planScenarioInstance(
      scenarioById("tracking-smooth-sine"),
      VIEWPORT,
      createInstanceRng({ experimentSeed: 8, round: 0, scenarioId: "tracking-smooth-sine", repIndex: 1 }),
    );
    const target = instance.targets[0]!;
    if (target.kind !== "path") throw new Error("expected path");
    const last = target.keyframes[target.keyframes.length - 1]!;
    expect(last.tMs).toBe(6000);
    const mid = plannedTargetPositionAt(target, 3000);
    expect(mid).not.toBeNull();
    expect(plannedTargetPositionAt(target, -10)).toBeNull();
  });
});
