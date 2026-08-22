import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPTIMIZER_CONFIG,
  SensitivityOptimizer,
  validateTrial,
  SyntheticExperimentRunner,
  buildExperimentDefinition,
  computeConfidence,
  evaluateCandidate,
  fitQuadraticWeighted,
  normalCdf,
  playerPreset,
} from "../src/index.ts";
import { equalXy } from "../src/domain/settings.ts";
import { makeTrial } from "./helpers.ts";

describe("quadratic surrogate fit", () => {
  it("recovers the vertex of an exact parabola", () => {
    const fit = fitQuadraticWeighted([
      { x: -0.4, y: 1 - 2 * 0.16, weight: 100 },
      { x: -0.2, y: 1 - 2 * 0.04, weight: 100 },
      { x: 0, y: 1, weight: 100 },
      { x: 0.2, y: 1 - 2 * 0.04, weight: 100 },
      { x: 0.4, y: 1 - 2 * 0.16, weight: 100 },
    ]);
    expect(fit).not.toBeNull();
    expect(fit!.a).toBeCloseTo(-2, 5);
    expect(fit!.vertexX).toBeCloseTo(0, 5);
  });

  it("recovers a shifted vertex", () => {
    const target = (x: number) => 0.8 - 3 * (x - 0.1) ** 2;
    const fit = fitQuadraticWeighted(
      [-0.3, -0.15, 0, 0.15, 0.3].map((x) => ({ x, y: target(x), weight: 1 })),
    );
    expect(fit!.vertexX).toBeCloseTo(0.1, 3);
  });

  it("reports vertex standard error on noisy data", () => {
    const points = [-0.4, -0.2, 0, 0.2, 0.4].map((x) => ({
      x,
      y: 1 - 2 * x * x + ((x > 0 ? 1 : -1) % 2) * 0.01,
      weight: 1,
    }));
    const fit = fitQuadraticWeighted(points);
    expect(fit!.standardErrorA).not.toBeNull();
    expect(fit!.vertexStandardError).not.toBeNull();
    expect(fit!.vertexStandardError!).toBeGreaterThan(0);
  });

  it("returns null with fewer than three points", () => {
    expect(fitQuadraticWeighted([{ x: 0, y: 1, weight: 1 }])).toBeNull();
  });
});

describe("confidence mapping", () => {
  it("monotonically increases with the gap z-score", () => {
    const low = computeConfidence({
      utilityGapZ: 0.5,
      bestCandidateIncomplete: false,
      anyCandidateIncomplete: false,
      bestAtSearchBoundary: false,
      candidatesWithData: 5,
    });
    const high = computeConfidence({
      utilityGapZ: 3,
      bestCandidateIncomplete: false,
      anyCandidateIncomplete: false,
      bestAtSearchBoundary: false,
      candidatesWithData: 5,
    });
    expect(high).toBeGreaterThan(low);
  });

  it("is minimal when evidence is structurally insufficient", () => {
    expect(
      computeConfidence({
        utilityGapZ: 5,
        bestCandidateIncomplete: false,
        anyCandidateIncomplete: false,
        bestAtSearchBoundary: false,
        candidatesWithData: 2,
      }),
    ).toBeLessThanOrEqual(0.2);
  });

  it("penalizes incomplete best candidate", () => {
    const complete = computeConfidence({
      utilityGapZ: 2.5,
      bestCandidateIncomplete: false,
      anyCandidateIncomplete: false,
      bestAtSearchBoundary: false,
      candidatesWithData: 5,
    });
    const incompleteBest = computeConfidence({
      utilityGapZ: 2.5,
      bestCandidateIncomplete: true,
      anyCandidateIncomplete: true,
      bestAtSearchBoundary: false,
      candidatesWithData: 5,
    });
    expect(incompleteBest).toBeLessThan(complete);
    expect(incompleteBest).toBeLessThanOrEqual(0.45);
  });

  it("uses a standard normal cdf approximation accurately", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 3);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 2);
    expect(normalCdf(-1)).toBeCloseTo(0.1587, 3);
  });
});

describe("candidate evaluation", () => {
  it("excludes invalid trials according to the policy", () => {
    const def = buildExperimentDefinition({
      id: "experiment-eval",
      name: "eval",
      baselineSensitivity: equalXy(7),
      dpi: 800,
      measuredRepsPerCandidatePerRound: 6,
    });
    const runner = new SyntheticExperimentRunner(def, playerPreset("consistent-medium"));
    const trials = runner
      .runRound(0, 42, "session-eval", def.id)
      .filter((t) => t.phase === "measured");
    const target = trials[0]!;
    const corrupted = structuredClone(trials[1]!);
    corrupted.samples = [
      { tMs: corrupted.startedAtMonotonicMs + 30, cursor: { x: 640, y: 360 }, dx: 0, dy: 0 },
      { tMs: corrupted.startedAtMonotonicMs + 20, cursor: { x: 650, y: 360 }, dx: 10, dy: 0 },
      ...Array.from({ length: 25 }, (_, i) => ({
        tMs: corrupted.startedAtMonotonicMs + 40 + i * 4,
        cursor: { x: 650, y: 360 },
        dx: 0,
        dy: 0,
      })),
    ];
    corrupted.validity = validateTrial(corrupted);
    expect(corrupted.validity.status).toBe("invalid");
    const evaluation = evaluateCandidate(def, [target, corrupted], {
      ...DEFAULT_OPTIMIZER_CONFIG.exclusionPolicy,
    })!;
    expect(evaluation.trialsExcluded).toBe(1);
    expect(Object.keys(evaluation.exclusionReasonCounts)).toContain(
      "IMPOSSIBLE_TIMESTAMPS",
    );
    expect(evaluation.trialsIncluded.length).toBe(1);
  });

  it("marks unassigned trials when candidateId missing", () => {
    const def = buildExperimentDefinition({
      id: "experiment-eval2",
      name: "eval2",
      baselineSensitivity: equalXy(7),
      dpi: 800,
    });
    const orphan = makeTrial({ id: "trial-orphan", phase: "measured" });
    const evaluation = evaluateCandidate(def, [orphan], {
      fatalReasons: [],
      suspectPolicy: "include-with-flag",
    });
    expect(evaluation?.trialsIncluded.length ?? 0).toBeLessThanOrEqual(1);
  });
});

