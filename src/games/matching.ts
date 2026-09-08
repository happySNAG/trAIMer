/**
 * Zoom matching philosophies (Game Profile Pass 1, requirement 6).
 *
 * There is no single correct answer to "what should my scoped sensitivity
 * be?". There are several legitimate answers, they disagree with each other,
 * and which one a player wants is a preference — so the profile layer
 * represents the choice explicitly instead of burying one of them in a
 * formula.
 *
 * The four this layer models:
 *
 * - **Physical 360 distance.** The same hand movement turns the view the same
 *   number of degrees at every zoom. Scoping in changes nothing about how far
 *   you move to spin around. Simple, and what "keep my sensitivity" usually
 *   means to a player who has never thought about it.
 *
 * - **Monitor distance.** The same hand movement moves the crosshair across
 *   the same fraction of the SCREEN at every zoom. Parameterised by a
 *   coefficient in [0, 1] naming which fraction of the half-screen is matched:
 *   1.0 matches the screen edge ("100% monitor distance"), and the limit at 0
 *   matches the very centre.
 *
 * - **FOV-relative.** The zero-coefficient limit of monitor distance, also
 *   called focal-length or 0% monitor-distance matching: the ratio of the
 *   tangents of the half-angles. It is the philosophy under which a flick to a
 *   target that is visible in both views takes the same hand movement.
 *
 * - **Game native.** Whatever the game's own neutral value does. Chosen when
 *   the player wants the developer's default relationship rather than any
 *   externally imposed one — including for games that already apply their own
 *   FOV scaling.
 *
 * ## The formula
 *
 * For half-angles θ_h (hip) and θ_z (zoomed) on the matched axis, and monitor
 * coefficient c:
 *
 *     ratio(c) = atan(c · tan θ_z) / atan(c · tan θ_h)      for c > 0
 *     ratio(0) = lim(c→0) = tan θ_z / tan θ_h               (FOV-relative)
 *
 * `ratio` is the factor applied to the hip-fire degrees-per-count to get the
 * zoomed degrees-per-count. Physical-360 matching is ratio = 1 by definition.
 */

import { resolveFov, type FovAxis, type ResolvedFov } from "./fov.ts";

export type ZoomMatchKind =
  | "physical-360-distance"
  | "monitor-distance"
  | "game-native";

export interface ZoomMatchMethod {
  readonly kind: ZoomMatchKind;
  /**
   * Monitor-distance only. 0 is the FOV-relative (focal length) limit; 1.0 is
   * the screen edge. Ignored by the other kinds.
   */
  readonly coefficient?: number | undefined;
  /** Monitor-distance only: which screen axis is matched. */
  readonly axis?: "horizontal" | "vertical" | undefined;
}

/** The named methods, so callers never hand-build a method object. */
export const MATCHING = {
  /** Same degrees per centimetre at every zoom. */
  physical360: { kind: "physical-360-distance" } as ZoomMatchMethod,
  /** Focal-length / 0% monitor-distance matching. */
  fovRelative: {
    kind: "monitor-distance",
    coefficient: 0,
    axis: "horizontal",
  } as ZoomMatchMethod,
  /** Classic "100% monitor distance, horizontal". */
  monitorDistance100: {
    kind: "monitor-distance",
    coefficient: 1,
    axis: "horizontal",
  } as ZoomMatchMethod,
  /** "0% monitor distance, vertical" — the other common convention. */
  monitorDistanceVertical0: {
    kind: "monitor-distance",
    coefficient: 0,
    axis: "vertical",
  } as ZoomMatchMethod,
  /** Defer to the game's own neutral multiplier. */
  gameNative: { kind: "game-native" } as ZoomMatchMethod,
} as const;

export const ZOOM_MATCH_KINDS: readonly ZoomMatchKind[] = [
  "physical-360-distance",
  "monitor-distance",
  "game-native",
];

/** Player-facing name and one-line explanation for a matching method. */
export function describeMatching(method: ZoomMatchMethod): {
  label: string;
  detail: string;
} {
  switch (method.kind) {
    case "physical-360-distance":
      return {
        label: "Same physical sensitivity",
        detail:
          "The same hand movement turns your view by the same amount whether you are hip-firing or scoped.",
      };
    case "game-native":
      return {
        label: "The game's own default",
        detail:
          "Keeps the relationship the developers ship, rather than imposing an external one.",
      };
    case "monitor-distance": {
      const c = method.coefficient ?? 0;
      const axis = method.axis ?? "horizontal";
      if (c <= 0) {
        return {
          label: "Match what you see (FOV-relative)",
          detail:
            "A target that is visible in both views takes the same hand movement to reach. Also called 0% monitor distance.",
        };
      }
      return {
        label: `Match ${Math.round(c * 100)}% monitor distance (${axis})`,
        detail: `The same hand movement sweeps the crosshair across the same fraction of the screen ${axis === "horizontal" ? "width" : "height"} at every zoom.`,
      };
    }
  }
}

export class MatchingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatchingError";
  }
}

const DEG = Math.PI / 180;

/**
 * The factor applied to hip-fire degrees-per-count to obtain the zoomed
 * degrees-per-count under `method`.
 *
 * Returns `null` for `game-native`, which has no externally computed ratio —
 * the caller must fall back to the game's own neutral value. Throws when a
 * method that needs FOVs is given a profile that does not model them, because
 * a fabricated FOV equivalence is worse than a refusal (requirement 7).
 */
export function zoomSensitivityRatio(
  method: ZoomMatchMethod,
  hipFov: ResolvedFov | null,
  zoomFov: ResolvedFov | null,
): number | null {
  switch (method.kind) {
    case "physical-360-distance":
      return 1;
    case "game-native":
      return null;
    case "monitor-distance": {
      if (!hipFov || !zoomFov) {
        throw new MatchingError(
          "monitor-distance matching needs a field of view for both the hip-fire and the zoomed view; this profile does not model one",
        );
      }
      const axis = method.axis ?? "horizontal";
      const hipDeg = axis === "vertical" ? hipFov.verticalDeg : hipFov.horizontalDeg;
      const zoomDeg = axis === "vertical" ? zoomFov.verticalDeg : zoomFov.horizontalDeg;
      const tanHip = Math.tan((hipDeg * DEG) / 2);
      const tanZoom = Math.tan((zoomDeg * DEG) / 2);
      const c = method.coefficient ?? 0;
      if (!Number.isFinite(c) || c < 0 || c > 1) {
        throw new MatchingError(
          `monitor-distance coefficient must be within [0, 1] (got ${c})`,
        );
      }
      if (c === 0) return tanZoom / tanHip;
      return Math.atan(c * tanZoom) / Math.atan(c * tanHip);
    }
  }
}

/**
 * Derives a zoomed view's FOV from a magnification factor when the game does
 * not state one.
 *
 * Magnification in an FPS scope means the tangent of the half-angle shrinks by
 * that factor — the same relationship a real optic has. This is used only when
 * a profile declares a magnification and no explicit FOV.
 */
export function fovFromMagnification(
  hipFov: ResolvedFov,
  magnification: number,
  axis: FovAxis = "horizontal",
): ResolvedFov {
  if (!Number.isFinite(magnification) || magnification <= 0) {
    throw new MatchingError(`magnification must be positive (got ${magnification})`);
  }
  const base = axis === "vertical" ? hipFov.verticalDeg : hipFov.horizontalDeg;
  const zoomed = (2 * Math.atan(Math.tan((base * DEG) / 2) / magnification)) / DEG;
  return resolveFov(zoomed, axis, hipFov.aspectRatio);
}
