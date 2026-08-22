import { describe, expect, it } from "vitest";
import { computeTrackingMetrics } from "../src/metrics/tracking.ts";
import type { TrialRecord } from "../src/domain/trial.ts";
import { makeTrial } from "./helpers.ts";

const DURATION = 3000;
const DT = 10;
const RADIUS = 30;
const KEYSTEP_MS = 25;

function makeTargetPath(
  targetAt: (t: number) => { x: number; y: number },
): { keyframes: { tMs: number; position: { x: number; y: number } }[]; interpolatedAt: (t: number) => { x: number; y: number } } {
  const keyframes: { tMs: number; position: { x: number; y: number } }[] = [];
  for (let t = 0; t <= DURATION; t += KEYSTEP_MS) {
    keyframes.push({ tMs: t, position: targetAt(t) });
  }
  const interpolatedAt = (t: number): { x: number; y: number } => {
    const clamped = Math.min(Math.max(t, 0), DURATION);
    const idx = Math.min(
      keyframes.length - 2,
      Math.floor(clamped / KEYSTEP_MS),
    );
    const a = keyframes[idx]!;
    const b = keyframes[idx + 1]!;
    const f = (clamped - a.tMs) / (b.tMs - a.tMs);
    return {
      x: a.position.x + (b.position.x - a.position.x) * f,
      y: a.position.y + (b.position.y - a.position.y) * f,
    };
  };
  return { keyframes, interpolatedAt };
}

function trackingTrial(
  cursorAt: (t: number, target: { x: number; y: number }) => { x: number; y: number },
  targetAt: (t: number) => { x: number; y: number },
): TrialRecord {
  const { keyframes, interpolatedAt } = makeTargetPath(targetAt);
  const samples = [];
  for (let t = 0; t <= DURATION; t += DT) {
    samples.push({
      tMs: t,
      cursor: cursorAt(t, interpolatedAt(t)),
      dx: 0,
      dy: 0,
    });
  }
  return makeTrial({
    scenarioKind: "tracking",
    scenarioId: "tracking-smooth-sine",
    outcome: "tracking-complete",
    samples,
    targets: [
      {
        targetId: "target-track",
        radiusPx: RADIUS,
        appearedMs: 0,
        removedMs: DURATION,
        removalReason: "trial-end",
        motion: { kind: "path", keyframes },
      },
    ],
  });
}

describe("perfect tracking", () => {
  const targetAt = (t: number) => ({ x: 640 + Math.cos(t / 500) * 200, y: 360 });
  const record = trackingTrial((_t, target) => ({ ...target }), targetAt);
  const m = computeTrackingMetrics(record);

  it("has zero error and full time on target", () => {
    expect(m.meanErrorPx!).toBeLessThan(1e-9);
    expect(m.timeOnTargetRatio!).toBe(1);
    expect(m.rmsErrorPx!).toBeLessThan(1e-9);
  });

  it("counts no losses or reacquisitions", () => {
    expect(m.lossEvents).toBe(0);
    expect(m.reacquisitionEvents).toBe(0);
  });

  it("reports near-unit path efficiency", () => {
    expect(m.trackingPathEfficiency!).toBeGreaterThan(0.95);
  });

  it("estimates directional lag near zero", () => {
    expect(Math.abs(m.directionalLagMs!)).toBeLessThanOrEqual(20);
  });
});

describe("constant-lag tracking", () => {
  const LAG_MS = 120;
  const targetAt = (t: number) => ({
    x: 640 + Math.sin((2 * Math.PI * t) / 1500) * 250,
    y: 360,
  });
  const record = trackingTrial(
    (t) => targetAt(t - LAG_MS),
    targetAt,
  );
  const m = computeTrackingMetrics(record);

  it("recovers the lag within a sample step or two", () => {
    expect(Math.abs(m.directionalLagMs! - LAG_MS)).toBeLessThanOrEqual(30);
  });

  it("shows nonzero mean error concentrated in bands", () => {
    expect(m.meanErrorPx!).toBeGreaterThan(5);
    expect(m.bandRatios["x3"]!).toBeGreaterThan(m.bandRatios["x1"]!);
    expect(m.percentileErrorsPx["90"]!).toBeGreaterThanOrEqual(
      m.percentileErrorsPx["50"]!,
    );
  });

  it("keeps raw and derived values distinct", () => {
    expect(m.sampleCount).toBeGreaterThan(100);
    expect(m.medianErrorPx!).toBeGreaterThan(0);
  });
});

describe("loss and reacquisition events", () => {
  const targetAt = (t: number) => ({ x: 640 + Math.sin(t / 800) * 180, y: 360 });
  const record = trackingTrial((t) => {
    if (t > 900 && t < 1400) return { x: 60, y: 60 };
    return targetAt(t);
  }, targetAt);
  const m = computeTrackingMetrics(record);

  it("detects one loss and one reacquisition", () => {
    expect(m.lossEvents).toBe(1);
    expect(m.reacquisitionEvents).toBe(1);
  });

  it("reduces time on target accordingly", () => {
    expect(m.timeOnTargetRatio!).toBeLessThan(0.95);
    expect(m.timeOnTargetRatio!).toBeGreaterThan(0.7);
  });
});

describe("correction frequency", () => {
  it("counts oscillating corrections per second", () => {
    const targetAt = () => ({ x: 700, y: 360 });
    const record = trackingTrial(
      (t) => ({ x: 700 + Math.sin(t / 100) * 45, y: 360 }),
      targetAt,
    );
    const m = computeTrackingMetrics(record);
    expect(m.correctionFrequencyPerSec!).toBeGreaterThan(1);
  });
});
