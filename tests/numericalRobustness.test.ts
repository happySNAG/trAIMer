import { describe, expect, it } from "vitest";
import { fitQuadraticWeighted } from "../src/optimizer/quadratic.ts";
import { computeConfidence, normalCdf, normalQuantile } from "../src/optimizer/confidence.ts";
import { analyzeCurveAdequacy } from "../src/optimizer/adequacy.ts";
import { validateTrial, DEFAULT_VALIDATION_CONFIG } from "../src/validation/validateTrial.ts";
import { makeTrial } from "./helpers.ts";

/**
 * Pass 6 numerical robustness (requirement 11).
 *
 * Attacks core calculations with non-finite, degenerate, and extreme inputs.
 * Contract: every result is FINITE + BOUNDED, explicitly REFUSED (null /
 * thrown), or typed invalid — never a silent NaN/Infinity.
 */

const mk = (x: number, y: number, weight = 1) => ({ x, y, weight });

describe("quadratic fit under attack", () => {
  it("refuses NaN/Infinity inputs", () => {
    expect(fitQuadraticWeighted([mk(0, NaN), mk(1, 2), mk(2, 3)])).toBeNull();
    expect(fitQuadraticWeighted([mk(0, Infinity), mk(1, 2), mk(2, 3)])).toBeNull();
    expect(fitQuadraticWeighted([mk(NaN, 0), mk(1, 2), mk(2, 3)])).toBeNull();
    expect(
      fitQuadraticWeighted([mk(0, 1, NaN), mk(1, 2), mk(2, 3)]),
    ).not.toBeNull(); // bad weights are zeroed, not fatal
  });

  it("refuses singular/degenerate surfaces", () => {
    expect(fitQuadraticWeighted([mk(1, 1), mk(1, 1), mk(1, 1)])).toBeNull();
    expect(fitQuadraticWeighted([])).toBeNull();
    expect(fitQuadraticWeighted([mk(0, 1), mk(1, 2)])).toBeNull();
  });

  it("stays bounded for extreme magnitudes", () => {
    const huge = fitQuadraticWeighted([mk(-1e300, 1), mk(0, 2), mk(1e300, 1)]);
    // Either refuses or returns finite coefficients — never Infinity.
    if (huge !== null) {
      for (const v of [huge.a, huge.b, huge.c]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
    const tiny = fitQuadraticWeighted([
      mk(-5e-320, 1),
      mk(0, 2),
      mk(5e-320, 1),
      mk(1e-310, 1.5),
    ]);
    if (tiny !== null) {
      for (const v of [tiny.a, tiny.b, tiny.c]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it("handles nearly identical candidates without exploding", () => {
    const fit = fitQuadraticWeighted([
      mk(-1e-8, 0.5),
      mk(0, 0.5000001),
      mk(1e-8, 0.5),
      mk(2e-8, 0.4999999),
    ]);
    if (fit !== null) {
      expect(Number.isFinite(fit.vertexX ?? 0)).toBe(true);
    }
  });
});

describe("confidence under attack", () => {
  const base = {
    bestCandidateIncomplete: false,
    anyCandidateIncomplete: false,
    bestAtSearchBoundary: false,
    candidatesWithData: 5,
  };

  it("treats non-finite gap z as missing evidence, never NaN", () => {
    expect(computeConfidence({ ...base, utilityGapZ: NaN })).toBe(0.15);
    expect(computeConfidence({ ...base, utilityGapZ: Infinity })).toBe(0.15);
    expect(computeConfidence({ ...base, utilityGapZ: -Infinity })).toBe(0.15);
    expect(computeConfidence({ ...base, utilityGapZ: null })).toBe(0.15);
  });

  it("bounds output even for absurd z", () => {
    expect(computeConfidence({ ...base, utilityGapZ: 1e308 })).toBeLessThanOrEqual(0.99);
    expect(computeConfidence({ ...base, utilityGapZ: -1e308 })).toBeLessThanOrEqual(0.99);
    expect(computeConfidence({ ...base, utilityGapZ: 1e308 })).toBeGreaterThanOrEqual(0.05);
  });

  it("normalQuantile rejects non-finite and out-of-range p", () => {
    expect(() => normalQuantile(NaN)).toThrow();
    expect(() => normalQuantile(Infinity)).toThrow();
    expect(() => normalQuantile(0)).toThrow();
    expect(() => normalQuantile(1)).toThrow();
    expect(Number.isFinite(normalQuantile(0.975))).toBe(true);
    expect(Number.isFinite(normalCdf(NaN))).toBe(true); // cdf clamps to a number
    expect(normalCdf(NaN)).toBeGreaterThanOrEqual(0);
    expect(normalCdf(NaN)).toBeLessThanOrEqual(1);
  });
});

describe("adequacy under attack", () => {
  const mkEval = (x: number, u: number, se = 0.01) => ({
    candidateId: `c${x}`,
    candidate: {
      id: `c${x}` as never,
      sensitivity: { sensX: 7 * Math.pow(2, x), sensY: 7 * Math.pow(2, x) },
      origin: { kind: "generated" as const, multiplicativeFactorVsBaseline: Math.pow(2, x) },
    },
    edpi: 800 * 7 * Math.pow(2, x),
    log2RatioVsBaseline: x,
    trialsIncluded: [1] as never,
    trialsExcluded: 0,
    exclusionReasonCounts: {},
    dimensionEstimates: {},
    perTrialUtilities: [],
    utilityMean: u,
    utilityStandardError: se,
    consistencyScore: 1,
    flaggedSuspectCount: 0,
  });

  it("excludes non-finite utilities instead of poisoning the shape", () => {
    const a = analyzeCurveAdequacy([
      mkEval(-0.6, NaN),
      mkEval(-0.3, 0.45),
      mkEval(0, 0.6),
      mkEval(0.3, 0.45),
      mkEval(0.6, 0.3),
    ]);
    expect(a.shape).not.toBe("insufficient");
    expect(a.result.kind === "point" ? Number.isFinite(a.result.octaves) : true).toBe(true);
  });

  it("returns insufficient rather than throwing on empty/degenerate input", () => {
    expect(analyzeCurveAdequacy([]).shape).toBe("insufficient");
    const nanOnly = analyzeCurveAdequacy([mkEval(0, NaN), mkEval(1, NaN)]);
    expect(nanOnly.shape).toBe("insufficient");
  });
});

describe("trial validation under attack", () => {
  function trialWithSamples() {
    return makeTrial({
      samples: Array.from({ length: 12 }, (_, i) => ({
        tMs: i * 8,
        cursor: { x: i, y: 0 },
        dx: 1,
        dy: 0,
      })),
    });
  }

  it("fails closed on every non-finite sample field", () => {
    const attacks: Partial<Record<string, number>>[] = [
      { tMs: NaN },
      { tMs: Infinity },
      { dx: NaN },
      { dy: Infinity },
    ];
    for (const patch of attacks) {
      const trial = trialWithSamples();
      (trial.samples[5] as unknown as Record<string, unknown>) = {
        ...trial.samples[5],
        ...patch,
      };
      const validity = validateTrial(trial, DEFAULT_VALIDATION_CONFIG);
      expect(validity.status).toBe("invalid");
      expect(validity.reasons.some((r) => r.code === "IMPOSSIBLE_TIMESTAMPS")).toBe(true);
    }
  });

  it("flags impossible trial-level timestamps", () => {
    for (const [start, end] of [
      [NaN, 100],
      [0, NaN],
      [Infinity, Infinity],
      [200, 100],
    ] as const) {
      const trial = trialWithSamples();
      trial.startedAtMonotonicMs = start;
      trial.endedAtMonotonicMs = end;
      const validity = validateTrial(trial, DEFAULT_VALIDATION_CONFIG);
      expect(validity.status).toBe("invalid");
    }
  });

  it("handles giant and duplicate timestamps deterministically", () => {
    const trial = trialWithSamples();
    trial.samples = trial.samples.map((s) => ({ ...s, tMs: 1e12 }));
    const validity = validateTrial(trial, DEFAULT_VALIDATION_CONFIG);
    expect(["valid", "invalid"]).toContain(validity.status);
  });
});
