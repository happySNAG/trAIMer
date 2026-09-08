/**
 * Battlefield 6 (Game Profile Campaign, Pass 3) — EXPERIMENTAL.
 *
 * ## Which game
 *
 * Battlefield 6 (EA / DICE, October 2025) only. Earlier Battlefield titles
 * use a different sensitivity scale — the maintainer of the community BF6
 * guide notes the menu scale changed from Battlefield 2042 and that the
 * base sensitivity is lower — so no earlier title shares this profile.
 *
 * ## The model
 *
 * "Soldier mouse sensitivity" is a 0–100 menu value adjustable in tenths;
 * the configuration file stores it as `GstInput.MouseSensitivity` from
 * 0.000000 to 0.075000, exactly 0.000750 per menu unit. DICE publishes no
 * rotation constant. One published data point exists — the guide's author
 * at 1600 DPI and menu value 6 measures 37.98 cm for a 360° turn — which
 * gives 0.0025079° per mouse count per menu unit. That single point is why
 * the profile is experimental.
 *
 * ## ADS: Uniform Soldier Aiming is a monitor-distance coefficient
 *
 * With Uniform Soldier Aiming on, the game matches every zoom to hip-fire by
 * monitor distance itself, and the coefficient names which fraction of the
 * vertical half-screen is matched: 0% is the focal-length limit, 133.3% is
 * the horizontal edge on a 4:3 display, 177.7% on 16:9, 233.3% on 21:9. The
 * per-zoom sensitivities then multiply on top, so leaving them at 1.00
 * lets one number cover every optic — the same structure as Call of Duty's
 * Relative mode, which this profile models the same way.
 *
 * ## Pass 4 correction: the stock coefficient is 133.3%, not 177.7%
 *
 * Pass 3 recorded 177.7% as the game's own default. It is not: 177.7% is the
 * value that matches 100% of the screen WIDTH on a 16:9 display, and the
 * coefficient Battlefield ships is 1.333333 — the Battlefield-series default
 * since Uniform Soldier Aiming was introduced, which matches the width of a
 * 4:3 screen and therefore about 75% of a 16:9 one. Both the community guide
 * this profile cites and the technical author who corrects the common
 * confusion agree the shipped value is 133 and that 178 is what a 16:9
 * player must set for a full-width match. So "the game's own default" now
 * produces 133.3% and "100% monitor distance" produces 177.8%, and they are
 * no longer the same answer under two names.
 */

import { MATCHING } from "../matching.ts";
import {
  GAME_PROFILE_SCHEMA_VERSION,
  type GameProfile,
} from "../profileSchema.ts";

/** Degrees of view rotation per mouse count per menu unit of soldier sensitivity. */
export const BATTLEFIELD_6_DEGREES_PER_COUNT_AT_ONE = 0.0025079;

/**
 * Stock Uniform Soldier Aiming coefficient, as a fraction (133.3% in the
 * menu). This is the value the game ships with, NOT the 16:9 full-width
 * match — that is 16/9 = 177.8%, which the monitor-distance philosophy
 * computes on its own from the player's aspect ratio.
 */
export const BATTLEFIELD_6_DEFAULT_COEFFICIENT = 4 / 3;

export const BATTLEFIELD_6_PROFILE_ID = "battlefield-6";

