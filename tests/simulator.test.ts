import { describe, expect, it } from "vitest";
import { SyntheticExperimentRunner } from "../src/sim/simulator.ts";
import { playerPreset } from "../src/sim/player.ts";
import { buildExperimentDefinition } from "../src/experiments/protocol.ts";
import { equalXy } from "../src/domain/settings.ts";
import { computeFlickMetrics } from "../src/metrics/flick.ts";

const def = buildExperimentDefinition({
  id: "experiment-sim-test",
  name: "sim test",
  baselineSensitivity: equalXy(7),
  dpi: 800,
  measuredRepsPerCandidatePerRound: 4,
});

describe("deterministic synthetic simulator", () => {
  it("produces identical trials for identical seeds", () => {
    const runnerA = new SyntheticExperimentRunner(def, playerPreset("consistent-medium"));
    const runnerB = new SyntheticExperimentRunner(def, playerPreset("consistent-medium"));
    const a = runnerA.runRound(0, 777, "session-same", def.id);
    const b = runnerB.runRound(0, 777, "session-same", def.id);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(JSON.stringify(a[i]!.samples)).toEqual(JSON.stringify(b[i]!.samples));
      expect(a[i]!.outcome).toEqual(b[i]!.outcome);
      expect(a[i]!.targets).toEqual(b[i]!.targets);
    }
  });

  it("produces different trials for different seeds", () => {
    const runner = new SyntheticExperimentRunner(def, playerPreset("consistent-medium"));
    const a = runner.runRound(0, 1, "session-a", def.id);
    const b = runner.runRound(0, 2, "session-a", def.id);
    const differ = a.some((t, i) => JSON.stringify(t.samples) !== JSON.stringify(b[i]!.samples));
    expect(differ).toBe(true);
  });

  it("never exposes the hidden optimum in trial data", () => {
    const runner = new SyntheticExperimentRunner(
      def,
      { ...playerPreset("consistent-medium"), trueOptimalEdpi: 6123 },
    );
    const trials = runner.runRound(0, 9, "session-x", def.id);
    const serialized = JSON.stringify(trials);
    expect(serialized).not.toContain("trueOptimal");
    expect(serialized.toLowerCase()).not.toContain("optimum");
    const numericLeaves: number[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "number") numericLeaves.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") {
        Object.values(value).forEach(walk);
      }
    };
    trials.forEach(walk);
    expect(numericLeaves.some((n) => Math.abs(n - 6123) < 1e-6)).toBe(false);
  });

  it("emits high-frequency samples with monotonic timestamps", () => {
    const runner = new SyntheticExperimentRunner(def, playerPreset("consistent-medium"));
    const trials = runner.runRound(0, 5, "session-y", def.id);
    for (const trial of trials) {
      if (trial.scenarioKind === "tracking") {
        expect(trial.samples.length).toBeGreaterThan(1000);
      } else {
        expect(trial.samples.length).toBeGreaterThan(30);
      }
      for (let i = 1; i < trial.samples.length; i++) {
        expect(trial.samples[i]!.tMs).toBeGreaterThan(trial.samples[i - 1]!.tMs);
      }
    }
  });

  it("records hits and misses through the recorder geometry", () => {
    const runner = new SyntheticExperimentRunner(def, playerPreset("consistent-medium"));
    const trials = runner.runRound(0, 3, "session-z", def.id)
      .filter((t) => t.phase === "measured" && t.scenarioKind === "flick-static");
    const outcomes = new Set(trials.map((t) => t.outcome));
    expect(outcomes.size).toBeGreaterThanOrEqual(1);
    for (const trial of trials) {
      if (trial.outcome === "hit") {
        expect(trial.shots[0]!.hit).toBe(true);
      }
    }
  });

  it("degrades hit rate away from the hidden optimum", () => {
    const wideDef = buildExperimentDefinition({
      id: "experiment-sim-wide",
      name: "sim wide",
      baselineSensitivity: equalXy(7),
      dpi: 800,
      ladderFactors: [1 / 2.2, 1, 2.2],
      measuredRepsPerCandidatePerRound: 25,
      warmupTrialsPerCandidateBlock: 2,
    });
    const runner = new SyntheticExperimentRunner(
      wideDef,
      { ...playerPreset("consistent-medium"), trueOptimalEdpi: 5600 },
    );
    const trials = runner.runRound(0, 12345, "session-w", wideDef.id);
    const hitRate = (candidateId: string) => {
      const relevant = trials.filter(
        (t) =>
          t.candidateId === candidateId &&
          t.phase === "measured" &&
          t.scenarioKind !== "tracking",
      );
      return relevant.filter((t) => t.outcome === "hit").length / relevant.length;
    };
    const baselineCand = wideDef.candidates.find((c) => c.origin.kind === "baseline")!;
    const slowCand = wideDef.candidates.find(
      (c) => c.origin.kind === "generated" && c.sensitivity.sensX < 7,
    )!;
    const fastCand = wideDef.candidates.find(
      (c) => c.origin.kind === "generated" && c.sensitivity.sensX > 7,
    )!;
    const atOptimum = hitRate(baselineCand.id);
    expect(atOptimum).toBeGreaterThan(hitRate(slowCand.id) - 0.05);
    expect(atOptimum).toBeGreaterThan(hitRate(fastCand.id));
  });

  it("generates plausible flick metrics on its own output", () => {
    const runner = new SyntheticExperimentRunner(def, playerPreset("consistent-medium"));
    const trials = runner.runRound(0, 21, "session-m", def.id).filter(
      (t) => t.phase === "measured" && t.scenarioKind.startsWith("flick"),
    );
    for (const trial of trials.slice(0, 10)) {
      const m = computeFlickMetrics(trial);
      if (m.reactionTimeMs !== null) {
        expect(m.reactionTimeMs).toBeGreaterThan(60);
        expect(m.reactionTimeMs).toBeLessThan(700);
      }
      if (m.totalAcquisitionTimeMs !== null) {
        expect(m.totalAcquisitionTimeMs).toBeLessThan(trial.endedAtMonotonicMs - trial.startedAtMonotonicMs + 1);
      }
      expect(m.pathLengthPx).toBeGreaterThan(0);
    }
  });

  it("applies fatigue across the session when configured", () => {
    const fatiguedDef = buildExperimentDefinition({
      id: "experiment-fatigue",
      name: "fatigue",
      baselineSensitivity: equalXy(7),
      dpi: 800,
      ladderFactors: [1],
      measuredRepsPerCandidatePerRound: 20,
      warmupTrialsPerCandidateBlock: 0,
      scenarioIds: ["flick-static-medium"],
    });
    const base = playerPreset("consistent-medium", { fatiguePerTrialMs: 8 });
    const runner = new SyntheticExperimentRunner(fatiguedDef, base);
    const trials = runner.runRound(0, 64, "session-f", fatiguedDef.id).filter(
      (t) => t.phase === "measured",
    );
    const early = computeFlickMetrics(trials[2]!).reactionTimeMs!;
    const late = computeFlickMetrics(trials[trials.length - 1]!).reactionTimeMs!;
    expect(late).toBeGreaterThan(early);
  });
});
