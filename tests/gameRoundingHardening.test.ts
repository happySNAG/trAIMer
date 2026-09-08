/**
 * Pass 4: rounding and precision hardening across every real profile.
 *
 * Pass 3 shipped a rounding defect — a fixed relative epsilon that behaved at
 * two decimal places and moved the answer by whole units at ten. It was found
 * by inspection, not by a test, because the rounding tests all ran against
 * architecture fixtures rather than against the twelve profiles players
 * actually pick.
 *
 * So this file does not test the rounding model in the abstract. It sweeps
 * EVERY numeric field of EVERY public profile — hip-fire, vertical, and every
 * zoom setting — through the values most likely to break a grid, and asserts
 * the invariants that make a quantized number safe to put in front of a
 * player. The strongest of them is the first: whatever comes out must be a
 * value the game will actually accept. A number the game rejects is worse
 * than a number that is slightly off, and it is exactly what the Pass 3 bug
 * produced.
 */

import { describe, expect, it } from "vitest";

import { PUBLIC_GAME_PROFILES } from "../src/games/profiles/index.ts";
import { zoomLevelsOf, type GameProfile } from "../src/games/profileSchema.ts";
import {
  isEnterableValue,
  quantize,
  roundToDecimals,
  type ValueEntrySpec,
} from "../src/games/rounding.ts";

/** Every numeric field a player can be told to type, across every profile. */
function allEntrySpecs(profile: GameProfile): [string, ValueEntrySpec][] {
  const specs: [string, ValueEntrySpec][] = [
    [profile.hipfireField.field, profile.hipfireField.entry],
  ];
  if (profile.axes.verticalField) {
    specs.push([profile.axes.verticalField.field, profile.axes.verticalField.entry]);
  }
  for (const zoom of zoomLevelsOf(profile)) {
    if (zoom.setting) specs.push([`${zoom.id}.${zoom.setting.field}`, zoom.setting.entry]);
  }
  return specs;
}

/** Values chosen to sit on, beside, and outside every interesting boundary. */
function probeValues(spec: ValueEntrySpec): number[] {
  const step = spec.step ?? 10 ** -spec.uiDecimals;
  const span = spec.max - spec.min;
  const values = new Set<number>();
  for (const v of [
    // Outside, at, and just inside each boundary.
    spec.min - span,
    spec.min - step,
    spec.min - step / 2,
    spec.min - step / 1e6,
    spec.min,
    spec.min + step / 2,
    spec.min + step,
    spec.max - step,
    spec.max - step / 2,
    spec.max,
    spec.max + step / 1e6,
    spec.max + step / 2,
    spec.max + step,
    spec.max + span,
    // Interior points, including exact half-steps (the tie-breaking case)
    // and values a decimal representation stores just below themselves.
    spec.min + span / 3,
    spec.min + span / 2,
    spec.min + span / 2 + step / 2,
    spec.min + (span * 2) / 3,
    spec.min + span / 7,
    spec.min + span / 7 + step / 2,
  ]) {
    if (Number.isFinite(v)) values.add(v);
  }
  if (spec.allowZero) values.add(0);
  return [...values];
}

