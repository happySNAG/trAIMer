/**
 * Persisted game-profile selection and the record history keeps
 * (Game Profile Pass 1, requirements 17, 18, 20).
 *
 * Two rules govern everything here:
 *
 * 1. **Ids and versions are persisted; display names are not.** A saved
 *    selection is `{ profileId, profileVersion }`. Renaming a game later is
 *    then a cosmetic change instead of a data-loss event.
 * 2. **A version bump is never applied silently.** A record written under
 *    conversion definition v1 stays a v1 record. When the definition changes,
 *    `GameProfileRegistry.checkSelection` reports it and the player is told;
 *    trAIMer does not reinterpret an old recommendation under new arithmetic.
 *
 * Old history has none of these fields. Every one is optional, every reader
 * treats absence as "this session predates game profiles", and nothing
 * already written is ever rewritten.
 */

import type { ZoomMatchKind, ZoomMatchMethod } from "./matching.ts";
import type { GameProfile, ProfileStatus } from "./profileSchema.ts";
import type { CanonicalDerivation } from "./measurement.ts";
import type { GameRecommendationExport } from "./export.ts";

export const GAME_SELECTION_RECORD_VERSION = 1 as const;

/** What the app persists about the player's chosen game. */
export interface GameProfileSelection {
  readonly recordVersion: typeof GAME_SELECTION_RECORD_VERSION;
  readonly profileId: string;
  /** The conversion definition in force when this selection was made. */
  readonly profileVersion: number;
  /** The player's current in-game hip-fire value, when they entered it. */
  readonly currentHipfire: number | null;
  readonly currentVertical: number | null;
  readonly fovDegrees: number | null;
  readonly matchingKind: ZoomMatchKind;
  readonly matchingCoefficient: number | null;
  readonly matchingAxis: "horizontal" | "vertical" | null;
}

/** A fresh selection for a profile, taking the profile's own defaults. */
export function defaultSelectionFor(profile: GameProfile): GameProfileSelection {
  return {
    recordVersion: GAME_SELECTION_RECORD_VERSION,
    profileId: profile.id,
    profileVersion: profile.profileVersion,
    currentHipfire: null,
    currentVertical: null,
    fovDegrees:
      profile.fov.kind === "configurable" ? profile.fov.defaultDegrees : null,
    matchingKind: profile.defaultMatching.kind,
    matchingCoefficient: profile.defaultMatching.coefficient ?? null,
    matchingAxis: profile.defaultMatching.axis ?? null,
  };
}

/** The matching method a stored selection describes. */
export function matchingMethodOf(
  selection: GameProfileSelection,
): ZoomMatchMethod {
  if (selection.matchingKind !== "monitor-distance") {
    return { kind: selection.matchingKind };
  }
  return {
    kind: "monitor-distance",
    coefficient: selection.matchingCoefficient ?? 0,
    axis: selection.matchingAxis ?? "horizontal",
  };
}

const MATCH_KINDS: readonly ZoomMatchKind[] = [
  "physical-360-distance",
  "monitor-distance",
  "game-native",
];

/**
 * Structural sanitizer for a persisted selection blob.
 *
 * Deliberately does NOT check the id against the registry: a selection naming
 * a profile this build no longer ships must survive the round trip so history
 * stays readable and the player can be told what happened. Identity questions
 * are `GameProfileRegistry.checkSelection`'s job.
 */
export function sanitizeGameSelection(raw: unknown): GameProfileSelection | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.profileId !== "string" || obj.profileId.length === 0) return null;

  const positiveOrNull = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

  const version =
    typeof obj.profileVersion === "number" &&
    Number.isInteger(obj.profileVersion) &&
    obj.profileVersion >= 1
      ? obj.profileVersion
      : 1;

  const kind =
    typeof obj.matchingKind === "string" &&
    (MATCH_KINDS as readonly string[]).includes(obj.matchingKind)
      ? (obj.matchingKind as ZoomMatchKind)
      : "physical-360-distance";

  const coefficient =
    typeof obj.matchingCoefficient === "number" &&
    Number.isFinite(obj.matchingCoefficient) &&
    obj.matchingCoefficient >= 0 &&
    obj.matchingCoefficient <= 1
      ? obj.matchingCoefficient
      : null;

  const axis =
    obj.matchingAxis === "horizontal" || obj.matchingAxis === "vertical"
      ? obj.matchingAxis
      : null;

  const fov =
    typeof obj.fovDegrees === "number" &&
    Number.isFinite(obj.fovDegrees) &&
    obj.fovDegrees > 0 &&
    obj.fovDegrees < 180
      ? obj.fovDegrees
      : null;

  return {
    recordVersion: GAME_SELECTION_RECORD_VERSION,
    profileId: obj.profileId.slice(0, 64),
    profileVersion: version,
    currentHipfire: positiveOrNull(obj.currentHipfire),
    currentVertical: positiveOrNull(obj.currentVertical),
    fovDegrees: fov,
    matchingKind: kind,
    matchingCoefficient: kind === "monitor-distance" ? coefficient : null,
    matchingAxis: kind === "monitor-distance" ? axis : null,
  };
}

