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
 *   model of 0.00222° per count per unit of General sensitivity at the
 *   default first-person FOV of 80 (chocoTaco, 25 at 800 DPI, 20.6 cm/360).
 *   Converters quoting "0.022" are off by a factor of ten under that data.
 * - The community's own PUBG tools scale the hip-fire constant by
 *   `80 / FOV`, i.e. PUBG's hip-fire rotation per count grows with the FOV
 *   slider. This profile applies that scaling and asks for the FOV.
 * - Whether the 1–100 scale is exactly linear is NOT verified; guides warn
 *   it may not be. The game also rounds configuration-file values to whole
 *   numbers on apply.
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
    defaultDegrees: PUBG_REFERENCE_FOV_DEGREES,
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
    "Hip-fire rotation per count scales with the first-person FOV slider (80–103); the conversion is made for the FOV you enter and is not valid at another.",
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
      "Krafton publishes no formula. The linear 0.00222° per unit model fits published professional settings at their stated DPI but the 1–100 scale is not verified to be linear; guides warn it may not be. Measure a 360° turn before trusting a converted value.",
      "The hip-fire scaling with FOV (80/FOV) is taken from a community converter, not measured.",
      "The FOV slider is assumed to be a horizontal angle; the axis is not verified and does not change the scaling ratio.",
      "Targeting, ADS, per-scope and vertical settings are not converted.",
    ],
  },
  supersededByProfileId: null,
  deprecationNote: null,
};
