/**
 * Canonical ↔ game conversion (Game Profile Pass 1, requirements 3–7, 14, 15).
 *
 * Everything here is driven by profile DATA. There is not one branch on a
 * game's name, and adding a game in a later pass adds no code to this file.
 *
 *     game settings ──canonicalFromGameSettings──▶ CanonicalAim
 *     CanonicalAim  ──gameSettingsFromCanonical──▶ game settings (+ what
 *                                                  rounding cost)
 *
 * The second direction always reports the exact value, the value the game
 * will actually accept, and the difference between them. Nothing is silently
 * absorbed (requirement 15).
 */

import {
  CM_PER_INCH,
  canonicalAim,
  cmPer360X,
  cmPer360Y,
  degreesPerCountAt,
  maxRelativeDifference,
  type CanonicalAim,
} from "./canonical.ts";
import {
  DEFAULT_ASPECT_RATIO,
  resolveFovModel,
  type ResolvedFov,
} from "./fov.ts";
import {
  MATCHING,
  fovFromMagnification,
  zoomSensitivityRatio,
  type ZoomMatchMethod,
} from "./matching.ts";
import {
  quantize,
  roundTripToleranceFraction,
  type QuantizedValue,
} from "./rounding.ts";
import {
  zoomLevelsOf,
  type GameProfile,
  type SensitivityModel,
  type ZoomLevelSpec,
} from "./profileSchema.ts";

export class ConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversionError";
  }
}

type Axis = "x" | "y";

/** Evaluates a profile's sensitivity model: setting value → degrees/count. */
export function degreesPerCountForValue(
  model: SensitivityModel,
  value: number,
  axis: Axis = "x",
): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConversionError(`sensitivity value must be positive and finite (got ${value})`);
  }
  switch (model.kind) {
    case "linear-yaw": {
      const k =
        axis === "y"
          ? model.pitchDegreesPerCountAtOne ?? model.yawDegreesPerCountAtOne
          : model.yawDegreesPerCountAtOne;
      return value * k;
    }
    case "power-law-yaw": {
      const c =
        axis === "y" ? model.pitchCoefficient ?? model.yawCoefficient : model.yawCoefficient;
      const e = axis === "y" ? model.pitchExponent ?? model.yawExponent : model.yawExponent;
      return c * value ** e;
    }
  }
}

/** Inverts a profile's sensitivity model: degrees/count → setting value. */
export function valueForDegreesPerCount(
  model: SensitivityModel,
  degreesPerCount: number,
  axis: Axis = "x",
): number {
  if (!Number.isFinite(degreesPerCount) || degreesPerCount <= 0) {
    throw new ConversionError(
      `degrees-per-count must be positive and finite (got ${degreesPerCount})`,
    );
  }
  switch (model.kind) {
    case "linear-yaw": {
      const k =
        axis === "y"
          ? model.pitchDegreesPerCountAtOne ?? model.yawDegreesPerCountAtOne
          : model.yawDegreesPerCountAtOne;
      return degreesPerCount / k;
    }
    case "power-law-yaw": {
      const c =
        axis === "y" ? model.pitchCoefficient ?? model.yawCoefficient : model.yawCoefficient;
      const e = axis === "y" ? model.pitchExponent ?? model.yawExponent : model.yawExponent;
      return (degreesPerCount / c) ** (1 / e);
    }
  }
}

/**
 * d ln(degrees per count) / d ln(setting value) for a profile's model.
 *
 * It is how much a relative error in the game's slider is magnified into a
 * relative error in physical sensitivity: 1 for every linear scale, and the
 * exponent for a power law. Every rounding tolerance has to be scaled by it,
 * or a non-linear profile would be held to a bound its own slider cannot meet.
 */
export function sensitivityElasticity(
  model: SensitivityModel,
  axis: Axis = "x",
): number {
  switch (model.kind) {
    case "linear-yaw":
      return 1;
    case "power-law-yaw":
      return axis === "y" ? model.pitchExponent ?? model.yawExponent : model.yawExponent;
  }
}

/** The vertical:horizontal ratio the game applies on its own. */
function builtInVerticalRatio(profile: GameProfile): number {
  return profile.axes.builtInVerticalRatio ?? 1;
}

