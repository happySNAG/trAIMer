import type { ConfidenceLabel } from "../domain/recommendation.ts";
import { clamp } from "../metrics/stats.ts";

export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly =
    t *
    (0.319381530 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const cdf = 1 - (Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI)) * poly;
  return z >= 0 ? cdf : 1 - cdf;
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
  if (input.candidatesWithData < 3 || input.utilityGapZ === null) {
    return 0.15;
  }
  let confidence = clamp(2 * (normalCdf(Math.abs(input.utilityGapZ)) - 0.5), 0, 1);
  if (input.anyCandidateIncomplete) confidence -= 0.15;
  if (input.bestCandidateIncomplete) confidence = Math.min(confidence, 0.45);
  if (input.bestAtSearchBoundary) confidence -= 0.1;
  return clamp(confidence, 0.05, 0.99);
}

export function labelForConfidence(confidence: number): ConfidenceLabel {
  if (confidence < CONFIDENCE_LABEL_THRESHOLDS.moderate) return "low";
  if (confidence < CONFIDENCE_LABEL_THRESHOLDS.high) return "moderate";
  return "high";
}
