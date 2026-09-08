/**
 * Rainbow Six Siege (Game Profile Campaign, Pass 3).
 *
 * ## The model
 *
 * Horizontal and vertical mouse sensitivity are separate whole numbers from
 * 1 to 100. One unit turns the view 0.00572958° per mouse count at the stock
 * `MouseSensitivityMultiplierUnit` of 0.02 — the constant the current (2026)
 * references and the published professional settings agree on. Older
 * references quote 0.00223 per unit, which is inconsistent with today's
 * settings by a factor of 2.57 and is not used.
 *
 * The field of view is a VERTICAL angle from 60 to 90 and does not change
 * hip-fire rotation per count.
 *
 * ## ADS since Y5S3 (Shadow Legacy): a slider per magnification
 *
 * Ubisoft replaced the single `XFactorAiming` multiplier with one ADS value
 * per optic magnification, on a 1–200 scale, and defined the new scale
 * around "visuomotor gain" — the game scales rotation by the focal length of
 * each optic itself, and 50 is the neutral value that keeps that gain
 * constant from hip-fire into every optic. So 50 is FOV-relative matching by
 * construction, and the value is a percentage-of-50 multiplier on top of the
 * game's own scaling.
 *
 * Each optic's field of view is the hip-fire vertical FOV scaled by a fixed
 * factor (1.0×: 0.90, 1.5×: 0.59, 2.0×: 0.49, 2.5×: 0.42, 3.0×: 0.35,
 * 4.0×: 0.30, 5.0×: 0.22, 12.0×: 0.092), which is what makes the other
 * philosophies computable from the FOV slider.
 */

import { MATCHING } from "../matching.ts";
import {
  GAME_PROFILE_SCHEMA_VERSION,
  type GameProfile,
  type ZoomLevelSpec,
} from "../profileSchema.ts";

/**
 * Degrees of view rotation per mouse count per sensitivity unit, at the stock
 * MouseSensitivityMultiplierUnit of 0.02.
 */
export const SIEGE_DEGREES_PER_COUNT_AT_ONE = 0.00572958;

/** Neutral ADS value: the game's own focal-length scaling, unmodified. */
export const SIEGE_NEUTRAL_ADS_VALUE = 50;

export const SIEGE_PROFILE_ID = "rainbow-six-siege";

const HIPFIRE_ENTRY = {
  min: 1,
  max: 100,
  step: 1,
  stepOrigin: 0,
  uiDecimals: 0,
  configDecimals: null,
  rounding: "nearest" as const,
  unitSuffix: "",
};

function optic(id: string, label: string, fovFactor: number): ZoomLevelSpec {
  return {
    id,
    label: `ADS — ${label} optics`,
    magnification: null,
    fov: { kind: "scaled-from-hipfire", factor: fovFactor },
    setting: {
      field: `adsSensitivity.${id}`,
      label: `ADS sensitivity ${label}`,
      entry: {
        min: 1,
        max: 200,
        step: 1,
        stepOrigin: 0,
        uiDecimals: 0,
        configDecimals: null,
        rounding: "nearest",
        unitSuffix: "",
        clampAdvice: "none",
      },
    },
    neutralValue: 1,
    nativeBehavior: "fov-relative-multiplier",
    valueScale: SIEGE_NEUTRAL_ADS_VALUE,
    notes: [],
  };
}

