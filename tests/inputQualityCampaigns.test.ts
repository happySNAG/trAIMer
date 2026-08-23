import { describe, expect, it } from "vitest";
import {
  computeInputQuality,
  validateTrial,
  SensitivityOptimizer,
  SyntheticExperimentRunner,
  buildExperimentDefinition,
  playerPreset,
  equalXy,
} from "../src/index.ts";
import type { TrialRecord } from "../src/domain/trial.ts";
import { makeTrial } from "./helpers.ts";

function samplesAtRate(
  hz: number,
  count: number,
  jitterPattern: (i: number) => number = () => 0,
): { tMs: number; cursor: { x: number; y: number }; dx: number; dy: number }[] {
  const out = [];
  let t = 0;
  let x = 640;
  for (let i = 0; i < count; i++) {
    const dt = 1000 / hz + jitterPattern(i);
    t += dt;
    const dx = 1.2 + (i % 5) * 0.4;
    x += dx;
    out.push({ tMs: Math.round(t), cursor: { x, y: 360 }, dx, dy: 0 });
  }
  return out;
}

describe("input-quality synthetic campaigns", () => {
  it("distinguishes stable high-rate sampling from unstable 60 Hz browser sampling", () => {
    const stable = computeInputQuality(
      makeTrial({ samples: samplesAtRate(240, 240, () => (Math.random() > 0.5 ? 0.1 : -0.1)) }),
    );
    const unstable60 = computeInputQuality(
      makeTrial({
        samples: samplesAtRate(60, 90, (i) => ((i * 7919) % 23) - 11),
      }),
    );
    expect(stable.metrics.observedRateHz).toBeGreaterThan(200);
    expect(unstable60.metrics.observedRateHz).toBeLessThan(80);
    expect((unstable60.metrics.intervalJitterCv ?? 0)).toBeGreaterThan(
      stable.metrics.intervalJitterCv ?? 0,
    );

    const degraded30 = computeInputQuality(
      makeTrial({ samples: samplesAtRate(30, 40) }),
    );
    expect(degraded30.warnings.lowEventRate).toBe(true);
    expect(degraded30.score).toBeLessThan(stable.score);
  });

  it("flags coalesced-style streams (bursty identical deltas, long stillness)", () => {
    // Frame-coalesced capture: bursts of movement separated by silent frames.
    const bursty: TrialRecord["samples"] = [];
    let t = 0;
    for (let frame = 0; frame < 120; frame++) {
      t += 16.7;
      if (frame % 3 === 0) {
        t += 40;
        bursty.push({
          tMs: Math.round(t),
          cursor: { x: 640 + frame * 4, y: 360 },
          dx: 12,
          dy: 0,
        });
      }
    }
    const report = computeInputQuality(makeTrial({ samples: bursty }));
    expect(report.metrics.observedRateHz).toBeLessThan(45);
    expect(report.warnings.lowEventRate).toBe(true);
  });

  it("lowers optimizer confidence when the worst trial has poor capture quality", () => {
    const def = buildExperimentDefinition({
      id: "experiment-iqcamp" as never,
      name: "iq campaign",
      baselineSensitivity: equalXy(7),
      dpi: 800,
      measuredRepsPerCandidatePerRound: 8,
    });
    const runner = new SyntheticExperimentRunner(def, playerPreset("consistent-medium"));
    const trials = runner.runRound(0, 123, "session-iqc" as never, def.id);

    const cleanOptimizer = new SensitivityOptimizer(def, { maxSearchRounds: 1 });
    cleanOptimizer.addTrials(structuredClone(trials));
    const cleanRec = cleanOptimizer.recommend();

    const degradedOptimizer = new SensitivityOptimizer(def, { maxSearchRounds: 1 });
    degradedOptimizer.addTrials(trials);
    const worst = computeInputQuality(
      makeTrial({
        id: "trial-degraded",
        samples: samplesAtRate(35, 30),
        focusInterruptions: [
          { startMs: 50, endMs: null, reason: "pointer-lock-loss" },
        ],
      }),
    );
    degradedOptimizer.setInputQuality(worst);
    const degradedRec = degradedOptimizer.recommend();

    expect(degradedRec.confidence).toBeLessThanOrEqual(0.45);
    expect(degradedRec.confidence).toBeLessThanOrEqual(cleanRec.confidence);
    expect(degradedRec.furtherTestingSuggested).toBe(true);
  });

  it("repeated sessions with the same hidden optimum stay consistent", () => {
    const recommendations: number[] = [];
    for (const sessionSeed of [71, 72]) {
      const def = buildExperimentDefinition({
        id: "experiment-repeat-same" as never,
        name: "repeat same",
        baselineSensitivity: equalXy(7),
        dpi: 800,
        orderSeed: sessionSeed,
        measuredRepsPerCandidatePerRound: 10,
      });
      const runner = new SyntheticExperimentRunner(def, {
        ...playerPreset("consistent-medium"),
        trueOptimalEdpi: 5600,
      });
      const optimizer = new SensitivityOptimizer(def, { maxSearchRounds: 2 });
      optimizer.addTrials(runner.runRound(0, sessionSeed, "session-rp" as never, def.id));
      recommendations.push(optimizer.recommend().recommendedEdpi);
    }
    const driftOctaves = Math.abs(Math.log2(recommendations[1]! / recommendations[0]!));
    expect(driftOctaves).toBeLessThan(0.3);
  });

  it("repeated sessions with a changed hidden optimum show measurable drift", () => {
    const recommendations: number[] = [];
    for (const [sessionSeed, hidden] of [
      [81, 4200],
      [82, 7700],
    ] as const) {
      const def = buildExperimentDefinition({
        id: "experiment-repeat-change" as never,
        name: "repeat change",
        baselineSensitivity: equalXy(7),
        dpi: 800,
        orderSeed: sessionSeed,
        ladderFactors: [1 / 1.15, 1, 1.15],
        measuredRepsPerCandidatePerRound: 10,
      });
      const runner = new SyntheticExperimentRunner(def, {
        ...playerPreset("consistent-medium"),
        trueOptimalEdpi: hidden,
      });
      const optimizer = new SensitivityOptimizer(def, { maxSearchRounds: 1 });
      optimizer.addTrials(runner.runRound(0, sessionSeed, "session-rc" as never, def.id));
      recommendations.push(optimizer.recommend().recommendedEdpi);
    }
    const driftOctaves = Math.abs(Math.log2(recommendations[1]! / recommendations[0]!));
    expect(driftOctaves).toBeGreaterThan(0.15);
  });

  it("noisy double-click streams are flagged as suspect by validation", () => {
    const base = makeTrial({
      scenarioKind: "flick-static",
      samples: Array.from({ length: 40 }, (_, i) => ({
        tMs: i * 8,
        cursor: { x: 640 + i, y: 360 },
        dx: 1,
        dy: 0,
      })),
      targets: [
        {
          targetId: "target-dbl" as never,
          radiusPx: 26,
          appearedMs: 10,
          removedMs: null,
          removalReason: null,
          motion: { kind: "static" as const, position: { x: 900, y: 360 } },
        },
      ],
      shots: [400, 404, 500].map((tMs) => ({
        tMs,
        cursorAtShot: { x: 800, y: 360 },
        aimedTargetId: null,
        hit: false,
        missDistancePx: 50,
      })),
      outcome: "miss-shot-fired",
    });
    const report = computeInputQuality(base);
    void report;
    const validity = validateTrial(base);
    expect(validity.status).not.toBe("valid");
  });
});
