/**
 * Valorant (Game Profile Campaign, Pass 2).
 *
 * ## The model
 *
 * "Sensitivity: Aim" turns the view 0.07° per mouse count at 1.000. There is
 * no separate vertical setting. The field of view is locked at 103°
 * horizontal on a 16:9 display; the profile models it as fixed rather than
 * pretending a slider exists.
 *
 * ## Zoom
 *
 * Two multipliers exist and each covers a tier of weapons:
 *
 * - **ADS Sensitivity Multiplier** — the right-click zoom on rifles and
 *   SMGs: 1.15× (Stinger, Spectre, Ares, Odin), 1.25× (Bulldog, Phantom,
 *   Vandal), 1.5× (Guardian).
 * - **Scoped Sensitivity Multiplier** — sniper scopes: 2.5× (Operator first
 *   zoom), 3.5× (Marshal, Outlaw), 5× (Operator second zoom).
 *
 * A zoomed view's horizontal FOV is 103° divided by the zoom factor, and the
 * game scales sensitivity by that LINEAR angle ratio before the multiplier
 * applies — the same relationship as Counter-Strike's zoom ratio. That model
 * reproduces the FOV-relative multipliers independent references publish
 * (0.7475 for the Operator, 0.8704 for the 1.25× rifles) to a few parts in a
 * hundred thousand. One setting serves each tier, so the profile converts the
 * most common weapon in each and says which others share it.
 */

import { MATCHING } from "../matching.ts";
import {
  GAME_PROFILE_SCHEMA_VERSION,
  type GameProfile,
} from "../profileSchema.ts";
import type { ValueEntrySpec } from "../rounding.ts";

/** Degrees of view rotation per mouse count at Valorant sensitivity 1.000. */
export const VALORANT_DEGREES_PER_COUNT_AT_ONE = 0.07;

/** Locked horizontal field of view on a 16:9 display. */
export const VALORANT_HIPFIRE_FOV_DEGREES = 103;

export const VALORANT_PROFILE_ID = "valorant";

const MULTIPLIER_ENTRY: ValueEntrySpec = {
  min: 0.001,
  max: 10,
  step: null,
  uiDecimals: 3,
  configDecimals: null,
  rounding: "nearest",
  unitSuffix: "",
  clampAdvice: "none",
};

export const VALORANT_PROFILE: GameProfile = {
  schemaVersion: GAME_PROFILE_SCHEMA_VERSION,
  id: VALORANT_PROFILE_ID,
  displayName: "Valorant",
  publisher: "Riot Games",
  gameFamily: "Unreal Engine (Valorant)",
  profileVersion: 1,
  status: "partially-verified",
  visibility: "public",
  platforms: ["pc"],

  sensitivityModel: {
    kind: "linear-yaw",
    yawDegreesPerCountAtOne: VALORANT_DEGREES_PER_COUNT_AT_ONE,
    pitchDegreesPerCountAtOne: null,
  },
  hipfireField: {
    field: "sensitivityAim",
    label: "Sensitivity: Aim",
    entry: {
      min: 0.001,
      max: 10,
      step: null,
      uiDecimals: 3,
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
      "Valorant reads raw mouse counts; the numbers assume Windows pointer speed at the default 6/11 notch with Enhance pointer precision off.",
      "Raw Input Buffer on or off does not change the sensitivity scale.",
    ],
  },
  fov: {
    kind: "fixed",
    axis: "horizontal-at-16-9",
    degrees: VALORANT_HIPFIRE_FOV_DEGREES,
  },
  zoom: {
    kind: "per-zoom",
    zooms: [
      {
        id: "ads-rifle",
        label: "ADS — rifles at 1.25× (Vandal, Phantom, Bulldog)",
        magnification: 1.25,
        fov: {
          kind: "fixed",
          axis: "horizontal-at-16-9",
          degrees: VALORANT_HIPFIRE_FOV_DEGREES / 1.25,
        },
        setting: {
          field: "adsSensitivityMultiplier",
          label: "ADS Sensitivity Multiplier",
          entry: MULTIPLIER_ENTRY,
        },
        neutralValue: 1,
        nativeBehavior: "fov-ratio-multiplier",
        notes: [
          "One setting covers every right-click zoom: 1.15× (Stinger, Spectre, Ares, Odin), 1.25× (Bulldog, Phantom, Vandal) and 1.5× (Guardian). The value is exact for the 1.25× tier; the others land within a few percent under the same philosophy.",
        ],
      },
      {
        id: "scoped-operator",
        label: "Scoped — Operator first zoom at 2.5×",
        magnification: 2.5,
        fov: {
          kind: "fixed",
          axis: "horizontal-at-16-9",
          degrees: VALORANT_HIPFIRE_FOV_DEGREES / 2.5,
        },
        setting: {
          field: "scopedSensitivityMultiplier",
          label: "Scoped Sensitivity Multiplier",
          entry: MULTIPLIER_ENTRY,
        },
        neutralValue: 1,
        nativeBehavior: "fov-ratio-multiplier",
        notes: [
          "One setting covers every sniper scope: 2.5× (Operator first zoom), 3.5× (Marshal, Outlaw) and 5× (Operator second zoom). The value is exact for the Operator's first zoom; the others land within a few percent under the same philosophy.",
        ],
      },
    ],
  },

  defaultMatching: MATCHING.gameNative,
  supportedMatching: ["physical-360-distance", "monitor-distance", "game-native"],

  unitDefinition:
    "1.000 turns the view 0.07° for every mouse count — at 800 DPI, 0.400 is 40.8 cm for a full 360° turn.",
  knownEdgeCases: [
    "Each multiplier serves a whole tier of weapons; it is converted for the most common weapon in its tier and the others differ by a few percent.",
    "The field of view is locked at 103° horizontal (16:9). Players on a stretched 4:3 resolution see the same image stretched, and the conversion does not change.",
  ],
  warnings: [],
  source: {
    title:
      "Community-established Valorant model: 0.07° per count at 1.000, locked 103° horizontal FOV, scoped FOV 103°/zoom with linear-ratio native scaling (reproduces the published FOV-relative multipliers 0.747462 and 0.870439)",
    type: "community-reference",
    url: "https://game-sens.jor.dev/",
    publisher: "game-sens.jor.dev (community), cross-checked against mouse-sensitivity.com-derived values",
    gameVersion:
      "Valorant 2026 (Patch 13.x) settings: Sensitivity: Aim, ADS Sensitivity Multiplier, Scoped Sensitivity Multiplier",
    verifiedAtIso: "2026-09-08",
    lastReviewedAtIso: "2026-09-08",
    confidence: "high",
    uncertaintyNotes: [
      "Riot has not published the yaw constant or the zoomed fields of view; both are community-measured.",
      "Pass 4 checked both halves against an independent source family. The constant: that reference's published 800 DPI recommendation of 0.204–0.816 for a 20–80 cm/360 band implies 0.07000 at both ends. The zoom model: an independently published formula, multiplier = magnification × tan(zoomFOV/2) ÷ tan(51.5°), is algebraically the same as this profile's linear-ratio native scaling, and the engine reproduces the published 0.870439 and 0.747462 to eight significant figures rather than approximating them.",
      "The multiplier fields are assumed to accept 0.001–10.000 in three decimals like the aim sensitivity; Riot does not document the bounds.",
      "A 'same physical sensitivity' scoped value for the Operator needs a 2.500 multiplier; if the game's field rejects it, the profile's assumed bound is wrong and the nearest accepted value is reported.",
    ],
  },
  supersededByProfileId: null,
  deprecationNote: null,
};
