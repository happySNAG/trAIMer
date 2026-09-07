import { describe, expect, it } from "vitest";
import { scenarioById } from "../src/domain/scenario.ts";
import { TrialRecorder } from "../src/capture/recorder.ts";
import { aimAt, directorFor, shoot, trialRequest } from "./arenaHarness.ts";

/**
 * "The pink one that moves fast, after you hit it once, you have to click
 * again to get it to go to the next screen." — Aldo, rc.5 on real hardware.
 *
 * The pink target is the TRACKING drill (`tracking-smooth-sine`, #ff6fd8): a
 * six-second Lissajous sweep the player is asked to keep the crosshair on, not
 * to shoot. rc.5's shot path removed whatever target a click landed on,
 * whatever drill it belonged to. Clicking the pink target therefore deleted it
 * and left an EMPTY arena for the rest of the six-second window — no target,
 * no feedback, nothing to do, and no way to make it end sooner. The drill was
 * running out a timer against a target that no longer existed (which also
 * destroyed that trial's tracking measurement); to the player it looked like
 * the hit had registered and the screen was waiting for another input.
 *
 * The rules pinned here:
 *   - a click never removes a tracking target, and never gates its completion;
 *   - in the click-to-hit drills one successful shot is one hit, removes the
 *     target once, and finishes the trial on the very next frame with no
 *     further input;
 *   - no shot can score twice on the same target, however fast the clicks;
 *   - a miss never advances anything.
 */

const TRACKING = scenarioById("tracking-smooth-sine");
const STATIC = scenarioById("flick-static-medium");
const DYNAMIC = scenarioById("flick-dynamic-horizontal");
const SWITCH = scenarioById("target-switch-triple");

describe("tracking drill (the fast pink target)", () => {
  it("keeps the target on screen after a hit — the arena never goes blank", () => {
    const director = directorFor(TRACKING, 3);
    let t = 1000;
    let shotAt: number | null = null;
    let blankFrames = 0;
    while (!director.finished && t < 1000 + TRACKING.timeoutMs + 500) {
      t += 16;
      if (director.tick(t).finished) break;
      const visible = director.recorder.activeTargetsAt(t);
      if (shotAt === null && t - 1000 > 800 && visible.length > 0) {
        const cursor = { x: 640, y: 360 };
        aimAt(director, cursor, visible[0]!, t);
        expect(shoot(director, t)).toBe(true);
        shotAt = t;
        continue;
      }
      if (shotAt !== null && visible.length === 0) blankFrames++;
    }
    expect(shotAt).not.toBeNull();
    expect(blankFrames).toBe(0);
    expect(director.recorder.state.spawnedTargets[0]!.removedMs).toBeNull();
  });

  it("records exactly one hit for one shot and never removes the target", () => {
    const director = directorFor(TRACKING, 8);
    director.tick(1500);
    const visible = director.recorder.activeTargetsAt(1500);
    const cursor = { x: 640, y: 360 };
    aimAt(director, cursor, visible[0]!, 1500);
    expect(shoot(director, 1501)).toBe(true);
    const state = director.recorder.state;
    expect(state.shotCount).toBe(1);
    expect(state.hitCount).toBe(1);
    expect(state.spawnedTargets[0]!.removalReason).toBeNull();
    expect(director.removesTargetOnHit).toBe(false);
  });

  it("finishes on its own clock with NO further input after the hit", () => {
    const director = directorFor(TRACKING, 8);
    director.tick(1500);
    const visible = director.recorder.activeTargetsAt(1500);
    const cursor = { x: 640, y: 360 };
    aimAt(director, cursor, visible[0]!, 1500);
    shoot(director, 1501);
    // Not finished yet — but nothing the player does is needed from here.
    expect(director.tick(1600).finished).toBe(false);
    expect(director.tick(1000 + TRACKING.timeoutMs - 30).finished).toBe(false);
    expect(director.tick(1000 + TRACKING.timeoutMs).finished).toBe(true);
    expect(director.recorder.state.shotCount).toBe(1);
    expect(director.outcome).toBe("tracking-complete");
  });

  it("exposes the drill's own window so the arena can show it running", () => {
    const director = directorFor(TRACKING, 8);
    expect(director.durationMs).toBe(TRACKING.timeoutMs);
    expect(director.startedAtMonotonicMs).toBe(1000);
  });
});

