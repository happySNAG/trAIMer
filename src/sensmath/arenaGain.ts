/**
 * THE authoritative conversion from raw mouse counts to arena reticle
 * movement for a blinded candidate sensitivity (Pass 15).
 *
 * ## The defect this module exists to make impossible
 *
 * Up to and including rc.8, `VirtualReticle.applyRawDelta` moved the reticle
 * one logical pixel per mouse count, always, whichever blinded candidate was
 * running. The candidate reached the trial record's metadata and reached the
 * simulator's player model, and never reached the player's hand. A human
 * calibration campaign on that build compared five sensitivities that all
 * felt identical, so its recommendation measured nothing about sensitivity.
 *
 * Every layer that needs "how much does the view move for this much mouse
 * movement" now calls into this file. There is no second copy of the
 * arithmetic anywhere in the tree, and `tests/arenaCandidateGain.test.ts`
 * fails if the arena stops consulting it.
 *
 * ## The physical model
 *
 * The chain is three multiplications, each of which is a physical fact:
 *
 *   1. **Candidate → physical rotation.** The candidate ladder is a purely
 *      multiplicative change of the player's own in-game slider, and every
 *      sensitivity model the conversion layer supports is proportional in
 *      that slider over the ladder's ±35 % width. A game's slider fixes
 *      degrees per COUNT; the mouse's DPI then fixes how many counts a
 *      centimetre of hand movement produces. So physical sensitivity is
 *      proportional to `sens × dpi` — which is exactly why players compare
 *      each other in eDPI — and an anchor must therefore say which DPI its
 *      reference was stated at:
 *
 *          degreesPerCm(sens, dpi) = anchor.referenceDegreesPerCm
 *                                  × sens / anchor.referenceSens
 *                                  × dpi  / anchor.referenceDpi
 *
 *      Degrees of view rotation per CENTIMETRE of mouse travel is the same
 *      canonical unit `src/games/canonical.ts` stores, chosen for the same
 *      reason: it is a property of the player's hand and their game.
 *
 *   2. **Physical rotation → per-count rotation.** The player's DPI divides
 *      back out here, exactly as it does in `degreesPerCountAt()`:
 *
 *          degreesPerCount = degreesPerCm × CM_PER_INCH / dpi
 *
 *   3. **Rotation → arena pixels.** The arena is a flat angular field with
 *      one declared display constant:
 *
 *          pxPerCount = degreesPerCount × ARENA_PX_PER_DEGREE
 *
 * Composed, with the session DPI cancelling:
 *
 *      pxPerCount(sens) = ARENA_PX_PER_DEGREE
 *                       × CM_PER_INCH / referenceDpi
 *                       × referenceDegreesPerCm × sens / referenceSens
 *
 * ### What that buys, in the terms the campaign is stated in
 *
 * - **Candidates differ, in proportion.** `pxPerCount` is linear in `sens`,
 *   so two candidates move the reticle in exactly their sensitivity ratio for
 *   identical raw counts. A ±15 % ladder arm is a ±15 % change in what the
 *   hand feels.
 * - **DPI participates the way it does in a real game.** A slider value fixes
 *   degrees per count, so raising DPI alone genuinely makes the arena faster,
 *   exactly as it would make the player's game faster. What must NOT change
 *   is the other direction: arena travel per centimetre of real hand movement
 *   is `pxPerCount × dpi / 2.54`, which is proportional to `sens × dpi`. Two
 *   setups at the same eDPI — equivalently, the same cm/360 — are therefore
 *   the same arena at any DPI, which is what "equivalent physical
 *   sensitivity" has to mean.
 * - **Nothing else changes.** The target plan, the scenario geometry, the
 *   viewport, the timing and the blinding are untouched. The candidate
 *   changes the gain and only the gain.
 *
 * ## The display constant
 *
 * `ARENA_PX_PER_DEGREE` is pinned so that the reference physical sensitivity
 * (30 cm/360, a middle-of-the-road real setting) at the reference DPI (800,
 * the most common gaming DPI) moves the reticle exactly 1.0 logical px per
 * count — the fixed gain every build up to rc.8 used. The arena's feel at the
 * centre of the range is therefore unchanged by this fix; what changes is
 * that it now moves away from that centre with the candidate.
 */

import type { SensitivityConfiguration } from "../domain/settings.ts";
import { CM_PER_INCH } from "./units.ts";

