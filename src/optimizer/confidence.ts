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
  if (input.bestAtSearchBoundary) confidence -= 0.1;
  return clamp(confidence, 0.05, 0.99);
}

export function labelForConfidence(confidence: number): ConfidenceLabel {
  if (!Number.isFinite(confidence)) return "low";
  if (confidence < CONFIDENCE_LABEL_THRESHOLDS.moderate) return "low";
  if (confidence < CONFIDENCE_LABEL_THRESHOLDS.high) return "moderate";
  return "high";
}