// ---------------------------------------------------------------------------
// game settings → canonical (requirement 14: works with no calibration)
// ---------------------------------------------------------------------------

export interface GameSettingsInput {
  /** The hip-fire (or only) sensitivity value as typed in the game. */
  readonly hipfire: number;
  /**
   * The vertical value, for profiles with independent axes. Omitted or null
   * means "same as horizontal" for an absolute scale, or 1.0 for a multiplier.
   */
  readonly vertical?: number | null | undefined;
  /** The player's configured FOV, for profiles with a configurable one. */
  readonly fovDegrees?: number | null | undefined;
  readonly aspectRatio?: number | undefined;
}

/**
 * Turns a player's current in-game settings into a canonical physical aim.
 *
 * This never needs a completed calibration: it is arithmetic on the profile's
 * declared constants plus the player's DPI (requirement 14).
 */
export function canonicalFromGameSettings(
  profile: GameProfile,
  dpi: number,
  input: GameSettingsInput,
): CanonicalAim {
  if (!Number.isFinite(dpi) || dpi <= 0) {
    throw new ConversionError(`dpi must be positive and finite (got ${dpi})`);
  }
  const model = profile.sensitivityModel;
  const degPerCountX = degreesPerCountForValue(model, input.hipfire, "x");

  let verticalInput: number;
  if (!profile.axes.independentAxes) {
    verticalInput = input.hipfire;
  } else if (profile.axes.verticalSemantics === "multiplier-of-horizontal") {
    const multiplier = input.vertical ?? 1;
    verticalInput = input.hipfire * multiplier;
  } else {
    verticalInput = input.vertical ?? input.hipfire;
  }
  const degPerCountY =
    degreesPerCountForValue(model, verticalInput, "y") * builtInVerticalRatio(profile);

  const countsPerCm = dpi / CM_PER_INCH;
  return canonicalAim(degPerCountX * countsPerCm, degPerCountY * countsPerCm);
}

// ---------------------------------------------------------------------------
// canonical → game settings
// ---------------------------------------------------------------------------

export interface ConversionOptions {
  readonly dpi: number;
  /** The player's configured FOV, when the profile has a configurable one. */
  readonly fovDegrees?: number | null | undefined;
  readonly aspectRatio?: number | undefined;
  /** Zoom matching philosophy; defaults to the profile's own default. */
  readonly matching?: ZoomMatchMethod | undefined;
}

export interface ConvertedSetting {
  readonly field: string;
  readonly label: string;
  readonly value: QuantizedValue;
  /** Formatted for display exactly as the game's own UI shows it. */
  readonly display: string;
}

export interface ConvertedZoom {
  readonly zoomId: string;
  readonly label: string;
  readonly magnification: number | null;
  readonly nativeBehavior: ZoomLevelSpec["nativeBehavior"];
  /** null when the profile declares no setting the player can change. */
  readonly setting: ConvertedSetting | null;
  /** Degrees per count this zoom ends up at, using the rounded values. */
  readonly achievedDegreesPerCount: number;
  readonly achievedCmPer360: number;
  readonly fovDegrees: number | null;
  readonly notes: readonly string[];
}

export interface GameConversion {
  readonly contract: "game-conversion-v1";
  readonly profileId: string;
  readonly profileVersion: number;
  readonly profileDisplayName: string;
  readonly dpi: number;
  /** The canonical aim that was requested. */
  readonly requested: CanonicalAim;
  /** The canonical aim the ROUNDED game values actually produce. */
  readonly achieved: CanonicalAim;
  readonly requestedCmPer360: { readonly x: number; readonly y: number };
  readonly achievedCmPer360: { readonly x: number; readonly y: number };
  readonly hipfire: ConvertedSetting;
  /** Present only for profiles with independent axes. */
  readonly vertical: ConvertedSetting | null;
  readonly zooms: readonly ConvertedZoom[];
  readonly matching: ZoomMatchMethod;
  readonly fov: ResolvedFov | null;
  /** Largest relative error introduced by the game's own entry grid. */
  readonly roundingErrorFraction: number;
  /** Tolerance within which this profile can round-trip at these values. */
  readonly roundTripTolerance: number;
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
}

