import type { TargetKeyframe } from "../domain/trial.ts";
import type { ScenarioDefinition } from "../domain/scenario.ts";
import type { Vec2 } from "../domain/geometry.ts";
import { Rng } from "../util/rng.ts";

export interface ViewportSize {
  widthPx: number;
  heightPx: number;
}

const VIEWPORT_MARGIN_PX = 24;

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
}

export function clampToViewport(v: number, max: number): number {
  return Math.min(max - VIEWPORT_MARGIN_PX, Math.max(VIEWPORT_MARGIN_PX, v));
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

function planDynamicFlickInstance(
  def: ScenarioDefinition,
  viewport: ViewportSize,
  rng: Rng,
): PlannedScenarioInstance {
  const center = centerOf(viewport);
  const distance = rng.range(def.distanceRangePx.min, def.distanceRangePx.max);
  const angle = pickAngle(def, rng, 0);
  const startPos = {
    x: clampToViewport(center.x + Math.cos(angle) * distance, viewport.widthPx),
    y: clampToViewport(center.y + Math.sin(angle) * distance, viewport.heightPx),
  };
  const speed = rng.range(
    def.targetSpeedPxPerSec?.min ?? 240,
    def.targetSpeedPxPerSec?.max ?? 480,
  );
  const dirX = startPos.x > center.x ? -1 : 1;
  const delay = spawnDelay(rng);
  const horizonMs = def.timeoutMs;
  const keyframes: TargetKeyframe[] = [];
  for (let kt = 0; kt <= horizonMs; kt += 50) {
    keyframes.push({
      tMs: delay + kt,
      position: {
        x: clampToViewport(startPos.x + (dirX * speed * kt) / 1000, viewport.widthPx),
        y: startPos.y,
      },
    });
  }
  return {
    scenarioId: def.id,
    kind: def.kind,
    targets: [{ kind: "path", spawnDelayMs: delay, keyframes, radiusPx: def.targetRadiusPx }],
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