export const RAINBOW_SIX_SIEGE_PROFILE: GameProfile = {
  schemaVersion: GAME_PROFILE_SCHEMA_VERSION,
  id: SIEGE_PROFILE_ID,
  displayName: "Rainbow Six Siege",
  publisher: "Ubisoft",
  gameFamily: "AnvilNext (Rainbow Six)",
  profileVersion: 1,
  status: "partially-verified",
  visibility: "public",
  platforms: ["pc"],

  sensitivityModel: {
    kind: "linear-yaw",
    yawDegreesPerCountAtOne: SIEGE_DEGREES_PER_COUNT_AT_ONE,
    pitchDegreesPerCountAtOne: null,
  },
  hipfireField: {
    field: "MouseYawSensitivity",
    label: "Mouse sensitivity — horizontal",
    entry: HIPFIRE_ENTRY,
  },
  axes: {
    independentAxes: true,
    verticalSemantics: "absolute",
    verticalField: {
      field: "MousePitchSensitivity",
      label: "Mouse sensitivity — vertical",
      entry: HIPFIRE_ENTRY,
    },
    builtInVerticalRatio: null,
  },
  dpi: {
    countBased: true,
    assumesWindowsPointerSpeedDefault: true,
    requiresRawInput: true,
    notes: [
      "Assumes the stock MouseSensitivityMultiplierUnit of 0.02 in GameSettings.ini; a player who changed it scales every value here by the same ratio.",
      "The numbers assume Windows pointer speed at the default 6/11 notch with Enhance pointer precision off.",
    ],
  },
  fov: {
    kind: "configurable",
    axis: "vertical",
    defaultDegrees: 60,
    minDegrees: 60,
    maxDegrees: 90,
    stepDegrees: 1,
    affectsHipfireSensitivity: false,
  },
  zoom: {
    kind: "per-zoom",
    zooms: [
      optic("ads-1x", "1.0×", 0.9),
      optic("ads-1-5x", "1.5×", 0.59),
      optic("ads-2x", "2.0×", 0.49),
      optic("ads-2-5x", "2.5×", 0.42),
      optic("ads-3x", "3.0×", 0.35),
      optic("ads-4x", "4.0×", 0.3),
      optic("ads-5x", "5.0×", 0.22),
      optic("ads-12x", "12.0×", 0.092),
    ],
  },

  defaultMatching: MATCHING.gameNative,
  supportedMatching: ["physical-360-distance", "monitor-distance", "game-native"],

  unitDefinition:
    "1 turns the view 0.00573° for every mouse count — at 400 DPI, 12 is 33.2 cm for a full 360° turn.",
  knownEdgeCases: [
    "Both sensitivities are whole numbers; finer control exists only by editing MouseSensitivityMultiplierUnit, which rescales every value and is not modelled.",
    "ADS values are the Advanced (per-magnification) sliders; the game's automatic conversion of pre-Y5S3 settings is not modelled.",
    "The optic FOV factors are a community reconstruction of Ubisoft's conversion table.",
  ],
  warnings: [],
  source: {
    title:
      "Ubisoft, 'Guide to ADS Sensitivity in Y5S3' (per-magnification ADS on a visuomotor-gain scale, 50 neutral); hip-fire 0.00572958° per count per unit and the optic FOV factors from current community references and published professional settings",
    type: "official-documentation",
    url: "https://www.ubisoft.com/en-us/game/rainbow-six/siege/news-updates/3IMlDGlaRFgdvQNq3BOSFv/guide-to-ads-sensitivity-in-y5s3",
    publisher: "Ubisoft (ADS system); r6senscalculator.com and aimbench.com (constants)",
    gameVersion:
      "Rainbow Six Siege Y11 (2026): Mouse Sensitivity horizontal/vertical 1–100, Advanced ADS per magnification 1–200, FOV 60–90 vertical",
    verifiedAtIso: "2026-09-08",
    lastReviewedAtIso: "2026-09-08",
    confidence: "high",
    uncertaintyNotes: [
      "Ubisoft does not publish the hip-fire yaw; 0.00572958° per count per unit is the value current converters and published pro settings agree on. Older guides quote 0.00223, which does not fit today's settings and is not used.",
      "That 50 is exactly the game's focal-length-scaled neutral follows from Ubisoft's description of the scale; it has not been re-measured here.",
      "The per-optic FOV factors come from a community reconstruction of Ubisoft's table and carry two-decimal rounding.",
    ],
  },
  supersededByProfileId: null,
  deprecationNote: null,
};