/** Resolves the FOV of one zoom level, deriving it from magnification if need be. */
function resolveZoomFov(
  zoom: ZoomLevelSpec,
  hipFov: ResolvedFov | null,
  aspectRatio: number,
): ResolvedFov | null {
  const explicit = resolveFovModel(zoom.fov, null, aspectRatio);
  if (explicit) return explicit;
  if (hipFov && zoom.magnification !== null) {
    return fovFromMagnification(hipFov, zoom.magnification);
  }
  return null;
}

/**
 * Converts a canonical physical aim into the numbers a player types into one
 * game, reporting every place the game's own precision limits the answer.
 */
export function gameSettingsFromCanonical(
  profile: GameProfile,
  aim: CanonicalAim,
  options: ConversionOptions,
): GameConversion {
  const dpi = options.dpi;
  if (!Number.isFinite(dpi) || dpi <= 0) {
    throw new ConversionError(`dpi must be positive and finite (got ${dpi})`);
  }
  const aspectRatio = options.aspectRatio ?? DEFAULT_ASPECT_RATIO;
  const matching = options.matching ?? profile.defaultMatching;
  if (!profile.supportedMatching.includes(matching.kind)) {
    throw new ConversionError(
      `profile "${profile.id}" does not support ${matching.kind} matching (supports: ${profile.supportedMatching.join(", ")})`,
    );
  }

  const warnings: string[] = [...profile.warnings];
  const notes: string[] = [];
  const model = profile.sensitivityModel;
  const target = degreesPerCountAt(aim, dpi);
  const countsPerCm = dpi / CM_PER_INCH;

  // ---- horizontal ----
  const exactHip = valueForDegreesPerCount(model, target.x, "x");
  const hipQuant = quantize(profile.hipfireField.entry, exactHip);
  const achievedDegPerCountX = degreesPerCountForValue(model, hipQuant.ui, "x");
  notes.push(...hipQuant.notes);

  // ---- vertical ----
  const ratio = builtInVerticalRatio(profile);
  let vertical: ConvertedSetting | null = null;
  let achievedDegPerCountY: number;

  if (!profile.axes.independentAxes) {
    achievedDegPerCountY = degreesPerCountForValue(model, hipQuant.ui, "y") * ratio;
    const impliedY = achievedDegPerCountY * countsPerCm;
    // Whether the AXIS MODEL can express the requested vertical is a separate
    // question from how much the slider grid rounded. Testing the rounded
    // value here would raise "this game has one sensitivity" against every
    // coarse-stepped profile, including ones that matched the request as
    // exactly as their own slider allows — so the comparison runs against the
    // UNROUNDED horizontal. Rounding has its own note.
    const impliedExactY =
      degreesPerCountForValue(model, exactHip, "y") * ratio * countsPerCm;
    if (Math.abs(impliedExactY - aim.degreesPerCmY) > 1e-6 * aim.degreesPerCmY) {
      warnings.push(
        `${profile.displayName} exposes a single sensitivity, so vertical cannot be set independently. Its vertical works out at ${(360 / impliedY).toFixed(1)} cm/360 rather than the requested ${cmPer360Y(aim).toFixed(1)} cm/360.`,
      );
    }
  } else {
    const field = profile.axes.verticalField!;
    const neededVerticalDegPerCount = target.y / ratio;
    const effectiveValue = valueForDegreesPerCount(model, neededVerticalDegPerCount, "y");
    const exactVertical =
      profile.axes.verticalSemantics === "multiplier-of-horizontal"
        ? effectiveValue / hipQuant.ui
        : effectiveValue;
    const vertQuant = quantize(field.entry, exactVertical);
    notes.push(...vertQuant.notes);
    vertical = {
      field: field.field,
      label: field.label,
      value: vertQuant,
      display: `${vertQuant.ui.toFixed(field.entry.uiDecimals)}${field.entry.unitSuffix}`,
    };
    const appliedValue =
      profile.axes.verticalSemantics === "multiplier-of-horizontal"
        ? hipQuant.ui * vertQuant.ui
        : vertQuant.ui;
    achievedDegPerCountY = degreesPerCountForValue(model, appliedValue, "y") * ratio;
  }

  const achieved = canonicalAim(
    achievedDegPerCountX * countsPerCm,
    achievedDegPerCountY * countsPerCm,
  );

  // The declared round-trip tolerance is the COARSEST grid a round trip has
  // to pass through, scaled by how much the model magnifies a slider error.
  // Using the horizontal field alone understated it for a profile whose
  // vertical control has its own, different granularity.
  let tolerance =
    roundTripToleranceFraction(
      profile.hipfireField.entry,
      Math.min(hipQuant.exact, hipQuant.ui),
    ) * sensitivityElasticity(model, "x");
  if (vertical && profile.axes.verticalField) {
    tolerance = Math.max(
      tolerance,
      roundTripToleranceFraction(
        profile.axes.verticalField.entry,
        Math.min(vertical.value.exact, vertical.value.ui),
      ) * sensitivityElasticity(model, "y"),
    );
  }

  // ---- zoom levels ----
  const hipFov = resolveFovModel(profile.fov, options.fovDegrees, aspectRatio);
  if (
    profile.fov.kind === "configurable" &&
    options.fovDegrees != null &&
    (options.fovDegrees < profile.fov.minDegrees || options.fovDegrees > profile.fov.maxDegrees)
  ) {
    warnings.push(
      `A field of view of ${options.fovDegrees}° is outside ${profile.displayName}'s range of ${profile.fov.minDegrees}–${profile.fov.maxDegrees}°; the conversion used the nearest allowed value.`,
    );
  }
  if (profile.fov.kind === "configurable" && profile.fov.affectsHipfireSensitivity) {
    warnings.push(
      `${profile.displayName} changes hip-fire sensitivity with the field of view; re-check this conversion if you change your FOV.`,
    );
  }

  const zooms: ConvertedZoom[] = [];
  for (const zoom of zoomLevelsOf(profile)) {
    const zoomNotes: string[] = [...zoom.notes];
    const zoomFov = resolveZoomFov(zoom, hipFov, aspectRatio);

    let ratioToHip: number | null;
    try {
      ratioToHip = zoomSensitivityRatio(matching, hipFov, zoomFov);
    } catch (err) {
      warnings.push(
        `${zoom.label}: ${(err as Error).message}. Left at the game's own value.`,
      );
      ratioToHip = null;
    }

    if (zoom.nativeBehavior === "hipfire" || !zoom.setting) {
      zooms.push({
        zoomId: zoom.id,
        label: zoom.label,
        magnification: zoom.magnification,
        nativeBehavior: zoom.nativeBehavior,
        setting: null,
        achievedDegreesPerCount: achievedDegPerCountX,
        achievedCmPer360: 360 / (achievedDegPerCountX * countsPerCm),
        fovDegrees: zoomFov?.statedDeg ?? null,
        notes: zoomNotes,
      });
      continue;
    }

    const fovFactor =
      hipFov && zoomFov
        ? Math.tan((zoomFov.horizontalDeg * Math.PI) / 360) /
          Math.tan((hipFov.horizontalDeg * Math.PI) / 360)
        : null;

    let exactValue: number | null = null;
    if (ratioToHip === null) {
      // game-native (or an unavailable ratio): use the developers' own value.
      if (zoom.neutralValue === null) {
        zoomNotes.push(
          "This game's stock value for this optic is not recorded in the profile, so no value is suggested.",
        );
      } else {
        exactValue = zoom.neutralValue;
        zoomNotes.push("Left at the game's own default relationship.");
      }
    } else {
      switch (zoom.nativeBehavior) {
        case "multiplies-hipfire":
          exactValue = ratioToHip;
          break;
        case "fov-relative-multiplier":
          if (fovFactor === null || fovFactor <= 0) {
            zoomNotes.push(
              "This optic scales with the field of view, which this profile does not model here; no value is suggested.",
            );
          } else {
            exactValue = ratioToHip / fovFactor;
          }
          break;
        case "independent-scalar":
          exactValue = valueForDegreesPerCount(model, achievedDegPerCountX * ratioToHip, "x");
          break;
      }
    }

    if (exactValue === null) {
      zooms.push({
        zoomId: zoom.id,
        label: zoom.label,
        magnification: zoom.magnification,
        nativeBehavior: zoom.nativeBehavior,
        setting: null,
        achievedDegreesPerCount: achievedDegPerCountX,
        achievedCmPer360: 360 / (achievedDegPerCountX * countsPerCm),
        fovDegrees: zoomFov?.statedDeg ?? null,
        notes: zoomNotes,
      });
      continue;
    }

    const q = quantize(zoom.setting.entry, exactValue);
    zoomNotes.push(...q.notes);
    let achievedZoomDegPerCount: number;
    switch (zoom.nativeBehavior) {
      case "multiplies-hipfire":
        achievedZoomDegPerCount = achievedDegPerCountX * q.ui;
        break;
      case "fov-relative-multiplier":
        achievedZoomDegPerCount = achievedDegPerCountX * q.ui * (fovFactor ?? 1);
        break;
      case "independent-scalar":
        achievedZoomDegPerCount = degreesPerCountForValue(model, q.ui, "x");
        break;
      default:
        achievedZoomDegPerCount = achievedDegPerCountX;
    }
    zooms.push({
      zoomId: zoom.id,
      label: zoom.label,
      magnification: zoom.magnification,
      nativeBehavior: zoom.nativeBehavior,
      setting: {
        field: zoom.setting.field,
        label: zoom.setting.label,
        value: q,
        display: `${q.ui.toFixed(zoom.setting.entry.uiDecimals)}${zoom.setting.entry.unitSuffix}`,
      },
      achievedDegreesPerCount: achievedZoomDegPerCount,
      achievedCmPer360: 360 / (achievedZoomDegPerCount * countsPerCm),
      fovDegrees: zoomFov?.statedDeg ?? null,
      notes: zoomNotes,
    });
  }

  if (profile.status === "experimental") {
    warnings.push(
      `The ${profile.displayName} profile is experimental: its numbers have not been confirmed against the game.`,
    );
  }
  if (profile.status === "deprecated") {
    warnings.push(
      `The ${profile.displayName} profile is deprecated. ${profile.deprecationNote ?? ""}`.trim(),
    );
  }
  if (profile.status === "partially-verified") {
    warnings.push(
      `Parts of the ${profile.displayName} profile are unverified — see what is known below before trusting a scoped value.`,
    );
  }

  return {
    contract: "game-conversion-v1",
    profileId: profile.id,
    profileVersion: profile.profileVersion,
    profileDisplayName: profile.displayName,
    dpi,
    requested: aim,
    achieved,
    requestedCmPer360: { x: cmPer360X(aim), y: cmPer360Y(aim) },
    achievedCmPer360: { x: cmPer360X(achieved), y: cmPer360Y(achieved) },
    hipfire: {
      field: profile.hipfireField.field,
      label: profile.hipfireField.label,
      value: hipQuant,
      display: `${hipQuant.ui.toFixed(profile.hipfireField.entry.uiDecimals)}${profile.hipfireField.entry.unitSuffix}`,
    },
    vertical,
    zooms,
    matching,
    fov: hipFov,
    roundingErrorFraction: maxRelativeDifference(achieved, aim),
    roundTripTolerance: tolerance,
    warnings,
    notes,
  };
}

