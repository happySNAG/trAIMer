import { describe, expect, it } from "vitest";
import {
  computeFlickMetrics,
  computeTargetSwitchLatency,
} from "../src/metrics/flick.ts";
import { makeTrial, straightFlickTrial } from "./helpers.ts";
import { makeTargetId } from "../src/domain/ids.ts";

describe("flick metrics on a straight ideal flick", () => {
  const record = straightFlickTrial({ reactionMs: 200, moveDurationMs: 150 });
  const m = computeFlickMetrics(record);

  it("measures reaction time from appearance to movement onset", () => {
    expect(m.reactionTimeMs!).toBeGreaterThanOrEqual(195);
    expect(m.reactionTimeMs!).toBeLessThanOrEqual(230);
  });

  it("has near-perfect path efficiency", () => {
    expect(m.pathEfficiency!).toBeGreaterThan(0.98);
  });

  it("has negligible overshoot and undershoot", () => {
    expect(m.overshootRatio).toBeLessThan(0.02);
    expect(m.undershootRatio).toBeLessThan(0.02);
  });

  it("records zero initial direction error for a straight path", () => {
    expect(m.initialDirectionErrorDeg!).toBeLessThan(1);
  });

  it("hits with small final error and one shot", () => {
    expect(m.shotsFired).toBe(1);
    expect(m.hitAccuracy).toBe(1);
    expect(m.finalErrorPx!).toBeLessThan(26);
  });

  it("reports total acquisition close to reaction plus movement plus settle", () => {
    expect(m.totalAcquisitionTimeMs!).toBeGreaterThan(340);
    expect(m.totalAcquisitionTimeMs!).toBeLessThan(440);
  });
});

describe("overshoot detection", () => {
  const record = straightFlickTrial({ overshootPx: 80, shotDelayAfterArrivalMs: 120 });
  const m = computeFlickMetrics(record);

  it("flags overshoot when the path passes beyond the target center", () => {
    expect(m.overshootRatio).toBeGreaterThan(0.15);
    expect(m.undershootRatio).toBeLessThan(0.02);
  });

  it("counts corrections after the overshoot reversal", () => {
    expect(m.correctionCount).toBeGreaterThanOrEqual(1);
    expect(m.correctionDistancePx).toBeGreaterThan(60);
  });

  it("still records the final error at the shot", () => {
    expect(m.finalErrorPx).not.toBeNull();
  });
});

describe("undershoot detection", () => {
  const record = straightFlickTrial({ stopShortRatio: 0.85, shotDelayAfterArrivalMs: 100 });
  const m = computeFlickMetrics(record);

  it("flags undershoot when the path stops short along the aim line", () => {
    expect(m.undershootRatio).toBeGreaterThan(0.1);
    expect(m.overshootRatio).toBeLessThan(0.02);
  });

  it("reduces hit accuracy because the cursor stops outside the disc", () => {
    expect(m.hitAccuracy).toBe(0);
  });
});

describe("direction error", () => {
  it("detects an angled initial movement", () => {
    const start = { x: 640, y: 360 };
    const samples = [];
    let t = 0;
    for (; t <= 400; t += 4) {
      if (t < 300) {
        const z = Math.min(1, Math.max(0, (t - 100) / 120));
        samples.push({
          tMs: t,
          cursor: { x: start.x + z * 200, y: start.y + z * 90 },
        });
      } else {
        samples.push({
          tMs: t,
          cursor: { x: start.x + 200, y: start.y + 90 },
        });
      }
    }
    const record = makeTrial({
      samples,
      targets: [
        {
          targetId: "target-d1",
          radiusPx: 26,
          appearedMs: 80,
          removedMs: null,
          removalReason: null,
          motion: { kind: "static", position: { x: start.x + 380, y: start.y - 10 } },
        },
      ],
      shots: [
        {
          tMs: 396,
          cursorAtShot: samples[samples.length - 1]!.cursor,
          aimedTargetId: null,
          hit: false,
          missDistancePx: 180,
        },
      ],
      outcome: "miss-shot-fired",
    });
    const m = computeFlickMetrics(record);
    const expectedDeg =
      (Math.atan2(-10, 380) * 180) / Math.PI -
      (Math.atan2(90, 200) * 180) / Math.PI;
    expect(m.initialDirectionErrorDeg!).toBeGreaterThan(Math.abs(expectedDeg) * 0.5);
    expect(m.initialDirectionErrorDeg!).toBeGreaterThan(5);
  });
});

describe("target switch latency", () => {
  it("measures onset latency between consecutive targets", () => {
    const targets = [0, 1, 2].map((i) => ({
      targetId: makeTargetId(`s${i}`),
      radiusPx: 26,
      appearedMs: 100 + i * 500,
      removedMs: 100 + i * 500 + 300,
      removalReason: "hit" as const,
      motion: {
        kind: "static" as const,
        position: { x: 300 + i * 250, y: 360 },
      },
    }));
    const samples = [];
    for (let t = 0; t <= 1700; t += 4) {
      const phase = Math.min(2, Math.max(0, Math.floor((t - 100) / 500)));
      const baseX = 300 + phase * 250;
      const z = Math.min(1, Math.max(0, ((t - (100 + phase * 500)) - 120) / 150));
      samples.push({ tMs: t, cursor: { x: baseX - (1 - z) * 200, y: 360 } });
    }
    const record = makeTrial({
      scenarioKind: "target-switch",
      scenarioId: "target-switch-triple",
      samples,
      targets,
      shots: [],
      outcome: "hit",
    });
    const latency = computeTargetSwitchLatency(record);
    expect(latency.latenciesMs.length).toBe(2);
    for (const l of latency.latenciesMs) {
      expect(l).toBeGreaterThanOrEqual(110);
      expect(l).toBeLessThanOrEqual(140);
    }
  });
});

describe("metric robustness", () => {
  it("returns nulls instead of throwing for trials without targets", () => {
    const record = makeTrial({ samples: [{ tMs: 10, cursor: { x: 0, y: 0 } }] });
    const m = computeFlickMetrics(record);
    expect(m.reactionTimeMs).toBeNull();
    expect(m.pathEfficiency).toBeNull();
  });

  it("handles a timeout trial with no shot", () => {
    const record = makeTrial({
      outcome: "timeout-no-shot",
      samples: Array.from({ length: 20 }, (_, i) => ({
        tMs: i * 50,
        cursor: { x: 640, y: 360 },
      })),
      targets: [
        {
          targetId: "target-x",
          radiusPx: 26,
          appearedMs: 100,
          removedMs: 1000,
          removalReason: "expired",
          motion: { kind: "static", position: { x: 900, y: 360 } },
        },
      ],
    });
    const m = computeFlickMetrics(record);
    expect(m.totalAcquisitionTimeMs).toBeNull();
    expect(m.undershootRatio).toBeGreaterThan(0.5);
    expect(m.hitAccuracy).toBeNull();
  });
});
