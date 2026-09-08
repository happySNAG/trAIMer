/**
 * PUBG: Battlegrounds (Game Profile Campaign, Pass 3) — EXPERIMENTAL.
 *
 * ## Why experimental
 *
 * PUBG has more sensitivity controls than any other game here — General,
 * Targeting, ADS and one slider per scope magnification, each a whole number
 * from 1 to 100, plus a vertical multiplier — and no published formula for
 * any of them. What can be said with evidence:
 *
 * - Published professional settings and their cm/360 figures fit a LINEAR
 *   model of 0.00222° per count per unit of General sensitivity at a
 *   first-person FOV of 80 (chocoTaco, 25 at 800 DPI, 20.6 cm/360). A second,
 *   independent family states 0.002222 outright, so the constant itself has
 *   corroboration.
 * - Converters quoting "0.022" are off by a factor of ten. One of them
 *   publishes "sens 50 at 800 DPI ≈ 1.0 cm/360" as a worked example, which is
 *   a three-centimetre turn of the whole world and is self-evidently wrong;
 *   that family is treated as misinformation, not as a competing view.
 * - The community's own PUBG tools scale the hip-fire constant by
 *   `80 / FOV`, i.e. PUBG's hip-fire rotation per count grows with the FOV
 *   slider. This profile applies that scaling and asks for the FOV.
 * - Whether the 1–100 scale is exactly linear is NOT verified; guides warn
 *   it may not be, and explicitly tell players to measure a 360° turn rather
 *   than trust a converted number. The game also rounds configuration-file
 *   values to whole numbers on apply.
 * - Pass 4 could not close this. The cm/360-band cross-check that pinned six
 *   other constants in this registry does not apply here: the reference
 *   prints 23–53 at 800 DPI, a span of 2.3×, where a 20–80 cm/360 band on a
 *   linear scale must span exactly 4×. Either that reference models a curve,
 *   or it quotes a PUBG-specific band — its numbers do bracket the published
 *   professional settings, which is the innocent reading — and the two cannot
 *   be told apart from outside the game. The linear model is therefore
 *   corroborated but still unconfirmed, and the profile stays experimental
 *   rather than being promoted on evidence that does not decide.
 *
 * So this profile converts General sensitivity only, carries the
 * experimental warning on every conversion, and leaves Targeting, ADS, the
 * per-scope sliders and the vertical multiplier alone rather than collapsing
 * them into a guess.
 */

import { MATCHING } from "../matching.ts";
import {
  GAME_PROFILE_SCHEMA_VERSION,
  type GameProfile,
} from "../profileSchema.ts";

/** Degrees of view rotation per mouse count per General sensitivity unit, at FOV 80. */
export const PUBG_DEGREES_PER_COUNT_AT_ONE = 0.00222;

/** The first-person FOV the constant above is stated at. */
export const PUBG_REFERENCE_FOV_DEGREES = 80;

export const PUBG_PROFILE_ID = "pubg-battlegrounds";

