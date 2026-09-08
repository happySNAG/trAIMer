/**
 * Physical units shared by every layer that turns mouse motion into rotation.
 *
 * This module exists so there is exactly ONE definition of the inch. The
 * canonical game-conversion layer (`src/games/canonical.ts`) re-exports it
 * rather than declaring its own, which keeps the arena's physical model and
 * the game-profile conversion model literally the same arithmetic instead of
 * two constants that merely happen to agree today.
 *
 * It lives under `src/sensmath` because the measurement core may not import
 * the game layer (tests/gameProfileBoundary.test.ts, requirement 1) while the
 * game layer may import sensmath.
 */

/** Centimetres per inch. Mouse DPI is counts per inch; everything else is cm. */
export const CM_PER_INCH = 2.54;

/** Mouse counts produced per centimetre of physical travel at a given DPI. */
export function countsPerCm(dpi: number): number {
  return dpi / CM_PER_INCH;
}
