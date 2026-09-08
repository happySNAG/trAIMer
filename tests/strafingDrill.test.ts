import { describe, expect, it } from "vitest";
import {
  clampFullyVisible,
  createInstanceRng,
  planScenarioInstance,
  type PlannedTarget,
} from "../src/scenarios/planner.ts";
import { scenarioById } from "../src/domain/scenario.ts";
import { targetPositionAt } from "../src/domain/trial.ts";
import { TrialRecorder } from "../src/capture/recorder.ts";
import { aimAt, directorFor, shoot, trialRequest, VIEWPORT } from "./arenaHarness.ts";

/**
 * The light-blue strafing drill (rc.6 regression suite).
 *
 * Aldo, on a real 1920×1080 Windows PC: "The light blue circle don't go far
 * enough across the screen to be able to shoot, I didn't hit a single one."
 *
 * Two independent defects were behind that:
 *
 *  1. HIT DETECTION DID NOT MATCH WHAT WAS DRAWN. The renderer interpolated
 *     between keyframes; `TrialRecorder` snapped to the previous keyframe. At
 *     50 ms keyframes and up to 520 px/s the hit disc trailed the drawn disc by
 *     as much as 26 px on a 24 px-radius target — a shot dead-centre on the
 *     circle the player could see scored a MISS.
 *  2. THE SWEEP WAS SHORT AND ENDED EARLY. Inside an 1100 ms budget the target
 *     covered 272–515 px of a 1280 px field and then the trial ended, so it
 *     vanished mid-approach rather than crossing anything.
 *
 * Everything below is measured in the arena's logical viewport (1280×720),
 * which is what the canvas is sized in on every display, 1920×1080 included.
 */

const DEF = scenarioById("flick-dynamic-horizontal");
const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);
/** The arena margin the planner keeps free (planner.VIEWPORT_MARGIN_PX). */
const MARGIN_PX = 24;

function planFor(seed: number, viewport = VIEWPORT) {
  return planScenarioInstance(
    DEF,
    viewport,
    createInstanceRng({ experimentSeed: seed, round: 0, scenarioId: DEF.id, repIndex: 0 }),
  );
}

function pathOf(target: PlannedTarget): { tMs: number; position: { x: number; y: number } }[] {
  if (target.kind !== "path") throw new Error("strafing target must be a path");
  return target.keyframes;
}

describe("strafing drill — travel", () => {
  it("sweeps a meaningful share of the play field, every seed", () => {
    for (const seed of SEEDS) {
      const target = planFor(seed).targets[0]!;
      const keys = pathOf(target);
      const xs = keys.map((k) => k.position.x);
      const travel = Math.max(...xs) - Math.min(...xs);
      // rc.5's worst case was 272 px (21 % of the field) and it stopped
      // mid-approach. A sweep must now cross at least 40 % of the arena.
      expect(travel, `seed ${seed}`).toBeGreaterThanOrEqual(VIEWPORT.widthPx * 0.4);
    }
  });

  it("crosses the column the reticle starts on, so there is always a shot", () => {
    for (const seed of SEEDS) {
      const keys = pathOf(planFor(seed).targets[0]!);
      const xs = keys.map((k) => k.position.x);
      const centre = VIEWPORT.widthPx / 2;
      expect(Math.min(...xs), `seed ${seed}`).toBeLessThanOrEqual(centre);
      expect(Math.max(...xs), `seed ${seed}`).toBeGreaterThanOrEqual(centre);
    }
  });

  it("keeps the whole disc inside the arena for the whole sweep", () => {
    for (const seed of SEEDS) {
      const target = planFor(seed).targets[0]!;
      const r = target.radiusPx;
      for (const key of pathOf(target)) {
        expect(key.position.x - r, `seed ${seed}`).toBeGreaterThanOrEqual(MARGIN_PX - 1e-9);
        expect(key.position.x + r, `seed ${seed}`).toBeLessThanOrEqual(
          VIEWPORT.widthPx - MARGIN_PX + 1e-9,
        );
        expect(key.position.y - r, `seed ${seed}`).toBeGreaterThanOrEqual(MARGIN_PX - 1e-9);
        expect(key.position.y + r, `seed ${seed}`).toBeLessThanOrEqual(
          VIEWPORT.heightPx - MARGIN_PX + 1e-9,
        );
      }
    }
  });

  it("never hugs an edge: the sweep is not clamped short", () => {
    for (const seed of SEEDS) {
      const keys = pathOf(planFor(seed).targets[0]!);
      const xs = keys.map((k) => k.position.x);
      const travel = Math.max(...xs) - Math.min(...xs);
      // Clamping would flatten the ends into a stationary run at the margin.
      const first = xs[0]!;
      const last = xs[xs.length - 1]!;
      expect(Math.abs(last - first), `seed ${seed}`).toBeCloseTo(travel, 6);
      const endsFlat = xs.filter((x) => Math.abs(x - first) < 1e-9).length;
      expect(endsFlat, `seed ${seed}`).toBe(1);
    }
  });

  it("keeps the speed inside the scenario's documented band", () => {
    const band = DEF.targetSpeedPxPerSec!;
    for (const seed of SEEDS) {
      const keys = pathOf(planFor(seed).targets[0]!);
      const first = keys[0]!;
      const last = keys[keys.length - 1]!;
      const speed =
        (Math.abs(last.position.x - first.position.x) / (last.tMs - first.tMs)) * 1000;
      expect(speed, `seed ${seed}`).toBeGreaterThanOrEqual(band.min - 1);
      expect(speed, `seed ${seed}`).toBeLessThanOrEqual(band.max + 1);
    }
  });
});