export const BATTLEFIELD_6_PROFILE: GameProfile = {
  schemaVersion: GAME_PROFILE_SCHEMA_VERSION,
  id: BATTLEFIELD_6_PROFILE_ID,
  displayName: "Battlefield 6",
  publisher: "Electronic Arts / DICE",
  gameFamily: "Frostbite (Battlefield)",
  profileVersion: 1,
  status: "experimental",
  visibility: "public",
  platforms: ["pc"],

  sensitivityModel: {
    kind: "linear-yaw",
    yawDegreesPerCountAtOne: BATTLEFIELD_6_DEGREES_PER_COUNT_AT_ONE,
    pitchDegreesPerCountAtOne: null,
  },
  hipfireField: {
    field: "GstInput.MouseSensitivity",
    label: "Soldier mouse sensitivity",
    entry: {
      min: 0.1,
      max: 100,
      step: 0.1,
      stepOrigin: 0,
      uiDecimals: 1,
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
      "The numbers assume raw mouse input, Windows pointer speed at the default 6/11 notch with Enhance pointer precision off.",
    ],
  },
  fov: {
    kind: "configurable",
    axis: "horizontal",
    defaultDegrees: 90,
    minDegrees: 85,
    maxDegrees: 122,
    stepDegrees: 1,
    affectsHipfireSensitivity: false,
  },
  zoom: {
    kind: "single-scalar",
    zoom: {
      id: "ads-uniform-aiming",
      label: "Aiming down sights — Uniform Soldier Aiming on, every zoom",
      magnification: null,
      fov: { kind: "none" },
      setting: {
        field: "GstInput.UniformSoldierAimingCoefficient",
        label: "Uniform Soldier Aiming coefficient",
        entry: {
          min: 0,
          max: 400,
          step: 0.1,
          stepOrigin: 0,
          uiDecimals: 1,
          configDecimals: null,
          rounding: "nearest",
          unitSuffix: "%",
          allowZero: true,
          clampAdvice: "none",
        },
      },
      neutralValue: BATTLEFIELD_6_DEFAULT_COEFFICIENT,
      nativeBehavior: "monitor-distance-coefficient",
      coefficientAxis: "vertical",
      valueScale: 100,
      notes: [
        "Turn Uniform Soldier Aiming on and leave Soldier zoom sensitivity and every per-zoom sensitivity at 1.00; the coefficient then matches every optic on its own.",
      ],
    },
  },

  defaultMatching: MATCHING.gameNative,
  supportedMatching: ["monitor-distance", "game-native"],

  unitDefinition:
    "1.0 turns the view 0.0025° for every mouse count — at 1600 DPI, 6.0 is 38.0 cm for a full 360° turn.",
  knownEdgeCases: [
    "Battlefield 6 only. Battlefield 2042 and earlier use a different menu scale and are not covered.",
    "The game's own default Uniform Soldier Aiming coefficient is 133.3%, which matches the full width of a 4:3 screen — about 75% of the width of a 16:9 one. Choosing 100% monitor distance instead gives 177.8% on 16:9.",
    "The configuration file stores the menu value × 0.000750 (0.000000–0.075000); it is the same setting on another scale, not extra precision, and is not offered.",
    "Per-zoom sensitivities (1.00×–10.00×) and Zoom Sensitivity Smoothing are not converted; the profile relies on Uniform Soldier Aiming with them at their defaults.",
    "Same-physical-sensitivity matching cannot be expressed as a coefficient and is not offered.",
    "The FOV slider (a horizontal angle, about 85–122) does not change hip-fire rotation per count and is not read by the coefficient conversion.",
  ],
  warnings: [],
  source: {
    title:
      "Community reference (Jotunn, 'Battlefield 6 PC Sensitivity Guide'): menu ↔ GstInput.MouseSensitivity scale, Uniform Soldier Aiming coefficients per aspect ratio, and the single published 360° measurement (6.0 at 1600 DPI = 37.98 cm) from which 0.0025079° per count per unit is derived",
    type: "community-reference",
    url: "https://gist.github.com/Jotunn/a574f25d18376f53bd1fb0ff8e4b9e04",
    publisher: "Jotunn (community guide), with mouse-sensitivity.com's Battlefield 6 support thread for the zoom structure",
    gameVersion:
      "Battlefield 6 (2025) on PC, 2026 settings: Soldier mouse sensitivity 0–100, Uniform Soldier Aiming + coefficient, per-zoom sensitivities, FOV slider",
    verifiedAtIso: "2026-09-08",
    lastReviewedAtIso: "2026-09-08",
    confidence: "moderate",
    uncertaintyNotes: [
      "DICE publishes no rotation constant. 0.0025079° per count per menu unit is derived from ONE published measurement (1600 DPI, 6.0 = 37.98 cm/360); it has not been re-measured here. A player who measures a different 360° distance should trust the measurement.",
      "The stock coefficient is 133.3% (the Battlefield-series default, a full-width match on 4:3 and about 75% of the width on 16:9). Guides that call 178% \"the default\" mean it is what a 16:9 player should set for a full-width match; that value is offered here as 100% monitor distance, not as the game's default.",
      "DICE does not document the coefficient's meaning; that it names the fraction of the vertical half-screen matched is inferred from the published per-aspect-ratio values (4:3 133.3%, 16:9 177.7%, 21:9 233.3%, 32:9 355.5%), which are exactly the aspect ratios themselves.",
      "A second community family quotes 0.0022° per count for \"the Battlefield series\"; that is 14% away from the value derived here and appears to predate Battlefield 6's menu-scale change. Neither value has been measured for this pass, which is why the profile stays experimental.",
      "The coefficient's upper bound (400% here) is assumed, not documented. The FOV slider bounds conflict between references (85–120 in one converter, up to 122 in the community guide) and the guide's author describes the same setting as both a horizontal and a vertical angle; no converted value reads it.",
      "The horizontal-to-vertical coefficient translation assumes a 16:9 display.",
    ],
  },
  supersededByProfileId: null,
  deprecationNote: null,
};
