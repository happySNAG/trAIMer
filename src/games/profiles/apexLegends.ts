/**
 * Apex Legends (Game Profile Campaign, Pass 2).
 *
 * ## The model
 *
 * Apex runs on Respawn's Source-derived engine and keeps its 0.022° per
 * count at sensitivity 1.0, on both axes. The field of view is a slider from
 * 70 to 110, quoted — as in every Source game — as a horizontal angle at 4:3;
 * it does not change hip-fire rotation per count.
 *
 * ## ADS and optics — deliberately NOT converted
 *
 * Apex scales sensitivity for every optic itself, then applies the ADS
 * multiplier (or, with "Per Optic ADS Settings" on, one multiplier per
 * optic). The published references for that scaling disagree with each
 * other: the 4× optic is quoted as 0.55 by one and 0.36 by another, the 6×
 * as 0.40 and 0.30, and they do not agree on whether the game scales by the
 * focal length or by a linear angle ratio. A conversion built on either set
 * would be precise and possibly wrong, so this profile exposes no ADS or
 * per-optic value and says so (requirement 14). Hip-fire is unaffected.
 */

import { MATCHING } from "../matching.ts";
import {
  GAME_PROFILE_SCHEMA_VERSION,
  type GameProfile,
} from "../profileSchema.ts";

/** Degrees of view rotation per mouse count at Apex sensitivity 1.0. */
export const APEX_DEGREES_PER_COUNT_AT_ONE = 0.022;

export const APEX_PROFILE_ID = "apex-legends";

export const APEX_LEGENDS_PROFILE: GameProfile = {
  schemaVersion: GAME_PROFILE_SCHEMA_VERSION,
  id: APEX_PROFILE_ID,
  displayName: "Apex Legends",
  publisher: "Electronic Arts / Respawn Entertainment",
  gameFamily: "Source (Respawn)",
  profileVersion: 1,
  status: "partially-verified",
  visibility: "public",
  platforms: ["pc"],

  sensitivityModel: {
    kind: "linear-yaw",
    yawDegreesPerCountAtOne: APEX_DEGREES_PER_COUNT_AT_ONE,
    pitchDegreesPerCountAtOne: null,
  },
  hipfireField: {
    field: "mouse_sensitivity",
    label: "Mouse sensitivity",
    entry: {
      min: 0.1,
      max: 20,
      step: 0.1,
      stepOrigin: 0,
      uiDecimals: 1,
      configDecimals: 6,
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
      "Mouse acceleration must be off; the numbers assume Windows pointer speed at the default 6/11 notch with Enhance pointer precision off.",
    ],
  },
  fov: {
    kind: "configurable",
    axis: "horizontal-at-4-3",
    defaultDegrees: 70,
    minDegrees: 70,
    maxDegrees: 110,
    stepDegrees: 1,
    affectsHipfireSensitivity: false,
  },
  zoom: { kind: "none" },

  defaultMatching: MATCHING.physical360,
  supportedMatching: ["physical-360-distance"],

  unitDefinition:
    "1.0 turns the view 0.022° for every mouse count — at 800 DPI, 1.5 is 34.6 cm for a full 360° turn.",
  knownEdgeCases: [
    "ADS and per-optic sensitivity are not converted. Apex scales each optic on its own before your multiplier applies, and published references disagree on the factors (the 4× optic is quoted as both 0.55 and 0.36) and on the kind of scaling. Leave the ADS multiplier at 1.0 or set it by feel.",
    "The settings slider moves in steps of 0.1; a finer value can be written to the settings file or an autoexec, and the profile reports it when it is closer.",
    "The field of view is quoted as a horizontal angle at 4:3 (110 is about 121° on a 16:9 display) and does not change hip-fire rotation per count.",
  ],
  warnings: [],
  source: {
    title:
      "Community-established Apex Legends hip-fire model: Source-engine 0.022° per count at 1.0; ADS per-optic scaling factors are published inconsistently and are not used",
    type: "community-reference",
    url: "https://steamcommunity.com/app/1172470/discussions/0/3129415222161819298",
    publisher: "Steam Community (Apex Legends discussions) and community converters",
    gameVersion:
      "Apex Legends 2026 seasons: Mouse Sensitivity slider, FOV 70–110, ADS Mouse Sensitivity Multiplier and Per Optic ADS Settings",
    verifiedAtIso: "2026-09-07",
    lastReviewedAtIso: "2026-09-07",
    confidence: "high",
    uncertaintyNotes: [
      "Respawn has not published the yaw constant; 0.022° per count is the Source-engine value every community converter uses for Apex.",
      "The hip-fire slider bounds (0.1–20.0 here) and its 0.1 step are taken from player reports, not from documentation.",
      "Per-optic ADS scaling factors conflict between references and are not converted.",
    ],
  },
  supersededByProfileId: null,
  deprecationNote: null,
};
