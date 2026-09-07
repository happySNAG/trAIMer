import type { ConfidenceLabel } from "../domain/recommendation.ts";
import { clamp } from "../metrics/stats.ts";

export function normalCdf(z: number): number {
  // Pass 6 numerical hardening: a non-finite z carries no evidence; map it
  // to the no-information center instead of propagating NaN.
  if (!Number.isFinite(z)) return 0.5;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly =
    t *
    (0.319381530 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const cdf = 1 - (Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI)) * poly;
  const value = z >= 0 ? cdf : 1 - cdf;
  return clamp(value, 0, 1);
}

export function normalQuantile(p: number): number {
  // Pass 6 numerical hardening: NaN must never flow through comparisons
  // (NaN < eps is always false) — reject non-finite p explicitly.
  if (!Number.isFinite(p) || p <= 0 || p >= 1) {
    throw new Error(`quantile requires p in (0,1), finite; got ${p}`);
  }
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - pLow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/**
 * Regularized incomplete beta function I_x(a, b), by continued fraction
 * (Lentz's algorithm). Deterministic, and the standard route to a Student-t
 * tail probability.
 */
function incompleteBeta(x: number, a: number, b: number): number {
  if (!(x > 0)) return 0;
  if (!(x < 1)) return 1;
  const lnBeta =
    lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front =
    Math.exp(Math.log(x) * a + Math.log1p(-x) * b - lnBeta) / a;
  // Symmetry keeps the continued fraction in its fast-converging region.
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - incompleteBeta(1 - x, b, a);
  }
  const TINY = 1e-30;
  let f = 1;
  let c = 1;
  let d = 0;
  for (let i = 0; i <= 300; i++) {
    const m = Math.floor(i / 2);
    let numerator: number;
    if (i === 0) {
      numerator = 1;
    } else if (i % 2 === 0) {
      numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    } else {
      numerator =
        (-((a + m) * (a + b + m) * x)) / ((a + 2 * m) * (a + 2 * m + 1));
    }
    d = 1 + numerator * d;
    if (Math.abs(d) < TINY) d = TINY;
    d = 1 / d;
    c = 1 + numerator / c;
    if (Math.abs(c) < TINY) c = TINY;
    const cd = c * d;
    f *= cd;
    if (Math.abs(1 - cd) < 1e-12) break;
  }
  return front * (f - 1);
}

/** Lanczos log-gamma. */
function lnGamma(z: number): number {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }
  const zz = z - 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) x += g[i]! / (zz + i + 1);
  const t = zz + g.length - 0.5;
  return (
    0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x)
  );
}

/** P(T <= t) for Student's t with `df` degrees of freedom. */
export function studentTCdf(t: number, df: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return 0.5;
  const x = df / (df + t * t);
  const tail = 0.5 * incompleteBeta(x, df / 2, 0.5);
  return t > 0 ? 1 - tail : tail;
}

/**
 * The normal z carrying the same evidence as a t statistic on `df` degrees of
 * freedom.
 *
 * A paired comparison over n cells produces mean/SE — a t statistic with
 * n − 1 degrees of freedom, NOT a normal z. Reading it as a z overstates the
 * evidence, and overstates it more the fewer cells there are: at 5 cells the
 * two-sided 95 % point is 2.78, not 1.96.
 *
 * This never mattered in 1.0.0-rc.7 because pairing was coincidental — the
 * paired path required 3 shared cells and usually did not have them, so the
 * optimizer fell back to the pooled comparison. Once pairing became a
 * property of the plan rather than of luck (src/experiments/protocol.ts), the
 * paired path became the normal case at 5, 8 or 16 cells, and the correction
 * became load-bearing: without it, a Quick session's five cells would be read
 * with the authority of an asymptotic sample.
 *
 * Measured over 40 seeds of the hardest honesty case (a noisy beginner whose
 * optimum sits at the ladder edge): coincidental pairing 6/40 overclaims,
 * by-construction pairing read as normal 9/40, by-construction pairing read
 * as t 4/40 — better than either, with a tighter point estimate than both.
 */
export function equivalentNormalZ(t: number, df: number): number {
  if (!Number.isFinite(t)) return 0;
  if (!Number.isFinite(df) || df <= 0) return 0;
  // Beyond this the two distributions agree to well inside the resolution of
  // any decision made from them.
  if (df >= 200) return t;
  const p = studentTCdf(t, df);
  const clamped = Math.min(1 - 1e-12, Math.max(1e-12, p));
  return normalQuantile(clamped);
}

export function dunnettAdjustedExclusionZ(candidateCount: number): number {
  const k = Math.max(candidateCount - 1, 1);
  return normalQuantile(1 - 0.05 / k);
}

export interface ConfidenceInput {
  utilityGapZ: number | null;
  bestCandidateIncomplete: boolean;
  anyCandidateIncomplete: boolean;
  bestAtSearchBoundary: boolean;
  candidatesWithData: number;
}

export const CONFIDENCE_LABEL_THRESHOLDS = {
  moderate: 0.5,
  high: 0.8,
} as const;

/**
 * Ceiling on confidence when the best candidate sits at the edge of the
 * tested ladder. Equal to the under-powered-candidate cap: both describe a
 * result whose uncertainty lies outside what the session measured.
 */
export const BOUNDARY_CONFIDENCE_CAP = 0.45;

export function computeConfidence(input: ConfidenceInput): number {
  // Pass 6 numerical hardening: a non-finite gap z must never yield a
  // non-finite confidence — treat it like missing evidence (floor value).
  const z =
    input.utilityGapZ !== null && Number.isFinite(input.utilityGapZ)
      ? input.utilityGapZ
      : null;
  if (input.candidatesWithData < 3 || z === null) {
    return 0.15;
  }
  let confidence = clamp(2 * (normalCdf(Math.abs(z)) - 0.5), 0, 1);
  if (input.anyCandidateIncomplete) confidence -= 0.15;
  if (input.bestCandidateIncomplete) confidence = Math.min(confidence, 0.45);
  // An unresolved search boundary is a CAP, not a deduction.
  //
  // When the winning candidate sits at the edge of the tested ladder, the
  // true optimum may lie outside everything that was measured — and no amount
  // of separation INSIDE the tested range is evidence about what is outside
  // it. rc.7 subtracted a flat 0.1, so a boundary run whose interior
  // candidates separated cleanly could still report high confidence in a
  // value the search had not bracketed. This is the same cap the engine
  // already applies when the best candidate is under-powered, for the same
  // reason: the number is not wrong, it is about the wrong question.
  if (input.bestAtSearchBoundary) {
    confidence = Math.min(confidence - 0.1, BOUNDARY_CONFIDENCE_CAP);
  }
  return clamp(confidence, 0.05, 0.99);
}

export function labelForConfidence(confidence: number): ConfidenceLabel {
  if (!Number.isFinite(confidence)) return "low";
  if (confidence < CONFIDENCE_LABEL_THRESHOLDS.moderate) return "low";
  if (confidence < CONFIDENCE_LABEL_THRESHOLDS.high) return "moderate";
  return "high";
}
