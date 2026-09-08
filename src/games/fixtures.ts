/**
 * Synthetic architecture fixtures (Game Profile Pass 1, requirement 13).
 *
 * These are NOT games. They exist so every branch of the profile schema —
 * linked and independent axes, stepped and continuous entry, a single ADS
 * scalar and per-optic multipliers, configurable FOV, a power-law scale, a
 * config file finer than the settings screen, and deprecation — is exercised
 * by tests without waiting for a real game profile to arrive in Pass 2.
 *
 * Every fixture carries `visibility: "fixture"`, which keeps it out of
 * `registry.selectable()` and out of `PUBLIC_GAME_PROFILES`. A test asserts
 * that none of them can reach a player.
 */

import { MATCHING } from "./matching.ts";
import {
  GAME_PROFILE_SCHEMA_VERSION,
  type GameProfile,
} from "./profileSchema.ts";

const FIXTURE_SOURCE = {
  title: "trAIMer synthetic architecture fixture",
  type: "unit-definition" as const,
  url: null,
  publisher: "trAIMer",
  gameVersion: null,
  verifiedAtIso: "2026-09-07",
  lastReviewedAtIso: "2026-09-07",
  confidence: "exact" as const,
  uncertaintyNotes: [],
};

/**
 * Linked X/Y, a stepped percent slider, a built-in vertical ratio, and one
 * ADS multiplier covering every optic.
 */
export const FIXTURE_LINKED_STEPPED: GameProfile = {
  schemaVersion: GAME_PROFILE_SCHEMA_VERSION,
  id: "fixture-linked-stepped",
  displayName: "Fixture — linked axes, stepped slider",
  publisher: null,
  gameFamily: "trAIMer fixtures",
  profileVersion: 1,
  status: "verified",
  visibility: "fixture",
  platforms: ["pc"],
  sensitivityModel: {
    kind: "linear-yaw",
    yawDegreesPerCountAtOne: 0.0035,
    pitchDegreesPerCountAtOne: null,
  },
  hipfireField: {
    field: "mouseSensitivity",
    label: "Mouse sensitivity",
    entry: {
      min: 0.1,
      max: 50,
      step: 0.1,
      stepOrigin: 0,
      uiDecimals: 1,
      configDecimals: null,
      rounding: "nearest",
      unitSuffix: "%",
    },
  },
  axes: {
    independentAxes: false,
    verticalSemantics: "none",
    verticalField: null,
    builtInVerticalRatio: 0.75,
  },
  dpi: {
    countBased: true,
    assumesWindowsPointerSpeedDefault: true,
    requiresRawInput: true,
    notes: [],
  },
  fov: {
    kind: "configurable",
    axis: "horizontal",
    defaultDegrees: 90,
    minDegrees: 70,
    maxDegrees: 120,
    stepDegrees: 1,
    affectsHipfireSensitivity: false,
  },
  zoom: {
    kind: "single-scalar",
    zoom: {
      id: "ads",
      label: "Aiming down sights",
      magnification: 1.5,
      fov: { kind: "fixed", axis: "horizontal", degrees: 65 },
      setting: {
        field: "adsSensitivity",
        label: "ADS sensitivity",
        entry: {
          min: 0.05,
          max: 3,
          step: 0.01,
          stepOrigin: 0,
          uiDecimals: 2,
          configDecimals: null,
          rounding: "nearest",
          unitSuffix: "×",
        },
      },
      neutralValue: 1,
      nativeBehavior: "multiplies-hipfire",
      notes: [],
    },
  },
  defaultMatching: MATCHING.physical360,
  supportedMatching: ["physical-360-distance", "monitor-distance", "game-native"],
  unitDefinition: "1.0% turns the view 0.0035° per mouse count.",
  knownEdgeCases: [],
  warnings: [],
  source: FIXTURE_SOURCE,
  supersededByProfileId: null,
  deprecationNote: null,
};

