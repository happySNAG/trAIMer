import { describe, expect, it } from "vitest";
import { fitPairedCandidateEffects } from "../src/optimizer/pairedFit.ts";
import {
  computeCellUtilities,
  computePairedComparisons,
} from "../src/optimizer/paired.ts";
import type { ExperimentDefinition } from "../src/domain/experiment.ts";
import type { SensitivityCandidate } from "../src/domain/candidate.ts";
import { DEFAULT_EXCLUSION_RULES } from "../src/experiments/protocol.ts";
import {
  buildUtilityTrials,
  utilityFromSeedTag,
  type SyntheticTrialSpec,
} from "./syntheticUtilities.ts";

const policy = {
  fatalReasons: DEFAULT_EXCLUSION_RULES.fatalReasons,
  suspectPolicy: "exclude" as const,
};

function definitionWith(ids: readonly string[]): ExperimentDefinition {
  return {
    id: "experiment-pairedfit" as never,
    name: "paired fit test",
    baselineSensitivity: { sensX: 7, sensY: 7 },
    dpi: 800,
    candidates: ids.map(
      (id): SensitivityCandidate => ({
        id: id as never,
        sensitivity: { sensX: 7, sensY: 7 },
        origin: { kind: "baseline" },
      }),
    ),
    scenarioMix: [],
    scenarioCatalog: [],
    warmupTrialsPerCandidateBlock: 0,
    measuredRepsPerCandidatePerRound: 8,
    randomizeOrder: false,
    orderSeed: 1,
    restBetweenCandidatesMs: 0,
    exclusionRules: DEFAULT_EXCLUSION_RULES,
    stoppingCriteria: {
      maxTotalMeasuredTrials: 10000,
      minValidTrialsPerCandidate: 2,
      maxSearchRounds: 1,
      targetUtilityCiHalfWidth: null,
    },
    adaptiveAllocation: {
      enabled: false,
      minRepsBeforeAdaptive: 8,
      contenderZThreshold: 2,
      controlRefreshEveryRounds: 2,
    },
    fatigueProtocol: {
      maxContinuousTestingMs: 600000,
      restDurationMs: 1000,
      degradationWindowTrials: 6,
      degradationRatioThreshold: 1.25,
    },
    yExploration: { enabled: false, yFactors: [], minImprovementZ: 2 },
  };
}

function specsFor(
  ids: readonly string[],
  scenarios: readonly string[],
  repsPerCell: number,
  utilityAt: (candidateIndex: number) => number,
): SyntheticTrialSpec[] {
  const specs: SyntheticTrialSpec[] = [];
  let seq = 0;
  for (const [ci] of ids.entries()) {
    for (const [si, scenarioId] of scenarios.entries()) {
      for (let rep = 0; rep < repsPerCell; rep++) {
        // Shared instance effect per cell — identical across candidates and
        // balanced (+/−) across reps so scenario means stay clean.
        const instanceEffect = (rep % 2 === 0 ? 1 : -1) * 0.01;
        specs.push({
          candidateId: ids[ci]!,
          scenarioId,
          repIndex: rep,
          indexInSession: seq++,
          utility: utilityAt(ci) + instanceEffect + (si === 0 ? -0.3 : 0.3),
        });
      }
    }
  }
  return specs;
}

function pairedFitOf(specs: readonly SyntheticTrialSpec[], ids: readonly string[]) {
  const trials = buildUtilityTrials(specs);
  const cellUtilities = computeCellUtilities(
    definitionWith(ids),
    trials,
    policy,
    undefined,
    utilityFromSeedTag,
  );
  const comparisons = computePairedComparisons(trials, cellUtilities);
  return fitPairedCandidateEffects(
    definitionWith(ids),
    trials,
    policy,
    comparisons,
    undefined,
    utilityFromSeedTag,
  )!;
}

