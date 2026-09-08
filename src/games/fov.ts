/**
 * Field-of-view model (Game Profile Pass 1, requirement 7).
 *
 * FOV matters to a sensitivity conversion in exactly two ways:
 *
 *  1. Some matching philosophies (monitor-distance, FOV-relative) are DEFINED
 *     in terms of the FOV at each zoom level. Without a FOV model those
 *     philosophies cannot be expressed at all, only faked.
 *  2. A few games scale hip-fire yaw with the configured FOV. That is a
 *     property of the game and is declared per profile, never assumed.
 *
 * Games disagree about what "FOV: 90" means — horizontal or vertical, and at
 * which aspect ratio the number is quoted. The axis is therefore part of the
 * model, and every internal calculation runs on a normalized pair of
 * horizontal and vertical angles for the DISPLAY aspect ratio in use.
 *
 * Nothing here invents an equivalence. A profile with `kind: "none"` simply
 * has no FOV model, and any conversion that would need one says so.
 */

/** What number a game's FOV setting actually names. */
export type FovAxis =
  | "horizontal"
  /** Horizontal degrees quoted at a fixed 4:3 base (the Quake/Source lineage). */
  | "horizontal-at-4-3"
  /** Horizontal degrees quoted at a fixed 16:9 base. */
  | "horizontal-at-16-9"
  | "vertical";

export const DEFAULT_ASPECT_RATIO = 16 / 9;

export type FovModel =
  | { readonly kind: "none" }
  | {
      readonly kind: "fixed";
      readonly axis: FovAxis;
      readonly degrees: number;
    }
  | {
      readonly kind: "configurable";
      readonly axis: FovAxis;
      readonly defaultDegrees: number;
      readonly minDegrees: number;
      readonly maxDegrees: number;
      /** Slider granularity, or null when the setting is continuous. */
      readonly stepDegrees: number | null;
      /**
       * True only for games whose HIP-FIRE yaw-per-count changes when the FOV
       * setting changes. Almost always false; never assumed.
       */
      readonly affectsHipfireSensitivity: boolean;
      /**
       * How hip-fire scales when `affectsHipfireSensitivity` is true (Pass 3):
       * degrees per count are multiplied by `stated / referenceDegrees`. A
       * profile that declares `affectsHipfireSensitivity` without this only
       * warns; with it, the conversion applies the scaling.
       */
      readonly hipfireScaling?:
        | { readonly kind: "linear-degrees"; readonly referenceDegrees: number }
        | undefined;
    }
  /**
   * A ZOOM level whose FOV is the hip-fire FOV scaled by a constant, in
   * degrees on the hip-fire number's own axis (Pass 3). Rainbow Six Siege
   * defines every optic this way. Meaningless on a profile's hip-fire FOV.
   */
  | {
      readonly kind: "scaled-from-hipfire";
      readonly factor: number;
    };

const DEG = Math.PI / 180;

function assertAngle(degrees: number, what: string): number {
  if (!Number.isFinite(degrees) || degrees <= 0 || degrees >= 180) {
    throw new RangeError(`${what} must be in (0, 180) degrees (got ${degrees})`);
  }
  return degrees;
}

/** Converts a horizontal FOV to the vertical FOV at a given aspect ratio. */
export function horizontalToVertical(hFovDeg: number, aspect: number): number {
  assertAngle(hFovDeg, "horizontal fov");
  return (2 * Math.atan(Math.tan((hFovDeg * DEG) / 2) / aspect)) / DEG;
}

/** Converts a vertical FOV to the horizontal FOV at a given aspect ratio. */
export function verticalToHorizontal(vFovDeg: number, aspect: number): number {
  assertAngle(vFovDeg, "vertical fov");
  return (2 * Math.atan(Math.tan((vFovDeg * DEG) / 2) * aspect)) / DEG;
}

