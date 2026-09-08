/**
 * Call of Duty / Warzone (Game Profile Campaign, Pass 2).
 *
 * ## Which game
 *
 * The current Call of Duty family — Warzone and the Black Ops 7 (2025)
 * integration it shares a settings menu with — uses one mouse model:
 * "Mouse Sensitivity" turns the view 0.0066° per mouse count at 1.00, with a
 * "Vertical Sensitivity Multiplier" on top for pitch. That constant has been
 * shared by every Call of Duty title since Modern Warfare (2019), Treyarch's
 * included.
 *
 * ## ADS — the part that is NOT one scalar
 *
 * The game exposes an "ADS Sensitivity Type":
 *
 * - **Relative** — the game matches ADS to hip-fire by MONITOR DISTANCE
 *   itself, using the "Monitor Distance Coefficient" (0.00–2.00). The
 *   coefficient names which fraction of the vertical half-screen is matched:
 *   0.00 is the FOV-relative (focal-length) limit, 1.33 (the default) is
 *   100% of the horizontal width on a 4:3 display, and 1.78 is 100% of the
 *   horizontal width on 16:9. An "ADS Sensitivity Multiplier" then applies on
 *   top, and "Custom Sensitivity Per Zoom" can replace it with one multiplier
 *   per zoom tier.
 * - **Legacy** — the older Call of Duty scaling. Not converted here.
 *
 * Because the game does the FOV arithmetic, this profile never needs an ADS
 * FOV: it translates the chosen matching philosophy directly into the
 * coefficient and asks for the multipliers to be left at 1.00, which matches
 * EVERY optic under one number. Same-physical-sensitivity matching would need
 * an infinite coefficient and is therefore not offered for this game.
 *
 * ## Field of view
 *
 * The FOV slider is 60–120, a horizontal angle at the display's own aspect
 * ratio (120 is about 89° vertical on 16:9). It does not change hip-fire
 * rotation per count, and the coefficient conversion does not read it.
 */

import { MATCHING } from "../matching.ts";
import {
  GAME_PROFILE_SCHEMA_VERSION,
  type GameProfile,
} from "../profileSchema.ts";

/** Degrees of view rotation per mouse count at Call of Duty sensitivity 1.00. */
export const COD_DEGREES_PER_COUNT_AT_ONE = 0.0066;

/** The game's stock Monitor Distance Coefficient. */
export const COD_DEFAULT_MONITOR_DISTANCE_COEFFICIENT = 1.33;

export const COD_WARZONE_PROFILE_ID = "call-of-duty-warzone";

