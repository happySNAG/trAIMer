import type { Recommendation } from "../domain/recommendation.ts";
import { CONFIDENCE_LABEL_THRESHOLDS } from "../optimizer/confidence.ts";
import type { RecommendationState } from "../experiments/sessionModes.ts";

/**
 * How strongly a sensitivity result may be presented.
 *
 * The rule this module exists to enforce: a low-confidence value must never
 * be shown with the visual authority of a strong one. rc.7 rendered the same
 * hero number, at the same size, whether the engine had 24 % evidence
 * strength or 90 % — the only difference was a small "PRELIMINARY" chip.
 *
 * Every tier below is derived from numbers the ENGINE already produces
 * (`confidence`, `confidenceLabel`, `refusedHighConfidence`, the candidate
 * completeness floor). Nothing new is invented, and no tier can be reached by
 * running fewer drills.
 */

export interface RecommendationPresentation {
  state: RecommendationState;
  /** The words above the number. Never softer than the evidence deserves. */
  title: string;
  /** One sentence a player can act on. */
  summary: string;
  /**
   * True when the plausible RANGE, not the point estimate, is the result.
   * The results screen leads with the range and de-emphasises the number.
   */
  emphasizeRange: boolean;
  /** Tone token for the UI. */
  tone: "ok" | "warn" | "danger" | "info";
  confidence: number;
}

export const RECOMMENDATION_STATE_TITLES: Record<RecommendationState, string> = {
  insufficient: "Not enough evidence yet",
  "directional-estimate": "Directional estimate",
  preliminary: "Preliminary recommendation",
  "moderate-confidence": "Moderate-confidence recommendation",
  "high-confidence": "High-confidence recommendation",
};

/**
 * Below this confidence a point estimate is not the result — the range is.
 *
 * It is the engine's own `low`/`moderate` boundary
 * (CONFIDENCE_LABEL_THRESHOLDS.moderate), not a second threshold invented
 * here, so the words, the colour and the layout can never disagree with the
 * label the optimizer chose.
 */
export const RANGE_FIRST_CONFIDENCE = CONFIDENCE_LABEL_THRESHOLDS.moderate;

/**
 * A directional estimate says only "your sensitivity should move this way".
 * Below this confidence, with a result the engine already declined to back,
 * that is genuinely all the data supports.
 */
export const DIRECTIONAL_ONLY_CONFIDENCE = 0.3;

export function classifyRecommendation(input: {
  recommendation: Recommendation | null;
  /** From `assessEvidenceSufficiency` — the hard floor, already applied. */
  evidenceSufficient: boolean;
  /** Set when the engine declined to stand behind the point estimate. */
  refusedHighConfidence?: boolean;
}): RecommendationPresentation {
  const rec = input.recommendation;
  if (!rec || !input.evidenceSufficient) {
    return {
      state: "insufficient",
      title: RECOMMENDATION_STATE_TITLES.insufficient,
      summary:
        "trAIMer will not name a sensitivity it cannot defend. Here is exactly what is missing.",
      emphasizeRange: false,
      tone: "warn",
      confidence: rec?.confidence ?? 0,
    };
  }

  const confidence = rec.confidence;
  const refused = input.refusedHighConfidence ?? rec.refusedHighConfidence;
  const label = rec.confidenceLabel;

  if (confidence < DIRECTIONAL_ONLY_CONFIDENCE) {
    return {
      state: "directional-estimate",
      title: RECOMMENDATION_STATE_TITLES["directional-estimate"],
      summary:
        "The evidence points in a direction but cannot pin down a value. Treat the range as the result, not the number.",
      emphasizeRange: true,
      tone: "danger",
      confidence,
    };
  }
  if (confidence < RANGE_FIRST_CONFIDENCE || label === "low") {
    return {
      state: "preliminary",
      title: RECOMMENDATION_STATE_TITLES.preliminary,
      summary:
        "A usable starting point, but the candidates are still close enough that more evidence could move it.",
      emphasizeRange: true,
      tone: "warn",
      confidence,
    };
  }
  if (confidence < CONFIDENCE_LABEL_THRESHOLDS.high || refused) {
    return {
      state: "moderate-confidence",
      title: RECOMMENDATION_STATE_TITLES["moderate-confidence"],
      summary: refused
        ? "The winner is clear, but a caveat in this session (see Advanced results) means the exact value should be confirmed."
        : "The winner separated from the others. Worth playing on, and worth confirming with one clean repeat.",
      emphasizeRange: false,
      tone: "info",
      confidence,
    };
  }
  return {
    state: "high-confidence",
    title: RECOMMENDATION_STATE_TITLES["high-confidence"],
    summary:
      "The winner separated clearly from every other candidate tested, with no open caveats in this session.",
    emphasizeRange: false,
    tone: "ok",
    confidence,
  };
}

/**
 * The one plain sentence about the player's aiming tendency.
 *
 * Deliberately refuses to speak when the numbers do not support a claim: two
 * tendencies within a few points of each other are not a tendency, they are
 * noise, and telling a player they "overshoot" on a 1-point difference is
 * exactly the kind of invented certainty this pass exists to remove.
 */
export const TENDENCY_MIN_SEPARATION = 0.03;

export function describeAimTendency(input: {
  overshootTendency: number | null;
  undershootTendency: number | null;
  validTrials: number;
  minTrials?: number;
}): { headline: string; detail: string; claimSupported: boolean } {
  const minTrials = input.minTrials ?? 8;
  const over = input.overshootTendency;
  const under = input.undershootTendency;
  if (over === null || under === null) {
    return {
      headline: "Not measured yet",
      detail: "No completed drill produced a usable aim path.",
      claimSupported: false,
    };
  }
  if (input.validTrials < minTrials) {
    return {
      headline: "Too few drills to call",
      detail: `Aim tendency needs at least ${minTrials} usable drills; this session has ${input.validTrials}.`,
      claimSupported: false,
    };
  }
  const gap = over - under;
  if (Math.abs(gap) < TENDENCY_MIN_SEPARATION) {
    return {
      headline: "Balanced",
      detail:
        "You overshoot and undershoot about equally, so nothing in your aim path argues for moving your sensitivity on its own.",
      claimSupported: true,
    };
  }
  if (gap > 0) {
    return {
      headline: "Slight overshoot tendency",
      detail:
        "You pass the centre more often than you stop short of it. A small sensitivity reduction usually improves control for that pattern.",
      claimSupported: true,
    };
  }
  return {
    headline: "Slight undershoot tendency",
    detail:
      "You stop short of the centre more often than you pass it. A small sensitivity increase usually reduces the extra corrections that costs.",
    claimSupported: true,
  };
}
