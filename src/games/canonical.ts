/**
 * THE canonical internal sensitivity representation (Game Profile Pass 1,
 * requirement 3).
 *
 * Every conversion in trAIMer goes
 *
 *     game A settings  →  CanonicalAim  →  game B settings
 *
 * and never game A → game B directly. There are no pairwise formulas anywhere
 * in this tree, and adding a game in a later pass can therefore never change
 * the arithmetic of a game that already exists.
 *
 * ## The representation: degrees of view rotation per centimetre of mouse travel
 *
 * `CanonicalAim` stores, per axis, how many degrees the player's view turns
 * for every centimetre the mouse physically moves on the pad.
 *
 * Why this one, of the candidates the campaign listed:
 *
 * - **It is physical.** Aiming equivalence between two games means the same
 *   hand movement produces the same rotation. That is exactly deg/cm. cm/360
 *   expresses the same fact; counts-based units (deg/count, rad/count,
 *   yaw-per-count, eDPI) do not — they change value when the player changes
 *   DPI without changing anything their hand does.
 * - **It is DPI-free.** Requirement 4 asks that a DPI change re-express the
 *   same physical sensitivity rather than alter it. With deg/cm the canonical
 *   value is literally untouched by a DPI change; only the game-facing number
 *   moves. DPI enters exactly once, at the boundary, in
 *   `degreesPerCountAt()`.
 * - **It is linear in game sensitivity.** For every sensitivity model this
 *   layer supports, deg/cm is a monotone increasing function of the game's
 *   slider, and for the linear models it is proportional to it. A 1% error in
 *   a slider value is a 1% error in deg/cm, so a rounding tolerance declared
 *   as a fraction means the same thing on both sides of a conversion.
 *   cm/360 is *inversely* proportional, which inverts and distorts every
 *   tolerance and has a singularity as sensitivity approaches zero.
 * - **It is reversible.** Both directions are closed-form; the only loss is
 *   the game's own slider granularity, which the rounding model reports
 *   rather than hides (requirement 15).
 *
 * cm/360 remains THE player-facing number — `cmPer360X/Y` derive it — because
 * that is the unit players actually talk in. It is a presentation of the
 * canonical value, not the storage form.
 *
 * Nothing in this module knows about any game.
 */

import { CM_PER_INCH } from "../sensmath/units.ts";

/** Contract tag persisted alongside canonical values. */
export const CANONICAL_AIM_CONTRACT = "canonical-aim-v1" as const;

/**
 * Re-exported, never redeclared. The arena's physical model
 * (`src/sensmath/arenaGain.ts`) and this conversion layer must be the same
 * arithmetic, not two constants that happen to agree; the measurement core
 * may not import this module, so the shared definition lives below it.
 */
export { CM_PER_INCH };

/**
 * A physical aiming sensitivity, independent of game, DPI and units.
 *
 * Both fields are strictly positive and finite. X is yaw (horizontal view
 * rotation per centimetre of horizontal mouse travel); Y is pitch.
 */
export interface CanonicalAim {
  readonly contract: typeof CANONICAL_AIM_CONTRACT;
  readonly degreesPerCmX: number;
  readonly degreesPerCmY: number;
}

export class CanonicalAimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalAimError";
  }
}

function requirePositive(value: number, what: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new CanonicalAimError(`${what} must be a positive finite number (got ${value})`);
  }
  return value;
}

/** Builds a canonical aim from degrees-per-centimetre on each axis. */
export function canonicalAim(
  degreesPerCmX: number,
  degreesPerCmY: number = degreesPerCmX,
): CanonicalAim {
  return {
    contract: CANONICAL_AIM_CONTRACT,
    degreesPerCmX: requirePositive(degreesPerCmX, "degreesPerCmX"),
    degreesPerCmY: requirePositive(degreesPerCmY, "degreesPerCmY"),
  };
}

/**
 * Builds a canonical aim from per-count rotation at a stated DPI.
 *
 * This is the boundary where DPI enters: `deg/cm = deg/count × counts/cm`,
 * and `counts/cm = dpi / 2.54`.
 */