/** Horizontal and vertical angles for one FOV number on one display. */
export interface ResolvedFov {
  readonly horizontalDeg: number;
  readonly verticalDeg: number;
  /** The number as the game states it, and on which axis. */
  readonly statedDeg: number;
  readonly statedAxis: FovAxis;
  readonly aspectRatio: number;
}

/**
 * Normalizes a game's FOV number onto the player's actual display.
 *
 * A "horizontal at 4:3" number is first taken to its vertical angle at 4:3 —
 * which is the angle the engine actually preserves — and then widened to the
 * display's aspect ratio. That is what hor+ rendering does, and doing it any
 * other way silently invents a FOV the player does not have.
 */
export function resolveFov(
  statedDeg: number,
  axis: FovAxis,
  aspectRatio: number = DEFAULT_ASPECT_RATIO,
): ResolvedFov {
  assertAngle(statedDeg, "fov");
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    throw new RangeError(`aspect ratio must be positive (got ${aspectRatio})`);
  }
  let verticalDeg: number;
  switch (axis) {
    case "vertical":
      verticalDeg = statedDeg;
      break;
    case "horizontal":
      verticalDeg = horizontalToVertical(statedDeg, aspectRatio);
      break;
    case "horizontal-at-4-3":
      verticalDeg = horizontalToVertical(statedDeg, 4 / 3);
      break;
    case "horizontal-at-16-9":
      verticalDeg = horizontalToVertical(statedDeg, 16 / 9);
      break;
  }
  return {
    horizontalDeg: verticalToHorizontal(verticalDeg, aspectRatio),
    verticalDeg,
    statedDeg,
    statedAxis: axis,
    aspectRatio,
  };
}

/**
 * Resolves the FOV a model describes, given the player's chosen value.
 *
 * Returns null for `kind: "none"` — a profile with no FOV model produces no
 * FOV, and callers must handle that rather than substitute a default.
 */
export function resolveFovModel(
  model: FovModel,
  chosenDegrees: number | null | undefined,
  aspectRatio: number = DEFAULT_ASPECT_RATIO,
): ResolvedFov | null {
  if (model.kind === "none") return null;
  // A scaled zoom FOV needs the hip-fire FOV it scales; see
  // `resolveScaledFov`. On its own it resolves to nothing rather than to a
  // guess.
  if (model.kind === "scaled-from-hipfire") return null;
  if (model.kind === "fixed") {
    return resolveFov(model.degrees, model.axis, aspectRatio);
  }
  const raw = chosenDegrees ?? model.defaultDegrees;
  const clamped = Math.min(model.maxDegrees, Math.max(model.minDegrees, raw));
  return resolveFov(clamped, model.axis, aspectRatio);
}

/** True when a chosen FOV is inside a configurable model's declared limits. */
export function fovWithinLimits(model: FovModel, degrees: number): boolean {
  if (model.kind !== "configurable") return false;
  return degrees >= model.minDegrees && degrees <= model.maxDegrees;
}

/** Resolves a `scaled-from-hipfire` zoom FOV against the hip-fire FOV. */
export function resolveScaledFov(
  factor: number,
  hipFov: ResolvedFov,
): ResolvedFov {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new RangeError(`fov scale factor must be positive (got ${factor})`);
  }
  return resolveFov(hipFov.statedDeg * factor, hipFov.statedAxis, hipFov.aspectRatio);
}

/**
 * The factor a game applies to hip-fire degrees-per-count for its configured
 * FOV, or 1 when the profile declares no such scaling.
 */
export function hipfireFovFactor(
  model: FovModel,
  chosenDegrees: number | null | undefined,
): number {
  if (model.kind !== "configurable" || !model.affectsHipfireSensitivity || !model.hipfireScaling) {
    return 1;
  }
  const raw = chosenDegrees ?? model.defaultDegrees;
  const clamped = Math.min(model.maxDegrees, Math.max(model.minDegrees, raw));
  return clamped / model.hipfireScaling.referenceDegrees;
}
