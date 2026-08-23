import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CHAIN_DEPTH,
  detectRetestTriggers,
  planNextTest,
  planRetestSession,
} from "../src/session/retest.ts";
import type { ExperimentDefinition } from "../src/domain/experiment.ts";
import type { Recommendation } from "../src/domain/recommendation.ts";
import { buildExperimentDefinition } from "../src/experiments/protocol.ts";
import { DEFAULT_SAFE_RANGE } from "../src/domain/candidate.ts";
import { Rng } from "../src/util/rng.ts";

/**
 * Pass 6 retest-policy torture tests (requirement 7).
 *
 * Thousands of synthetic endings — including adversarial field values — are
 * pushed through detectRetestTriggers / planNextTest / chained re-planning.
 * Every plan must be coherent: bounded candidate sets inside the safe range,
 * fresh blinding, correct lineage, rest gating honored, and chains TERMINATE
 * (defer to human review) instead of looping forever.
 */

function makeDefinition(seed: number): ExperimentDefinition {
  return buildExperimentDefinition({
    id: `experiment-torture-${seed}` as never,
    name: `torture ${seed}`,
    baselineSensitivity: { sensX: 7, sensY: 7 },
    dpi: 800,
    orderSeed: seed,
    randomizeOrder: true,
    measuredRepsPerCandidatePerRound: 4,
    warmupTrialsPerCandidateBlock: 1,
  });
}

let idCounter = 0;
function makeRecommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  idCounter++;
  return {
    experimentId: `experiment-torture-src-${idCounter}`,
    primarySensitivity: { sensX: 7.5, sensY: 7.5 },
    recommendedEdpi: 6000,
    sensXRange: { min: 5.2, max: 9.8 },
    edpiRange: { min: 4160, max: 7840 },
    confidence: 0.55,
    confidenceLabel: "moderate",
    dimensionEstimates: {},
    utilityWeights: {
      speed: 0.14,
      accuracy: 0.28,
      overshootControl: 0.11,
      undershootControl: 0.11,
      correctionEfficiency: 0.12,
      trackingPrecision: 0.14,
      consistency: 0.1,
    },
    evidence: {
      trialsAnalyzed: 60,
      trialsExcluded: 0,
      exclusionReasonCounts: {},
      candidatesEvaluated: 5,
      validTrialsPerCandidate: { a: 12, b: 12, c: 12, d: 12, e: 12 },
      bestCandidateId: "cand-baseline",
      runnerUpCandidateId: "cand-fp15",
      utilityGapBestVsRunnerUp: 0.03,
      utilityGapZScore: 1.2,
      separation: "weak",
      searchRoundsRun: 2,
      notes: [],
    },
    warnings: [],
    refusedHighConfidence: false,
    rationaleLines: [],
    unresolvedBoundary: false,
    furtherTestingSuggested: false,
    ...overrides,
  };
}

const CHAIN_CASES = 2000;

describe("retest trigger detection over synthetic space", () => {
  it("classifies thousands of recommendation shapes without throwing", () => {
    const rng = new Rng(424242);
    for (let i = 0; i < CHAIN_CASES; i++) {
      const rec = makeRecommendation({
        confidence: rng.pick([0, 0.2, 0.45, 0.5, 0.65, 0.8, 0.99]),
        unresolvedBoundary: rng.bernoulli(0.5),
        refusedHighConfidence: rng.bernoulli(0.3),
        furtherTestingSuggested: rng.bernoulli(0.5),
        curveAdequacy: {
          shape: rng.pick([
            "single-smooth-optimum",
            "broad-plateau",
            "multimodal-inconsistent",
            "monotonic-boundary",
            "asymmetric-optimum",
            "insufficient",
          ]),
          result: { kind: "insufficient", detail: "" },
          vertexUsable: false,
          asymmetryRatio: null,
          diagnostics: [],
        },
        captureQualitySession: rng.bernoulli(0.3)
          ? ({ retestingNecessary: true } as never)
          : undefined,
        changePointAnalysis: rng.bernoulli(0.3)
          ? ({ contaminationDetected: true } as never)
          : undefined,
        jointXY: rng.bernoulli(0.3)
          ? ({ outcome: "asymmetry-unresolved" } as never)
          : undefined,
        edpiRange: {
          min: rng.range(1000, 5000),
          max: rng.range(5000, 12000),
        },
      });
      expect(() => detectRetestTriggers(rec, { calibrationStale: rng.bernoulli(0.3) })).not.toThrow();
    }
  });

  it("never triggers retests on clean recommendations", () => {
    for (let i = 0; i < 200; i++) {
      const rec = makeRecommendation({
        confidence: 0.85,
        unresolvedBoundary: false,
        refusedHighConfidence: false,
        furtherTestingSuggested: false,
        evidence: {
          ...makeRecommendation().evidence,
          separation: "clear",
        },
      });
      expect(detectRetestTriggers(rec)).toEqual([]);
      expect(planNextTest(makeDefinition(i), rec, {})).toBeNull();
    }
  });
});