export { CM_PER_INCH };

/** Contract tag persisted with every anchor, so history can be read back. */
export const ARENA_GAIN_CONTRACT = "arena-gain-v1" as const;

/**
 * The physical sensitivity the arena's display constant is pinned to,
 * expressed the way players talk: centimetres of mouse travel per 360° turn.
 */
export const ARENA_REFERENCE_CM_PER_360 = 30;

/** The same reference in canonical units: degrees of rotation per centimetre. */
export const ARENA_REFERENCE_DEGREES_PER_CM = 360 / ARENA_REFERENCE_CM_PER_360;

/** The DPI the reference is stated at. */
export const ARENA_REFERENCE_DPI = 800;

/**
 * Logical arena pixels per degree of view rotation.
 *
 * Derived, never typed in: it is whatever makes the reference sensitivity at
 * the reference DPI come out at exactly 1.0 px/count. With the values above
 * that is ≈26.2467 px/deg, i.e. the 1280 px logical arena spans ≈48.8° — a
 * flat, linear angular field, deliberately not a projected 3D frustum, since
 * the arena is a 2D task and a tangent projection would be a decoration
 * rather than a fact.
 */
export const ARENA_PX_PER_DEGREE =
  ARENA_REFERENCE_DPI / (CM_PER_INCH * ARENA_REFERENCE_DEGREES_PER_CM);

/** Where an anchor's physical sensitivity came from, best first. */
export type ArenaAnchorSource =
  /** The player physically measured degrees-per-count. No assumptions at all. */
  | "measured-calibration"
  /** Their current in-game settings, converted through a game profile. */
  | "game-profile"
  /** Neither available: the baseline is pinned to the declared reference. */
  | "baseline-reference";

/**
 * A candidate-independent statement of "what one unit of the player's
 * sensitivity slider is worth, physically".
 *
 * `referenceSens` is in whatever units the candidate ladder is in — the
 * player's own game slider — so the anchor and the candidates are always
 * commensurable. It is never a display value and never a game name.
 */
export interface ArenaSensitivityAnchor {
  readonly contract: typeof ARENA_GAIN_CONTRACT;
  readonly source: ArenaAnchorSource;
  readonly referenceSensX: number;
  readonly referenceSensY: number;
  /**
   * The DPI the reference was stated at.
   *
   * Load-bearing, not bookkeeping: degrees-per-centimetre is a statement
   * about a mouse AND a slider, so a reference quoted without its DPI cannot
   * be re-expressed at another one. Omitting it is what made an early draft
   * of this model treat 7 @ 800 DPI and 3.5 @ 1600 DPI — the same physical
   * sensitivity — as a factor-of-two difference.
   */
  readonly referenceDpi: number;
  /** Degrees of view rotation per cm of mouse travel AT the reference sens. */
  readonly referenceDegreesPerCmX: number;
  readonly referenceDegreesPerCmY: number;
  /** One player-facing sentence naming where this came from. */
  readonly basis: string;
}

export class ArenaGainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArenaGainError";
  }
}

function requirePositive(value: number, what: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ArenaGainError(
      `${what} must be a positive finite number (got ${String(value)})`,
    );
  }
  return value;
}

/** Per-axis multiplier applied to raw mouse counts to get logical arena px. */
export interface ReticleGain {
  readonly x: number;
  readonly y: number;
}

/** The gain a build that does not apply candidate sensitivity would use. */
export const UNIT_RETICLE_GAIN: ReticleGain = Object.freeze({ x: 1, y: 1 });

/**
 * The fallback anchor: no calibration and no game profile.
 *
 * With neither, the player's physical sensitivity is genuinely unknown — that
 * is what "uncalibrated" means — so the arena declares it instead of guessing:
 * the BASELINE candidate is the reference physical sensitivity, and every
 * other candidate is that scaled by its own ladder factor. The comparison
 * between candidates, which is the entire experiment, is exact; only the
 * absolute feel is a stated convention rather than a measurement.
 */