// ---------------------------------------------------------------------------
// DPI handling (requirement 4)
// ---------------------------------------------------------------------------

export interface DpiChange {
  readonly fromDpi: number;
  readonly toDpi: number;
  /** The physical sensitivity, which a DPI change must not alter. */
  readonly canonical: CanonicalAim;
  readonly cmPer360: number;
  readonly before: GameConversion;
  readonly after: GameConversion;
  /** True when the new DPI cannot express the same physical sensitivity. */
  readonly unreachableAtNewDpi: boolean;
}

/**
 * Answers "I want the same feel at a different DPI — what do I type now?".
 *
 * The canonical aim is computed once from the CURRENT settings and then
 * re-expressed at the new DPI. cm/360 is invariant by construction; only the
 * game-facing number moves (requirement 4).
 */
export function changeDpi(
  profile: GameProfile,
  current: GameSettingsInput,
  fromDpi: number,
  toDpi: number,
  options: Omit<ConversionOptions, "dpi"> = {},
): DpiChange {
  const canonical = canonicalFromGameSettings(profile, fromDpi, current);
  const before = gameSettingsFromCanonical(profile, canonical, { ...options, dpi: fromDpi });
  const after = gameSettingsFromCanonical(profile, canonical, { ...options, dpi: toDpi });
  return {
    fromDpi,
    toDpi,
    canonical,
    cmPer360: cmPer360X(canonical),
    before,
    after,
    unreachableAtNewDpi:
      after.hipfire.value.clampedToMin || after.hipfire.value.clampedToMax,
  };
}