export const PUBG_PROFILE: GameProfile = {
  schemaVersion: GAME_PROFILE_SCHEMA_VERSION,
  id: PUBG_PROFILE_ID,
  displayName: "PUBG: Battlegrounds",
  publisher: "Krafton",
  gameFamily: "Unreal Engine 4 (PUBG)",
  profileVersion: 1,
  status: "experimental",
  visibility: "public",
  platforms: ["pc"],

  sensitivityModel: {
    kind: "linear-yaw",
    yawDegreesPerCountAtOne: PUBG_DEGREES_PER_COUNT_AT_ONE,
    pitchDegreesPerCountAtOne: null,
  },
  hipfireField: {
    field: "generalSensitivity",
    label: "General sensitivity",
    entry: {
      min: 1,
      max: 100,
      step: 1,
      stepOrigin: 0,
      uiDecimals: 0,
      configDecimals: null,
      rounding: "nearest",
      unitSuffix: "",
    },
  },
  axes: {
    independentAxes: false,
    verticalSemantics: "none",
    verticalField: null,
    builtInVerticalRatio: null,
  },
  dpi: {
    countBased: true,
    assumesWindowsPointerSpeedDefault: true,
    requiresRawInput: true,
    notes: [
      "The numbers assume Windows pointer speed at the default 6/11 notch with Enhance pointer precision off, and the vertical sensitivity multiplier at its default.",
    ],
  },
  fov: {
    kind: "configurable",
    axis: "horizontal",
    // The GAME's default, which is not the FOV the constant is stated at.
    // Pass 3 recorded 80 for both; 80 is the slider's floor, and the default
    // is reported as 90. A player who never touched the slider and never
    // enters one would have been converted at a FOV they do not play — so
    // the fact is corrected here and `gameSettingsFromCanonical` now warns
    // whenever no field of view is supplied at all.
    defaultDegrees: 90,
    minDegrees: 80,
    maxDegrees: 103,
    stepDegrees: 1,
    affectsHipfireSensitivity: true,
    hipfireScaling: { kind: "linear-degrees", referenceDegrees: PUBG_REFERENCE_FOV_DEGREES },
  },
  zoom: { kind: "none" },

  defaultMatching: MATCHING.physical360,
  supportedMatching: ["physical-360-distance"],

  unitDefinition:
    "1 turns the view 0.00222° for every mouse count at FOV 80 — at 800 DPI, 25 is 20.6 cm for a full 360° turn.",
  knownEdgeCases: [
    "Only General sensitivity is converted. Targeting, ADS and the per-scope sliders (2×–15×) each have their own scale and their own zoom, and none is published; they are left alone.",
    "The vertical sensitivity multiplier is not modelled; the conversion assumes it stays at its default.",
    "Hip-fire rotation per count scales with the first-person FOV slider (80–103, default 90); the conversion is made for the FOV you enter and is not valid at another. Enter your actual FOV — leaving it out assumes the game's default and is wrong in proportion if you play at another.",
    "The game rounds configuration-file sensitivities to whole numbers when settings are applied, so no finer value is offered.",
  ],
  warnings: [],
  source: {
    title:
      "Community reference: linear 0.00222° per count per General sensitivity unit at FOV 80, fitted to aimbench.com's published professional settings and cm/360 figures; hip-fire scaled by 80/FOV as the community PUBG converter does; no published formula from Krafton",
    type: "community-reference",
    url: "https://aimbench.com/games/pubg",
    publisher: "aimbench.com (community); schokkya/PUBG-Sensitivity-Converter for the FOV scaling",
    gameVersion:
      "PUBG: Battlegrounds 2026 (PC): General / Targeting / ADS / per-scope sensitivity 1–100, Vertical Sensitivity Multiplier, FPP FOV 80–103",
    verifiedAtIso: "2026-09-08",
    lastReviewedAtIso: "2026-09-08",
    confidence: "low",
    uncertaintyNotes: [
      "Krafton publishes no formula. The linear 0.00222° per unit model fits published professional settings at their stated DPI, and a second independent family states 0.002222 outright, but the 1–100 scale is still not verified to be LINEAR — Pass 4 tried and failed to settle it. Measure a 360° turn before trusting a converted value.",
      "The reference FOV of 80 that the constant is stated at is itself unconfirmed: the professional settings it was fitted to do not publish the FOV each player used. If the true reference is the game's default of 90, every value here is 12.5% out. This is the second reason the profile is experimental.",
      "The hip-fire scaling with FOV (80/FOV) is taken from a community converter, not measured.",
      "The FOV slider is assumed to be a horizontal angle; the axis is not verified and does not change the scaling ratio.",
      "Targeting, ADS, per-scope and vertical settings are not converted.",
    ],
  },
  supersededByProfileId: null,
  deprecationNote: null,
};