describe("click-to-hit drills advance on ONE successful shot", () => {
  const cases = [
    { def: STATIC, label: "static flick" },
    { def: DYNAMIC, label: "strafing" },
  ];

  for (const { def, label } of cases) {
    it(`${label}: one shot → one hit → finished on the next frame`, () => {
      const director = directorFor(def, 4, `one-shot-${def.id}`);
      let t = 1000;
      let hit = false;
      while (!hit && t < 1000 + def.timeoutMs) {
        t += 16;
        director.tick(t);
        const visible = director.recorder.activeTargetsAt(t);
        if (visible.length === 0) continue;
        const cursor = { x: 640, y: 360 };
        aimAt(director, cursor, visible[0]!, t);
        hit = shoot(director, t);
      }
      expect(hit).toBe(true);
      expect(director.removesTargetOnHit).toBe(true);
      // No extra click, no extra frame budget: the very next tick is done.
      expect(director.tick(t + 16).finished).toBe(true);
      const state = director.recorder.state;
      expect(state.shotCount).toBe(1);
      expect(state.hitCount).toBe(1);
      expect(state.spawnedTargets.filter((s) => s.removalReason === "hit")).toHaveLength(1);
      expect(director.outcome).toBe("hit");
    });
  }

  it("switch sequence: the third hit finishes the trial with no extra click", () => {
    const director = directorFor(SWITCH, 6, "switch-advance");
    const cursor = { x: 640, y: 360 };
    let t = 1000;
    let hits = 0;
    while (!director.finished && t < 1000 + SWITCH.timeoutMs) {
      t += 16;
      if (director.tick(t).finished) break;
      const visible = director.recorder.activeTargetsAt(t);
      if (visible.length === 0) continue;
      aimAt(director, cursor, visible[0]!, t);
      if (shoot(director, t)) hits++;
    }
    expect(hits).toBe(3);
    expect(director.recorder.state.shotCount).toBe(3);
    expect(director.tick(t + 16).finished).toBe(true);
    expect(director.outcome).toBe("hit");
  });
});

describe("no double-scoring and no double-transition", () => {
  it("a second click in the SAME millisecond cannot hit the same target twice", () => {
    const director = directorFor(STATIC, 12, "double-same-ms");
    let t = 1000;
    while (director.recorder.activeTargetsAt(t).length === 0 && t < 1600) {
      t += 16;
      director.tick(t);
    }
    const visible = director.recorder.activeTargetsAt(t)[0]!;
    const cursor = { x: 640, y: 360 };
    aimAt(director, cursor, visible, t);
    expect(shoot(director, t)).toBe(true);
    // The removal is recorded at t + 1; a second press stamped at the same
    // millisecond used to slip past the "removed before now" check.
    expect(shoot(director, t)).toBe(false);
    const state = director.recorder.state;
    expect(state.shotCount).toBe(2);
    expect(state.hitCount).toBe(1);
    expect(state.spawnedTargets.filter((s) => s.removalReason === "hit")).toHaveLength(1);
  });

  it("a burst of rapid clicks scores one hit and finishes once", () => {
    const director = directorFor(STATIC, 21, "burst");
    let t = 1000;
    while (director.recorder.activeTargetsAt(t).length === 0 && t < 1600) {
      t += 16;
      director.tick(t);
    }
    const cursor = { x: 640, y: 360 };
    aimAt(director, cursor, director.recorder.activeTargetsAt(t)[0]!, t);
    let removals = 0;
    for (const stamp of [t, t, t + 1, t + 2, t + 3]) {
      if (shoot(director, stamp)) removals++;
    }
    expect(removals).toBe(1);
    expect(director.recorder.state.hitCount).toBe(1);
    // The director finishes once and stays finished.
    expect(director.tick(t + 32).finished).toBe(true);
    expect(director.tick(t + 48).finished).toBe(true);
    expect(director.recorder.state.spawnedTargets.filter((s) => s.removalReason === "hit"))
      .toHaveLength(1);
  });

  it("an expired target cannot be hit by a late click", () => {
    const recorder = new TrialRecorder(trialRequest(SWITCH, "expired"));
    recorder.add({
      kind: "target-spawn",
      tMs: 1000,
      targetId: "gone" as never,
      radiusPx: 24,
      motion: { kind: "static", position: { x: 640, y: 360 } },
    });
    recorder.add({
      kind: "target-remove",
      tMs: 2100,
      targetId: "gone" as never,
      reason: "expired",
    });
    recorder.add({ kind: "button", tMs: 2100, action: "press" });
    expect(recorder.state.latestShot?.hit).toBe(false);
    recorder.add({ kind: "button", tMs: 2200, action: "press" });
    expect(recorder.state.hitCount).toBe(0);
  });
});

describe("misses never advance anything", () => {
  it("a miss leaves the flick trial running to its own timeout", () => {
    const director = directorFor(STATIC, 15, "miss");
    let t = 1000;
    while (director.recorder.activeTargetsAt(t).length === 0 && t < 1600) {
      t += 16;
      director.tick(t);
    }
    const target = director.recorder.activeTargetsAt(t)[0]!;
    const cursor = { x: 640, y: 360 };
    // Deliberately 200 px wide of the target.
    aimAt(director, cursor, { x: target.x + 200, y: target.y }, t);
    expect(shoot(director, t)).toBe(false);
    expect(director.tick(t + 16).finished).toBe(false);
    expect(director.recorder.state.hitCount).toBe(0);
    // It ends when its window ends, not because a click happened.
    expect(director.tick(1000 + STATIC.timeoutMs).finished).toBe(true);
    expect(director.outcome).toBe("miss-shot-fired");
  });

  it("a miss on the tracking drill changes nothing at all", () => {
    const director = directorFor(TRACKING, 30, "tracking-miss");
    director.tick(1500);
    const target = director.recorder.activeTargetsAt(1500)[0]!;
    const cursor = { x: 640, y: 360 };
    aimAt(director, cursor, { x: target.x + 400, y: target.y }, 1500);
    expect(shoot(director, 1501)).toBe(false);
    expect(director.tick(1600).finished).toBe(false);
    expect(director.recorder.state.spawnedTargets[0]!.removedMs).toBeNull();
  });
});
