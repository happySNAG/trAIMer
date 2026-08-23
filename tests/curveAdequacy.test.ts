import { describe, expect, it } from "vitest";
import { analyzeCurveAdequacy } from "../src/optimizer/adequacy.ts";
import { fitQuadraticWeighted } from "../src/optimizer/quadratic.ts";
import type { CandidateEvaluation } from "../src/optimizer/evaluate.ts";
import type { SensitivityCandidate } from "../src/domain/candidate.ts";

function evalAt(
  octaves: number,
  utility: number,
  se = 0.01,
): CandidateEvaluation {
  const candidate: SensitivityCandidate = {
    id: `cand-${octaves.toFixed(3)}` as never,
    sensitivity: { sensX: 7 * Math.pow(2, octaves), sensY: 7 * Math.pow(2, octaves) },
    origin: { kind: "generated", multiplicativeFactorVsBaseline: Math.pow(2, octaves) },
  };
  return {
    candidateId: candidate.id,
    candidate,
    edpi: 800 * candidate.sensitivity.sensX,
    log2RatioVsBaseline: octaves,
    trialsIncluded: new Array(8).fill(null).map((_, i) => ({ id: `t${i}` })) as never,
    trialsExcluded: 0,
    exclusionReasonCounts: {},
    dimensionEstimates: {},
    perTrialUtilities: [],
    utilityMean: utility,
    utilityStandardError: se,
    consistencyScore: 1,
    flaggedSuspectCount: 0,
  };
}

describe("model adequacy: synthetic campaigns that fool a naive quadratic fit", () => {
  it("clean parabola → single-smooth-optimum, vertex usable", () => {
    const peak = 0;
    const evals = [-0.4, -0.2, 0, 0.2, 0.4].map((x) =>
      evalAt(x, 0.5 - 1.2 * 0.5 * (x - peak) ** 2),
    );
    const a = analyzeCurveAdequacy(evals);
    expect(a.shape).toBe("single-smooth-optimum");
    expect(a.result.kind).toBe("point");
    if (a.result.kind === "point") expect(a.result.octaves).toBeCloseTo(peak, 9);
    expect(a.vertexUsable).toBe(true);
  });

  it("monotone increasing data → unresolved boundary even though a parabola would fabricate an interior vertex", () => {
    // Strictly increasing, concave-down sequence — the weighted quadratic on
    // these exact points is concave (a<0) with an interior vertex that is pure
    // fabrication; the true curve just keeps rising past the boundary.
    const evals = [
      evalAt(-0.4, 0.400),
      evalAt(-0.2, 0.455),
      evalAt(0.0, 0.496),
      evalAt(0.2, 0.520),
      evalAt(0.4, 0.512 + 0.02), // keep strictly increasing: 0.532
    ];
    for (let i = 1; i < evals.length; i++) {
      expect(evals[i]!.utilityMean).toBeGreaterThan(evals[i - 1]!.utilityMean);
    }
    const a = analyzeCurveAdequacy(evals);
    expect(a.shape).toBe("monotonic-boundary");
    expect(a.result.kind).toBe("unresolved-boundary");
    if (a.result.kind === "unresolved-boundary") {
      expect(a.result.direction).toBe("high");
      expect(a.result.bestTestedOctaves).toBeCloseTo(0.4, 9);
    }
    expect(a.vertexUsable).toBe(false);

    // Prove the naive quadratic WOULD have been fooled: it fabricates a
    // precise peak (a<0 ⇒ a vertex exists) at/just beyond the tested edge,
    // which a naive optimizer would quote as "the optimum".
    const fit = fitQuadraticWeighted(
      evals.map((e) => ({
        x: e.log2RatioVsBaseline,
        y: e.utilityMean,
        weight: 1 / e.utilityStandardError ** 2,
      })),
    )!;
    expect(fit.a).toBeLessThan(0); // concave ⇒ a precise-looking vertex exists
    expect(fit.vertexX).not.toBeNull();
    if (fit.vertexX !== null) {
      expect(fit.vertexX).toBeGreaterThan(0); // on the rising side…
      expect(fit.vertexX).toBeLessThan(1.0);  // …and finite/quotable
    }
  });

  it("multimodal evidence (two separated humps) → inconsistent, never a precise optimum", () => {
    const evals = [
      evalAt(-0.5, 0.40),
      evalAt(-0.25, 0.55),
      evalAt(0, 0.35),
      evalAt(0.25, 0.56),
      evalAt(0.5, 0.38),
    ];
    const a = analyzeCurveAdequacy(evals);
    expect(a.shape).toBe("multimodal-inconsistent");
    expect(a.result.kind).toBe("inconsistent");
    expect(a.vertexUsable).toBe(false);
  });

  it("flat plateau → plateau interval spanning tested range", () => {
    const evals = [-0.3, -0.15, 0, 0.15, 0.3].map(
      (x, i) => evalAt(x, 0.50 + ((i % 2 === 0 ? 1 : -1) * 0.002), 0.02),
    );
    const a = analyzeCurveAdequacy(evals);
    expect(a.shape).toBe("broad-plateau");
    expect(a.result).toMatchObject({ kind: "plateau", octavesMin: -0.3, octavesMax: 0.3 });
    expect(a.vertexUsable).toBe(false);
  });

  it("asymmetric fall-off is detected and reported", () => {
    // Sharp drop left of the peak, gentle drop right.
    const evals = [
      evalAt(-0.45, 0.10),
      evalAt(-0.15, 0.44),
      evalAt(0, 0.50),
      evalAt(0.2, 0.47),
      evalAt(0.45, 0.38),
    ];
    const a = analyzeCurveAdequacy(evals);
    expect(a.asymmetryRatio).not.toBeNull();
    expect(a.asymmetryRatio!).toBeGreaterThan(2);
    expect(a.shape === "asymmetric-optimum" || a.shape === "single-smooth-optimum").toBe(true);
  });

  it("too few distinct positions → insufficient", () => {
    const a = analyzeCurveAdequacy([evalAt(0, 0.5), evalAt(0.2, 0.52), evalAt(0.21, 0.51)]);
    expect(a.shape).toBe("insufficient");
    expect(a.result.kind).toBe("insufficient");
  });
});
