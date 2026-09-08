/**
 * Recommendation export (Game Profile Pass 1, requirements 15, 19).
 *
 * THE object a results screen renders when a game profile is selected. It is
 * built here, in the engine layer, from engine-produced values only — the view
 * formats it and never recomputes any part of it (docs/UI-CONTRACT.md §4).
 *
 * It always carries three numbers, in the order a player asks for them:
 *
 *     CURRENT             what they are using now
 *     RECOMMENDED         what to type into that game
 *     PHYSICAL EQUIVALENT the underlying cm/360
 *
 * and it never hides what rounding cost. When the exact equivalent is 6.347%
 * and the game accepts steps of 0.1%, the export says so and names the entry
 * value (requirement 15).
 */

import { cmPer360X, cmPer360Y, type CanonicalAim } from "./canonical.ts";
import {
  canonicalFromGameSettings,
  gameSettingsFromCanonical,
  type ConvertedSetting,
  type GameConversion,
  type GameSettingsInput,
} from "./convert.ts";
import { describeMatching, type ZoomMatchMethod } from "./matching.ts";
import type { DerivedCanonicalAim } from "./measurement.ts";
import type { GameProfile, ProfileStatus } from "./profileSchema.ts";

export interface CurrentGameSettings {
  readonly settings: GameSettingsInput;
  readonly aim: CanonicalAim;
}

export interface GameRecommendationInput {
  readonly profile: GameProfile;
  readonly dpi: number;
  /** What trAIMer recommends, as a physical aim, with its provenance. */
  readonly recommended: DerivedCanonicalAim;
  /** What the player runs today, when they have told us. */
  readonly current: CurrentGameSettings | null;
  readonly fovDegrees?: number | null | undefined;
  readonly aspectRatio?: number | undefined;
  readonly matching?: ZoomMatchMethod | undefined;
  /**
   * The engine's own confidence wording for the underlying calibration,
   * passed through verbatim. A conversion is never allowed to read as more
   * certain than the measurement behind it (requirement 19).
   */
  readonly calibrationConfidenceLine?: string | null | undefined;
}

export interface ProfileProvenance {
  readonly sourceTitle: string;
  readonly sourceType: string;
  readonly sourceUrl: string | null;
  readonly gameVersion: string | null;
  readonly verifiedAtIso: string;
  readonly lastReviewedAtIso: string;
  readonly confidence: string;
  readonly uncertaintyNotes: readonly string[];
}

export interface GameRecommendationExport {
  readonly contract: "game-recommendation-v1";
  readonly profileId: string;
  readonly profileVersion: number;
  readonly profileDisplayName: string;
  readonly profileStatus: ProfileStatus;
  readonly unitDefinition: string;
  readonly dpi: number;

  /** What the player is using now, when known. */
  readonly current: {
    readonly hipfire: number;
    readonly vertical: number | null;
    readonly cmPer360X: number;
    readonly cmPer360Y: number;
    readonly display: string;
    /** The hip-fire value alone, formatted as the game's own UI shows it. */
    readonly hipfireDisplay: string;
    readonly verticalDisplay: string | null;
  } | null;

  /** What to set, with every rounding consequence attached. */
  readonly recommended: GameConversion;
  /** One line per value the player has to type. */
  readonly entryLines: readonly string[];
  /**
   * Exact equivalent versus what the game accepts, for every value the
   * game's own grid or range moved. Empty when nothing was lost.
   */
  readonly exactVsEntered: readonly {
    readonly label: string;
    readonly exact: string;
    readonly enter: string;
    /** A finer value for a configuration file, when the profile has one. */
    readonly config: string | null;
    readonly clamped: boolean;
  }[];

  /** The physical sensitivity underneath both of the above. */
  readonly physicalEquivalent: {
    readonly degreesPerCmX: number;
    readonly degreesPerCmY: number;
    readonly cmPer360X: number;
    readonly cmPer360Y: number;
    readonly basis: string;
    readonly derivation: DerivedCanonicalAim["derivation"];
  };

  /** The change from current to recommended, as a percentage, when known. */
  readonly changeFromCurrentPercent: { readonly x: number; readonly y: number } | null;

  readonly matchingLabel: string;
  readonly matchingDetail: string;
  /** Everything about precision the player is entitled to know. */
  readonly precisionNotes: readonly string[];
  readonly warnings: readonly string[];
  readonly provenance: ProfileProvenance;
  /** Verbatim confidence wording from the calibration, when supplied. */
  readonly calibrationConfidenceLine: string | null;
}

function entryLine(setting: ConvertedSetting): string {
  return `${setting.label}: ${setting.display}`;
}