describe("planNextTest coherence over adversarial endings", () => {
  it("produces bounded, safe-range plans for thousands of endings", () => {
    const rng = new Rng(777_777);
    let plansBuilt = 0;
    for (let i = 0; i < CHAIN_CASES; i++) {
      const degenerateRange = rng.bernoulli(0.1);
      const rec = makeRecommendation({
        confidence: rng.pick([0.1, 0.42, 0.49, 0.51, 0.75]),
        unresolvedBoundary: rng.bernoulli(0.6),
        curveAdequacy: {
          shape: rng.pick(["broad-plateau", "monotonic-boundary", "single-smooth-optimum"]),
          result: { kind: "insufficient", detail: "" },
          vertexUsable: false,
          asymmetryRatio: null,
          diagnostics: [],
        },
        edpiRange: degenerateRange
          ? { min: 5600, max: 5600 }
          : { min: rng.range(3000, 5500), max: rng.range(5700, 11000) },
      });
      const definition = makeDefinition(i + 10_000);
      const plan = planNextTest(definition, rec, {});
      if (plan === null) continue;
      plansBuilt++;
      expect(["targeted-retest", "repeat-session", "none"]).toContain(plan.kind);
      if (plan.definition !== null) {
        expect(plan.definition.candidates.length).toBeGreaterThanOrEqual(2);
        expect(plan.definition.candidates.length).toBeLessThanOrEqual(12);
        for (const c of plan.definition.candidates) {
          expect(c.sensitivity.sensX).toBeGreaterThanOrEqual(DEFAULT_SAFE_RANGE.minSensX - 1e-9);
          expect(c.sensitivity.sensX).toBeLessThanOrEqual(DEFAULT_SAFE_RANGE.maxSensX + 1e-9);
          expect(c.id).not.toContain("undefined");
          // Blinding: any present label never leaks sensitivity values or prior ids.
          const label = (c.origin as { label?: unknown }).label;
          if (typeof label === "string") {
            expect(label).not.toMatch(/\d{4,}/);
          }
        }
        const ids = new Set(plan.definition.candidates.map((c) => c.id));
        expect(ids.size).toBe(plan.definition.candidates.length);
        // Lineage is preserved in the name/notes.
        expect(
          plan.definition.name.includes(definition.name.split(" ")[0]!) ||
            (plan.definition.notes ?? "").length > 0,
        ).toBe(true);
      }
      if (plan.kind === "none") {
        expect(plan.definition).toBeNull();
      }
      expect(Number.isFinite(Date.parse(plan.earliestStartIso)) || plan.earliestStartIso === "").toBe(true);
    }
    expect(plansBuilt).toBeGreaterThan(CHAIN_CASES / 2);
  });

  it("handles extreme numeric fields without producing insane plans", () => {
    const extremes = [
      { edpiRange: { min: 0, max: Number.MAX_VALUE } },
      { edpiRange: { min: 1e-9, max: 1e-6 } },
      { edpiRange: { min: 5600, max: 5600 } },
      { edpiRange: { min: -1000, max: -10 } },
      { confidence: 1e9 },
      { confidence: -1e9 },
    ];
    for (const ext of extremes) {
      const rec = makeRecommendation({ unresolvedBoundary: true, ...ext } as never);
      const plan = planNextTest(makeDefinition(1), rec, {});
      if (plan?.definition) {
        for (const c of plan.definition.candidates) {
          expect(Number.isFinite(c.sensitivity.sensX)).toBe(true);
          expect(c.sensitivity.sensX).toBeGreaterThanOrEqual(DEFAULT_SAFE_RANGE.minSensX - 1e-9);
          expect(c.sensitivity.sensX).toBeLessThanOrEqual(DEFAULT_SAFE_RANGE.maxSensX + 1e-9);
        }
      }
    }
  });

  it("enforces the minimum rest between sessions", () => {
    const rec = makeRecommendation({ confidence: 0.3 });
    const plan = planNextTest(makeDefinition(2), rec, {
      priorSessionEndedAtIso: "2026-08-23T10:00:00.000Z",
      nowIso: "2026-08-23T10:10:00.000Z",
    });
    expect(plan!.canStartNow).toBe(false);
    expect(plan!.earliestStartIso).toBe("2026-08-23T10:30:00.000Z");
    const later = planNextTest(makeDefinition(2), rec, {
      priorSessionEndedAtIso: "2026-08-23T10:00:00.000Z",
      nowIso: "2026-08-23T11:00:00.000Z",
    });
    expect(later!.canStartNow).toBe(true);
  });
});

