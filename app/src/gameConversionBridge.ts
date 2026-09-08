import type { Recommendation } from "../../src/domain/recommendation.ts";
import {
  GAME_PROFILE_REGISTRY,
  buildGameRecommendationExport,
  canonicalFromGameSettings,
  matchingMethodOf,
  recommendationFactors,
  type GameProfileSelection,
  type GameRecommendationExport,
} from "../../src/games/index.ts";
import { applyRecommendationToCanonical } from "../../src/games/measurement.ts";
import type { AppSettings } from "./state.ts";

/**
 * Turns a completed session into game-facing numbers, or explains why it
 * cannot (Game Profile Pass 1, requirements 15 and 19).
 *
 * All of the arithmetic lives in `src/games/**`; this file only decides which
 * engine call applies and passes engine-owned values through
 * (docs/UI-CONTRACT.md §4).
 *
 * ## How a measured recommendation becomes a physical sensitivity
 *
 * trAIMer's search reports its recommendation in the SAME units as the
 * baseline sensitivity the player entered on the setup screen, so the ratio
 * between them is a pure multiplicative change in physical sensitivity. Apply
 * that ratio to the canonical aim derived from the player's current in-game
 * settings and the result is the recommended physical aim — exactly, with no
 * calibration required.
 *
 * The one thing this cannot do without is an ANCHOR: some real setting the
 * player is on today. With no current sensitivity entered there is nothing to
 * scale, and this returns a reason rather than a number.
 */

export type GameRecommendationOutcome =
  | { readonly kind: "ready"; readonly exported: GameRecommendationExport }
  | { readonly kind: "no-profile-selected" }
  | {
      readonly kind: "unavailable";
      /** Player-facing sentence: what is missing, and what to do about it. */
      readonly reason: string;
    };

export function buildGameRecommendation(
  settings: AppSettings,
  recommendation: Recommendation | null,
  options: { calibrationConfidenceLine?: string | null } = {},
): GameRecommendationOutcome {
  const selection: GameProfileSelection | null = settings.gameProfile;
  if (!selection) return { kind: "no-profile-selected" };

  const compatibility = GAME_PROFILE_REGISTRY.checkSelection({
    profileId: selection.profileId,
    profileVersion: selection.profileVersion,
  });
  if (compatibility.status === "unknown-profile") {
    return { kind: "unavailable", reason: compatibility.message };
  }
  const profile = compatibility.profile;

  if (selection.currentHipfire === null) {
    return {
      kind: "unavailable",
      reason: `Enter the ${profile.hipfireField.label.toLowerCase()} you currently use in ${profile.displayName} on the Aim Test screen, and trAIMer can convert this recommendation into that game's numbers.`,
    };
  }
  if (!recommendation) {
    return {
      kind: "unavailable",
      reason: "This session did not produce a recommendation, so there is nothing to convert yet.",
    };
  }

  const factors = recommendationFactors({
    baselineSensX: settings.sensX,
    baselineSensY: settings.sensY,
    recommendedSensX: recommendation.primarySensitivity.sensX,
    recommendedSensY: recommendation.primarySensitivity.sensY,
  });
  if (!factors) {
    return {
      kind: "unavailable",
      reason: "The session's baseline sensitivity is missing, so the recommended change cannot be expressed as a physical one.",
    };
  }

  try {
    const currentAim = canonicalFromGameSettings(profile, settings.dpi, {
      hipfire: selection.currentHipfire,
      vertical: selection.currentVertical,
      fovDegrees: selection.fovDegrees,
    });
    const recommended = applyRecommendationToCanonical(
      { aim: currentAim, derivation: "game-profile", basis: "your current in-game settings" },
      factors,
    );
    return {
      kind: "ready",
      exported: buildGameRecommendationExport({
        profile,
        dpi: settings.dpi,
        recommended,
        current: { settings: { hipfire: selection.currentHipfire, vertical: selection.currentVertical }, aim: currentAim },
        fovDegrees: selection.fovDegrees,
        matching: matchingMethodOf(selection),
        calibrationConfidenceLine: options.calibrationConfidenceLine ?? null,
      }),
    };
  } catch (err) {
    return {
      kind: "unavailable",
      reason: `That game profile could not convert these settings: ${String((err as Error).message ?? err)}`,
    };
  }
}