export function canonicalFromDegreesPerCount(input: {
  degreesPerCountX: number;
  degreesPerCountY?: number | undefined;
  dpi: number;
}): CanonicalAim {
  const dpi = requirePositive(input.dpi, "dpi");
  const countsPerCm = dpi / CM_PER_INCH;
  const y = input.degreesPerCountY ?? input.degreesPerCountX;
  return canonicalAim(
    requirePositive(input.degreesPerCountX, "degreesPerCountX") * countsPerCm,
    requirePositive(y, "degreesPerCountY") * countsPerCm,
  );
}

/** Builds a canonical aim from centimetres of mouse travel per 360° turn. */
export function canonicalFromCmPer360(
  cmPer360X: number,
  cmPer360Y: number = cmPer360X,
): CanonicalAim {
  return canonicalAim(
    360 / requirePositive(cmPer360X, "cmPer360X"),
    360 / requirePositive(cmPer360Y, "cmPer360Y"),
  );
}

/**
 * Re-expresses a canonical aim in per-count units at a given DPI.
 *
 * The canonical value does not change. This is the ONLY place a DPI turns a
 * physical sensitivity into a count-domain one, so "same feel at a new DPI"
 * is a re-expression rather than a recalculation (requirement 4).
 */
export function degreesPerCountAt(
  aim: CanonicalAim,
  dpi: number,
): { x: number; y: number } {
  const countsPerCm = requirePositive(dpi, "dpi") / CM_PER_INCH;
  return {
    x: aim.degreesPerCmX / countsPerCm,
    y: aim.degreesPerCmY / countsPerCm,
  };
}

/** Mouse counts required for a full 360° turn at a given DPI. */
export function countsPer360At(
  aim: CanonicalAim,
  dpi: number,
): { x: number; y: number } {
  const perCount = degreesPerCountAt(aim, dpi);
  return { x: 360 / perCount.x, y: 360 / perCount.y };
}

/** Centimetres of horizontal mouse travel for a full 360° turn. */
export function cmPer360X(aim: CanonicalAim): number {
  return 360 / aim.degreesPerCmX;
}

/** Centimetres of vertical mouse travel for a full 360° of pitch rotation. */
export function cmPer360Y(aim: CanonicalAim): number {
  return 360 / aim.degreesPerCmY;
}

/** Inches of horizontal mouse travel for a full 360° turn. */
export function inchesPer360X(aim: CanonicalAim): number {
  return cmPer360X(aim) / CM_PER_INCH;
}

/** True when the two axes carry the same physical sensitivity. */
export function isSymmetric(aim: CanonicalAim, epsilonFraction = 1e-9): boolean {
  return (
    Math.abs(aim.degreesPerCmX - aim.degreesPerCmY) <=
    epsilonFraction * aim.degreesPerCmX
  );
}

/** Signed relative difference of `candidate` against `reference`, per axis. */
export function relativeDifference(
  candidate: CanonicalAim,
  reference: CanonicalAim,
): { x: number; y: number } {
  return {
    x: (candidate.degreesPerCmX - reference.degreesPerCmX) / reference.degreesPerCmX,
    y: (candidate.degreesPerCmY - reference.degreesPerCmY) / reference.degreesPerCmY,
  };
}

/** Largest absolute relative difference between two canonical aims. */
export function maxRelativeDifference(
  candidate: CanonicalAim,
  reference: CanonicalAim,
): number {
  const d = relativeDifference(candidate, reference);
  return Math.max(Math.abs(d.x), Math.abs(d.y));
}

/** Scales both axes by one multiplicative factor (a symmetric change). */
export function scaleCanonical(aim: CanonicalAim, factor: number): CanonicalAim {
  return canonicalAim(
    aim.degreesPerCmX * requirePositive(factor, "factor"),
    aim.degreesPerCmY * factor,
  );
}

/** Scales each axis independently. */
export function scaleCanonicalPerAxis(
  aim: CanonicalAim,
  factorX: number,
  factorY: number,
): CanonicalAim {
  return canonicalAim(
    aim.degreesPerCmX * requirePositive(factorX, "factorX"),
    aim.degreesPerCmY * requirePositive(factorY, "factorY"),
  );
}
