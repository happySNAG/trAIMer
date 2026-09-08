/**
 * Marvel Rivals (Game Profile Campaign, Pass 3).
 *
 * ## The model
 *
 * "Mouse Sensitivity" turns the view 0.017453° per mouse count at 1.00 —
 * one degree per 57.3 counts at sensitivity 1, i.e. π/180 in degrees. That
 * is NOT the 0.022 some converters assume from the Unreal Engine default:
 * the two references that state a constant explicitly (game-sens.jor.dev and
 * aimbench.com's cm/360 tables) both use π/180, and published professional
 * settings (0.64–6.00 at 400–1600 DPI) land in the 10–50 cm/360 band under
 * it. A third reference quotes 0.0066, under which those same settings
 * would be 30–135 cm/360; it is not used.
 *
 * The field of view is fixed with no setting. The game writes a finer
 * sensitivity to its configuration file but does not read it back, so there
 * is no configuration-file precision.
 *
 * ## Zoom — deliberately NOT converted
 *
 * Black Widow's scope and The Punisher's turret have their own aim
 * sensitivity, and the game reportedly applies focal-length scaling at the
 * default 1.0. The zoomed fields of view are not published, so no value is
 * suggested; leave them at 1.0 or set them by feel.
 */

import { MATCHING } from "../matching.ts";
import {
  GAME_PROFILE_SCHEMA_VERSION,
  type GameProfile,
} from "../profileSchema.ts";

/** Degrees of view rotation per mouse count at Marvel Rivals sensitivity 1.00. */
export const MARVEL_RIVALS_DEGREES_PER_COUNT_AT_ONE = 0.017453;

export const MARVEL_RIVALS_PROFILE_ID = "marvel-rivals";

export const MARVEL_RIVALS_PROFILE: GameProfile = {
  schemaVersion: GAME_PROFILE_SCHEMA_VERSION,
  id: MARVEL_RIVALS_PROFILE_ID,
  displayName: "Marvel Rivals",
  publisher: "NetEase Games",
  gameFamily: "Unreal Engine 5 (Marvel Rivals)",
  profileVersion: 1,
  status: "partially-verified",
  visibility: "public",
  platforms: ["pc"],

  sensitivityModel: {
    kind: "linear-yaw",
    yawDegreesPerCountAtOne: MARVEL_RIVALS_DEGREES_PER_COUNT_AT_ONE,
    pitchDegreesPerCountAtOne: null,
  },
  hipfireField: {
    field: "mouseSensitivity",
    label: "Mouse Sensitivity",
    entry: {
      min: 0.01,
      max: 20,
      step: null,
      uiDecimals: 2,
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
  zoom: { kind: "none" },

  defaultMatching: MATCHING.physical360,
  supportedMatching: ["physical-360-distance"],

  unitDefinition:
    "1.00 turns the view 0.01745° for every mouse count — at 800 DPI, 3.50 is 18.7 cm for a full 360° turn.",
  knownEdgeCases: [
    "Black Widow's scoped and The Punisher's turret aim sensitivity are not converted: the zoomed fields of view are not published. The game reportedly scales them by focal length at 1.0.",
    "The field of view is fixed and has no setting; it is not modelled.",
    "The game has a vertical sensitivity option; this profile assumes it is left at its default and both axes turn at the same rate.",
    "The game writes a finer sensitivity to its configuration file but does not read it back, so only the two decimals of the settings screen apply.",
  ],
  warnings: [],
  source: {
    title:
      "Community-established Marvel Rivals model: 0.017453° per count at 1.00 (π/180), as used by game-sens.jor.dev and by aimbench.com's cm/360 tables for published professional settings; converters assuming 0.022 or 0.0066 disagree and are not used",
    type: "community-reference",
    url: "https://game-sens.jor.dev/",
    publisher: "game-sens.jor.dev and aimbench.com (community)",
    gameVersion:
      "Marvel Rivals 2026 seasons (build 20260903): Mouse Sensitivity, fixed FOV, per-hero aim sensitivity for Black Widow and The Punisher",
    verifiedAtIso: "2026-09-08",
    lastReviewedAtIso: "2026-09-08",
    confidence: "moderate",
    uncertaintyNotes: [
      "NetEase has not published the yaw constant. Three community values exist (0.017453, 0.022, 0.0066); the two references that state their constant and publish consistent cm/360 tables use 0.017453, which this profile adopts. A player who measures a different 360° distance should trust the measurement.",
      "The sensitivity field bounds (0.01–20.00) are assumed from published settings, not from documentation.",
      "The fixed field of view is reported as about 90° horizontal on 16:9 but is not verified and is not needed for hip-fire.",
    ],
  },
  supersededByProfileId: null,
  deprecationNote: null,
};
