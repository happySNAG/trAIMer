/**
 * The bridge from what trAIMer MEASURED to the canonical physical aim
 * (Game Profile Pass 1, requirements 1, 3, 4).
 *
 * The measurement engine stays game-agnostic: it reports a sensitivity in the
 * player's own units and, when a physical calibration exists, a measured
 * degrees-per-count constant. Neither of those is a game profile, and nothing
 * in `src/games/**` is ever an input to how aim is measured.
 *
 * There are exactly two honest ways to reach a canonical aim, and this module
 * implements both rather than guessing:
 *
 * 1. **Calibrated.** The player physically measured how far their view turns
 *    per mouse count. That is a direct physical fact and converts with no
 *    assumptions at all.
 *
 * 2. **Relative to the player's own baseline.** trAIMer's search always
 *    reports a recommendation in the SAME units as the baseline it started
 *    from, so the ratio between them is a pure multiplicative change in
 *    physical sensitivity. Applied to a canonical aim derived from the
 *    player's current game settings, it gives the recommended physical aim
 *    without any calibration at all (requirement 14).
 *
 * Path 2 is exact whenever path 1 is unavailable, which is most of the time.
 * Neither path is allowed to be faked: with no calibration AND no current
 * game settings, these functions return null and the UI says so.
 */

import type { CalibrationParameters } from "../sensmath/calibration.ts";
import {
  canonicalFromDegreesPerCount,
  scaleCanonicalPerAxis,
  type CanonicalAim,
} from "./canonical.ts";

/**
 * The multiplicative change the calibration recommends, per axis.
 *
 * Returns null when the baseline is unusable, because a ratio against zero is
 * not a change — it is a missing measurement.
 */
export function recommendationFactors(input: {
  baselineSensX: number;
  baselineSensY: number;
  recommendedSensX: number;
  recommendedSensY: number;
}): { x: number; y: number } | null {
  const ok = (v: number): boolean => Number.isFinite(v) && v > 0;
  if (
    !ok(input.baselineSensX) ||
    !ok(input.baselineSensY) ||
    !ok(input.recommendedSensX) ||
    !ok(input.recommendedSensY)
  ) {
    return null;
  }
  return {
    x: input.recommendedSensX / input.baselineSensX,
    y: input.recommendedSensY / input.baselineSensY,
  };
}

/**
 * Canonical aim straight from a completed physical calibration.
 *
 * `degreesPerCountAt100` is measured with the player's game sensitivity at
 * 100, so the value at any other setting scales linearly with it.
 */
export function canonicalFromCalibration(input: {
  calibration: CalibrationParameters;
  dpi: number;
  sensXPercent: number;
  sensYPercent: number;
}): CanonicalAim | null {
  const { calibration, dpi, sensXPercent, sensYPercent } = input;
  if (
    calibration.degreesPerCountAt100X === null ||
    calibration.degreesPerCountAt100Y === null ||
    !Number.isFinite(dpi) ||
    dpi <= 0 ||
    !(sensXPercent > 0) ||
    !(sensYPercent > 0)
  ) {
    return null;
  }
  return canonicalFromDegreesPerCount({
    degreesPerCountX: calibration.degreesPerCountAt100X * (sensXPercent / 100),
    degreesPerCountY: calibration.degreesPerCountAt100Y * (sensYPercent / 100),
    dpi,
  });
}

/** How a canonical aim was arrived at — carried into history verbatim. */
export type CanonicalDerivation =
  /** From a completed physical calibration. */
  | "measured-calibration"
  /** From the player's current in-game settings through a game profile. */
  | "game-profile"
  /** A game-profile aim scaled by the calibration's recommended change. */
  | "game-profile-scaled-by-recommendation";

export interface DerivedCanonicalAim {
  readonly aim: CanonicalAim;
  readonly derivation: CanonicalDerivation;
  /** Player-facing sentence naming where the number came from. */
  readonly basis: string;
}

/**
 * Applies trAIMer's recommended multiplicative change to a canonical aim
 * derived from the player's current game settings.
 */
export function applyRecommendationToCanonical(
  current: DerivedCanonicalAim,
  factors: { x: number; y: number },
): DerivedCanonicalAim {
  return {
    aim: scaleCanonicalPerAxis(current.aim, factors.x, factors.y),
    derivation:
      current.derivation === "measured-calibration"
        ? "measured-calibration"
        : "game-profile-scaled-by-recommendation",
    basis:
      current.derivation === "measured-calibration"
        ? "your measured calibration, adjusted by the change this session recommends"
        : "your current in-game settings, adjusted by the change this session recommends",
  };
}