/** Independent, absolute X and Y on a continuous scale; no optics. */
export const FIXTURE_INDEPENDENT_CONTINUOUS: GameProfile = {
  schemaVersion: GAME_PROFILE_SCHEMA_VERSION,
  id: "fixture-independent-continuous",
  displayName: "Fixture — independent axes, continuous entry",
  publisher: null,
  gameFamily: "trAIMer fixtures",
  profileVersion: 1,
  status: "verified",
  visibility: "fixture",
  platforms: ["pc"],
  sensitivityModel: {
    kind: "linear-yaw",
    yawDegreesPerCountAtOne: 0.022,
    pitchDegreesPerCountAtOne: 0.022,
  },
  hipfireField: {
    field: "sensitivity",
    label: "Horizontal sensitivity",
    entry: {
      min: 0.01,
      max: 20,
      step: null,
      uiDecimals: 3,
      configDecimals: 6,
      rounding: "nearest",
      unitSuffix: "",
    },
  },
  axes: {
    independentAxes: true,
    verticalSemantics: "absolute",
    verticalField: {
      field: "sensitivityY",
      label: "Vertical sensitivity",
      entry: {
        min: 0.01,
        max: 20,
        step: null,
        uiDecimals: 3,
        configDecimals: 6,
        rounding: "nearest",
        unitSuffix: "",
      },
    },
    builtInVerticalRatio: null,
  },
  dpi: {
    countBased: true,
    assumesWindowsPointerSpeedDefault: true,
    requiresRawInput: true,
    notes: [],
  },
  fov: {
    kind: "configurable",
    axis: "horizontal-at-4-3",
    defaultDegrees: 90,
    minDegrees: 70,
    maxDegrees: 130,
    stepDegrees: null,
    affectsHipfireSensitivity: false,
  },
  zoom: { kind: "none" },
  defaultMatching: MATCHING.physical360,
  supportedMatching: ["physical-360-distance", "monitor-distance"],
  unitDefinition: "1.0 turns the view 0.022° per mouse count.",
  knownEdgeCases: [],
  warnings: [],
  source: FIXTURE_SOURCE,
  supersededByProfileId: null,
  deprecationNote: null,
};