describe("fully paired statistical fit", () => {
  it("shared scenario difficulty cannot shift the inferred optimum", () => {
    const ids = ["cand-lo", "cand-mid", "cand-hi"];
    // True utilities: mid is best. Scenario 0 is brutally hard (-0.3) but
    // shared identically by every candidate in every matching cell.
    const utilities = [0.3, 0.55, 0.4];
    const withHard = pairedFitOf(
      specsFor(ids, ["hard", "easy"], 5, (i) => utilities[i]!),
      ids,
    );
    const withoutHard = pairedFitOf(
      specsFor(ids, ["plain-a", "plain-b"], 5, (i) => utilities[i]!),
      ids,
    );
    const argmax = (
      fit: ReturnType<typeof pairedFitOf>,
    ): string => {
      const best = fit.estimates.reduce((a, b) => (b.effect > a.effect ? b : a));
      void best;
      const winner = fit.estimates.reduce((a, b) => (b.effect > a.effect ? b : a));
      return winner.candidateId;
    };
    expect(argmax(withHard)).toBe("cand-mid");
    expect(argmax(withoutHard)).toBe("cand-mid");
    // Effects themselves agree up to reference constant:
    const relEffects = (fit: ReturnType<typeof pairedFitOf>): number[] =>
      fit.estimates.map((e) => e.effect - Math.min(...fit.estimates.map((x) => x.effect)));
    const a = relEffects(withHard);
    const b = relEffects(withoutHard);
    for (let i = 0; i < ids.length; i++) {
      expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(1e-9);
    }
  });

  it("recovers pairwise contrasts within sampling error of the truth", () => {
    const ids = ["cand-a", "cand-b", "cand-c"];
    const utilities = [0.35, 0.42, 0.28];
    const fit = pairedFitOf(
      specsFor(ids, ["sc-1", "sc-2", "sc-3", "sc-4"], 6, (i) => utilities[i]!),
      ids,
    );
    const byId = new Map(fit.estimates.map((e) => [e.candidateId, e]));
    expect(byId.get("cand-a")!.effect).toBeCloseTo(0, 10);
    expect(byId.get("cand-b")!.effect).toBeCloseTo(0.07, 6);
    expect(byId.get("cand-c")!.effect).toBeCloseTo(-0.07, 6);
    expect(fit.diagnostics.pairsUsed.length).toBe(3);
    expect(fit.diagnostics.converged).toBe(true);
  });

  it("invalid and suspect-excluded trials never enter the paired system", () => {
    const good = specsFor(
      ["cand-a", "cand-b", "cand-x"],
      ["s1", "s2"],
      4,
      (i) => [0.35, 0.42, 0.28][i]!,
    );
    const poisoned: SyntheticTrialSpec[] = good.concat([
      {
        candidateId: "cand-a",
        scenarioId: "s1",
        repIndex: 0,
        indexInSession: 999,
        utility: -50,
        validity: "invalid",
      },
      {
        candidateId: "cand-b",
        scenarioId: "s2",
        repIndex: 1,
        indexInSession: 998,
        utility: -50,
        validity: "suspect",
      },
    ]);
    const fit = pairedFitOf(poisoned, ["cand-a", "cand-b", "cand-x"]);
    const byId = new Map(fit.estimates.map((e) => [e.candidateId, e]));
    // The −50 outliers were excluded, so the recovered contrasts match truth.
    expect(byId.get("cand-b")!.effect).toBeCloseTo(0.07, 6);
    expect(byId.get("cand-x")!.effect).toBeCloseTo(-0.07, 6);
  });

  it("returns null (explicit sparse fallback) when candidates cannot be connected", () => {
    const trials = buildUtilityTrials([
      {
        candidateId: "cand-solo",
        scenarioId: "s1",
        repIndex: 0,
        indexInSession: 0,
        utility: 0.5,
      },
    ]);
    const cellUtilities = computeCellUtilities(
      definitionWith(["cand-solo"]),
      trials,
      policy,
      undefined,
      utilityFromSeedTag,
    );
    const comparisons = computePairedComparisons(trials, cellUtilities);
    const fit = fitPairedCandidateEffects(
      definitionWith(["cand-solo"]),
      trials,
      policy,
      comparisons,
      undefined,
      utilityFromSeedTag,
    );
    expect(fit).toBeNull();
  });

  it("scenario difficulty effects are reported separately and cancel from rankings", () => {
    const fit = pairedFitOf(
      specsFor(
        ["cand-a", "cand-b", "cand-x"],
        ["s-hard", "s-easy"],
        4,
        (i) => [0.35, 0.42, 0.28][i]!,
      ),
      ["cand-a", "cand-b", "cand-x"],
    );
    const hard = fit.scenarioEffects.find((s) => s.scenarioId === "s-hard")!;
    const easy = fit.scenarioEffects.find((s) => s.scenarioId === "s-easy")!;
    expect(hard.effect).toBeLessThan(easy.effect);
    expect(easy.effect - hard.effect).toBeCloseTo(0.6, 5);
  });
});