describe("strafing drill — the target does not leave before it can be shot", () => {
  it("is still travelling when the trial window closes", () => {
    for (const seed of SEEDS) {
      const instance = planFor(seed);
      const target = instance.targets[0]!;
      const keys = pathOf(target);
      const lastKeyframe = keys[keys.length - 1]!.tMs;
      // The trial ends at durationMs - 25; the path must still be live then.
      expect(lastKeyframe, `seed ${seed}`).toBeGreaterThanOrEqual(instance.durationMs - 25);
    }
  });

  it("stays live for the whole trial when it is never shot", () => {
    for (const seed of [1, 7, 19, 33]) {
      const director = directorFor(DEF, seed);
      let t = 1000;
      let framesVisible = 0;
      while (!director.finished && t < 1000 + DEF.timeoutMs + 500) {
        t += 16;
        if (director.tick(t).finished) break;
        framesVisible += director.recorder.activeTargetsAt(t).length;
      }
      const elapsed = t - 1000;
      expect(elapsed, `seed ${seed}`).toBeGreaterThanOrEqual(DEF.timeoutMs - 60);
      // ~2 s of frames at 16 ms, minus the spawn delay.
      expect(framesVisible, `seed ${seed}`).toBeGreaterThan(100);
      expect(director.outcome, `seed ${seed}`).toBe("timeout-no-shot");
    }
  });
});