// ---------------------------------------------------------------------------
// round-trip verification (requirement 16)
// ---------------------------------------------------------------------------

export interface RoundTripResult {
  readonly aim: CanonicalAim;
  readonly recovered: CanonicalAim;
  /** Error on the axes this profile can actually express. */
  readonly relativeError: number;
  readonly tolerance: number;
  readonly withinTolerance: boolean;
  readonly clamped: boolean;
  /**
   * True when reading the produced settings back reproduces the conversion's
   * own `achieved` aim exactly. This is the pure mathematical property — the
   * inverse really is the inverse — and it holds even when the profile cannot
   * express the requested aim at all.
   */
  readonly inverseConsistent: boolean;
  /**
   * False when the profile has no way to set vertical independently, so the
   * vertical axis is whatever the horizontal one implies. The warning that
   * says so lives on the conversion.
   */
  readonly verticalExpressible: boolean;
}

/**
 * `canonical → profile → canonical`, with the tolerance the profile's own
 * entry grid makes possible. A conversion cannot be more precise than the
 * game's slider, and a test demanding otherwise would be testing a lie.
 *
 * The comparison runs on the axes the profile can EXPRESS. A game with one
 * sensitivity slider and a built-in 0.75 pitch ratio cannot reproduce a
 * symmetric physical aim on both axes, and calling that a round-trip failure
 * would be measuring the game's design rather than this layer's arithmetic —
 * `gameSettingsFromCanonical` already warns about it in words.
 */
