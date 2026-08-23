import type { CandidateEvaluation } from "./evaluate.ts";
import { fitQuadraticWeighted } from "./quadratic.ts";

/**
 * Model adequacy for the sensitivity–performance curve (Pass 4, requirement H).
 *
 * A quadratic surrogate is only trusted when the observed geometry supports
 * one. These diagnostics identify five shapes and force honest result types:
 *
 *   - single-smooth-optimum : parabola adequate, vertex usable
 *   - broad-plateau         : no significant slope or curvature
 *   - monotonic-boundary    : utility trends monotonically toward an edge;
 *                             a naive parabola would fabricate an interior peak
 *   - multimodal-inconsistent: ≥2 separated local maxima among tested points
 *   - insufficient          : too few distinct tested positions
 */

export type CurveShape =
  | "single-smooth-optimum"
  | "broad-plateau"
  | "monotonic-boundary"
  | "multimodal-inconsistent"
  | "asymmetric-optimum"
  | "insufficient";

export type CurveSearchResult =
  | { kind: "point"; octaves: number; standardError: number | null }
  | { kind: "plateau"; octavesMin: number; octavesMax: number }
  | { kind: "unresolved-boundary"; direction: "low" | "high"; bestTestedOctaves: number }
  | { kind: "inconsistent"; detail: string }
  | { kind: "insufficient"; detail: string };

export interface CurveAdequacy {
  shape: CurveShape;
  result: CurveSearchResult;
  /** True when a quadratic vertex may be used as the point estimate. */
  vertexUsable: boolean;
  asymmetryRatio: number | null;
  diagnostics: string[];
}

export interface AdequacyOptions {
  /** |t| threshold for treating curvature/slope as significant. */
  significanceT?: number;
  /** Minimum distinct candidate positions for any curve inference. */
  minPoints?: number;
}

interface FitPoint {
  x: number;
  y: number;
  weight: number;
}

function weightedLinearFit(points: readonly FitPoint[]): {
  slope: number;
  intercept: number;
  slopeSe: number | null;
} | null {
  if (points.length < 2) return null;
  let sw = 0;
  let sxx = 0;
  let sx = 0;
  let sxy = 0;
  let sy = 0;
  for (const p of points) {
    const w = p.weight > 0 ? p.weight : 0;
    sw += w;
    sxx += w * p.x * p.x;
    sx += w * p.x;
    sxy += w * p.x * p.y;
    sy += w * p.y;
  }
  const det = sw * sxx - sx * sx;
  if (!(Math.abs(det) > 1e-14)) return null;
  const slope = (sw * sxy - sx * sy) / det;
  const intercept = (sy - slope * sx) / sw;
  // Residual variance for slope SE (weighted).
  let rss = 0;
  let dof = -2;
  for (const p of points) {
    rss += Math.max(p.weight, 0) * (p.y - (slope * p.x + intercept)) ** 2;
    dof += 1;
  }
  const varSlope =
    points.length > 2 && rss > 0 ? (rss / dof) * (sw / det) : null;
  return {
    slope,
    intercept,
    slopeSe: varSlope !== null && varSlope > 0 ? Math.sqrt(varSlope) : null,
  };
}

/**
 * Analyzes the tested (log2-eDPI, utility) geometry. Deterministic pure
 * function of the evaluations.
 */