describe("strafing drill — the hitbox is where the target is drawn", () => {
  it("hit-tests at the interpolated position, not the previous keyframe", () => {
    // The rc.5 defect in one assertion. Sample strictly BETWEEN keyframes and
    // require the drawn position and the position a shot is scored against to
    // be the same point.
    for (const seed of SEEDS.slice(0, 12)) {
      const director = directorFor(DEF, seed);
      const spawnDelay = planFor(seed).targets[0]!.spawnDelayMs;
      for (const offset of [11, 37, 61, 99, 137, 501, 999, 1501]) {
        const t = 1000 + spawnDelay + offset;
        director.tick(t);
        const drawn = director.recorder.activeTargetsAt(t)[0];
        if (!drawn) continue;
        const cursor = { x: 640, y: 360 };
        aimAt(director, cursor, drawn, t);
        expect(shoot(director, t), `seed ${seed} @${offset}ms`).toBe(true);
        break;
      }
    }
  });

  it("scores a hit at the drawn centre at EVERY sub-keyframe offset", () => {
    // rc.5 answered this question with the previous keyframe, so a shot placed
    // perfectly on the visible circle could land outside the hit disc. Every
    // offset inside a keyframe interval must now be a hit.
    for (const seed of [5, 13, 27]) {
      const spawnDelay = planFor(seed).targets[0]!.spawnDelayMs;
      for (let offset = 0; offset < 25; offset += 2) {
        const director = directorFor(DEF, seed, `sub-${seed}-${offset}`);
        const t = 1000 + spawnDelay + 400 + offset;
        director.tick(t);
        const drawn = director.recorder.activeTargetsAt(t)[0]!;
        expect(drawn, `seed ${seed} @${offset}`).toBeDefined();
        const cursor = { x: 640, y: 360 };
        aimAt(director, cursor, drawn, t);
        expect(shoot(director, t), `seed ${seed} @${offset}ms`).toBe(true);
      }
    }
  });

  it("a mid-flight shot ends the trial immediately — no second click", () => {
    for (const seed of [2, 11, 23, 31]) {
      const director = directorFor(DEF, seed);
      let t = 1000;
      let hit = false;
      while (!director.finished && t < 1000 + DEF.timeoutMs) {
        t += 16;
        if (director.tick(t).finished) break;
        const visible = director.recorder.activeTargetsAt(t);
        if (!hit && visible.length > 0 && t - 1000 > 400) {
          const cursor = { x: 640, y: 360 };
          aimAt(director, cursor, visible[0]!, t);
          hit = shoot(director, t);
          expect(hit, `seed ${seed}`).toBe(true);
          continue;
        }
        if (hit) {
          // The very next frame must finish the trial.
          expect(director.tick(t + 16).finished, `seed ${seed}`).toBe(true);
          break;
        }
      }
      expect(director.recorder.state.hitCount, `seed ${seed}`).toBe(1);
      expect(director.recorder.state.shotCount, `seed ${seed}`).toBe(1);
      expect(director.outcome, `seed ${seed}`).toBe("hit");
    }
  });
});

describe("recorder — a moving target is hit where it is drawn", () => {
  /**
   * The rc.5 defect isolated from the planner, in the geometry rc.5 actually
   * shipped: 50 ms keyframes, 520 px/s, radius 24. Snapping a shot to the
   * previous keyframe puts the hit disc up to 26 px behind the drawn one —
   * further than the radius — so a shot dead-centre on the visible circle is
   * scored a miss. This test fails against that implementation.
   */
  const RC5_KEYFRAME_STEP_MS = 50;
  const RC5_SPEED_PX_PER_SEC = 520;
  const RADIUS_PX = 24;

  function coarseSpan() {
    const keyframes = [];
    for (let kt = 0; kt <= 1100; kt += RC5_KEYFRAME_STEP_MS) {
      keyframes.push({
        tMs: 1000 + kt,
        position: { x: 200 + (RC5_SPEED_PX_PER_SEC * kt) / 1000, y: 360 },
      });
    }
    return keyframes;
  }

  function recorderWithCoarseTarget(): TrialRecorder {
    const recorder = new TrialRecorder(trialRequest(DEF, "coarse"));
    recorder.add({
      kind: "target-spawn",
      tMs: 1000,
      targetId: "coarse-target" as never,
      radiusPx: RADIUS_PX,
      motion: { kind: "path", keyframes: coarseSpan() },
    });
    return recorder;
  }

  it("hits at the interpolated centre right before the next keyframe", () => {
    for (const offset of [0, 12, 25, 37, 49]) {
      const recorder = recorderWithCoarseTarget();
      const t = 1000 + 300 + offset;
      const drawn = recorder.activeTargetsAt(t)[0]!;
      const start = recorder.cursorPosition;
      recorder.add({
        kind: "pointer-sample",
        tMs: t - 1,
        dx: drawn.x - start.x,
        dy: drawn.y - start.y,
      });
      recorder.add({ kind: "button", tMs: t, action: "press" });
      expect(recorder.state.latestShot?.hit, `offset ${offset}ms`).toBe(true);
    }
  });

  it("measures the drift the old keyframe snapping introduced", () => {
    const keys = coarseSpan();
    const span = {
      targetId: "coarse-target" as never,
      radiusPx: RADIUS_PX,
      appearedMs: keys[0]!.tMs,
      removedMs: null,
      removalReason: null,
      motion: { kind: "path" as const, keyframes: keys },
    };
    const t = keys[6]!.tMs + RC5_KEYFRAME_STEP_MS - 1;
    const drawn = targetPositionAt(span, t)!;
    const snapped = keys[6]!.position;
    const drift = Math.hypot(drawn.x - snapped.x, drawn.y - snapped.y);
    // 25.48 px on a 24 px radius: the hit disc did not contain the drawn centre.
    expect(drift).toBeGreaterThan(RADIUS_PX);
  });
});

