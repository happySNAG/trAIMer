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
  /**
   * Sequential multi-target scenarios: how long each target stays up before
   * it expires and the next one appears. The trial's `timeoutMs` is the hard
   * ceiling for the whole sequence.
   */
  perTargetTimeoutMs?: number;
  difficulty: {
    tier: "easy" | "medium" | "hard";
    discriminatesDimensions: string[];
    notes: string;
  };
  notes?: string;
}

const FLICK_STATIC_MEDIUM: ScenarioDefinition = {
  id: "flick-static-medium",
  kind: "flick-static",
  label: "Static flick, medium targets",
  timeoutMs: 900,
  targetRadiusPx: 26,
  distanceRangePx: { min: 240, max: 620 },
  angleMode: "any",
  difficulty: {
    tier: "medium",
    discriminatesDimensions: ["speed", "accuracy"],
    notes: "core flick signal; generous radius keeps miss noise low",
  },
};

const FLICK_STATIC_SMALL: ScenarioDefinition = {
  id: "flick-static-small",
  kind: "flick-static",
  label: "Static flick, small targets",
  timeoutMs: 1000,
  targetRadiusPx: 16,
  distanceRangePx: { min: 280, max: 640 },
  angleMode: "any",
  difficulty: {
    tier: "hard",
    discriminatesDimensions: ["accuracy", "overshootControl", "undershootControl"],
    notes: "small radius punishes amplitude errors — strongest sens discriminator",
  },
};

const FLICK_DYNAMIC_HORIZONTAL: ScenarioDefinition = {
  id: "flick-dynamic-horizontal",
  kind: "flick-dynamic",
  label: "Flick to horizontally strafing target",
  // rc.6: the sweep now runs for the whole window and crosses the centre
  // (scenarios/planner.ts). rc.5 gave a 1100 ms budget in which the target
  // covered 272–515 px of a 1280 px field and then vanished mid-approach —
  // "the light blue circle don't go far enough across the screen to be able
  // to shoot". 2000 ms buys the full crossing at the SAME speed band, so the
  // drill is no easier per pixel, it simply presents a real opportunity.
  timeoutMs: 2000,
  targetRadiusPx: 24,
  // Vertical spread only (the horizontal path is derived from speed × window);
  // kept so the shared definition shape stays meaningful across scenarios.
  distanceRangePx: { min: 260, max: 560 },
  angleMode: "horizontal-biased",
  // Upper bound trimmed 520 → 480 so a full-window sweep (speed × 2 s) always
  // fits inside the fully-visible band and never has to be clamped short.
  targetSpeedPxPerSec: { min: 260, max: 480 },
  difficulty: {
    tier: "hard",
    discriminatesDimensions: ["speed", "correctionEfficiency"],
    notes: "interception timing separates over/under-flicking styles",
  },
};

const TARGET_SWITCH_SEQUENCE: ScenarioDefinition = {
  id: "target-switch-triple",
  kind: "target-switch",
  label: "Three-target switch sequence",
  // One target at a time (Pass 11): each gets its own 1100 ms window — the
  // same order of budget a single static flick gets — and the sequence ceiling
  // covers three windows, the inter-target gaps and the spawn delays. rc.4 showed all three
  // targets at once inside a single 2400 ms budget, so the third acquisition
  // was routinely cut off by the trial timeout mid-flick.
  timeoutMs: 3800,
  perTargetTimeoutMs: 1100,
  targetRadiusPx: 24,
  distanceRangePx: { min: 220, max: 480 },
  angleMode: "any",
  targetsPerTrial: 3,
  difficulty: {
    tier: "hard",
    discriminatesDimensions: ["speed", "consistency", "correctionEfficiency"],
    notes: "sequential load exposes consistency across repeated acquisitions",
  },
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
  targetSpeedPxPerSec: { min: 280, max: 420 },
  difficulty: {
    tier: "hard",
    discriminatesDimensions: ["trackingPrecision", "consistency"],
    notes: "Lissajous path with both axes in motion; jitter/lag sensitive",
  },
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
