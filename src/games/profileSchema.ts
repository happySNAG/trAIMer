/**
 * The versioned game-profile schema (Game Profile Pass 1, requirement 2).
 *
 * A game profile is a strongly typed description of how ONE game turns a
 * number in its settings screen into a physical aiming sensitivity. It is
 * data, not code: no profile ever contains a formula, only the constants and
 * the declared model that `convert.ts` evaluates.
 *
 * Two versions live in every profile and they mean different things:
 *
 * - `schemaVersion` — the shape of THIS file's types. Bumping it means old
 *   profile objects need migrating before they can be loaded.
 * - `profileVersion` — the conversion DEFINITION for that one game. Bumping it
 *   means a value produced under the old definition may no longer be the
 *   right answer, and anything that stored a recommendation under the old
 *   version must be told so rather than silently reinterpreted
 *   (requirement 17).
 *
 * Nothing in `src/**` outside `src/games/**` may import this module into the
 * measurement engine: game profiles are a translation layer that reads the
 * engine's output, never an input to how aim is measured (requirement 1).
 */

import type { FovModel } from "./fov.ts";
import type { ZoomMatchKind, ZoomMatchMethod } from "./matching.ts";
import type { ValueEntrySpec } from "./rounding.ts";

/** Shape version of the profile schema itself. */
export const GAME_PROFILE_SCHEMA_VERSION = 1 as const;

export type GameProfileSchemaVersion = typeof GAME_PROFILE_SCHEMA_VERSION;

/**
 * How far a profile's numbers can be trusted.
 *
 * - `verified` — measured or documented, with complete provenance, and shown
 *   to players as a supported game.
 * - `partially-verified` — hip-fire is trusted; some zoom/FOV behaviour is
 *   not. Shown, with the gap stated.
 * - `experimental` — plausible but unconfirmed. Shown only behind an explicit
 *   opt-in, always labelled.
 * - `deprecated` — superseded or known wrong. Never offered for a new
 *   selection; still resolvable so old history stays readable.
 */
export type ProfileStatus =
  | "verified"
  | "partially-verified"
  | "experimental"
  | "deprecated";

export const PROFILE_STATUSES: readonly ProfileStatus[] = [
  "verified",
  "partially-verified",
  "experimental",
  "deprecated",
];

/** Whether a profile is a real game or a test-only architecture fixture. */
export type ProfileVisibility = "public" | "fixture";

export type ProfilePlatform = "pc" | "console" | "mobile";

/** Where a profile's numbers came from, and how stale they may be. */
export type ProfileSourceType =
  | "official-documentation"
  | "in-game-measurement"
  | "first-party-config-file"
  | "community-reference"
  | "unit-definition";

export type SourceConfidence = "exact" | "high" | "moderate" | "low";

/**
 * Provenance for a profile (requirement 10).
 *
 * Game sensitivity behaviour changes between patches. Every public profile
 * carries where its numbers came from, which build of the game they were
 * checked against, when they were checked, and what is still uncertain — so a
 * stale formula surfaces as stale instead of as a confident recommendation.
 */
export interface ProfileSource {
  readonly title: string;
  readonly type: ProfileSourceType;
  /**
   * Reference URL, when there is a citable one.
   *
   * trAIMer makes no network requests of any kind; a URL here is displayed
   * text and provenance, never something the app fetches. The no-telemetry
   * audit therefore treats profile source URLs as an explicitly declared,
   * enumerated allowance — see scripts/audit-no-telemetry.mjs.
   */
  readonly url: string | null;
  /** Publisher or author of the source, when it differs from the game's. */
  readonly publisher: string | null;
  /** Game build, patch or season the numbers were checked against. */
  readonly gameVersion: string | null;
  /** When the numbers were last VERIFIED against the game. */
  readonly verifiedAtIso: string;
  /** When a human last LOOKED at the profile, verified or not. */
  readonly lastReviewedAtIso: string;
  readonly confidence: SourceConfidence;
  /** What is known not to be settled. Rendered to players verbatim. */
  readonly uncertaintyNotes: readonly string[];
}

/**
 * How a game's sensitivity number becomes degrees of view rotation per mouse
 * count. Discriminated, closed, and invertible in closed form.
 */
export type SensitivityModel =
  | {
      /** deg/count = value × yawDegreesPerCountAtOne */
      readonly kind: "linear-yaw";
      readonly yawDegreesPerCountAtOne: number;
      /** Pitch constant; null means pitch uses the yaw constant. */
      readonly pitchDegreesPerCountAtOne: number | null;
    }
  | {
      /** deg/count = coefficient × value^exponent */
      readonly kind: "power-law-yaw";
      readonly yawCoefficient: number;
      readonly yawExponent: number;
      readonly pitchCoefficient: number | null;
      readonly pitchExponent: number | null;
    };

/** One numeric setting in a game, with the grid the game accepts it on. */
export interface SensitivityFieldSpec {
  /** The setting's machine name (config key, or a stable slug). */
  readonly field: string;
  /** What the game's own settings screen calls it. */
  readonly label: string;
  readonly entry: ValueEntrySpec;
}

/** What a game's vertical number means, when it has one. */
export type VerticalSemantics =
  /** No separate vertical control at all. */
  | "none"
  /** A second absolute sensitivity on the same scale as horizontal. */
  | "absolute"
  /** A multiplier applied to the horizontal value. */
  | "multiplier-of-horizontal";

/**
 * The X/Y model (requirement 5).
 *
 * Games differ: one scalar, two scalars, or one scalar plus a vertical
 * multiplier — and some apply a fixed vertical ratio the player cannot see or
 * change. All four are representable; none is assumed.
 */
