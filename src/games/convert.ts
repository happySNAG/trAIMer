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
  hipfireFovFactor,
  resolveFovModel,
  resolveScaledFov,
  verticalToHorizontal,
  type FovAxis,
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
  // A game whose hip-fire rotation scales with its FOV setting (PUBG) applies
  // that factor to both axes; every other profile has a factor of exactly 1.
  const fovFactor = hipfireFovFactor(profile.fov, input.fovDegrees);
  const degPerCountX = degreesPerCountForValue(model, input.hipfire, "x") * fovFactor;

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
    degreesPerCountForValue(model, verticalInput, "y") * builtInVerticalRatio(profile) * fovFactor;

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
  /**
   * Degrees per count this zoom ends up at, using the rounded values. `null`
   * when there is no single answer — a game-applied coefficient gives every
   * optic its own value, and the profile does not pretend to know them all.
   */
  readonly achievedDegreesPerCount: number | null;
  readonly achievedCmPer360: number | null;
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

/**
 * A resolved FOV re-stated on a given axis convention.
 *
 * The linear angle ratio a Source-lineage engine applies is taken on ITS
 * numbers — 40° over 90°, both quoted at 4:3 — and would come out differently
 * on the 16:9 horizontal angles, so the ratio has to be formed on the axis the
 * hip-fire number is stated on.
 */
export function fovDegreesOnAxis(fov: ResolvedFov, axis: FovAxis): number {
  switch (axis) {
    case "horizontal":
      return fov.horizontalDeg;
    case "vertical":
      return fov.verticalDeg;
    case "horizontal-at-4-3":
      return verticalToHorizontal(fov.verticalDeg, 4 / 3);
    case "horizontal-at-16-9":
      return verticalToHorizontal(fov.verticalDeg, 16 / 9);
  }
}

/**
 * True when converting this profile reads a field of view the player can set.
 * Drives whether the picker shows an FOV control at all: a configurable FOV
 * that no conversion path reads would be a decorative input.
 */
export function conversionUsesFov(profile: GameProfile): boolean {
  if (profile.fov.kind !== "configurable") return false;
  if (profile.fov.affectsHipfireSensitivity) return true;
  // A coefficient the game applies itself is translated without any FOV;
  // only a zoom whose ratio THIS layer computes can read one.
  const fovZooms = zoomLevelsOf(profile).filter(
    (z) => z.nativeBehavior !== "hipfire" && z.nativeBehavior !== "monitor-distance-coefficient",
  );
  if (fovZooms.length === 0) return false;
  return (
    profile.supportedMatching.includes("monitor-distance") ||
    fovZooms.some(
      (z) =>
        z.nativeBehavior === "fov-relative-multiplier" ||
        z.nativeBehavior === "fov-ratio-multiplier",
    )
  );
}

/**
 * Translates a matching philosophy into the coefficient a game that applies
 * monitor-distance matching ITSELF expects, on the axis that game matches on.
 *
 * Matching a fraction c of the horizontal half-width is the same point on the
 * screen as matching c × aspect of the vertical half-height, because
 * tan(θ_h) = aspect × tan(θ_v). Returns null for a philosophy the coefficient
 * cannot express (physical-360 would need an infinite coefficient).
 */
export function monitorDistanceCoefficientFor(
  matching: ZoomMatchMethod,
  gameAxis: "horizontal" | "vertical",
  aspectRatio: number,
): number | null {
  if (matching.kind !== "monitor-distance") return null;
  const c = matching.coefficient ?? 0;
  const axis = matching.axis ?? "horizontal";
  if (axis === gameAxis) return c;
  return gameAxis === "vertical" ? c * aspectRatio : c / aspectRatio;
}

