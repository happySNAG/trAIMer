import { describe, expect, it } from "vitest";
import { ScenarioDirector } from "../src/scenarios/director.ts";
import { createInstanceRng, planScenarioInstance } from "../src/scenarios/planner.ts";
import { scenarioById } from "../src/domain/scenario.ts";
import type { TrialRecordingRequest } from "../src/capture/recorder.ts";
import type { TargetId } from "../src/domain/ids.ts";

/**
 * Three-target switch drill (Pass 11 regression).
 *
 * On Aldo's PC the "switch sequence" showed all three targets at once and the
 * third could not be completed. Root cause: the director gated the next spawn
 * on the previous removal only AFTER a first removal existed, so with none
 * yet every target spawned on its own schedule (~250 ms in), and all three
 * then competed for one 2400 ms trial budget — the third acquisition was cut
 * off by the trial timeout mid-flick, and nothing told the player why.
 *
 * The drill is now genuinely sequential with a per-target window.
 */

const VIEWPORT = { widthPx: 1280, heightPx: 720 };
const DEF = scenarioById("target-switch-triple");

function request(id: string): TrialRecordingRequest {
  return {
    id: id as never,
    sessionId: null,
    experimentId: null,
    candidateId: null,
    indexInSession: 0,
    phase: "measured",
    scenarioId: DEF.id,
    scenarioKind: DEF.kind,
    scenarioRepIndex: 0,
    viewport: VIEWPORT,
    sensitivity: { sensX: 7, sensY: 7 },
    dpi: 800,
    expectedSampleIntervalMs: null,
    startedAtMonotonicMs: 1000,
  };
}

function directorFor(seed: number, id = `switch-${seed}`): ScenarioDirector {
  const instance = planScenarioInstance(
    DEF,
    VIEWPORT,
    createInstanceRng({ experimentSeed: seed, round: 0, scenarioId: DEF.id, repIndex: 0 }),
  );
  const d = new ScenarioDirector(request(id), instance);
  d.start(1000);
  return d;
}

/** Mirrors BrowserRunController#handleCaptureEvent for a button press. */
function shoot(director: ScenarioDirector, t: number): boolean {
  director.recorder.add({ kind: "button", tMs: t, action: "press" });
  const latest = director.recorder.state.latestShot;
  if (latest?.hit && latest.aimTargetId) {
    director.recorder.add({
      kind: "target-remove",
      tMs: latest.tMs + 1,
      targetId: latest.aimTargetId as TargetId,
      reason: "hit",
    });
    director.observeRemoval(latest.tMs + 1);
    return true;
  }
  return false;
}

/** Moves the recorder cursor onto a target in one sample. */
function aimAt(director: ScenarioDirector, cursor: { x: number; y: number }, target: { x: number; y: number }, t: number): void {
  director.recorder.add({ kind: "pointer-sample", tMs: t, dx: target.x - cursor.x, dy: target.y - cursor.y });
  cursor.x = target.x;
  cursor.y = target.y;
}

/**
 * Drives the director at 16 ms frames. `acquireMs` is how long the player
 * takes from a target appearing to clicking it; null = never shoots.
 */
function play(director: ScenarioDirector, acquireMs: number | null) {
  const cursor = { x: 640, y: 360 };
  let t = 1000;
  let hits = 0;
  let maxVisible = 0;
  const appearances: number[] = [];
  const seen = new Set<string>();
  let dueAt: number | null = null;
  while (!director.finished && t < 20_000) {
    t += 16;
    const status = director.tick(t);
    if (status.finished) break;
    const visible = director.recorder.activeTargetsAt(t);
    maxVisible = Math.max(maxVisible, visible.length);
    for (const v of visible) {
      if (!seen.has(v.id)) {
        seen.add(v.id);
        appearances.push(v.appearedMs - 1000);
        dueAt = acquireMs === null ? null : v.appearedMs + acquireMs;
      }
    }
    if (dueAt !== null && t >= dueAt && visible.length > 0) {
      aimAt(director, cursor, visible[0]!, t);
      if (shoot(director, t + 1)) hits++;
      dueAt = null;
    }
  }
  return { hits, maxVisible, appearances, outcome: director.outcome, state: director.recorder.state, endedAt: t - 1000 };
}