/** Builds the export. Pure; throws only on structurally impossible input. */
export function buildGameRecommendationExport(
  input: GameRecommendationInput,
): GameRecommendationExport {
  const { profile, dpi } = input;
  const conversion = gameSettingsFromCanonical(profile, input.recommended.aim, {
    dpi,
    fovDegrees: input.fovDegrees,
    aspectRatio: input.aspectRatio,
    matching: input.matching,
  });

  const entryLines = [entryLine(conversion.hipfire)];
  if (conversion.vertical) entryLines.push(entryLine(conversion.vertical));
  for (const zoom of conversion.zooms) {
    if (zoom.setting) entryLines.push(entryLine(zoom.setting));
  }

  // "Exact equivalent / Enter in game", one pair per value the game's grid
  // moved (requirement 11 of Pass 2). Rounding loss is never hidden.
  const exactVsEntered: {
    label: string;
    exact: string;
    enter: string;
    config: string | null;
    clamped: boolean;
  }[] = [];
  const settingsToCheck: ConvertedSetting[] = [conversion.hipfire];
  if (conversion.vertical) settingsToCheck.push(conversion.vertical);
  for (const zoom of conversion.zooms) if (zoom.setting) settingsToCheck.push(zoom.setting);
  for (const setting of settingsToCheck) {
    const q = setting.value;
    if (!q.roundingLoss && !q.clampedToMin && !q.clampedToMax) continue;
    const decimals = setting.display.includes(".")
      ? setting.display.replace(/[^0-9.]/g, "").split(".")[1]?.length ?? 0
      : 0;
    const suffix = setting.display.replace(/[-0-9.]/g, "");
    exactVsEntered.push({
      label: setting.label,
      exact: `${q.exact.toFixed(decimals + 2)}${suffix}`,
      enter: setting.display,
      config: q.config !== null && q.config !== q.ui ? `${q.config}${suffix}` : null,
      clamped: q.clampedToMin || q.clampedToMax,
    });
  }

  const precisionNotes: string[] = [...conversion.notes];
  for (const zoom of conversion.zooms) {
    for (const note of zoom.notes) precisionNotes.push(`${zoom.label}: ${note}`);
  }

  const current = input.current
    ? {
        hipfire: input.current.settings.hipfire,
        vertical: input.current.settings.vertical ?? null,
        cmPer360X: cmPer360X(input.current.aim),
        cmPer360Y: cmPer360Y(input.current.aim),
        display: `${profile.hipfireField.label}: ${input.current.settings.hipfire.toFixed(profile.hipfireField.entry.uiDecimals)}${profile.hipfireField.entry.unitSuffix}`,
        hipfireDisplay: `${input.current.settings.hipfire.toFixed(profile.hipfireField.entry.uiDecimals)}${profile.hipfireField.entry.unitSuffix}`,
        verticalDisplay:
          input.current.settings.vertical != null && profile.axes.verticalField
            ? `${input.current.settings.vertical.toFixed(profile.axes.verticalField.entry.uiDecimals)}${profile.axes.verticalField.entry.unitSuffix}`
            : null,
      }
    : null;

  const changeFromCurrentPercent = input.current
    ? {
        x:
          ((input.recommended.aim.degreesPerCmX - input.current.aim.degreesPerCmX) /
            input.current.aim.degreesPerCmX) *
          100,
        y:
          ((input.recommended.aim.degreesPerCmY - input.current.aim.degreesPerCmY) /
            input.current.aim.degreesPerCmY) *
          100,
      }
    : null;

  const matchingDescription = describeMatching(conversion.matching);

  return {
    contract: "game-recommendation-v1",
    profileId: profile.id,
    profileVersion: profile.profileVersion,
    profileDisplayName: profile.displayName,
    profileStatus: profile.status,
    unitDefinition: profile.unitDefinition,
    dpi,
    current,
    recommended: conversion,
    entryLines,
    exactVsEntered,
    physicalEquivalent: {
      degreesPerCmX: input.recommended.aim.degreesPerCmX,
      degreesPerCmY: input.recommended.aim.degreesPerCmY,
      cmPer360X: cmPer360X(input.recommended.aim),
      cmPer360Y: cmPer360Y(input.recommended.aim),
      basis: input.recommended.basis,
      derivation: input.recommended.derivation,
    },
    changeFromCurrentPercent,
    matchingLabel: matchingDescription.label,
    matchingDetail: matchingDescription.detail,
    precisionNotes,
    warnings: conversion.warnings,
    provenance: {
      sourceTitle: profile.source.title,
      sourceType: profile.source.type,
      sourceUrl: profile.source.url,
      gameVersion: profile.source.gameVersion,
      verifiedAtIso: profile.source.verifiedAtIso,
      lastReviewedAtIso: profile.source.lastReviewedAtIso,
      confidence: profile.source.confidence,
      uncertaintyNotes: profile.source.uncertaintyNotes,
    },
    calibrationConfidenceLine: input.calibrationConfidenceLine ?? null,
  };
}

/**
 * The "what am I on right now?" flow (requirement 14): a player enters their
 * DPI and their current in-game sensitivity and is told the physical
 * equivalent. Needs no calibration and no completed session.
 */
export interface CurrentSensitivityImport {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly dpi: number;
  readonly settings: GameSettingsInput;
  readonly aim: CanonicalAim;
  readonly cmPer360X: number;
  readonly cmPer360Y: number;
  readonly degreesPerCmX: number;
  readonly degreesPerCmY: number;
  /** One sentence a player can read without knowing any of this vocabulary. */
  readonly summary: string;
}

export function importCurrentSensitivity(
  profile: GameProfile,
  dpi: number,
  settings: GameSettingsInput,
): CurrentSensitivityImport {
  const aim = canonicalFromGameSettings(profile, dpi, settings);
  const x = cmPer360X(aim);
  const y = cmPer360Y(aim);
  return {
    profileId: profile.id,
    profileVersion: profile.profileVersion,
    dpi,
    settings,
    aim,
    cmPer360X: x,
    cmPer360Y: y,
    degreesPerCmX: aim.degreesPerCmX,
    degreesPerCmY: aim.degreesPerCmY,
    summary: `${settings.hipfire}${profile.hipfireField.entry.unitSuffix} in ${profile.displayName} at ${dpi} DPI is ${x.toFixed(1)} cm for a full 360° turn.`,
  };
}