// ---------------------------------------------------------------------------
// history record (requirement 18)
// ---------------------------------------------------------------------------

export const SESSION_GAME_CONVERSION_RECORD_VERSION = 1 as const;

/**
 * What a completed session records about the game conversion it produced.
 *
 * Stored on the human-session artifact as an OPTIONAL field. Sessions written
 * before game profiles existed simply do not have it, and readers must treat
 * that as "no game profile", never as an error.
 */
export interface SessionGameConversionRecord {
  readonly recordVersion: typeof SESSION_GAME_CONVERSION_RECORD_VERSION;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly profileStatus: ProfileStatus;
  readonly dpi: number;
  readonly currentHipfire: number | null;
  readonly currentVertical: number | null;
  readonly currentCmPer360: number | null;
  /** The value the player was told to enter, after the game's own rounding. */
  readonly recommendedHipfire: number;
  readonly recommendedVertical: number | null;
  /** The value before the game's grid was applied. */
  readonly recommendedHipfireExact: number;
  readonly canonicalDegreesPerCmX: number;
  readonly canonicalDegreesPerCmY: number;
  readonly cmPer360X: number;
  readonly cmPer360Y: number;
  /** Matching philosophy plus how the canonical aim was derived. */
  readonly conversionMethod: string;
  readonly derivation: CanonicalDerivation;
  /** Relative error the game's entry grid introduced, as a fraction. */
  readonly roundingAppliedFraction: number;
  readonly convertedAtIso: string;
}

/** Builds the history record from an export. Never mutates anything. */
export function buildSessionGameConversionRecord(
  exported: GameRecommendationExport,
  convertedAtIso: string,
): SessionGameConversionRecord {
  return {
    recordVersion: SESSION_GAME_CONVERSION_RECORD_VERSION,
    profileId: exported.profileId,
    profileVersion: exported.profileVersion,
    profileStatus: exported.profileStatus,
    dpi: exported.dpi,
    currentHipfire: exported.current?.hipfire ?? null,
    currentVertical: exported.current?.vertical ?? null,
    currentCmPer360: exported.current?.cmPer360X ?? null,
    recommendedHipfire: exported.recommended.hipfire.value.ui,
    recommendedVertical: exported.recommended.vertical?.value.ui ?? null,
    recommendedHipfireExact: exported.recommended.hipfire.value.exact,
    canonicalDegreesPerCmX: exported.physicalEquivalent.degreesPerCmX,
    canonicalDegreesPerCmY: exported.physicalEquivalent.degreesPerCmY,
    cmPer360X: exported.physicalEquivalent.cmPer360X,
    cmPer360Y: exported.physicalEquivalent.cmPer360Y,
    conversionMethod: `${exported.recommended.matching.kind}/${exported.physicalEquivalent.derivation}`,
    derivation: exported.physicalEquivalent.derivation,
    roundingAppliedFraction: exported.recommended.roundingErrorFraction,
    convertedAtIso,
  };
}

/**
 * Reads a possibly-absent, possibly-ancient conversion record off a persisted
 * session. Returns null for anything it does not recognise — an unreadable
 * game record must never make a historical session unreadable.
 */
export function readSessionGameConversionRecord(
  raw: unknown,
): SessionGameConversionRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<SessionGameConversionRecord>;
  if (r.recordVersion !== SESSION_GAME_CONVERSION_RECORD_VERSION) return null;
  if (typeof r.profileId !== "string" || typeof r.profileVersion !== "number") return null;
  if (typeof r.recommendedHipfire !== "number") return null;
  return r as SessionGameConversionRecord;
}
