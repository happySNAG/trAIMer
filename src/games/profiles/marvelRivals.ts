/**
 * Marvel Rivals (Game Profile Campaign, Pass 3).
 *
 * ## The model
 *
 * "Mouse Sensitivity" turns the view 0.017453° per mouse count at 1.00 —
 * one degree per 57.3 counts at sensitivity 1, i.e. π/180 in degrees.
 *
 * ## Four community constants exist, and Pass 4 settled it arithmetically
 *
 * Published converters quote 0.017453, 0.022 (the Unreal default), 0.0066
 * (Overwatch's) and even 0.07 (Valorant's) for this one game. Pass 4 broke
 * the tie without trusting any of them: the oldest technical reference in
 * the field publishes, for every game it supports, the sensitivity range
 * that lands a player in its stated 20–80 cm/360 band at 800 DPI. That band
 * is a fact about centimetres, not about Marvel Rivals, and it pins the
 * constant directly — `yaw = 360 × 2.54 / (20 × 800 × sens_fast)`.
 *
 * For Marvel Rivals it prints 0.82 to 3.27, which gives 0.017424 and
 * 0.017477 at the two ends: π/180 to within the three digits it prints.
 * 0.022 would have required it to print 0.65 to 2.60, 0.0066 would have
 * required 2.16 to 8.66, and 0.07 would have required 0.204 to 0.816. The
 * same method reproduces the KNOWN constants of five other games in this
 * registry exactly, which is what makes it evidence rather than a
 * coincidence. The three rival constants are excluded, not merely
 * out-voted.
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
      "Community-established Marvel Rivals model: 0.017453° per count at 1.00 (π/180), agreed by game-sens.jor.dev, aimbench.com's cm/360 tables, and — Pass 4 — mouse-sensitivity.com's published 800 DPI recommendation of 0.82–3.27 for its 20–80 cm/360 band, which excludes the rival 0.022, 0.0066 and 0.07 constants arithmetically",
    type: "community-reference",
    url: "https://game-sens.jor.dev/",
    publisher: "game-sens.jor.dev, aimbench.com and mouse-sensitivity.com (three independent community families)",
    gameVersion:
      "Marvel Rivals 2026 seasons (build 20260903): Mouse Sensitivity, fixed FOV, per-hero aim sensitivity for Black Widow and The Punisher",
    verifiedAtIso: "2026-09-08",
    lastReviewedAtIso: "2026-09-08",
    // Raised from "moderate" in Pass 4: a third, independent source family
 // now pins the constant, and the rival values are excluded rather than
 // merely less popular. What keeps this profile short of "verified" is the
 // unconverted per-hero zoom, not the hip-fire constant.
    confidence: "high",
    uncertaintyNotes: [
      "NetEase has not published the yaw constant. Four community values are in circulation (0.017453, 0.022, 0.0066, 0.07); three independent source families support 0.017453, and Pass 4 excluded the other three arithmetically against a published cm/360 band. A player who measures a different 360° distance should still trust the measurement over any of them.",
      "The sensitivity field bounds (0.01–20.00) are assumed from published settings, not from documentation.",
      "The fixed field of view is reported as about 90° horizontal on 16:9 but is not verified and is not needed for hip-fire.",
    ],
  },
  supersededByProfileId: null,
  deprecationNote: null,
};
