/**
 * Fortnite (Game Profile Campaign, Pass 2).
 *
 * ## The model
 *
 * Fortnite's mouse settings are percentages: X-axis sensitivity and Y-axis
 * sensitivity are entered independently, and each 1% turns the view
 * 0.005555° per mouse count. Epic has never published that constant; it is
 * the value every major community converter has measured and used since the
 * v10 change to a percentage scale, and it is treated here as a
 * community-established constant with high — not exact — confidence.
 *
 * ## Targeting (aiming down sights)
 *
 * "Targeting sensitivity" is the percentage applied while right-click aiming
 * with a weapon that has no scope. For those weapons Fortnite keeps the
 * hip-fire field of view and only moves the camera forward, so the targeting
 * value is a plain multiplier of the hip-fire sensitivity and 100% is exactly
 * hip-fire. Every matching philosophy therefore agrees on it, so only one —
 * same physical sensitivity, 100% — is offered.
 *
 * ## Scope — deliberately NOT converted
 *
 * "Scope sensitivity" applies to scoped weapons, which DO change the field of
 * view, and Fortnite rescales the sensitivity for that change itself. The
 * scope FOV of each weapon in the current season is not verified, so this
 * profile does not produce a scope value. A number here would be a guess
 * dressed as a recommendation (requirement 14).
 */

import { MATCHING } from "../matching.ts";
import {
  GAME_PROFILE_SCHEMA_VERSION,
  type GameProfile,
} from "../profileSchema.ts";
import type { ValueEntrySpec } from "../rounding.ts";

/** Degrees of view rotation per mouse count at 1% Fortnite sensitivity. */
export const FORTNITE_DEGREES_PER_COUNT_PER_PERCENT = 0.005555;

export const FORTNITE_PROFILE_ID = "fortnite";

const PERCENT_SLIDER: ValueEntrySpec = {
  min: 1,
  max: 100,
  step: 0.1,
  stepOrigin: 0,
  uiDecimals: 1,
  configDecimals: null,
  rounding: "nearest",
  unitSuffix: "%",
};

export const FORTNITE_PROFILE: GameProfile = {
  schemaVersion: GAME_PROFILE_SCHEMA_VERSION,
  id: FORTNITE_PROFILE_ID,
  displayName: "Fortnite",
  publisher: "Epic Games",
  gameFamily: "Unreal Engine (Fortnite)",
  profileVersion: 1,
  status: "partially-verified",
  visibility: "public",
  platforms: ["pc"],

  sensitivityModel: {
    kind: "linear-yaw",
    yawDegreesPerCountAtOne: FORTNITE_DEGREES_PER_COUNT_PER_PERCENT,
    pitchDegreesPerCountAtOne: null,
  },
  hipfireField: {
    field: "mouseSensitivityX",
    label: "X-axis sensitivity",
    entry: PERCENT_SLIDER,
  },
  axes: {
    independentAxes: true,
    verticalSemantics: "absolute",
    verticalField: {
      field: "mouseSensitivityY",
      label: "Y-axis sensitivity",
      entry: PERCENT_SLIDER,
    },
    builtInVerticalRatio: null,
  },
  dpi: {
    countBased: true,
    assumesWindowsPointerSpeedDefault: true,
    requiresRawInput: true,
    notes: [
      "Fortnite reads raw mouse counts on Windows; the numbers assume Windows pointer speed at the default 6/11 notch with Enhance pointer precision off.",
      "Mouse acceleration and the legacy look controls must be off.",
    ],
  },
  fov: { kind: "none" },
  zoom: {
    kind: "single-scalar",
    zoom: {
      id: "targeting",
      label: "Targeting sensitivity (aim down sights)",
      magnification: null,
      fov: { kind: "none" },
      setting: {
        field: "mouseTargetingSensitivity",
        label: "Targeting sensitivity",
        entry: { ...PERCENT_SLIDER, clampAdvice: "none" },
      },
      neutralValue: 1,
      nativeBehavior: "multiplies-hipfire",
      valueScale: 100,
      notes: [
        "Applies to right-click aiming with weapons that have no scope. Fortnite keeps the hip-fire field of view for them, so 100% is exactly your hip-fire sensitivity.",
      ],
    },
  },

  defaultMatching: MATCHING.physical360,
  // Only one philosophy is offered: with the FOV unchanged, every philosophy
  // lands on the same 100%, and a choice between identical answers is noise.
  supportedMatching: ["physical-360-distance"],

  unitDefinition:
    "1% turns the view 0.005555° for every mouse count — at 800 DPI, 8% is 25.7 cm for a full 360° turn.",
  knownEdgeCases: [
    "Scope sensitivity is not converted: scoped weapons change the field of view and Fortnite rescales for that change on its own, and the scope field of view of each weapon in the current season is not verified.",
    "A scoped weapon that also uses targeting (some marksman rifles) is not covered by the targeting value above.",
    "Controller look sensitivity uses a different scale and is not modelled.",
  ],
  warnings: [],
  source: {
    title:
      "Community-established Fortnite mouse model: 0.005555° per count per 1% (the constant used by the major sensitivity converters); targeting keeps the hip-fire FOV per DPI Wizard, mouse-sensitivity.com",
    type: "community-reference",
    url: "https://www.mouse-sensitivity.com/forums/topic/4896-fortnite-targeting-fov/",
    publisher: "mouse-sensitivity.com (DPI Wizard) and community converters",
    gameVersion:
      "Fortnite Chapter 6 (2026) mouse settings: X-axis / Y-axis / targeting / scope sensitivity percentages",
    verifiedAtIso: "2026-09-07",
    lastReviewedAtIso: "2026-09-07",
    confidence: "high",
    uncertaintyNotes: [
      "Epic has not published the yaw constant; 0.005555° per count per 1% is community-measured and may carry rounding in its last digit.",
      "The settings screen is assumed to accept 0.1% steps between 1.0% and 100.0%; a finer value in the configuration file is not claimed.",
      "The Y-axis is assumed to use the same constant as the X-axis at the same percentage.",
      "Scope sensitivity and scope fields of view are not verified and are not converted.",
    ],
  },
  supersededByProfileId: null,
  deprecationNote: null,
};
