import type { ScenarioKind } from "./trial.ts";

export interface ScenarioDefinition {
  id: string;
  kind: ScenarioKind;
  label: string;
  timeoutMs: number;
  targetRadiusPx: number;
  distanceRangePx: { min: number; max: number };
  angleMode: "any" | "horizontal-biased" | "cardinal";
  targetSpeedPxPerSec?: { min: number; max: number };
  trackingDurationMs?: number;
  targetsPerTrial?: number;
  notes?: string;
}

const FLICK_STATIC_MEDIUM: ScenarioDefinition = {
  id: "flick-static-medium",
  kind: "flick-static",
  label: "Static flick, medium targets",
  timeoutMs: 900,
  targetRadiusPx: 26,
  distanceRangePx: { min: 220, max: 620 },
  angleMode: "any",
};

const FLICK_STATIC_SMALL: ScenarioDefinition = {
  id: "flick-static-small",
  kind: "flick-static",
  label: "Static flick, small targets",
  timeoutMs: 1000,
  targetRadiusPx: 16,
  distanceRangePx: { min: 260, max: 640 },
  angleMode: "any",
};

const FLICK_DYNAMIC_HORIZONTAL: ScenarioDefinition = {
  id: "flick-dynamic-horizontal",
  kind: "flick-dynamic",
  label: "Flick to horizontally strafing target",
  timeoutMs: 1100,
  targetRadiusPx: 24,
  distanceRangePx: { min: 240, max: 560 },
  angleMode: "horizontal-biased",
  targetSpeedPxPerSec: { min: 220, max: 520 },
};

const TARGET_SWITCH_SEQUENCE: ScenarioDefinition = {
  id: "target-switch-triple",
  kind: "target-switch",
  label: "Three-target switch sequence",
  timeoutMs: 2400,
  targetRadiusPx: 24,
  distanceRangePx: { min: 200, max: 480 },
  angleMode: "any",
  targetsPerTrial: 3,
};

const TRACKING_SINE: ScenarioDefinition = {
  id: "tracking-smooth-sine",
  kind: "tracking",
  label: "Smooth moving-target tracking",
  timeoutMs: 6000,
  targetRadiusPx: 30,
  distanceRangePx: { min: 0, max: 0 },
  angleMode: "any",
  trackingDurationMs: 6000,
  targetSpeedPxPerSec: { min: 260, max: 420 },
};

export const CORE_SCENARIOS: readonly ScenarioDefinition[] = [
  FLICK_STATIC_MEDIUM,
  FLICK_STATIC_SMALL,
  FLICK_DYNAMIC_HORIZONTAL,
  TARGET_SWITCH_SEQUENCE,
  TRACKING_SINE,
];

export function scenarioById(id: string): ScenarioDefinition {
  const found = CORE_SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error(`Unknown scenario: ${id}`);
  return found;
}
