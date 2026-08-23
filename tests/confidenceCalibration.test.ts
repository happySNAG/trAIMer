import { describe, expect, it } from "vitest";
import {
  buildConfidenceCalibration,
  HEURISTIC_CONFIDENCE_VERSION,
} from "../src/confidence/calibration.ts";
import { computeInputQuality } from "../src/diagnostics/inputQuality.ts";
import { SensitivityOptimizer } from "../src/optimizer/optimizer.ts";
import { buildExperimentDefinition } from "../src/experiments/protocol.ts";
import { SyntheticExperimentRunner } from "../src/sim/simulator.ts";
import { playerPreset } from "../src/sim/player.ts";
import { equalXy } from "../src/domain/settings.ts";
import { makeTrial } from "./helpers.ts";

describe("confidence calibration framework", () => {
  it("always labels confidence as heuristic with diagnostics attached", () => {
    const meta = buildConfidenceCalibration({
      trialsAnalyzed: 40,
      candidatesEvaluated: 5,
      utilityGapZ: 2.4,
      separation: "clear",
      unresolvedBoundary: false,
      searchRoundsRun: 2,
      inputQuality: null,
    });
    expect(meta.basis).toBe("heuristic");
    expect(meta.empiricalModelVersion).toBeNull();
    expect(meta.heuristicVersion).toBe(HEURISTIC_CONFIDENCE_VERSION);
    expect(meta.diagnostics.trialsAnalyzed).toBe(40);
    expect(meta.notes.join(" ")).toMatch(/NOT an empirically validated probability/i);
  });

  it("attaches calibration metadata to real recommendations", () => {
    const def = buildExperimentDefinition({
      id: "experiment-cc",
      name: "cc",
      baselineSensitivity: equalXy(7),
      dpi: 800,
      measuredRepsPerCandidatePerRound: 6,
    });
    const runner = new SyntheticExperimentRunner(def, playerPreset("consistent-medium"));
    const optimizer = new SensitivityOptimizer(def, { maxSearchRounds: 1 });
    optimizer.addTrials(runner.runRound(0, 3, "session-cc" as never, def.id));
    const rec = optimizer.recommend();
    expect(rec.confidenceCalibration?.basis).toBe("heuristic");
    expect(rec.confidenceCalibration?.diagnostics.trialsAnalyzed).toBe(
      rec.evidence.trialsAnalyzed,
    );
  });

  it("poor capture quality caps confidence and requests retest", () => {
    const def = buildExperimentDefinition({
      id: "experiment-iq",
      name: "iq",
      baselineSensitivity: equalXy(7),
      dpi: 800,
      measuredRepsPerCandidatePerRound: 6,
    });
    const runner = new SyntheticExperimentRunner(def, playerPreset("consistent-medium"));
    const optimizer = new SensitivityOptimizer(def, { maxSearchRounds: 1 });
    optimizer.addTrials(runner.runRound(0, 8, "session-cc" as never, def.id));

    const poor = computeInputQuality(
      makeTrial({
        samples: Array.from({ length: 40 }, (_, i) => ({
          tMs: i * 25,
          cursor: { x: 640 + (i % 3), y: 360 },
          dx: i % 3 === 0 ? 2 : 0,
          dy: 0,
        })),
        focusInterruptions: [
          { startMs: 100, endMs: 200, reason: "pointer-lock-loss" },
        ],
        viewportResizes: [{ tMs: 150, widthPx: 900, heightPx: 600 }],
      }),
    );
    expect(poor.warnings.unsuitableForHighConfidence).toBe(true);
    optimizer.setInputQuality(poor);
    const rec = optimizer.recommend();
    expect(rec.confidence).toBeLessThanOrEqual(0.45);
    expect(rec.warnings.join(" ")).toMatch(/capture quality is degraded/i);
    expect(rec.furtherTestingSuggested).toBe(true);
    expect(rec.inputQuality?.score).toBeCloseTo(poor.score);
  });

  it("clean high-rate input keeps quality score high without warnings", () => {
    const clean = computeInputQuality(
      makeTrial({
        samples: Array.from({ length: 200 }, (_, i) => ({
          tMs: Math.round(i * 1000 / 240),
          cursor: { x: 640 + i * 1.5, y: 360 + (i % 5) },
          dx: 1.5,
          dy: i % 5,
        })),
      }),
    );
    expect(clean.warnings.lowEventRate).toBe(false);
    expect(clean.warnings.unstableTiming).toBe(false);
    expect(clean.score).toBeGreaterThan(0.9);
  });
});