describe("retest chain termination (loop prevention)", () => {
  it("chains terminate by deferring instead of looping forever", () => {
    // A pathological player whose EVERY session ends at an unresolved upper
    // boundary would previously generate endless narrow/retest cycles.
    const rng = new Rng(31337);
    for (let trial = 0; trial < 400; trial++) {
      let depth = 0;
      let definition = makeDefinition(trial + 50_000);
      let steps = 0;
      while (steps < 20) {
        steps++;
        const rec = makeRecommendation({
          confidence: 0.4,
          unresolvedBoundary: true,
          edpiRange: {
            min: 5600 + depth * rng.range(500, 1500),
            max: 9000 + depth * rng.range(500, 1500),
          },
        });
        const plan = planNextTest(definition, rec, { chainDepth: depth });
        if (plan === null) break;
        if (depth >= DEFAULT_MAX_CHAIN_DEPTH) {
          expect(plan.kind).toBe("none");
          expect(plan.definition).toBeNull();
          expect(plan.rationaleLines.join(" ")).toMatch(/manual review/i);
          break;
        }
        expect(plan.definition).not.toBeNull();
        definition = plan.definition!;
        depth++;
      }
      expect(steps).toBeLessThan(20);
    }
  });

  it("chains also stop when every ending keeps requesting clean repeats", () => {
    let depth = 0;
    let definition = makeDefinition(90_000);
    while (depth <= DEFAULT_MAX_CHAIN_DEPTH + 1) {
      const rec = makeRecommendation({
        confidence: 0.35,
        curveAdequacy: {
          shape: "broad-plateau",
          result: { kind: "insufficient", detail: "" },
          vertexUsable: false,
          asymmetryRatio: null,
          diagnostics: [],
        },
      });
      const plan = planNextTest(definition, rec, { chainDepth: depth });
      if (plan === null) break;
      if (depth >= DEFAULT_MAX_CHAIN_DEPTH) {
        expect(plan.kind).toBe("none");
        break;
      }
      definition = plan.definition!;
      depth++;
    }
    expect(depth).toBeLessThanOrEqual(DEFAULT_MAX_CHAIN_DEPTH + 1);
  });
});

describe("legacy targeted retest planner", () => {
  it("refuses degenerate ranges and stays within safe bounds otherwise", () => {
    const degenerate = makeRecommendation({ edpiRange: { min: 5600, max: 5600 } });
    expect(planRetestSession(makeDefinition(7), degenerate)).toBeNull();

    const wide = makeRecommendation({ edpiRange: { min: 4400, max: 7200 } });
    const plan = planRetestSession(makeDefinition(7), wide);
    expect(plan).not.toBeNull();
    for (const c of plan!.definition.candidates) {
      expect(c.sensitivity.sensX).toBeGreaterThanOrEqual(DEFAULT_SAFE_RANGE.minSensX - 1e-9);
      expect(c.sensitivity.sensX).toBeLessThanOrEqual(DEFAULT_SAFE_RANGE.maxSensX + 1e-9);
    }
  });
});