export function baselineReferenceAnchor(
  baseline: SensitivityConfiguration,
  dpi: number = ARENA_REFERENCE_DPI,
): ArenaSensitivityAnchor {
  return {
    contract: ARENA_GAIN_CONTRACT,
    source: "baseline-reference",
    referenceSensX: requirePositive(baseline.sensX, "baseline sensX"),
    referenceSensY: requirePositive(baseline.sensY, "baseline sensY"),
    referenceDpi: requirePositive(dpi, "dpi"),
    referenceDegreesPerCmX: ARENA_REFERENCE_DEGREES_PER_CM,
    referenceDegreesPerCmY: ARENA_REFERENCE_DEGREES_PER_CM,
    basis: `your starting sensitivity is treated as ${ARENA_REFERENCE_CM_PER_360} cm/360 because no calibration or game profile was available; the differences between the sensitivities being compared are exact either way`,
  };
}

/**
 * The best anchor: a completed physical calibration.
 *
 * `degreesPerCountAt100` was measured at 100 % in-game sensitivity AND at the
 * DPI in force during that measurement, so the DPI is divided back out here
 * to recover the DPI-free physical quantity. If the player later changes DPI,
 * `arenaGainPxPerCount` re-expresses the SAME physical sensitivity at the new
 * DPI rather than silently treating a stale per-count number as current.
 */
export function calibratedAnchor(input: {
  degreesPerCountAt100X: number;
  degreesPerCountAt100Y: number;
  calibrationDpi: number;
}): ArenaSensitivityAnchor {
  const dpi = requirePositive(input.calibrationDpi, "calibrationDpi");
  const perCm = dpi / CM_PER_INCH;
  return {
    contract: ARENA_GAIN_CONTRACT,
    source: "measured-calibration",
    referenceSensX: 100,
    referenceSensY: 100,
    referenceDpi: dpi,
    referenceDegreesPerCmX:
      requirePositive(input.degreesPerCountAt100X, "degreesPerCountAt100X") * perCm,
    referenceDegreesPerCmY:
      requirePositive(input.degreesPerCountAt100Y, "degreesPerCountAt100Y") * perCm,
    basis:
      "your own calibration measurement of how far the view turns per mouse count",
  };
}

/**
 * An anchor built from a canonical aim the game-profile layer derived from
 * the player's current in-game settings.
 *
 * Deliberately takes plain numbers rather than a `CanonicalAim`: the
 * measurement core may not import the game layer, so the caller (which may)
 * unwraps it. The numbers are the same canonical degrees-per-centimetre.
 */
export function gameProfileAnchor(input: {
  atSensX: number;
  atSensY: number;
  /** The DPI the profile conversion was performed at. */
  atDpi: number;
  degreesPerCmX: number;
  degreesPerCmY: number;
  gameDisplayName: string;
}): ArenaSensitivityAnchor {
  return {
    contract: ARENA_GAIN_CONTRACT,
    source: "game-profile",
    referenceSensX: requirePositive(input.atSensX, "atSensX"),
    referenceSensY: requirePositive(input.atSensY, "atSensY"),
    referenceDpi: requirePositive(input.atDpi, "atDpi"),
    referenceDegreesPerCmX: requirePositive(input.degreesPerCmX, "degreesPerCmX"),
    referenceDegreesPerCmY: requirePositive(input.degreesPerCmY, "degreesPerCmY"),
    basis: `your current ${input.gameDisplayName} settings, so the arena turns as far as that game does`,
  };
}

/**
 * Physical rotation per centimetre of mouse travel for a candidate at a DPI.
 *
 * Scales with `sens × dpi`, because a game slider fixes degrees per count and
 * the DPI fixes counts per centimetre.
 */
export function arenaDegreesPerCm(
  anchor: ArenaSensitivityAnchor,
  sensitivity: SensitivityConfiguration,
  dpi: number,
): { x: number; y: number } {
  const dpiFactor = requirePositive(dpi, "dpi") / anchor.referenceDpi;
  return {
    x:
      anchor.referenceDegreesPerCmX *
      (requirePositive(sensitivity.sensX, "sensX") / anchor.referenceSensX) *
      dpiFactor,
    y:
      anchor.referenceDegreesPerCmY *
      (requirePositive(sensitivity.sensY, "sensY") / anchor.referenceSensY) *
      dpiFactor,
  };
}

/**
 * Rotation per mouse count for a candidate at a DPI.
 *
 * The DPI that entered `arenaDegreesPerCm` divides back out here, so this —
 * and therefore the arena gain — depends on the slider value alone, exactly
 * as a real game's degrees-per-count does.
 */
