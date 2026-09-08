/**
 * Overwatch 2 (Game Profile Campaign, Pass 3).
 *
 * ## The model
 *
 * "Sensitivity" turns the view 0.0066° per mouse count at 1.00 — the same
 * constant Call of Duty uses — and there is no separate vertical setting.
 * The field of view is a slider from 80 to 103 in half-degree steps, quoted
 * as a horizontal angle on a 16:9 display; it does not change hip-fire
 * rotation per count.
 *
 * ## Zoom is per hero, and it is a plain multiplier
 *
 * Each scoped hero has its own "Relative Aim Sensitivity While Zoomed", a
 * percentage of hip-fire rotation per count. The game applies NO field-of-
 * view scaling of its own, which is why the community's FOV-relative values
 * (37.89 for Widowmaker and Ana, 51.47 for Ashe at 103 FOV) are simply the
 * tangent ratio of the hero's fixed scoped FOV to the hip-fire FOV. Those
 * scoped FOVs do not move with the FOV slider, so the right relative value
 * depends on the slider — which is why this profile asks for it.
 *
 * Three heroes are modelled: Widowmaker and Ana (50.94° scoped), and Ashe
 * (65.81° aimed). Newer heroes with a zoom are not converted.
 */

import { MATCHING } from "../matching.ts";
import {
  GAME_PROFILE_SCHEMA_VERSION,
  type GameProfile,
  type ZoomLevelSpec,
} from "../profileSchema.ts";
import type { ValueEntrySpec } from "../rounding.ts";

/** Degrees of view rotation per mouse count at Overwatch sensitivity 1.00. */
export const OVERWATCH_DEGREES_PER_COUNT_AT_ONE = 0.0066;

export const OVERWATCH_PROFILE_ID = "overwatch-2";

const RELATIVE_ZOOM_ENTRY: ValueEntrySpec = {
  min: 1,
  max: 100,
  step: null,
  uiDecimals: 2,
  configDecimals: null,
  rounding: "nearest",
  unitSuffix: "%",
  clampAdvice: "none",
};

function hero(id: string, name: string, scopedFovDegrees: number, what: string): ZoomLevelSpec {
  return {
    id,
    label: `${name} — ${what}`,
    magnification: null,
    fov: { kind: "fixed", axis: "horizontal-at-16-9", degrees: scopedFovDegrees },
    setting: {
      field: `relativeAimSensitivityWhileZoomed.${id}`,
      label: `${name} — Relative Aim Sensitivity While Zoomed`,
      entry: RELATIVE_ZOOM_ENTRY,
    },
    neutralValue: 0.3,
    nativeBehavior: "multiplies-hipfire",
    valueScale: 100,
    notes: [
      `Set under the hero's own options. The ${scopedFovDegrees}° ${what.toLowerCase()} field of view does not move with the FOV slider, so this value depends on the FOV you play at.`,
    ],
  };
}

export const OVERWATCH_2_PROFILE: GameProfile = {
  schemaVersion: GAME_PROFILE_SCHEMA_VERSION,
  id: OVERWATCH_PROFILE_ID,
  displayName: "Overwatch 2",
  publisher: "Blizzard Entertainment",
  gameFamily: "Overwatch",
  profileVersion: 1,
  status: "partially-verified",
  visibility: "public",
  platforms: ["pc"],

  sensitivityModel: {
    kind: "linear-yaw",
    yawDegreesPerCountAtOne: OVERWATCH_DEGREES_PER_COUNT_AT_ONE,
    pitchDegreesPerCountAtOne: null,
  },
  hipfireField: {
    field: "sensitivity",
    label: "Sensitivity",
    entry: {
      min: 1,
      max: 100,
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
  fov: {
    kind: "configurable",
    axis: "horizontal-at-16-9",
    defaultDegrees: 103,
    minDegrees: 80,
    maxDegrees: 103,
    stepDegrees: 0.5,
    affectsHipfireSensitivity: false,
  },
  zoom: {
    kind: "per-zoom",
    zooms: [
      hero("widowmaker", "Widowmaker", 50.94, "Scoped"),
      hero("ana", "Ana", 50.94, "Scoped"),
      hero("ashe", "Ashe", 65.81, "Aimed"),
    ],
  },

  defaultMatching: MATCHING.gameNative,
  supportedMatching: ["physical-360-distance", "monitor-distance", "game-native"],

  unitDefinition:
    "1.00 turns the view 0.0066° for every mouse count — at 800 DPI, 5.00 is 34.6 cm for a full 360° turn.",
  knownEdgeCases: [
    "Each scoped hero has its own relative zoom value; three are converted (Widowmaker, Ana, Ashe). Heroes added later with a zoom are not.",
    "The FOV slider is quoted as a horizontal angle on a 16:9 display; on other aspect ratios the game keeps the vertical angle.",
  ],
  warnings: [],
  source: {
    title:
      "Community-established Overwatch 2 model: 0.0066° per count at 1.00; per-hero scoped FOVs (Widowmaker/Ana 50.94°, Ashe 65.81°) with the relative zoom value a pure multiplier of hip-fire, reproducing the published 37.89 / 51.47 FOV-relative values at 103 FOV",
    type: "community-reference",
    url: "https://game-sens.jor.dev/",
    publisher: "game-sens.jor.dev (community), consistent with mouse-sensitivity.com-derived values",
    gameVersion:
      "Overwatch 2, 2026 seasons: Sensitivity, FOV 80–103, per-hero Relative Aim Sensitivity While Zoomed",
    verifiedAtIso: "2026-09-08",
    lastReviewedAtIso: "2026-09-08",
    confidence: "high",
    uncertaintyNotes: [
      "Blizzard has not published the yaw constant or the scoped fields of view; both are community-measured.",
      "The sensitivity field is assumed to accept 1.00–100.00 in two decimals, and the relative zoom values 1.00–100.00%.",
      "The stock relative zoom value is taken as 30.00%; a hero whose stock value differs lands on a different game-default number.",
    ],
  },
  supersededByProfileId: null,
  deprecationNote: null,
};
