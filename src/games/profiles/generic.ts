/**
 * The generic / raw sensitivity profile (Game Profile Pass 1, requirement 12).
 *
 * This is the CONTROL profile. It is
 * how a player works in physical units — DPI, cm/360, and a plain sensitivity
 * number — with no game-specific behaviour anywhere in the path.
 *
 * ## The unit
 *
 * `1.00` on this scale means **0.02 degrees of view rotation per mouse count**.
 *
 * That constant is a DEFINITION, not a measurement: it is exact by
 * construction, which is what makes this profile a control. It was chosen to
 * put everyday sensitivities in a readable range rather than to imitate any
 * particular engine — at 800 DPI, 1.00 is 57.2 cm/360, and the values players
 * actually run land between roughly 0.5 and 5.
 *
 * ## Why it is the control
 *
 * - Its entry grid is continuous to four decimal places, so a round trip
 *   `canonical → generic → canonical` is limited only by float precision.
 * - Its axes are independent and absolute, so an asymmetric physical aim can
 *   be expressed exactly rather than approximated.
 * - It models no FOV and no optics, so nothing about a zoom philosophy can
 *   quietly contaminate a hip-fire number.
 *
 * If a conversion is wrong here, the architecture is wrong — not a game's
 * constants.
 */

import {
  GAME_PROFILE_SCHEMA_VERSION,
  type GameProfile,
} from "../profileSchema.ts";
import { MATCHING } from "../matching.ts";

/** Degrees of view rotation per mouse count at generic sensitivity 1.00. */
export const GENERIC_DEGREES_PER_COUNT_AT_ONE = 0.02;

export const GENERIC_PROFILE_ID = "generic-raw";

export const GENERIC_RAW_PROFILE: GameProfile = {
  schemaVersion: GAME_PROFILE_SCHEMA_VERSION,
  id: GENERIC_PROFILE_ID,
  displayName: "Generic / Raw",
  publisher: null,
  gameFamily: null,
  profileVersion: 1,
  status: "verified",
  visibility: "public",
  platforms: ["pc"],

  sensitivityModel: {
    kind: "linear-yaw",
    yawDegreesPerCountAtOne: GENERIC_DEGREES_PER_COUNT_AT_ONE,
    pitchDegreesPerCountAtOne: null,
  },
  hipfireField: {
    field: "sensitivity",
    label: "Sensitivity",
    entry: {
      min: 0.0001,
      max: 100,
      step: null,
      uiDecimals: 4,
      configDecimals: null,
      rounding: "nearest",
      unitSuffix: "",
    },
  },
  axes: {
    independentAxes: true,
    verticalSemantics: "absolute",
    verticalField: {
      field: "sensitivityVertical",
      label: "Vertical sensitivity",
      entry: {
        min: 0.0001,
        max: 100,
        step: null,
        uiDecimals: 4,
        configDecimals: null,
        rounding: "nearest",
        unitSuffix: "",
      },
    },
    builtInVerticalRatio: null,
  },
  dpi: {
    countBased: true,
    assumesWindowsPointerSpeedDefault: true,
    requiresRawInput: true,
    notes: [
      "Values assume your mouse reports raw counts: Windows pointer speed at the default 6/11 notch, with Enhance pointer precision off.",
    ],
  },
  fov: { kind: "none" },
  zoom: { kind: "none" },

  defaultMatching: MATCHING.physical360,
  supportedMatching: ["physical-360-distance"],

  unitDefinition:
    "1.00 turns the view 0.02° for every mouse count — at 800 DPI that is 57.2 cm for a full 360° turn.",
  knownEdgeCases: [
    "This profile has no optics and no field of view, so it cannot express a scoped or aimed-down-sights value.",
  ],
  warnings: [],
  source: {
    title: "trAIMer generic sensitivity unit definition",
    type: "unit-definition",
    url: null,
    publisher: "trAIMer",
    gameVersion: null,
    verifiedAtIso: "2026-09-07",
    lastReviewedAtIso: "2026-09-07",
    confidence: "exact",
    uncertaintyNotes: [],
  },
  supersededByProfileId: null,
  deprecationNote: null,
};