export function arenaDegreesPerCount(
  anchor: ArenaSensitivityAnchor,
  sensitivity: SensitivityConfiguration,
  dpi: number,
): { x: number; y: number } {
  const perCm = arenaDegreesPerCm(anchor, sensitivity, dpi);
  const cmPerCount = CM_PER_INCH / requirePositive(dpi, "dpi");
  return { x: perCm.x * cmPerCount, y: perCm.y * cmPerCount };
}

/**
 * THE function. Logical arena pixels the reticle moves per raw mouse count,
 * for one blinded candidate, at the player's DPI.
 *
 * Applied in exactly one place at runtime — `VirtualReticle.applyRawDelta` —
 * so no input path can apply it twice and none can skip it.
 */
export function arenaGainPxPerCount(
  anchor: ArenaSensitivityAnchor,
  sensitivity: SensitivityConfiguration,
  dpi: number,
): ReticleGain {
  const perCount = arenaDegreesPerCount(anchor, sensitivity, dpi);
  return {
    x: perCount.x * ARENA_PX_PER_DEGREE,
    y: perCount.y * ARENA_PX_PER_DEGREE,
  };
}

/**
 * Centimetres of mouse travel per 360° for a candidate — the player-facing
 * presentation of the same value. Never used to compute anything.
 */
export function arenaCmPer360(
  anchor: ArenaSensitivityAnchor,
  sensitivity: SensitivityConfiguration,
  dpi: number,
): { x: number; y: number } {
  const perCm = arenaDegreesPerCm(anchor, sensitivity, dpi);
  return { x: 360 / perCm.x, y: 360 / perCm.y };
}

/**
 * The ratio of two candidates' arena gain.
 *
 * DPI cancels exactly, which is the point: this is a property of the two
 * sensitivities alone, and the optimizer's log-ratio arithmetic and the
 * arena's physical arithmetic therefore cannot disagree.
 */
export function arenaGainRatio(
  anchor: ArenaSensitivityAnchor,
  candidate: SensitivityConfiguration,
  reference: SensitivityConfiguration,
): { x: number; y: number } {
  const a = arenaDegreesPerCm(anchor, candidate, anchor.referenceDpi);
  const b = arenaDegreesPerCm(anchor, reference, anchor.referenceDpi);
  return { x: a.x / b.x, y: a.y / b.y };
}

/**
 * The band of physical sensitivities the arena can actually be played at.
 *
 * Real players live between roughly 10 cm/360 (very fast) and 100 cm/360 (very
 * slow). Outside that band the arena is not merely unusual, it is unplayable:
 * at 1200 cm/360 crossing the 1280 px field takes over a metre and a half of
 * mouse movement, so no drill can be completed and every trial is garbage.
 *
 * An anchor can land there through no fault of the model — a calibration taken
 * with a mistyped turn count, a game sensitivity entered in the wrong units, a
 * profile whose slider means something else. The check exists so those become
 * a documented fallback to the declared reference rather than a session the
 * player cannot play and a recommendation nobody can use.
 */
export const ARENA_MIN_PLAYABLE_CM_PER_360 = 5;
export const ARENA_MAX_PLAYABLE_CM_PER_360 = 200;

/**
 * Whether an anchor puts a given sensitivity inside the playable band.
 *
 * Checked per axis at the sensitivity that will actually be tested, not at the
 * anchor's own reference, because it is the candidate's feel that has to be
 * playable.
 */
export function anchorIsPlayable(
  anchor: ArenaSensitivityAnchor,
  sensitivity: SensitivityConfiguration,
  dpi: number,
): boolean {
  let cm: { x: number; y: number };
  try {
    cm = arenaCmPer360(anchor, sensitivity, dpi);
  } catch {
    return false;
  }
  const ok = (v: number): boolean =>
    Number.isFinite(v) &&
    v >= ARENA_MIN_PLAYABLE_CM_PER_360 &&
    v <= ARENA_MAX_PLAYABLE_CM_PER_360;
  return ok(cm.x) && ok(cm.y);
}

/** True when two gains are the same to within a relative tolerance. */
export function sameGain(
  a: ReticleGain,
  b: ReticleGain,
  relativeTolerance = 1e-9,
): boolean {
  const close = (p: number, q: number): boolean =>
    Math.abs(p - q) <= relativeTolerance * Math.max(Math.abs(p), Math.abs(q), 1);
  return close(a.x, b.x) && close(a.y, b.y);
}