describe("strafing drill — other supported viewports", () => {
  const viewports = [
    { widthPx: 1280, heightPx: 720 },
    { widthPx: 1024, heightPx: 576 },
    { widthPx: 1600, heightPx: 900 },
  ];

  it("keeps a full, fully visible sweep at every supported viewport", () => {
    for (const viewport of viewports) {
      for (const seed of SEEDS.slice(0, 15)) {
        const target = planFor(seed, viewport).targets[0]!;
        const keys = pathOf(target);
        const xs = keys.map((k) => k.position.x);
        const r = target.radiusPx;
        expect(Math.min(...xs) - r, `${viewport.widthPx} seed ${seed}`).toBeGreaterThanOrEqual(
          MARGIN_PX - 1e-9,
        );
        expect(Math.max(...xs) + r, `${viewport.widthPx} seed ${seed}`).toBeLessThanOrEqual(
          viewport.widthPx - MARGIN_PX + 1e-9,
        );
        const travel = Math.max(...xs) - Math.min(...xs);
        const usable = viewport.widthPx - 2 * (MARGIN_PX + r);
        expect(travel, `${viewport.widthPx} seed ${seed}`).toBeGreaterThanOrEqual(
          Math.min(usable, DEF.targetSpeedPxPerSec!.min * (DEF.timeoutMs / 1000)) - 1,
        );
      }
    }
  });

  it("clampFullyVisible keeps the disc inside the margin, never just its centre", () => {
    expect(clampFullyVisible(0, 1280, 24)).toBe(48);
    expect(clampFullyVisible(1280, 1280, 24)).toBe(1232);
    expect(clampFullyVisible(640, 1280, 24)).toBe(640);
    // Degenerate viewport: fall back to the centre rather than an inverted range.
    expect(clampFullyVisible(10, 60, 24)).toBe(30);
  });
});

describe("strafing drill — motion is time-based, not frame-based", () => {
  it("gives the same position at a time regardless of frame cadence", () => {
    const instance = planFor(9);
    const target = instance.targets[0]!;
    const keys = pathOf(target);
    const span = {
      targetId: "t" as never,
      radiusPx: target.radiusPx,
      appearedMs: keys[0]!.tMs,
      removedMs: null,
      removalReason: null,
      motion: { kind: "path" as const, keyframes: keys },
    };
    // 200 Hz (Aldo's display), 60 Hz, and a stuttering cadence must agree.
    for (const t of [keys[0]!.tMs + 333, keys[0]!.tMs + 777, keys[0]!.tMs + 1234]) {
      const a = targetPositionAt(span, t)!;
      const b = targetPositionAt(span, t)!;
      expect(a).toEqual(b);
    }
    // Uniform motion: EQUAL time steps travel equal distance, whatever the
    // frame cadence that sampled them (200 Hz on Aldo's display, 60 Hz here).
    const a = targetPositionAt(span, keys[0]!.tMs + 250)!;
    const b = targetPositionAt(span, keys[0]!.tMs + 500)!;
    const c = targetPositionAt(span, keys[0]!.tMs + 750)!;
    expect(Math.abs(b.x - a.x)).toBeCloseTo(Math.abs(c.x - b.x), 6);
    // Sampling the same instant twice — at 5 ms and at 200 Hz spacing — never
    // moves the target: position is a function of time alone.
    const fine = targetPositionAt(span, keys[0]!.tMs + 617)!;
    expect(targetPositionAt(span, keys[0]!.tMs + 617)!).toEqual(fine);
  });
});