describe("three-target switch drill", () => {
  it("shows ONE target at a time, never three", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const result = play(directorFor(seed), 500);
      expect(result.maxVisible, `seed ${seed}`).toBe(1);
      expect(result.appearances.length, `seed ${seed}`).toBe(3);
    }
  });

  it("a player who acquires each target in 500 ms completes all three (outcome hit)", () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const result = play(directorFor(seed), 500);
      expect(result.hits, `seed ${seed}`).toBe(3);
      expect(result.outcome, `seed ${seed}`).toBe("hit");
      expect(result.state.spawnedTargets.every((t) => t.removalReason === "hit")).toBe(true);
    }
  });

  it("a slower player (900 ms per target) still gets and completes all three", () => {
    // rc.4's single 2400 ms budget made this impossible: 3 × 900 > 2400.
    for (const seed of [1, 2, 3]) {
      const result = play(directorFor(seed), 900);
      expect(result.hits, `seed ${seed}`).toBe(3);
      expect(result.outcome, `seed ${seed}`).toBe("hit");
    }
  });

  it("the next target appears only after the previous one is gone (with the inter-target gap)", () => {
    const director = directorFor(2);
    const result = play(director, 400);
    const spans = director.recorder.state.spawnedTargets;
    for (let i = 1; i < spans.length; i++) {
      const prev = spans[i - 1]!;
      const next = spans[i]!;
      expect(prev.removedMs).not.toBeNull();
      expect(next.appearedMs).toBeGreaterThanOrEqual(prev.removedMs! + 120);
    }
    expect(result.hits).toBe(3);
  });

  it("an ignored target expires within its own window and the sequence continues", () => {
    const director = directorFor(3);
    const result = play(director, null);
    const spans = director.recorder.state.spawnedTargets;
    expect(spans.length).toBe(3);
    for (const span of spans) {
      expect(span.removalReason).toBe("expired");
      expect(span.removedMs! - span.appearedMs).toBe(DEF.perTargetTimeoutMs);
    }
    expect(result.outcome).toBe("timeout-no-shot");
    // The whole sequence, even fully ignored, fits inside the trial ceiling.
    expect(result.endedAt).toBeLessThanOrEqual(DEF.timeoutMs);
  });

  it("missing the middle target does not cost the third one", () => {
    const director = directorFor(4);
    const cursor = { x: 640, y: 360 };
    let t = 1000;
    let hits = 0;
    let index = -1;
    let lastSeen = "";
    let dueAt: number | null = null;
    while (!director.finished && t < 20_000) {
      t += 16;
      if (director.tick(t).finished) break;
      const visible = director.recorder.activeTargetsAt(t);
      if (visible.length === 1 && visible[0]!.id !== lastSeen) {
        lastSeen = visible[0]!.id;
        index++;
        // Ignore the second target entirely; acquire the first and third.
        dueAt = index === 1 ? null : visible[0]!.appearedMs + 450;
      }
      if (dueAt !== null && t >= dueAt && visible.length > 0) {
        aimAt(director, cursor, visible[0]!, t);
        if (shoot(director, t + 1)) hits++;
        dueAt = null;
      }
    }
    const reasons = director.recorder.state.spawnedTargets.map((s) => s.removalReason);
    expect(reasons).toEqual(["hit", "expired", "hit"]);
    expect(hits).toBe(2);
    expect(director.outcome).toBe("miss-shot-fired");
  });

  it("the drill budget covers three full windows plus gaps and spawn delays", () => {
    const perTarget = DEF.perTargetTimeoutMs!;
    const count = DEF.targetsPerTrial!;
    // 90 ms max first spawn delay, 120 ms inter-target gap.
    expect(DEF.timeoutMs).toBeGreaterThanOrEqual(90 + count * perTarget + (count - 1) * 120);
  });
});