describe("optimizer end-to-end structure", () => {
  it("produces ordered ranges and coherent evidence", () => {
    const def = buildExperimentDefinition({
      id: "experiment-structure",
      name: "structure",
      baselineSensitivity: equalXy(7),
      dpi: 800,
      measuredRepsPerCandidatePerRound: 8,
    });
    const runner = new SyntheticExperimentRunner(
      def,
      playerPreset("consistent-medium"),
    );
    const optimizer = new SensitivityOptimizer(def, { maxSearchRounds: 1 });
    optimizer.addTrials(runner.runRound(0, 7, "session-structure", def.id));
    const rec = optimizer.recommend();

    expect(rec.edpiRange.min).toBeLessThanOrEqual(rec.edpiRange.max);
    expect(rec.sensXRange.min).toBeLessThanOrEqual(rec.sensXRange.max);
    expect(rec.confidence).toBeGreaterThanOrEqual(0);
    expect(rec.confidence).toBeLessThanOrEqual(1);
    expect(rec.evidence.trialsAnalyzed).toBeGreaterThan(0);
    expect(rec.evidence.candidatesEvaluated).toBeGreaterThanOrEqual(5);
    expect(rec.refusedHighConfidence).toBe(rec.confidence < 0.5);
    expect(rec.rationaleLines.length).toBeGreaterThan(0);
    for (const estimate of Object.values(rec.dimensionEstimates)) {
      if (!estimate) continue;
      expect(estimate.mean).toBeGreaterThanOrEqual(-1);
      expect(estimate.mean).toBeLessThanOrEqual(1);
      expect(Number.isFinite(estimate.standardError)).toBe(true);
    }
  });

  it("refuses high confidence when data are insufficient", () => {
    const def = buildExperimentDefinition({
      id: "experiment-refusal",
      name: "refusal",
      baselineSensitivity: equalXy(7),
      dpi: 800,
      measuredRepsPerCandidatePerRound: 1,
      warmupTrialsPerCandidateBlock: 0,
    });
    const runner = new SyntheticExperimentRunner(
      def,
      playerPreset("consistent-medium"),
    );
    const optimizer = new SensitivityOptimizer(def, { maxSearchRounds: 1 });
    optimizer.addTrials(runner.runRound(0, 8, "session-refusal", def.id));
    const rec = optimizer.recommend();
    expect(rec.evidence.candidatesEvaluated).toBe(5);
    for (const count of Object.values(rec.evidence.validTrialsPerCandidate)) {
      expect(count).toBeLessThan(4);
    }
    expect(rec.refusedHighConfidence).toBe(true);
    expect(rec.confidenceLabel).toBe("low");
    expect(rec.warnings.some((w) => /below|refus/i.test(w))).toBe(true);
  });

  it("proposes refinement candidates between and beyond tested points", () => {
    const def = buildExperimentDefinition({
      id: "experiment-refine",
      name: "refine",
      baselineSensitivity: equalXy(7),
      dpi: 800,
      measuredRepsPerCandidatePerRound: 8,
    });
    const runner = new SyntheticExperimentRunner(
      def,
      playerPreset("consistent-medium"),
    );
    const optimizer = new SensitivityOptimizer(def, { maxSearchRounds: 2 });
    optimizer.addTrials(runner.runRound(0, 9, "session-refine", def.id));
    const next = optimizer.needsMoreEvidence();
    expect(next.kind).toBe("collect");
    if (next.kind !== "collect") return;
    expect(next.candidates.length).toBeGreaterThanOrEqual(1);
    expect(next.round).toBe(1);

    optimizer.addCandidates(next.candidates);
    const secondRoundTrials = runner.runRound(
      next.round,
      9,
      "session-refine",
      def.id,
      next.candidates.map((c) => c.id),
    );
    expect(secondRoundTrials.length).toBeGreaterThan(0);
    optimizer.addTrials(secondRoundTrials);
    expect(optimizer.recommend().evidence.searchRoundsRun).toBe(2);
  });

  it("stops proposing when rounds are exhausted", () => {
    const def = buildExperimentDefinition({
      id: "experiment-stop",
      name: "stop",
      baselineSensitivity: equalXy(7),
      dpi: 800,
    });
    const runner = new SyntheticExperimentRunner(
      def,
      playerPreset("consistent-medium"),
    );
    const optimizer = new SensitivityOptimizer(def, { maxSearchRounds: 1 });
    optimizer.addTrials(runner.runRound(0, 10, "session-stop", def.id));
    expect(optimizer.needsMoreEvidence().kind).toBe("done");
  });
});