export const CALL_OF_DUTY_WARZONE_PROFILE: GameProfile = {
  schemaVersion: GAME_PROFILE_SCHEMA_VERSION,
  id: COD_WARZONE_PROFILE_ID,
  displayName: "Call of Duty / Warzone",
  publisher: "Activision",
  gameFamily: "Call of Duty (IW engine)",
  profileVersion: 1,
  status: "partially-verified",
  visibility: "public",
  platforms: ["pc"],

  sensitivityModel: {
    kind: "linear-yaw",
    yawDegreesPerCountAtOne: COD_DEGREES_PER_COUNT_AT_ONE,
    pitchDegreesPerCountAtOne: null,
  },
  hipfireField: {
    field: "mouseSensitivity",
    label: "Mouse Sensitivity",
    entry: {
      min: 0.01,
      max: 100,
      step: null,
      uiDecimals: 2,
      configDecimals: null,
      rounding: "nearest",
      unitSuffix: "",
    },
  },
  axes: {
    independentAxes: true,
    verticalSemantics: "multiplier-of-horizontal",
    verticalField: {
      field: "verticalSensitivityMultiplier",
      label: "Vertical Sensitivity Multiplier",
      entry: {
        min: 0.1,
        max: 5,
        step: null,
        uiDecimals: 2,
        configDecimals: null,
        rounding: "nearest",
        unitSuffix: "",
        clampAdvice: "none",
      },
    },
    builtInVerticalRatio: null,
  },
  dpi: {
    countBased: true,
    assumesWindowsPointerSpeedDefault: true,
    requiresRawInput: true,
    notes: [
      "Mouse acceleration and mouse smoothing must be off; the numbers assume Windows pointer speed at the default 6/11 notch with Enhance pointer precision off.",
    ],
  },
  fov: {
    kind: "configurable",
    axis: "horizontal",
    defaultDegrees: 80,
    minDegrees: 60,
    maxDegrees: 120,
    stepDegrees: 1,
    affectsHipfireSensitivity: false,
  },
  zoom: {
    kind: "single-scalar",
    zoom: {
      id: "ads-relative",
      label: "Aiming down sights — Relative mode, every optic",
      magnification: null,
      fov: { kind: "none" },
      setting: {
        field: "monitorDistanceCoefficient",
        label: "Monitor Distance Coefficient",
        entry: {
          min: 0,
          max: 2,
          step: 0.01,
          stepOrigin: 0,
          uiDecimals: 2,
          configDecimals: null,
          rounding: "nearest",
          unitSuffix: "",
          allowZero: true,
          clampAdvice: "none",
        },
      },
      neutralValue: COD_DEFAULT_MONITOR_DISTANCE_COEFFICIENT,
      nativeBehavior: "monitor-distance-coefficient",
      coefficientAxis: "vertical",
      notes: [
        "Set ADS Sensitivity Type to Relative, leave ADS Sensitivity Multiplier at 1.00 and Custom Sensitivity Per Zoom off; the coefficient then matches every optic on its own.",
      ],
    },
  },

  defaultMatching: MATCHING.gameNative,
  supportedMatching: ["monitor-distance", "game-native"],

  unitDefinition:
    "1.00 turns the view 0.0066° for every mouse count — at 800 DPI, 6.00 is 28.9 cm for a full 360° turn.",
  knownEdgeCases: [
    "Legacy ADS Sensitivity Type and per-zoom ADS multipliers are not converted; the Relative coefficient above covers every optic with the multipliers left at 1.00.",
    "Same-physical-sensitivity matching cannot be expressed as a coefficient and is not offered for this game.",
    "The ADS Field of View option (Affected / Independent) changes what you see while aiming, not the coefficient conversion.",
    "Console and controller sensitivity use a different scale and are not modelled.",
  ],
  warnings: [],
  source: {
    title:
      "Call of Duty mouse model: 0.0066° per count at 1.00 (shared across Modern Warfare 2019 through Black Ops 7 / Warzone); Relative ADS = vertical monitor-distance match by coefficient (1.33 default, 1.78 = 100% horizontal on 16:9) per DPI Wizard, mouse-sensitivity.com",
    type: "community-reference",
    url: "https://www.mouse-sensitivity.com/forums/topic/6174-modern-warfare-monitor-distance-coefficient-defaulted-to-133/",
    publisher: "mouse-sensitivity.com (DPI Wizard) and community converters",
    gameVersion:
      "Call of Duty: Warzone with Black Ops 7 (2025–2026) shared settings: Mouse Sensitivity, Vertical Sensitivity Multiplier, ADS Sensitivity Type (Relative), Monitor Distance Coefficient 0.00–2.00, FOV 60–120",
    verifiedAtIso: "2026-09-08",
    lastReviewedAtIso: "2026-09-08",
    confidence: "high",
    uncertaintyNotes: [
      "Activision has not published the yaw constant; 0.0066° per count is the community-measured value used by every Call of Duty converter. Pass 4 confirmed it for the Black Ops 6/7 settings family specifically: that reference's published 800 DPI recommendation of 2.16–8.66 for a 20–80 cm/360 band implies 0.0065993, and it is the same recommendation that reference prints for Overwatch 2, which shares the constant.",
      "The Mouse Sensitivity bounds (0.01–100.00 here) and the Vertical Sensitivity Multiplier bounds (0.10–5.00 here) are taken from the settings screens of recent titles, not from documentation.",
      "The coefficient conversion assumes a 16:9 display when translating a horizontal monitor-distance match onto the vertical axis the game matches on.",
      "Legacy ADS mode is not modelled.",
    ],
  },
  supersededByProfileId: null,
  deprecationNote: null,
};
