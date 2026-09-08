import { describe, expect, it } from "vitest";
import {
  CM_PER_INCH,
  CanonicalAimError,
  canonicalAim,
  canonicalFromCmPer360,
  canonicalFromDegreesPerCount,
  cmPer360X,
  cmPer360Y,
  countsPer360At,
  degreesPerCountAt,
  inchesPer360X,
  isSymmetric,
  maxRelativeDifference,
  relativeDifference,
  scaleCanonical,
  scaleCanonicalPerAxis,
} from "../src/games/canonical.ts";

/**
 * THE canonical representation (Game Profile Pass 1, requirements 3 and 4).
 *
 * Two properties carry the whole architecture and are pinned here:
 *
 *  1. a DPI change re-expresses the canonical value and never alters it;
 *  2. every unit the product speaks (cm/360, deg/count, counts/360, inches)
 *     is a lossless view of the same number.
 */
describe("canonical aim — construction and units", () => {
  it("refuses values that are not a physical sensitivity", () => {
    expect(() => canonicalAim(0)).toThrow(CanonicalAimError);
    expect(() => canonicalAim(-1)).toThrow(CanonicalAimError);
    expect(() => canonicalAim(Number.NaN)).toThrow(CanonicalAimError);
    expect(() => canonicalAim(Number.POSITIVE_INFINITY)).toThrow(CanonicalAimError);
    expect(() => canonicalFromCmPer360(0)).toThrow(CanonicalAimError);
    expect(() =>
      canonicalFromDegreesPerCount({ degreesPerCountX: 0.02, dpi: 0 }),
    ).toThrow(CanonicalAimError);
  });

  it("defaults the vertical axis to the horizontal one", () => {
    const aim = canonicalAim(6.3);
    expect(aim.degreesPerCmY).toBe(6.3);
    expect(isSymmetric(aim)).toBe(true);
  });

  it("cm/360 and deg/cm are reciprocal views of one number", () => {
    const aim = canonicalFromCmPer360(34.5);
    expect(cmPer360X(aim)).toBeCloseTo(34.5, 10);
    expect(aim.degreesPerCmX).toBeCloseTo(360 / 34.5, 10);
    expect(inchesPer360X(aim)).toBeCloseTo(34.5 / CM_PER_INCH, 10);
  });

  it("round-trips through per-count units at any DPI", () => {
    for (const dpi of [400, 800, 1600, 3200, 25600]) {
      const original = canonicalFromCmPer360(28.4, 41.2);
      const perCount = degreesPerCountAt(original, dpi);
      const rebuilt = canonicalFromDegreesPerCount({
        degreesPerCountX: perCount.x,
        degreesPerCountY: perCount.y,
        dpi,
      });
      expect(maxRelativeDifference(rebuilt, original)).toBeLessThan(1e-12);
    }
  });

  it("counts per 360 scales exactly with DPI", () => {
    const aim = canonicalFromCmPer360(30);
    const at800 = countsPer360At(aim, 800);
    const at1600 = countsPer360At(aim, 1600);
    expect(at1600.x).toBeCloseTo(at800.x * 2, 9);
    // The physical distance is what stays fixed.
    expect((at800.x / 800) * CM_PER_INCH).toBeCloseTo(30, 9);
    expect((at1600.x / 1600) * CM_PER_INCH).toBeCloseTo(30, 9);
  });
});

describe("canonical aim — DPI independence (requirement 4)", () => {
  it("changing DPI does not change the canonical value", () => {
    const aim = canonicalFromCmPer360(34.5);
    const at800 = degreesPerCountAt(aim, 800);
    const at1600 = degreesPerCountAt(aim, 1600);
    // The per-count number halves; the canonical value is untouched.
    expect(at1600.x).toBeCloseTo(at800.x / 2, 12);
    expect(cmPer360X(aim)).toBeCloseTo(34.5, 12);
  });

  it("the same deg/count at two DPIs is two different physical sensitivities", () => {
    const a = canonicalFromDegreesPerCount({ degreesPerCountX: 0.022, dpi: 800 });
    const b = canonicalFromDegreesPerCount({ degreesPerCountX: 0.022, dpi: 1600 });
    expect(cmPer360X(a)).toBeCloseTo(cmPer360X(b) * 2, 9);
  });
});

describe("canonical aim — asymmetry and comparison", () => {
  it("keeps the axes independent", () => {
    const aim = canonicalFromCmPer360(30, 45);
    expect(cmPer360X(aim)).toBeCloseTo(30, 10);
    expect(cmPer360Y(aim)).toBeCloseTo(45, 10);
    expect(isSymmetric(aim)).toBe(false);
  });

  it("reports signed relative differences per axis", () => {
    const reference = canonicalAim(10, 10);
    const candidate = canonicalAim(11, 9);
    const diff = relativeDifference(candidate, reference);
    expect(diff.x).toBeCloseTo(0.1, 12);
    expect(diff.y).toBeCloseTo(-0.1, 12);
    expect(maxRelativeDifference(candidate, reference)).toBeCloseTo(0.1, 12);
  });

  it("scales symmetrically and per axis", () => {
    const aim = canonicalAim(10, 10);
    expect(scaleCanonical(aim, 1.25).degreesPerCmX).toBeCloseTo(12.5, 12);
    expect(scaleCanonical(aim, 1.25).degreesPerCmY).toBeCloseTo(12.5, 12);
    const perAxis = scaleCanonicalPerAxis(aim, 2, 0.5);
    expect(perAxis.degreesPerCmX).toBeCloseTo(20, 12);
    expect(perAxis.degreesPerCmY).toBeCloseTo(5, 12);
    expect(() => scaleCanonical(aim, 0)).toThrow(CanonicalAimError);
  });
});