export interface AxisModel {
  /** True when the player can set vertical independently of horizontal. */
  readonly independentAxes: boolean;
  readonly verticalSemantics: VerticalSemantics;
  /** The vertical setting, present exactly when `independentAxes` is true. */
  readonly verticalField: SensitivityFieldSpec | null;
  /**
   * A vertical:horizontal ratio the ENGINE applies regardless of settings
   * (many shooters run pitch slower than yaw). `null` means 1:1.
   */
  readonly builtInVerticalRatio: number | null;
}

/** Assumptions a profile's constants depend on (requirement 4). */
export interface DpiModel {
  /**
   * True when the game's scale is defined per mouse COUNT, so DPI and
   * sensitivity trade off exactly. False would mean an OS-filtered path where
   * they do not; no such profile is supported yet.
   */
  readonly countBased: boolean;
  /** True when the numbers assume Windows pointer speed at the 6/11 default. */
  readonly assumesWindowsPointerSpeedDefault: boolean;
  /** True when raw input must be enabled for the constants to hold. */
  readonly requiresRawInput: boolean;
  readonly notes: readonly string[];
}

/** How a game applies a zoom level's own setting, internally. */
export type ZoomNativeBehavior =
  /** The hip-fire view itself; it has no multiplier. */
  | "hipfire"
  /** deg/count(zoom) = deg/count(hip) × value */
  | "multiplies-hipfire"
  /**
   * deg/count(zoom) = deg/count(hip) × value × tan(θ_zoom/2)/tan(θ_hip/2):
   * the game has already applied FOV-relative scaling, so its neutral value
   * means "matched to what you see".
   */
  | "fov-relative-multiplier"
  /** The zoom carries its own absolute sensitivity on the game's scale. */
  | "independent-scalar";

/** One aim state a game can be in: hip-fire, ADS, or a specific optic. */
export interface ZoomLevelSpec {
  /** Stable within the profile: "hipfire", "ads", "2x", "sniper", … */
  readonly id: string;
  readonly label: string;
  /** Magnification relative to hip-fire, when the game states one. */
  readonly magnification: number | null;
  /** FOV in this state. `{kind:"none"}` when the game does not define it. */
  readonly fov: FovModel;
  /** The setting the player changes for this state, when there is one. */
  readonly setting: SensitivityFieldSpec | null;
  /** Value of that setting that yields the game's stock behaviour. */
  readonly neutralValue: number | null;
  readonly nativeBehavior: ZoomNativeBehavior;
  readonly notes: readonly string[];
}

/**
 * The ADS / scope architecture (requirement 6).
 *
 * `none` — the profile models hip-fire only.
 * `single-scalar` — one ADS setting covering every optic.
 * `per-zoom` — a setting per optic (1x / 2x / 3x / 4x / sniper …).
 */
export type ZoomModel =
  | { readonly kind: "none" }
  | { readonly kind: "single-scalar"; readonly zoom: ZoomLevelSpec }
  | { readonly kind: "per-zoom"; readonly zooms: readonly ZoomLevelSpec[] };

/** A complete, versioned description of one game's sensitivity behaviour. */
export interface GameProfile {
  readonly schemaVersion: GameProfileSchemaVersion;
  /** Stable machine id. Never a display name; never reused. */
  readonly id: string;
  readonly displayName: string;
  readonly publisher: string | null;
  /** Engine/franchise family, when grouping profiles is useful. */
  readonly gameFamily: string | null;
  /** Conversion-definition version for THIS game. Integer, monotonic. */
  readonly profileVersion: number;
  readonly status: ProfileStatus;
  readonly visibility: ProfileVisibility;
  readonly platforms: readonly ProfilePlatform[];

  readonly sensitivityModel: SensitivityModel;
  /** The hip-fire (or only) sensitivity setting. */
  readonly hipfireField: SensitivityFieldSpec;
  readonly axes: AxisModel;
  readonly dpi: DpiModel;
  readonly fov: FovModel;
  readonly zoom: ZoomModel;

  /** Matching philosophy used when the player expresses no preference. */
  readonly defaultMatching: ZoomMatchMethod;
  /** Philosophies this profile can legitimately express. */
  readonly supportedMatching: readonly ZoomMatchKind[];

  /** One sentence defining what "1.00" means on this game's scale. */
  readonly unitDefinition: string;
  /** Known quirks a converted value does NOT account for. */
  readonly knownEdgeCases: readonly string[];
  /** Warnings shown with every conversion from this profile. */
  readonly warnings: readonly string[];
  readonly source: ProfileSource;

  /** Set on a deprecated profile that has a successor. */
  readonly supersededByProfileId: string | null;
  readonly deprecationNote: string | null;
}

/** Every zoom level a profile defines, hip-fire excluded. */
export function zoomLevelsOf(profile: GameProfile): readonly ZoomLevelSpec[] {
  switch (profile.zoom.kind) {
    case "none":
      return [];
    case "single-scalar":
      return [profile.zoom.zoom];
    case "per-zoom":
      return profile.zoom.zooms;
  }
}

/** Looks up one zoom level by id. */
export function zoomLevelById(
  profile: GameProfile,
  zoomId: string,
): ZoomLevelSpec | null {
  return zoomLevelsOf(profile).find((z) => z.id === zoomId) ?? null;
}

/** True when the profile can express the given matching philosophy. */
export function supportsMatching(
  profile: GameProfile,
  kind: ZoomMatchKind,
): boolean {
  return profile.supportedMatching.includes(kind);
}

/** A short, stable identity string for logs and persisted records. */
export function profileRef(profile: GameProfile): string {
  return `${profile.id}@v${profile.profileVersion}`;
}
