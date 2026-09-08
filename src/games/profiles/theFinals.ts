/**
 * The Finals (Game Profile Campaign, Pass 3).
 *
 * ## The model
 *
 * "Mouse look sensitivity" is a whole number from 1 to 100 (default 50), and
 * one unit turns the view 0.001° per mouse count. Embark publishes no
 * constant; 0.001 is the value published professional settings fit
 * (commit, 26 at 800 DPI, 43.6 cm/360; UNI, 38 at 800 DPI, 29.8 cm/360).
 * Guides that copy Overwatch's 0.0066 for this game are wrong by more than
 * six times and are not used.
 *
 * ## Zoom
 *
 * "Mouse zoom sensitivity multiplier" is one percentage for every sight, and
 * "Mouse focal length sensitivity scaling" (on by default) makes the game
 * scale zoomed sensitivity by focal length itself — FOV-relative matching by
 * construction — before the multiplier applies. The zoomed fields of view
 * are not published, so this profile can only say what the game's own
 * relationship is: 100% with focal-length scaling on. Other philosophies
 * are not offered rather than approximated.
 */

import { MATCHING } from "../matching.ts";
import {
  GAME_PROFILE_SCHEMA_VERSION,
  type GameProfile,
} from "../profileSchema.ts";

/** Degrees of view rotation per mouse count per look-sensitivity unit. */
export const THE_FINALS_DEGREES_PER_COUNT_AT_ONE = 0.001;

export const THE_FINALS_PROFILE_ID = "the-finals";

export const THE_FINALS_PROFILE: GameProfile = {
  schemaVersion: GAME_PROFILE_SCHEMA_VERSION,
  id: THE_FINALS_PROFILE_ID,
  displayName: "The Finals",
  publisher: "Embark Studios",
  gameFamily: "Unreal Engine 5 (The Finals)",
  profileVersion: 1,
  status: "partially-verified",
  visibility: "public",
  platforms: ["pc"],

  sensitivityModel: {
    kind: "linear-yaw",
    yawDegreesPerCountAtOne: THE_FINALS_DEGREES_PER_COUNT_AT_ONE,
    pitchDegreesPerCountAtOne: null,
  },
  hipfireField: {
    field: "mouseLookSensitivity",
    label: "Mouse look sensitivity",
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
      "The numbers assume Windows pointer speed at the default 6/11 notch with Enhance pointer precision off.",
    ],
  },
  fov: { kind: "none" },
  zoom: {
    kind: "single-scalar",
    zoom: {
      id: "zoom",
      label: "Zoom — every sight, with focal length sensitivity scaling on",
      magnification: null,
      fov: { kind: "none" },
      setting: {
        field: "mouseZoomSensitivityMultiplier",
        label: "Mouse zoom sensitivity multiplier",
        entry: {
          min: 10,
          max: 200,
          step: 1,
          stepOrigin: 0,
          uiDecimals: 0,
          configDecimals: null,
          rounding: "nearest",
          unitSuffix: "%",
          clampAdvice: "none",
        },
      },
      neutralValue: 1,
      nativeBehavior: "fov-relative-multiplier",
      valueScale: 100,
      notes: [
        "Keep 'Mouse focal length sensitivity scaling' on; the game then matches every sight to hip-fire at the crosshair by itself, and 100% leaves that relationship as it is.",
      ],
    },
  },

  defaultMatching: MATCHING.gameNative,
  supportedMatching: ["game-native"],

  unitDefinition:
    "1 turns the view 0.001° for every mouse count — at 800 DPI, 40 is 28.6 cm for a full 360° turn.",
  knownEdgeCases: [
    "Only the game's own zoom relationship is offered: the zoomed fields of view are not published, so same-physical-sensitivity and monitor-distance values cannot be computed.",
    "The field-of-view slider is a VERTICAL angle from 45 to 100, default 71; the game keeps the vertical angle across aspect ratios. It is not modelled, and it does not change hip-fire rotation per count.",
    "Sensitivity is a whole number; there is no finer value.",
  ],
  warnings: [],
  source: {
    title:
      "Community reference: 0.001° per count per look-sensitivity unit, fitted to aimbench.com's published professional settings and cm/360 figures (Embark publishes no constant); zoom scaled by focal length natively with the multiplier on top",
    type: "community-reference",
    url: "https://aimbench.com/games/the-finals",
    publisher: "aimbench.com (community)",
    gameVersion:
      "The Finals Season 10+ (2026): Mouse look sensitivity 1–100, Mouse zoom sensitivity multiplier, Mouse focal length sensitivity scaling",
    verifiedAtIso: "2026-09-08",
    lastReviewedAtIso: "2026-09-08",
    confidence: "moderate",
    uncertaintyNotes: [
      "Embark publishes no yaw constant. Pass 4 re-derived 0.001° per count per unit from a second, independent source family: that reference's published recommendation of 14–57 at 800 DPI for its stated 20–80 cm/360 band implies 0.001003 and 0.001021 at the two ends, which brackets 0.001 to within its printed precision. The value is corroborated, not measured.",
      "The zoom multiplier bounds (10–200%) are assumed; the controller equivalent is documented as 10–100%.",
      "The FOV slider is a vertical angle of 45–100 with a default of 71 (Pass 4, two independent references). It is not modelled because no converted value reads it; Pass 3 recorded it as a horizontal 71–100, which was wrong on both the axis and the lower bound.",
    ],
  },
  supersededByProfileId: null,
  deprecationNote: null,
};