export function analyzeCurveAdequacy(
  evals: readonly CandidateEvaluation[],
  options: AdequacyOptions = {},
): CurveAdequacy {
  const tSig = options.significanceT ?? 2;
  const minPoints = options.minPoints ?? 4;
  const diagnostics: string[] = [];

  const points: FitPoint[] = evals
    .filter((e) => e.trialsIncluded.length > 0 && Number.isFinite(e.utilityMean))
    .map((e) => ({
      x: e.log2RatioVsBaseline,
      y: e.utilityMean,
      weight:
        Number.isFinite(e.utilityStandardError) && e.utilityStandardError > 0
          ? 1 / (e.utilityStandardError ** 2)
          : 1e-6,
    }))
    .sort((a, b) => a.x - b.x);

  const distinctX = new Set(points.map((p) => p.x.toFixed(6))).size;

  if (distinctX < minPoints || points.length < minPoints) {
    diagnostics.push(
      `only ${distinctX} distinct tested position(s); curve shape cannot be inferred`,
    );
    return {
      shape: "insufficient",
      result: { kind: "insufficient", detail: `${distinctX} distinct positions` },
      vertexUsable: false,
      asymmetryRatio: null,
      diagnostics,
    };
  }

  // Local-maxima scan on the tested means (multimodality check).
  let localMaxima = 0;
  for (let i = 1; i < points.length - 1; i++) {
    if (points[i]!.y > points[i - 1]!.y && points[i]!.y > points[i + 1]!.y) {
      localMaxima++;
    }
  }
  if (localMaxima >= 2) {
    diagnostics.push(
      `${localMaxima} separated local maxima among tested candidates; evidence is multimodal/inconsistent`,
    );
    return {
      shape: "multimodal-inconsistent",
      result: { kind: "inconsistent", detail: `${localMaxima} local maxima` },
      vertexUsable: false,
      asymmetryRatio: null,
      diagnostics,
    };
  }

  // Monotonicity check on the mean sequence (boundary-trend detector).
  const diffs: number[] = [];
  for (let i = 1; i < points.length; i++) diffs.push(points[i]!.y - points[i - 1]!.y);
  const allNonDecreasing = diffs.every((d) => d >= 0);
  const allNonIncreasing = diffs.every((d) => d <= 0);
  const strictlyMoving = diffs.some((d) => Math.abs(d) > 1e-9);

  if ((allNonDecreasing || allNonIncreasing) && strictlyMoving) {
    const direction: "low" | "high" = allNonDecreasing ? "high" : "low";
    diagnostics.push(
      `utility is monotonic ${direction === "high" ? "increasing" : "decreasing"} across the tested range; the optimum may lie beyond the boundary`,
    );
    const bestX = allNonDecreasing ? points[points.length - 1]!.x : points[0]!.x;
    return {
      shape: "monotonic-boundary",
      result: { kind: "unresolved-boundary", direction, bestTestedOctaves: bestX },
      vertexUsable: false,
      asymmetryRatio: null,
      diagnostics,
    };
  }

  // Curvature significance decides optimum vs plateau vs boundary trend.
  // (A symmetric parabola has ≈zero net slope, so slope alone cannot be the
  // discriminator.)
  const quadFit = fitQuadraticWeighted(points);
  const curvatureT =
    quadFit && quadFit.a < 0 && quadFit.standardErrorA !== null && quadFit.standardErrorA > 0
      ? Math.abs(quadFit.a / quadFit.standardErrorA)
      : 0;

  if (!(quadFit && curvatureT >= tSig)) {
    // No significant concave curvature. A significant linear trend means the
    // evidence is boundary-dominated even if a tiny dip breaks strict
    // monotonicity; otherwise this is a plateau.
    const linear = weightedLinearFit(points);
    const slopeT =
      linear?.slopeSe != null && linear.slopeSe > 0
        ? Math.abs(linear.slope / linear.slopeSe)
        : 0;
    if (linear && slopeT >= tSig) {
      const direction: "low" | "high" = linear.slope > 0 ? "high" : "low";
      diagnostics.push(
        `no significant curvature but significant ${direction === "high" ? "rising" : "falling"} trend (t=${slopeT.toFixed(1)}); optimum likely lies beyond the ${direction} boundary`,
      );
      const argmaxIdx2 = points.reduce(
        (best, p, i) => (p.y > points[best]!.y ? i : best),
        0,
      );
      return {
        shape: "monotonic-boundary",
        result: {
          kind: "unresolved-boundary",
          direction,
          bestTestedOctaves: points[argmaxIdx2]!.x,
        },
        vertexUsable: false,
        asymmetryRatio: null,
        diagnostics,
      };
    }
    diagnostics.push(
      "neither curvature nor slope is significant; evidence supports a plateau rather than a sharp optimum",
    );
    const xs = points.map((p) => p.x);
    return {
      shape: "broad-plateau",
      result: { kind: "plateau", octavesMin: Math.min(...xs), octavesMax: Math.max(...xs) },
      vertexUsable: false,
      asymmetryRatio: null,
      diagnostics,
    };
  }

  // Asymmetry probe: compare mean gain moving right vs left away from the argmax.
  const argmaxIdx = points.reduce(
    (best, p, i) => (p.y > points[best]!.y ? i : best),
    0,
  );
  const leftDeltas: number[] = [];
  for (let i = argmaxIdx; i > 0; i--) leftDeltas.push(points[argmaxIdx]!.y - points[i - 1]!.y);
  const rightDeltas: number[] = [];
  for (let i = argmaxIdx; i + 1 < points.length; i++) rightDeltas.push(points[argmaxIdx]!.y - points[i + 1]!.y);
  const leftMean = leftDeltas.length > 0 ? leftDeltas.reduce((a, b) => a + b, 0) / leftDeltas.length : null;
  const rightMean = rightDeltas.length > 0 ? rightDeltas.reduce((a, b) => a + b, 0) / rightDeltas.length : null;
  let asymmetryRatio: number | null = null;
  if (leftMean !== null && rightMean !== null && Math.min(leftMean, rightMean) > 1e-9) {
    asymmetryRatio = Math.max(leftMean, rightMean) / Math.min(leftMean, rightMean);
    if (asymmetryRatio >= 2) {
      diagnostics.push(
        `curve falls off asymmetrically around the best candidate (fall-off ratio ${asymmetryRatio.toFixed(1)}×)`,
      );
    }
  }

  // Interior single optimum: report the best tested position as the point.
  // The quadratic vertex refinement happens in the optimizer ONLY when its own
  // adequacy checks (significant curvature + interior vertex) pass; this module
  // deliberately returns the empirical argmax so bad geometry never produces a
  // precise fabricated value.
  diagnostics.push("single interior optimum supported by the tested geometry");
  return {
    shape: asymmetryRatio !== null && asymmetryRatio >= 2 ? "asymmetric-optimum" : "single-smooth-optimum",
    result: {
      kind: "point",
      octaves: points[argmaxIdx]!.x,
      standardError: null,
    },
    vertexUsable: true,
    asymmetryRatio,
    diagnostics,
  };
}
