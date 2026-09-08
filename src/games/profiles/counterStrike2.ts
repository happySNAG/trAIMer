/**
 * Counter-Strike 2 (Game Profile Campaign, Pass 2).
 *
 * ## The model
 *
 * `sensitivity` × `m_yaw` (0.022 by default) is the view rotation per mouse
 * count, and `m_pitch` carries the same 0.022, so one number sets both axes.
 * The hip-fire field of view is fixed at 90°, quoted as a horizontal angle at
 * 4:3 — the Source lineage's convention — which is 106.26° horizontal on a
 * 16:9 display.
 *
 * ## Zoom
 *
 * `zoom_sensitivity_ratio` (the settings menu's "Zoom Sensitivity
 * Multiplier") is one setting for every scoped weapon. Scoped sensitivity is
 * hip-fire sensitivity × ratio × (zoom FOV / 90), with the FOVs taken as the
 * game states them: AWP 40° then 10°, SSG 08 40° then 15°, AUG and SG 553
 * 45°. Because the game applies a LINEAR angle ratio, FOV-relative matching
 * needs 0.818933 for a 40° scope — the value the community has used for a
 * decade — and this profile derives it rather than storing it.
 *
 * The AWP's first zoom is converted and named; the same setting then lands
 * within about 4% of the same philosophy on every other scope.
 *
 * ## Precision
 *
 * The settings screen shows two decimals. The console and an autoexec accept
 * more, and the profile reports the finer value alongside the entry value.
 */

import { MATCHING } from "../matching.ts";
import {
  GAME_PROFILE_SCHEMA_VERSION,
  type GameProfile,
} from "../profileSchema.ts";

/** Default `m_yaw`: degrees of view rotation per count at sensitivity 1.00. */
export const CS2_DEGREES_PER_COUNT_AT_ONE = 0.022;

/** Hip-fire FOV, horizontal at 4:3 (the number the engine uses). */
export const CS2_HIPFIRE_FOV_DEGREES = 90;

/** AWP first-zoom FOV, on the same convention. */
export const CS2_AWP_FIRST_ZOOM_FOV_DEGREES = 40;

export const CS2_PROFILE_ID = "counter-strike-2";

export const COUNTER_STRIKE_2_PROFILE: GameProfile = {
  schemaVersion: GAME_PROFILE_SCHEMA_VERSION,
  id: CS2_PROFILE_ID,
  displayName: "Counter-Strike 2",
  publisher: "Valve",
  gameFamily: "Source 2 (Counter-Strike)",
  profileVersion: 1,
  status: "verified",
  visibility: "public",
  platforms: ["pc"],

  sensitivityModel: {
    kind: "linear-yaw",
    yawDegreesPerCountAtOne: CS2_DEGREES_PER_COUNT_AT_ONE,
    pitchDegreesPerCountAtOne: null,
  },
  hipfireField: {
    field: "sensitivity",
    label: "Mouse sensitivity",
    entry: {
      min: 0.1,
      max: 8,
      step: null,
      uiDecimals: 2,
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
      "Assumes the default m_yaw and m_pitch of 0.022 and no mouse acceleration.",
      "The numbers assume Windows pointer speed at the default 6/11 notch with Enhance pointer precision off.",
    ],
  },
  fov: {
    kind: "fixed",
    axis: "horizontal-at-4-3",
    degrees: CS2_HIPFIRE_FOV_DEGREES,
  },
  zoom: {
    kind: "per-zoom",
    zooms: [
      {
        id: "awp-first-zoom",
        label: "Scoped — AWP first zoom (40°)",
        magnification: null,
        fov: {
          kind: "fixed",
          axis: "horizontal-at-4-3",
          degrees: CS2_AWP_FIRST_ZOOM_FOV_DEGREES,
        },
        setting: {
          field: "zoom_sensitivity_ratio",
          label: "Zoom Sensitivity Multiplier",
          entry: {
            min: 0.1,
            max: 3,
            step: null,
            uiDecimals: 2,
            configDecimals: 6,
            rounding: "nearest",
            unitSuffix: "",
            clampAdvice: "none",
          },
        },
        neutralValue: 1,
        nativeBehavior: "fov-ratio-multiplier",
        notes: [
          "One setting covers every scoped weapon. It is converted for the AWP's first zoom (40°); the AWP's second zoom (10°), the SSG 08 (40° then 15°) and the AUG and SG 553 (45°) share it and land within about 4% of the same philosophy.",
        ],
      },
    ],
  },

  defaultMatching: MATCHING.gameNative,
  supportedMatching: ["physical-360-distance", "monitor-distance", "game-native"],

  unitDefinition:
    "1.00 turns the view 0.022° for every mouse count — at 800 DPI, 2.00 is 26.0 cm for a full 360° turn.",
  knownEdgeCases: [
    "The settings screen accepts two decimals; the console command `sensitivity` and an autoexec accept more, and the finer value is reported when it is closer.",
    "Playing at a stretched 4:3 resolution changes what you see, not the rotation per count; hip-fire values do not change.",
  ],
  warnings: [],
  source: {
    title:
      "Counter-Strike 2 engine constants: m_yaw 0.022, zoom_sensitivity_ratio applied as a linear FOV ratio, weapon zoom FOVs (AWP 40°/10°, SSG 08 40°/15°, AUG/SG 553 45°) from the community weapon-data reference",
    type: "community-reference",
    url: "https://steamcommunity.com/sharedfiles/filedetails/?id=3260510071",
    publisher: "Steam Community (CS2 weapon stats guide); Valve console variables",
    gameVersion:
      "Counter-Strike 2, 2026 builds (sensitivity, zoom_sensitivity_ratio, fixed 90° FOV)",
    verifiedAtIso: "2026-09-07",
    lastReviewedAtIso: "2026-09-07",
    confidence: "high",
    uncertaintyNotes: [
      "The settings-menu slider bounds (0.10–8.00 here) vary between guides; the console accepts any positive value, so a clamped hip-fire value can always be entered there.",
      "Whether the zoom ratio still applies to the AUG and SG 553 first zoom has been disputed since a 2014 CS:GO update; the AWP and SSG 08 are unaffected.",
    ],
  },
  supersededByProfileId: null,
  deprecationNote: null,
};
