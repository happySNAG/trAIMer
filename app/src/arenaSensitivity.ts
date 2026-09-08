/**
 * Deciding what a blinded candidate is worth PHYSICALLY, for this player, in
 * this session (Pass 15).
 *
 * `src/sensmath/arenaGain.ts` owns the arithmetic and knows nothing about
 * storage or games. This module is the only place that chooses which anchor
 * that arithmetic runs against, because it is the only layer allowed to see
 * both the measurement core and the game-profile layer
 * (tests/gameProfileBoundary.test.ts, requirement 1).
 *
 * ## The resolution ladder, best evidence first
 *
 *  1. **A completed physical calibration.** The player measured how far their
 *     view turns per mouse count. Nothing is assumed; the arena reproduces
 *     their real game's rotation exactly, and a later DPI change re-expresses
 *     it rather than corrupting it.
 *  2. **Their current in-game settings through a game profile.** The profile
 *     converts the slider they actually play on into the same canonical
 *     degrees-per-centimetre. Used only when the sensitivity they told the
 *     game screen matches the baseline the ladder is built around — otherwise
 *     the two numbers are on different scales and pairing them would produce
 *     an arena that is confidently wrong.
 *  3. **The declared reference.** Neither available: the baseline candidate
 *     is pinned to 30 cm/360 and the ladder scales exactly around it.
 *
 * Every rung produces the SAME kind of anchor, so the candidate arithmetic —
 * and therefore the ratio between two candidates, which is what the
 * experiment measures — is identical on all three. Only the absolute feel
 * improves as the evidence improves.
 */

import {
  anchorIsPlayable,
  arenaGainPxPerCount,
  baselineReferenceAnchor,
  calibratedAnchor,
  gameProfileAnchor,
  type ArenaSensitivityAnchor,
  type ReticleGain,
} from "../../src/sensmath/arenaGain.ts";
import type { SensitivityCandidate } from "../../src/domain/candidate.ts";
import type { SensitivityConfiguration } from "../../src/domain/settings.ts";
import type { CalibrationHistoryEntry } from "../../src/history/api.ts";
import {
  GAME_PROFILE_REGISTRY,
  canonicalFromGameSettings,
} from "../../src/games/index.ts";
import type { GameProfileSelection } from "../../src/games/selection.ts";

/**
 * What an anchor is resolved FROM.
 *
 * Deliberately not `AppSettings`. The anchor has to describe the sensitivity
 * the candidate ladder was built around, and for a RESUMED session that is
 * the original experiment definition's baseline — not whatever is in the setup
 * form today. Taking the baseline and DPI explicitly makes the caller say
 * which it means, so a player who edits their setup mid-calibration cannot end
 * up with the second half of a session measured against a different ruler
 * from the first.
 */
export interface ArenaAnchorInput {
  readonly baseline: SensitivityConfiguration;
  readonly dpi: number;
  readonly gameProfile: GameProfileSelection | null;
}

/**
 * How far the game-screen sensitivity may differ from the baseline before the
 * two are treated as different scales rather than the same number entered
 * twice. A tenth of a percent: typing the same value is exact, and anything
 * looser starts silently absorbing a genuine mismatch.
 */
const SAME_SCALE_TOLERANCE = 1e-3;

/** The freshest adequate calibration per axis, or null if there is none. */
function latestAdequate(
  history: readonly CalibrationHistoryEntry[],
  axis: "x" | "y",
): CalibrationHistoryEntry | null {
  let best: CalibrationHistoryEntry | null = null;
  for (const entry of history) {
    if (entry.axis !== axis) continue;
    if (!entry.adequate) continue;
    if (entry.degreesPerCountAt100 === null || !(entry.degreesPerCountAt100 > 0)) continue;
    if (entry.dpi === null || !(entry.dpi > 0)) continue;
    // calibrationHistory() is sorted oldest-first by createdAtIso.
    best = entry;
  }
  return best;
}

/**
 * Resolves the anchor for a session.
 *
 * Pure: the caller supplies the calibration history it already loaded. Never
 * throws — an unusable calibration or an unconvertible profile falls through
 * to the next rung, because an arena that refuses to start is a worse failure
 * than an arena anchored on a stated convention.
 */
export function resolveArenaAnchor(
  input: ArenaAnchorInput,
  calibrationHistory: readonly CalibrationHistoryEntry[] = [],
): ArenaSensitivityAnchor {
  const { baseline, dpi } = input;

  /**
   * A rung only counts if the arena it describes can be played.
   *
   * A calibration taken with a mistyped turn count, or a game sensitivity
   * entered in the wrong units, produces an anchor that is arithmetically
   * fine and physically absurd — hundreds of centimetres of mouse movement to
   * cross the arena. Better evidence that says something impossible is worse
   * than no evidence, so it falls through to the next rung instead.
   */
  const usable = (
    anchor: ArenaSensitivityAnchor,
  ): ArenaSensitivityAnchor | null =>
    anchorIsPlayable(anchor, baseline, dpi) ? anchor : null;

  // 1. a measured calibration
  const calX = latestAdequate(calibrationHistory, "x");
  if (calX) {
    // Y falls back to X: the calibration screen measures X, and the product's
    // model is symmetric unless a Y calibration exists to say otherwise.
    const calY = latestAdequate(calibrationHistory, "y") ?? calX;
    try {
      const anchor = usable(
        calibratedAnchor({
          degreesPerCountAt100X: calX.degreesPerCountAt100!,
          degreesPerCountAt100Y: calY.degreesPerCountAt100!,
          calibrationDpi: calX.dpi!,
        }),
      );
      if (anchor) return anchor;
    } catch {
      // fall through
    }
  }

  // 2. the player's current in-game settings, through their game profile
  const selection = input.gameProfile;
  if (selection && selection.currentHipfire !== null) {
    const compatibility = GAME_PROFILE_REGISTRY.checkSelection({
      profileId: selection.profileId,
      profileVersion: selection.profileVersion,
    });
    const sameScale =
      Math.abs(selection.currentHipfire - baseline.sensX) <=
      SAME_SCALE_TOLERANCE * Math.max(selection.currentHipfire, baseline.sensX);
    if (compatibility.status !== "unknown-profile" && sameScale) {
      try {
        const aim = canonicalFromGameSettings(compatibility.profile, dpi, {
          hipfire: selection.currentHipfire,
          vertical: selection.currentVertical,
          fovDegrees: selection.fovDegrees,
        });
        const anchor = usable(
          gameProfileAnchor({
            atSensX: selection.currentHipfire,
            atSensY: selection.currentVertical ?? selection.currentHipfire,
            atDpi: dpi,
            degreesPerCmX: aim.degreesPerCmX,
            degreesPerCmY: aim.degreesPerCmY,
            gameDisplayName: compatibility.profile.displayName,
          }),
        );
        if (anchor) return anchor;
      } catch {
        // fall through
      }
    }
  }

  // 3. the declared reference, stated at THIS player's DPI so their baseline
  // is 30 cm/360 whatever mouse they are on
  return baselineReferenceAnchor(baseline, dpi);
}

/**
 * THE call the run controller makes at every candidate boundary.
 *
 * Exported (rather than inlined into the controller) so the regression suite
 * exercises the same function the arena does. A test that computed the gain
 * itself would prove only that the test agrees with itself.
 */
export function candidateReticleGain(
  anchor: ArenaSensitivityAnchor,
  candidate: SensitivityCandidate,
  dpi: number,
): ReticleGain {
  return arenaGainPxPerCount(anchor, candidate.sensitivity, dpi);
}

export type { ArenaSensitivityAnchor, ReticleGain };