/** Per-optic multipliers, mixed native behaviours, fixed per-optic FOVs. */
export const FIXTURE_PER_SCOPE: GameProfile = {
  schemaVersion: GAME_PROFILE_SCHEMA_VERSION,
  id: "fixture-per-scope",
  displayName: "Fixture — per-scope multipliers",
  publisher: null,
  gameFamily: "trAIMer fixtures",
  profileVersion: 2,
  status: "partially-verified",
  visibility: "fixture",
  platforms: ["pc", "console"],
  sensitivityModel: {
    kind: "linear-yaw",
    yawDegreesPerCountAtOne: 0.0066,
    pitchDegreesPerCountAtOne: null,
  },
  hipfireField: {
    field: "lookSensitivity",
    label: "Look sensitivity",
    entry: {
      min: 0.1,
      max: 10,
      step: 0.05,
      stepOrigin: 0,
      uiDecimals: 2,
      configDecimals: 5,
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
    notes: [],
  },
  fov: {
    kind: "configurable",
    axis: "vertical",
    defaultDegrees: 60,
    minDegrees: 50,
    maxDegrees: 90,
    stepDegrees: 1,
    affectsHipfireSensitivity: false,
  },
  zoom: {
    kind: "per-zoom",
    zooms: [
      {
        id: "ads-1x",
        label: "1x sights",
        magnification: 1,
        fov: { kind: "fixed", axis: "vertical", degrees: 55 },
        setting: {
          field: "ads1xSensitivity",
          label: "1x sensitivity",
          entry: {
            min: 0.1,
            max: 2,
            step: 0.01,
            stepOrigin: 0,
            uiDecimals: 2,
            configDecimals: null,
            rounding: "nearest",
            unitSuffix: "×",
          },
        },
        neutralValue: 1,
        nativeBehavior: "multiplies-hipfire",
        notes: [],
      },
      {
        id: "ads-2x",
        label: "2x scope",
        magnification: 2,
        fov: { kind: "fixed", axis: "vertical", degrees: 30 },
        setting: {
          field: "ads2xSensitivity",
          label: "2x sensitivity",
          entry: {
            min: 0.1,
            max: 2,
            step: 0.01,
            stepOrigin: 0,
            uiDecimals: 2,
            configDecimals: null,
            rounding: "nearest",
            unitSuffix: "×",
          },
        },
        neutralValue: 1,
        nativeBehavior: "multiplies-hipfire",
        notes: [],
      },
      {
        id: "ads-4x",
        label: "4x scope",
        magnification: 4,
        fov: { kind: "fixed", axis: "vertical", degrees: 15 },
        setting: {
          field: "ads4xSensitivity",
          label: "4x sensitivity",
          entry: {
            min: 0.1,
            max: 2,
            step: 0.01,
            stepOrigin: 0,
            uiDecimals: 2,
            configDecimals: null,
            rounding: "nearest",
            unitSuffix: "×",
          },
        },
        neutralValue: 1,
        // This optic is one the game already scales by field of view, so its
        // neutral 1.00 means "matched to what you see" rather than "same
        // degrees per count".
        nativeBehavior: "fov-relative-multiplier",
        notes: [],
      },
      {
        id: "sniper",
        label: "Sniper scope",
        magnification: 8,
        fov: { kind: "fixed", axis: "vertical", degrees: 7.5 },
        setting: {
          field: "sniperSensitivity",
          label: "Sniper sensitivity",
          entry: {
            min: 0.05,
            max: 2,
            step: 0.01,
            stepOrigin: 0,
            uiDecimals: 2,
            configDecimals: null,
            rounding: "nearest",
            unitSuffix: "×",
          },
        },
        neutralValue: 1,
        nativeBehavior: "multiplies-hipfire",
        notes: [],
      },
    ],
  },
  defaultMatching: MATCHING.fovRelative,
  supportedMatching: ["physical-360-distance", "monitor-distance", "game-native"],
  unitDefinition: "1.00 turns the view 0.0066° per mouse count.",
  knownEdgeCases: [
    "The sniper scope's second zoom stage is not modelled; only its first stage converts.",
  ],
  warnings: [],
  source: {
    ...FIXTURE_SOURCE,
    confidence: "high",
    uncertaintyNotes: ["Scope FOVs are fixture values, not measurements."],
  },
  supersededByProfileId: null,
  deprecationNote: null,
};

/** A non-linear (power-law) scale with a vertical multiplier. */
export const FIXTURE_POWER_LAW: GameProfile = {
  schemaVersion: GAME_PROFILE_SCHEMA_VERSION,
  id: "fixture-power-law",
  displayName: "Fixture — power-law scale",
  publisher: null,
  gameFamily: "trAIMer fixtures",
  profileVersion: 1,
  status: "experimental",
  visibility: "fixture",
  platforms: ["pc"],
  sensitivityModel: {
    kind: "power-law-yaw",
    yawCoefficient: 0.004,
    yawExponent: 1.4,
    pitchCoefficient: null,
    pitchExponent: null,
  },
  hipfireField: {
    field: "sensitivity",
    label: "Sensitivity",
    entry: {
      min: 0.5,
      max: 25,
      step: 0.25,
      stepOrigin: 0,
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
      field: "verticalMultiplier",
      label: "Vertical multiplier",
      entry: {
        min: 0.25,
        max: 4,
        step: 0.01,
        stepOrigin: 0,
        uiDecimals: 2,
        configDecimals: null,
        rounding: "nearest",
        unitSuffix: "×",
      },
    },
    builtInVerticalRatio: null,
  },
  dpi: {
    countBased: true,
    assumesWindowsPointerSpeedDefault: true,
    requiresRawInput: true,
    notes: [],
  },
  fov: { kind: "none" },
  zoom: { kind: "none" },
  defaultMatching: MATCHING.physical360,
  supportedMatching: ["physical-360-distance"],
  unitDefinition: "Degrees per count is 0.004 × sensitivity^1.4.",
  knownEdgeCases: [],
  warnings: [],
  source: { ...FIXTURE_SOURCE, confidence: "moderate", uncertaintyNotes: ["Synthetic exponent."] },
  supersededByProfileId: null,
  deprecationNote: null,
};

/** A deprecated profile that names its successor. */
export const FIXTURE_DEPRECATED: GameProfile = {
  ...FIXTURE_LINKED_STEPPED,
  id: "fixture-deprecated",
  displayName: "Fixture — deprecated profile",
  profileVersion: 1,
  status: "deprecated",
  supersededByProfileId: FIXTURE_LINKED_STEPPED.id,
  deprecationNote:
    "The game changed its sensitivity scale in a patch, so values converted under this definition are no longer correct.",
};

/**
 * A linear-FOV-ratio zoom (the Source / Valorant relationship) with a
 * percentage-scaled targeting value, and a monitor-distance coefficient the
 * game applies itself (Pass 2 behaviours).
 */
export const FIXTURE_ENGINE_SCALED: GameProfile = {
  schemaVersion: GAME_PROFILE_SCHEMA_VERSION,
  id: "fixture-engine-scaled",
  displayName: "Fixture — engine-scaled zoom and coefficient",
  publisher: null,
  gameFamily: "trAIMer fixtures",
  profileVersion: 1,
  status: "verified",
  visibility: "fixture",
  platforms: ["pc"],
  sensitivityModel: {
    kind: "linear-yaw",
    yawDegreesPerCountAtOne: 0.022,
    pitchDegreesPerCountAtOne: null,
  },
  hipfireField: {
    field: "sensitivity",
    label: "Sensitivity",
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
    notes: [],
  },
  fov: { kind: "fixed", axis: "horizontal-at-4-3", degrees: 90 },
  zoom: {
    kind: "per-zoom",
    zooms: [
      {
        id: "scope",
        label: "Scope (40°)",
        magnification: null,
        fov: { kind: "fixed", axis: "horizontal-at-4-3", degrees: 40 },
        setting: {
          field: "zoomRatioPercent",
          label: "Zoom sensitivity",
          entry: {
            min: 10,
            max: 300,
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
        nativeBehavior: "fov-ratio-multiplier",
        valueScale: 100,
        notes: [],
      },
      {
        id: "coefficient",
        label: "Aim down sights (game-applied coefficient)",
        magnification: null,
        fov: { kind: "none" },
        setting: {
          field: "coefficient",
          label: "Monitor distance coefficient",
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
        neutralValue: 1.33,
        nativeBehavior: "monitor-distance-coefficient",
        coefficientAxis: "vertical",
        notes: [],
      },
    ],
  },
  defaultMatching: MATCHING.gameNative,
  supportedMatching: ["physical-360-distance", "monitor-distance", "game-native"],
  unitDefinition: "1.00 turns the view 0.022° per mouse count.",
  knownEdgeCases: [],
  warnings: [],
  source: FIXTURE_SOURCE,
  supersededByProfileId: null,
  deprecationNote: null,
};

export const ARCHITECTURE_FIXTURE_PROFILES: readonly GameProfile[] = [
  FIXTURE_LINKED_STEPPED,
  FIXTURE_INDEPENDENT_CONTINUOUS,
  FIXTURE_PER_SCOPE,
  FIXTURE_POWER_LAW,
  FIXTURE_ENGINE_SCALED,
  FIXTURE_DEPRECATED,
];