/** Resolves the FOV of one zoom level, deriving it from magnification if need be. */
function resolveZoomFov(
  zoom: ZoomLevelSpec,
  hipFov: ResolvedFov | null,
  aspectRatio: number,
): ResolvedFov | null {
  if (zoom.fov.kind === "scaled-from-hipfire") {
    return hipFov ? resolveScaledFov(zoom.fov.factor, hipFov) : null;
  }
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
  // The setting the game needs is the target divided by whatever its FOV
  // setting multiplies hip-fire by (1 for every game but PUBG).
  const hipFovFactor = hipfireFovFactor(profile.fov, options.fovDegrees);

  // ---- horizontal ----
  const exactHip = valueForDegreesPerCount(model, target.x / hipFovFactor, "x");
  const hipQuant = quantize(profile.hipfireField.entry, exactHip);
  const achievedDegPerCountX = degreesPerCountForValue(model, hipQuant.ui, "x") * hipFovFactor;
  notes.push(
    ...hipQuant.notes.map((n) =>
      profile.axes.independentAxes ? `${profile.hipfireField.label}: ${n}` : n,
    ),
  );

  // ---- vertical ----
  const ratio = builtInVerticalRatio(profile);
  let vertical: ConvertedSetting | null = null;
  let achievedDegPerCountY: number;

  if (!profile.axes.independentAxes) {
    achievedDegPerCountY = degreesPerCountForValue(model, hipQuant.ui, "y") * ratio * hipFovFactor;
    const impliedY = achievedDegPerCountY * countsPerCm;
    // Whether the AXIS MODEL can express the requested vertical is a separate
    // question from how much the slider grid rounded. Testing the rounded
    // value here would raise "this game has one sensitivity" against every
    // coarse-stepped profile, including ones that matched the request as
    // exactly as their own slider allows — so the comparison runs against the
    // UNROUNDED horizontal. Rounding has its own note.
    const impliedExactY =
      degreesPerCountForValue(model, exactHip, "y") * ratio * hipFovFactor * countsPerCm;
    if (Math.abs(impliedExactY - aim.degreesPerCmY) > 1e-6 * aim.degreesPerCmY) {
      warnings.push(
        `${profile.displayName} exposes a single sensitivity, so vertical cannot be set independently. Its vertical works out at ${(360 / impliedY).toFixed(1)} cm/360 rather than the requested ${cmPer360Y(aim).toFixed(1)} cm/360.`,
      );
    }
  } else {
    const field = profile.axes.verticalField!;
    const neededVerticalDegPerCount = target.y / ratio / hipFovFactor;
    const effectiveValue = valueForDegreesPerCount(model, neededVerticalDegPerCount, "y");
    const exactVertical =
      profile.axes.verticalSemantics === "multiplier-of-horizontal"
        ? effectiveValue / hipQuant.ui
        : effectiveValue;
    const vertQuant = quantize(field.entry, exactVertical);
    notes.push(...vertQuant.notes.map((n) => `${field.label}: ${n}`));
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
    achievedDegPerCountY = degreesPerCountForValue(model, appliedValue, "y") * ratio * hipFovFactor;
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
      profile.fov.hipfireScaling
        ? `${profile.displayName} changes hip-fire sensitivity with the field of view; this conversion is for ${hipFov?.statedDeg ?? profile.fov.defaultDegrees}° and must be redone if you change your FOV.`
        : `${profile.displayName} changes hip-fire sensitivity with the field of view; re-check this conversion if you change your FOV.`,
    );
    // Fail-closed (Pass 4, requirement 24). For these games the FOV is not a
    // decoration on the answer, it is a MULTIPLIER on it — so a conversion
    // run without one is a conversion at a field of view the player never
    // stated. Saying which value was assumed, and that a wrong assumption is
    // proportionally wrong, is the difference between a qualified answer and
    // an invented one.
    if (options.fovDegrees == null) {
      warnings.push(
        `No field of view was given, so this conversion assumes ${profile.fov.defaultDegrees}°. Because ${profile.displayName} scales hip-fire with the field of view, playing at a different one makes every value here wrong in the same proportion — enter your actual FOV.`,
      );
    }
  }

  const zooms: ConvertedZoom[] = [];
  for (const zoom of zoomLevelsOf(profile)) {
    const zoomNotes: string[] = [...zoom.notes];
    const zoomFov = resolveZoomFov(zoom, hipFov, aspectRatio);

    const valueScale = zoom.valueScale ?? 1;

    // ---- a coefficient the game applies itself (Pass 2) ----
    if (zoom.nativeBehavior === "monitor-distance-coefficient" && zoom.setting) {
      const gameAxis = zoom.coefficientAxis ?? "vertical";
      let exactCoefficient: number | null;
      if (matching.kind === "game-native") {
        exactCoefficient = zoom.neutralValue;
        if (exactCoefficient === null) {
          zoomNotes.push(
            "This game's stock coefficient is not recorded in the profile, so no value is suggested.",
          );
        } else {
          zoomNotes.push("Left at the game's own default relationship.");
        }
      } else {
        exactCoefficient = monitorDistanceCoefficientFor(matching, gameAxis, aspectRatio);
        if (exactCoefficient === null) {
          zoomNotes.push(
            `${describeMatchingKind(matching)} cannot be expressed as a monitor-distance coefficient; no value is suggested.`,
          );
        } else if ((matching.axis ?? "horizontal") !== gameAxis) {
          zoomNotes.push(
            `Converted to the ${gameAxis} axis this game matches on, assuming a ${describeAspect(aspectRatio)} display.`,
          );
        }
      }
      if (exactCoefficient === null) {
        zooms.push(unconverted(zoom, zoomNotes, null, null, zoomFov));
        continue;
      }
      const q = quantize(zoom.setting.entry, exactCoefficient * valueScale);
      zoomNotes.push(...q.notes);
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
        // Every optic lands somewhere different under a coefficient; the
        // game computes each one from its own FOV and the profile does not
        // claim to know them.
        achievedDegreesPerCount: null,
        achievedCmPer360: null,
        fovDegrees: zoomFov?.statedDeg ?? null,
        notes: zoomNotes,
      });
      continue;
    }

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
      zooms.push(
        unconverted(
          zoom,
          zoomNotes,
          achievedDegPerCountX,
          360 / (achievedDegPerCountX * countsPerCm),
          zoomFov,
        ),
      );
      continue;
    }

    const fovFactor =
      hipFov && zoomFov
        ? Math.tan((zoomFov.horizontalDeg * Math.PI) / 360) /
          Math.tan((hipFov.horizontalDeg * Math.PI) / 360)
        : null;
    // The linear angle ratio, on the axis the game states its hip-fire FOV.
    const linearFovRatio =
      hipFov && zoomFov
        ? fovDegreesOnAxis(zoomFov, hipFov.statedAxis) /
          fovDegreesOnAxis(hipFov, hipFov.statedAxis)
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
        case "fov-ratio-multiplier":
          if (linearFovRatio === null || linearFovRatio <= 0) {
            zoomNotes.push(
              "This optic's sensitivity is scaled by the game's own field-of-view ratio, which this profile cannot form here; no value is suggested.",
            );
          } else {
            exactValue = ratioToHip / linearFovRatio;
          }
          break;
        default:
          break;
      }
    }

    if (exactValue === null) {
      zooms.push(
        unconverted(
          zoom,
          zoomNotes,
          achievedDegPerCountX,
          360 / (achievedDegPerCountX * countsPerCm),
          zoomFov,
        ),
      );
      continue;
    }

    const q = quantize(zoom.setting.entry, exactValue * valueScale);
    zoomNotes.push(...q.notes);
    const applied = q.ui / valueScale;
    let achievedZoomDegPerCount: number | null;
    switch (zoom.nativeBehavior) {
      case "multiplies-hipfire":
        achievedZoomDegPerCount = achievedDegPerCountX * applied;
        break;
      case "fov-relative-multiplier":
        // Without the zoomed FOV the game's own scaling is unknown here, so
        // the achieved value is unknown too — never "hip-fire times one".
        achievedZoomDegPerCount = fovFactor === null ? null : achievedDegPerCountX * applied * fovFactor;
        if (fovFactor === null) {
          zoomNotes.push(
            "The game applies its own focal-length scaling for this zoom on top of the value above; the zoomed field of view is not published, so the resulting rotation per count is not stated.",
          );
        }
        break;
      case "fov-ratio-multiplier":
        achievedZoomDegPerCount = achievedDegPerCountX * applied * (linearFovRatio ?? 1);
        break;
      case "independent-scalar":
        achievedZoomDegPerCount = degreesPerCountForValue(model, applied, "x");
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
      achievedCmPer360:
        achievedZoomDegPerCount === null ? null : 360 / (achievedZoomDegPerCount * countsPerCm),
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

/** A zoom level that produced no setting, with whatever is known about it. */
function unconverted(
  zoom: ZoomLevelSpec,
  notes: readonly string[],
  achievedDegreesPerCount: number | null,
  achievedCmPer360: number | null,
  zoomFov: ResolvedFov | null,
): ConvertedZoom {
  return {
    zoomId: zoom.id,
    label: zoom.label,
    magnification: zoom.magnification,
    nativeBehavior: zoom.nativeBehavior,
    setting: null,
    achievedDegreesPerCount,
    achievedCmPer360,
    fovDegrees: zoomFov?.statedDeg ?? null,
    notes,
  };
}

function describeMatchingKind(method: ZoomMatchMethod): string {
  switch (method.kind) {
    case "physical-360-distance":
      return "Same-physical-sensitivity matching";
    case "game-native":
      return "The game's own default";
    case "monitor-distance":
      return "Monitor-distance matching";
  }
}

function describeAspect(aspectRatio: number): string {
  const known: [number, string][] = [
    [16 / 9, "16:9"],
    [16 / 10, "16:10"],
    [4 / 3, "4:3"],
    [21 / 9, "21:9"],
    [32 / 9, "32:9"],
  ];
  for (const [value, label] of known) {
    if (Math.abs(value - aspectRatio) < 1e-6) return label;
  }
  return `${aspectRatio.toFixed(3)}:1`;
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