export function roundTrip(
  profile: GameProfile,
  aim: CanonicalAim,
  options: ConversionOptions,
): RoundTripResult {
  const conversion = gameSettingsFromCanonical(profile, aim, options);
  const recovered = canonicalFromGameSettings(profile, options.dpi, {
    hipfire: conversion.hipfire.value.ui,
    vertical: conversion.vertical?.value.ui ?? null,
    fovDegrees: options.fovDegrees ?? null,
    aspectRatio: options.aspectRatio ?? DEFAULT_ASPECT_RATIO,
  });
  const clamped =
    conversion.hipfire.value.clampedToMin ||
    conversion.hipfire.value.clampedToMax ||
    (conversion.vertical?.value.clampedToMin ?? false) ||
    (conversion.vertical?.value.clampedToMax ?? false);
  const verticalExpressible = profile.axes.independentAxes;
  const errorX = Math.abs(
    (recovered.degreesPerCmX - aim.degreesPerCmX) / aim.degreesPerCmX,
  );
  const errorY = Math.abs(
    (recovered.degreesPerCmY - aim.degreesPerCmY) / aim.degreesPerCmY,
  );
  const relativeError = verticalExpressible ? Math.max(errorX, errorY) : errorX;
  return {
    aim,
    recovered,
    relativeError,
    tolerance: conversion.roundTripTolerance,
    withinTolerance: clamped || relativeError <= conversion.roundTripTolerance,
    clamped,
    inverseConsistent:
      maxRelativeDifference(recovered, conversion.achieved) <= 1e-9,
    verticalExpressible,
  };
}

/** Convenience: the matching methods a profile can actually be asked for. */
export function availableMatching(profile: GameProfile): ZoomMatchMethod[] {
  const out: ZoomMatchMethod[] = [];
  if (profile.supportedMatching.includes("physical-360-distance")) {
    out.push(MATCHING.physical360);
  }
  if (profile.supportedMatching.includes("monitor-distance")) {
    out.push(MATCHING.fovRelative, MATCHING.monitorDistance100);
  }
  if (profile.supportedMatching.includes("game-native")) {
    out.push(MATCHING.gameNative);
  }
  return out;
}