describe("rounding hardening: every field of every public profile", () => {
  for (const profile of PUBLIC_GAME_PROFILES) {
    for (const [name, spec] of allEntrySpecs(profile)) {
      it(`${profile.id} · ${name}: always produces a value the game accepts`, () => {
        for (const exact of probeValues(spec)) {
          const q = quantize(spec, exact);

          // 1. THE invariant. Whatever we print, the game must accept it.
          expect(isEnterableValue(spec, q.ui)).toBe(true);
          expect(q.ui).toBeGreaterThanOrEqual(spec.min - 1e-9);
          expect(q.ui).toBeLessThanOrEqual(spec.max + 1e-9);

          // 2. Clamping is reported for the EXACT value, not for where the
          //    grid happened to land it.
          expect(q.clampedToMin).toBe(exact < spec.min);
          expect(q.clampedToMax).toBe(exact > spec.max);

          // 3. Inside the range, the grid never moves a value by more than
          //    half a step — the bug in Pass 3 moved it by many.
          if (!q.clampedToMin && !q.clampedToMax) {
            const grain = spec.step ?? 10 ** -spec.uiDecimals;
            expect(Math.abs(q.ui - exact)).toBeLessThanOrEqual(grain / 2 + 1e-9);
          }

          // 4. Anything that cost the player precision is said out loud.
          if (q.clampedToMin || q.clampedToMax || q.roundingLoss) {
            expect(q.notes.length).toBeGreaterThan(0);
          } else {
            expect(q.ui).toBe(roundToDecimals(exact, spec.uiDecimals));
          }

          // 5. A config-file value is finer, but still inside the range.
          if (q.config !== null) {
            expect(spec.configDecimals).not.toBeNull();
            expect(q.config).toBeGreaterThanOrEqual(spec.min - 1e-9);
            expect(q.config).toBeLessThanOrEqual(spec.max + 1e-9);
            if (!q.clampedToMin && !q.clampedToMax) {
              expect(Math.abs(q.config - exact)).toBeLessThanOrEqual(
                Math.abs(q.ui - exact) + 1e-9,
              );
            }
          }

          // 6. The reported error is the error that was actually made.
          if (exact !== 0) {
            expect(q.relativeError).toBeCloseTo((q.ui - exact) / exact, 12);
          }
        }
      });
    }
  }

  it("no sensitivity field allows zero; only coefficients declare it", () => {
    for (const profile of PUBLIC_GAME_PROFILES) {
      expect(profile.hipfireField.entry.min).toBeGreaterThan(0);
      expect(profile.hipfireField.entry.allowZero ?? false).toBe(false);
      if (profile.axes.verticalField) {
        expect(profile.axes.verticalField.entry.min).toBeGreaterThan(0);
      }
      for (const zoom of zoomLevelsOf(profile)) {
        if (!zoom.setting) continue;
        const entry = zoom.setting.entry;
        if (entry.min === 0) {
          // A zero minimum is only meaningful where zero is a real setting:
          // the focal-length limit of a monitor-distance coefficient.
          expect(entry.allowZero).toBe(true);
          expect(zoom.nativeBehavior).toBe("monitor-distance-coefficient");
        }
      }
    }
  });

  it("rounds halfway values away from zero without binary-representation dust", () => {
    // The two shapes that defeat a naive Math.round: a decimal stored just
    // below itself (1.005), and a product that lands just below an integer
    // (2.675 * 100 === 267.49999999999994).
    expect(roundToDecimals(1.005, 2)).toBe(1.01);
    expect(roundToDecimals(2.675, 2)).toBe(2.68);
    expect(roundToDecimals(-1.005, 2)).toBe(-1.01);
    // And the case the Pass 3 epsilon broke: a large magnitude at high
    // precision must not be shifted by whole units.
    expect(roundToDecimals(1234567.891, 3)).toBe(1234567.891);
    expect(roundToDecimals(0.1234567891, 10)).toBe(0.1234567891);
  });

  it("a percentage field is quantized in percent, not in the underlying ratio", () => {
    // valueScale exists so a ratio of 1.0 is entered as 100%. If the grid
    // were applied to the ratio instead, a 1% step would become a 100% one.
    for (const profile of PUBLIC_GAME_PROFILES) {
      for (const zoom of zoomLevelsOf(profile)) {
        if (!zoom.setting || zoom.valueScale === undefined) continue;
        expect(zoom.valueScale).toBeGreaterThan(1);
        // The neutral value, scaled, has to be enterable — otherwise the
        // game's own default is a number the game would reject.
        if (zoom.neutralValue !== null) {
          const q = quantize(zoom.setting.entry, zoom.neutralValue * zoom.valueScale);
          expect(isEnterableValue(zoom.setting.entry, q.ui)).toBe(true);
          expect(q.clampedToMin).toBe(false);
          expect(q.clampedToMax).toBe(false);
        }
      }
    }
  });

  it("every profile's stated neutral value is reachable on the game's own grid", () => {
    // Not the same as "is itself enterable". A game can ship a default its
    // own settings screen cannot express: Battlefield 6's stock Uniform
    // Soldier Aiming coefficient is 1.333333 in the configuration file, and
    // the menu moves in tenths of a percent, so 133.3% is as close as a
    // player can type. That is a fact about the game, and the right
    // behaviour is to produce 133.3 with the difference stated — not to
    // pretend the default is something rounder than it is.
    for (const profile of PUBLIC_GAME_PROFILES) {
      for (const zoom of zoomLevelsOf(profile)) {
        if (!zoom.setting || zoom.neutralValue === null) continue;
        const entry = zoom.setting.entry;
        const scaled = zoom.neutralValue * (zoom.valueScale ?? 1);
        const q = quantize(entry, scaled);
        expect(isEnterableValue(entry, q.ui)).toBe(true);
        expect(q.clampedToMin).toBe(false);
        expect(q.clampedToMax).toBe(false);
        const grain = entry.step ?? 10 ** -entry.uiDecimals;
        expect(Math.abs(q.ui - scaled)).toBeLessThanOrEqual(grain / 2 + 1e-9);
        // Only that one game's default is off its own menu grid.
        if (!isEnterableValue(entry, scaled)) {
          expect(profile.id).toBe("battlefield-6");
        }
      }
    }
  });
});
