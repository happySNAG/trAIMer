import { describe, expect, it } from "vitest";
import {
  SensitivityOptimizer,
  SyntheticExperimentRunner,
  buildExperimentDefinition,
  playerPreset,
  equalXy,
  planYExploration,
  evaluateYExploration,
  makeCandidateId,
} from "../src/index.ts";
import type { Recommendation } from "../src/domain/recommendation.ts";
import type { TrialRecord } from "../src/domain/trial.ts";

type TrialRecordList = TrialRecord[];

const DPI = 800;

function standardSearch(
  hiddenEdpi: number,
  opts: {
    ladder?: readonly number[];
    reps?: number;
    rounds?: number;
    seed?: number;
    preset?: Parameters<typeof playerPreset>[0];
    fatiguePerTrialMs?: number;
  },
): Recommendation {
  const def = buildExperimentDefinition({
    id: "experiment-campaign",
    name: "campaign",
    baselineSensitivity: equalXy(7),
    dpi: DPI,
    orderSeed: opts.seed ?? 11,
    ladderFactors: opts.ladder ?? [1 / 1.15, 1, 1.15],
    measuredRepsPerCandidatePerRound: opts.reps ?? 12,
    warmupTrialsPerCandidateBlock: 2,
  });
  const runner = new SyntheticExperimentRunner(def, {
    ...playerPreset(opts.preset ?? "consistent-medium"),
    trueOptimalEdpi: hiddenEdpi,
    fatiguePerTrialMs: opts.fatiguePerTrialMs ?? 0,
  });
  const optimizer = new SensitivityOptimizer(def, {
    maxSearchRounds: opts.rounds ?? 2,
  });
  optimizer.addTrials(runner.runRound(0, 55, "session-c", def.id));
  for (let guard = 0; guard < 4; guard++) {
    const next = optimizer.needsMoreEvidence();
    if (next.kind === "done") break;
    optimizer.addCandidates(next.candidates);
    optimizer.addTrials(
      runner.runRound(
        next.round,
        55,
        "session-c",
        def.id,
        next.candidates.map((c) => c.id),
      ),
    );
  }
  return optimizer.recommend();
}

describe("blind regression campaigns (Pass 2 hardening)", () => {
  it("case A — optimum below the initial ladder: honest range + unresolved flag", () => {
    const rec = standardSearch(3200, { seed: 21 });
    expect(rec.unresolvedBoundary).toBe(true);
    expect(rec.confidence).toBeLessThan(0.5);
    expect(rec.edpiRange.min).toBeLessThanOrEqual(3200);
    expect(rec.furtherTestingSuggested).toBe(true);
  });

  it("case B — optimum above the initial ladder: no high-confidence miss", () => {
    const rec = standardSearch(8800, { seed: 22 });
    // Pass 1 behaviour this replaces: a precise-but-wrong point with high confidence.
    expect(rec.confidence).toBeLessThanOrEqual(0.65);
    expect(rec.furtherTestingSuggested).toBe(true);
    expect(rec.warnings.join(" ")).toMatch(/edge of the initially tested range|boundary/i);
  });

  it("case C — far-above optimum with rounds exhausted: explicit unresolved boundary", () => {
    const rec = standardSearch(15000, {
      rounds: 1,
      seed: 30,
      ladder: [1 / 1.35, 1 / 1.15, 1, 1.15],
      reps: 6,
    });
    if (rec.evidence.separation !== "insufficient") {
      expect(rec.confidence).toBeLessThanOrEqual(0.45);
    }
    expect(rec.refusedHighConfidence || rec.warnings.length > 0).toBe(true);
  });

  it("case D — flat/noisy plateau at the baseline: accurate and honest", () => {
    const rec = standardSearch(5600, { preset: "noisy-beginner", seed: 44 });
    const errorFraction = Math.abs(rec.recommendedEdpi / 5600 - 1);
    expect(errorFraction).toBeLessThan(0.15);
    expect(rec.confidenceLabel).not.toBe("high");
  });

  it("case E — noisy plateau away from baseline: refuses overclaim", () => {
    const rec = standardSearch(7000, { preset: "noisy-beginner", seed: 45 });
    const covers = rec.edpiRange.min <= 7000 && rec.edpiRange.max >= 7000;
    expect(rec.refusedHighConfidence || covers).toBe(true);
    expect(rec.furtherTestingSuggested).toBe(true);
  });

  it("case F — deliberate-slow profile near the baseline stays modest", () => {
    const rec = standardSearch(5600, { preset: "deliberate-slow", seed: 46 });
    expect(Math.abs(rec.recommendedEdpi / 5600 - 1)).toBeLessThan(0.35);
    expect(rec.confidenceLabel).not.toBe("high");
  });

  it("case G — fatigue drift does not derail the recommendation", () => {
    const rec = standardSearch(5600, { fatiguePerTrialMs: 6, seed: 31 });
    expect(Math.abs(rec.recommendedEdpi / 5600 - 1)).toBeLessThan(0.25);
  });

  it("case H — asymmetric X/Y optimum is detected by staged Y exploration", () => {
    const anchorXPercent = 7;
    const definition = buildExperimentDefinition({
      id: "experiment-camp-y",
      name: "camp-y",
      baselineSensitivity: equalXy(anchorXPercent),
      dpi: DPI,
      scenarioIds: ["flick-static-medium"],
      measuredRepsPerCandidatePerRound: 14,
      warmupTrialsPerCandidateBlock: 1,
    });

    const stagePlan = planYExploration(
      { enabled: true, yFactors: [0.5, 1, 2], minImprovementZ: 2 },
      {
        id: makeCandidateId("stage1-winner"),
        sensitivity: equalXy(anchorXPercent),
        origin: { kind: "manual", label: "stage-1 winner" },
      },
    )!;
    const yVariants = stagePlan.candidates;
    definition.candidates.push(...yVariants);

    // Hidden truth: X correct at 5600 but Y optimal is half of that.
    const runner = new SyntheticExperimentRunner(definition, {
      ...playerPreset("consistent-medium"),
      trueOptimalEdpi: 5600,
      trueOptimalEdpiY: 2800,
    });
    const trialsByCandidate = new Map<string, TrialRecordList>();
    for (const trial of runner.runRound(0, 909, "session-y", definition.id)) {
      if (trial.phase !== "measured") continue;
      const list = trialsByCandidate.get(trial.candidateId!) ?? [];
      list.push(trial);
      trialsByCandidate.set(trial.candidateId!, list);
    }

    const summary = evaluateYExploration({
      definition,
      trialsByCandidate,
      policy: { fatalReasons: [], suspectPolicy: "exclude" },
      plan: stagePlan,
      config: { enabled: true, yFactors: [0.5, 1, 2], minImprovementZ: 2 },
    });
    expect(summary.explored).toBe(true);
    expect(summary.recommendedEqualY).toBe(false);
    expect(summary.improvementZ!).toBeGreaterThan(2);
  });
});


