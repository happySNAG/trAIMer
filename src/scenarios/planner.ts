import type { TargetKeyframe } from "../domain/trial.ts";
import type { ScenarioDefinition } from "../domain/scenario.ts";
import type { Vec2 } from "../domain/geometry.ts";
import { Rng } from "../util/rng.ts";

export interface ViewportSize {
  widthPx: number;
  heightPx: number;
}

const VIEWPORT_MARGIN_PX = 24;
const DYNAMIC_KEYFRAME_STEP_MS = 25;

export interface ScenarioInstanceSeed {
  experimentSeed: number;
  round: number;
  scenarioId: string;
  repIndex: number;
}

export function createInstanceRng(seed: ScenarioInstanceSeed): Rng {
  return new Rng(
    combineSeeds(
      seed.experimentSeed,
      seed.round,
      hashString(seed.scenarioId),
      seed.repIndex,
    ),
  );
}

export function combineSeeds(...parts: readonly number[]): number {
  let h = 2166136261 >>> 0;
  for (const part of parts) {
    const v = Math.floor(part) >>> 0;
    h ^= v + 0x9e3779b9 + (h << 6) + (h >>> 2);
    h >>>= 0;
  }
  return h >>> 0;
}

export function hashString(value: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export type PlannedTarget =
  | {
      kind: "static";
      spawnDelayMs: number;
      position: Vec2;
      radiusPx: number;
    }
  | {
      kind: "path";
      spawnDelayMs: number;
      keyframes: TargetKeyframe[];
      radiusPx: number;
    };

export interface PlannedScenarioInstance {
  scenarioId: string;
  kind: ScenarioDefinition["kind"];
  targets: PlannedTarget[];
  durationMs: number;
  /** Sequential scenarios only: each target's own window before it expires. */
  perTargetTimeoutMs?: number;
}

export function clampToViewport(v: number, max: number): number {
  return Math.min(max - VIEWPORT_MARGIN_PX, Math.max(VIEWPORT_MARGIN_PX, v));
}

/**
 * Clamps a target CENTRE so the whole disc stays inside the playable margin.
 * `clampToViewport` only keeps the centre in bounds, which lets a target sit
 * with half of itself outside the arena — unshootable, and impossible to read.
 */
export function clampFullyVisible(
  v: number,
  max: number,
  radiusPx: number,
): number {
  const lo = VIEWPORT_MARGIN_PX + radiusPx;
  const hi = max - VIEWPORT_MARGIN_PX - radiusPx;
  if (hi <= lo) return max / 2;
  return Math.min(hi, Math.max(lo, v));
}

function centerOf(viewport: ViewportSize): Vec2 {
  return { x: viewport.widthPx / 2, y: viewport.heightPx / 2 };
}

function pickAngle(def: ScenarioDefinition, rng: Rng, index: number): number {
  if (def.angleMode === "horizontal-biased") {
    const side = rng.bernoulli(0.5) ? 1 : -1;
    const jitter = rng.range(-0.35, 0.35);
    return side * jitter + (rng.bernoulli(0.5) ? Math.PI : 0);
  }
  if (def.kind === "target-switch") {
    return (index * 2.1 + rng.range(-0.6, 0.6)) % (2 * Math.PI);
  }
  return rng.range(-Math.PI, Math.PI);
}

export function planScenarioInstance(
  def: ScenarioDefinition,
  viewport: ViewportSize,
  rng: Rng,
): PlannedScenarioInstance {
  switch (def.kind) {
    case "flick-static":
      return planStaticFlickInstance(def, viewport, rng);
    case "flick-dynamic":
      return planDynamicFlickInstance(def, viewport, rng);
    case "target-switch":
      return planTargetSwitchInstance(def, viewport, rng);
    case "tracking":
      return planTrackingInstance(def, viewport, rng);
  }
}

function spawnDelay(rng: Rng): number {
  return rng.range(30, 90);
}

function planStaticFlickInstance(
  def: ScenarioDefinition,
  viewport: ViewportSize,
  rng: Rng,
): PlannedScenarioInstance {
  const center = centerOf(viewport);
  const distance = rng.range(def.distanceRangePx.min, def.distanceRangePx.max);
  const angle = pickAngle(def, rng, 0);
  const position = {
    x: clampToViewport(center.x + Math.cos(angle) * distance, viewport.widthPx),
    y: clampToViewport(center.y + Math.sin(angle) * distance, viewport.heightPx),
  };
  return {
    scenarioId: def.id,
    kind: def.kind,
    targets: [
      { kind: "static", spawnDelayMs: spawnDelay(rng), position, radiusPx: def.targetRadiusPx },
    ],
    durationMs: def.timeoutMs,
  };
}

/**
 * The strafing drill: ONE horizontal sweep across the middle of the arena.
 *
 * rc.5 built this as "start at a random offset from the centre, drift toward
 * the centre for the trial's 1100 ms budget". Aldo hit none of them, and the
 * geometry says why:
 *
 *  - the sweep covered only 272–515 px of a 1280 px field and then the trial
 *    ended — the target vanished mid-approach rather than crossing anything;
 *  - the whole opportunity lasted ~1.03 s including reaction time, for a
 *    target that had to be led.
 *
 * The sweep now runs for the WHOLE trial window and is laid out symmetrically
 * about the centre, so it is guaranteed to cross the column the reticle starts
 * on: there is always a real acquisition window, and the target is still
 * travelling when the window closes rather than disappearing early. Leading
 * the target is still required — the speed band is unchanged.
 */
function planDynamicFlickInstance(
  def: ScenarioDefinition,
  viewport: ViewportSize,
  rng: Rng,
): PlannedScenarioInstance {
  const center = centerOf(viewport);
  const radius = def.targetRadiusPx;
  const speed = rng.range(
    def.targetSpeedPxPerSec?.min ?? 260,
    def.targetSpeedPxPerSec?.max ?? 480,
  );
  const traverseMs = def.timeoutMs;
  const travelPx = (speed * traverseMs) / 1000;
  const dirX = rng.bernoulli(0.5) ? 1 : -1;
  const startX = clampFullyVisible(
    center.x - (dirX * travelPx) / 2,
    viewport.widthPx,
    radius,
  );
  const endX = clampFullyVisible(
    center.x + (dirX * travelPx) / 2,
    viewport.widthPx,
    radius,
  );
  // A lane above or below the centre line: the sweep must not be a freebie
  // that walks straight through the resting reticle every time.
  const laneY = clampFullyVisible(
    center.y + rng.range(-1, 1) * viewport.heightPx * 0.2,
    viewport.heightPx,
    radius,
  );
  const delay = spawnDelay(rng);
  const keyframes: TargetKeyframe[] = [];
  // 25 ms keyframes: hit detection and rendering both interpolate between
  // them (domain/trial.ts targetPositionAt), so the path is exact for linear
  // motion; the tighter spacing just bounds any consumer that samples them.
  for (let kt = 0; kt <= traverseMs; kt += DYNAMIC_KEYFRAME_STEP_MS) {
    const f = kt / traverseMs;
    keyframes.push({
      tMs: delay + kt,
      position: { x: startX + (endX - startX) * f, y: laneY },
    });
  }
  return {
    scenarioId: def.id,
    kind: def.kind,
    targets: [{ kind: "path", spawnDelayMs: delay, keyframes, radiusPx: radius }],
    durationMs: def.timeoutMs,
  };
}

function planTargetSwitchInstance(
  def: ScenarioDefinition,
  viewport: ViewportSize,
  rng: Rng,
): PlannedScenarioInstance {
  const center = centerOf(viewport);
  const count = def.targetsPerTrial ?? 3;
  const targets: PlannedTarget[] = [];
  let cumulativeDelay = 0;
  for (let i = 0; i < count; i++) {
    cumulativeDelay += spawnDelay(rng);
    const distance = rng.range(def.distanceRangePx.min, def.distanceRangePx.max);
    const angle = pickAngle(def, rng, i);
    targets.push({
      kind: "static",
      spawnDelayMs: cumulativeDelay,
      position: {
        x: clampToViewport(center.x + Math.cos(angle) * distance, viewport.widthPx),
        y: clampToViewport(center.y + Math.sin(angle) * distance, viewport.heightPx),
      },
      radiusPx: def.targetRadiusPx,
    });
  }
  return {
    scenarioId: def.id,
    kind: def.kind,
    targets,
    durationMs: def.timeoutMs,
    ...(def.perTargetTimeoutMs !== undefined
      ? { perTargetTimeoutMs: def.perTargetTimeoutMs }
      : {}),
  };
}

function planTrackingInstance(
  def: ScenarioDefinition,
  viewport: ViewportSize,
  rng: Rng,
): PlannedScenarioInstance {
  const center = centerOf(viewport);
  const ax = viewport.widthPx * 0.28;
  const ay = viewport.heightPx * 0.22;
  const periodXms = 2100 + rng.range(-300, 300);
  const periodYms = 3400 + rng.range(-500, 500);
  const phase1 = rng.range(0, 2 * Math.PI);
  const phase2 = rng.range(0, 2 * Math.PI);
  const durationMs = def.trackingDurationMs ?? def.timeoutMs;
  const keyframes: TargetKeyframe[] = [];
  for (let kt = 0; kt <= durationMs; kt += 50) {
    keyframes.push({
      tMs: kt,
      position: {
        x: center.x + ax * Math.sin((2 * Math.PI * kt) / periodXms + phase1),
        y: center.y + ay * Math.sin((2 * Math.PI * kt) / periodYms + phase2),
      },
    });
  }
  return {
    scenarioId: def.id,
    kind: def.kind,
    targets: [
      { kind: "path", spawnDelayMs: 0, keyframes, radiusPx: def.targetRadiusPx },
    ],
    durationMs,
  };
}

export function plannedTargetPositionAt(
  target: PlannedTarget,
  elapsedMs: number,
): Vec2 | null {
  if (elapsedMs < target.spawnDelayMs) return null;
  if (target.kind === "static") return target.position;
  const keys = target.keyframes;
  if (keys.length === 0) return null;
  return interpolateKeyframes(keys, elapsedMs);
}

function interpolateKeyframes(
  keys: TargetKeyframe[],
  tMs: number,
): Vec2 | null {
  if (tMs < keys[0]!.tMs) return keys[0]!.position;
  let lo = 0;
  let hi = keys.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (keys[mid]!.tMs <= tMs) lo = mid;
    else hi = mid - 1;
  }
  const a = keys[lo]!;
  const b = keys[Math.min(lo + 1, keys.length - 1)]!;
  if (a === b || b.tMs === a.tMs) return a.position;
  const f = (tMs - a.tMs) / (b.tMs - a.tMs);
  return {
    x: a.position.x + (b.position.x - a.position.x) * f,
    y: a.position.y + (b.position.y - a.position.y) * f,
  };
}
