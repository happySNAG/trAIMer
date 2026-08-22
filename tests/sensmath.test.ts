import { describe, expect, it } from "vitest";
import {
  UNCALIBRATED,
  calibrationFromEmpiricalMeasurement,
  compareSensitivity,
  countsForRotationDegrees,
  edpi,
  edpiOf,
  generateCandidateLadder,
  multiplicativeChange,
  percentageChange,
  physicalCmPer360,
  rotationDegreesForCounts,
  sameSensitivity,
} from "../src/index.ts";
import { DEFAULT_SAFE_RANGE } from "../src/domain/candidate.ts";

describe("edpi", () => {
  it("multiplies dpi by the fortnite percent value", () => {
    expect(edpi(800, 7)).toBeCloseTo(5600);
    expect(edpiOf({ sensX: 6, sensY: 6 }, 400)).toBe(2400);
  });

  it("keeps x and y independent when configured", () => {
    const changed = { sensX: 8, sensY: 5 };
    expect(changed.sensX).not.toBe(changed.sensY);
    expect(edpiOf(changed, 800)).toBe(6400);
  });
});

describe("normalized comparisons", () => {
  it("computes linear ratio, log2 ratio, percent difference", () => {
    const cmp = compareSensitivity(8400, 5600);
    expect(cmp.linearRatio).toBeCloseTo(1.5);
    expect(cmp.log2Ratio).toBeCloseTo(Math.log2(1.5));
    expect(cmp.percentDifferenceVsReference).toBeCloseTo(50);
  });

  it("is symmetric in log space", () => {
    const up = compareSensitivity(7000, 5600).log2Ratio;
    const down = compareSensitivity(5600, 7000).log2Ratio;
    expect(up).toBeCloseTo(-down);
  });
});

describe("changes", () => {
  it("applies multiplicative changes to both axes", () => {
    const out = multiplicativeChange({ sensX: 6, sensY: 6 }, 1.15);
    expect(out.sensX).toBeCloseTo(6.9);
    expect(out.sensY).toBeCloseTo(6.9);
  });

  it("applies percentage changes as +p%", () => {
    const out = percentageChange({ sensX: 10, sensY: 10 }, -10);
    expect(out.sensX).toBeCloseTo(9);
  });
});

describe("calibration boundary", () => {
  it("refuses to produce physical rotation while uncalibrated", () => {
    expect(rotationDegreesForCounts(UNCALIBRATED, "x", 100)).toBeNull();
    expect(countsForRotationDegrees(UNCALIBRATED, "x", 90)).toBeNull();
    expect(physicalCmPer360(UNCALIBRATED, 800, "x")).toBeNull();
  });

  it("uses explicit calibration constants only when supplied", () => {
    const cal = calibrationFromEmpiricalMeasurement({
      degreesPerCountAt100X: 0.09,
      degreesPerCountAt100Y: 0.09,
      source: "example-measurement",
    });
    expect(rotationDegreesForCounts(cal, "x", 1000)).toBeCloseTo(90);
    expect(countsForRotationDegrees(cal, "x", 90)).toBeCloseTo(1000);
    const cm = physicalCmPer360(cal, 800, "x");
    expect(cm).toBeCloseTo((4000 / 800) * 2.54);
  });

  it("rejects invalid calibration constants", () => {
    expect(() =>
      calibrationFromEmpiricalMeasurement({
        degreesPerCountAt100X: -1,
        degreesPerCountAt100Y: 1,
        source: "bad",
      }),
    ).toThrow();
  });

  it("supports independent x/y calibration", () => {
    const cal = calibrationFromEmpiricalMeasurement({
      degreesPerCountAt100X: 0.1,
      degreesPerCountAt100Y: 0.05,
      source: "asymmetric-example",
    });
    expect(rotationDegreesForCounts(cal, "y", 1000)).toBeCloseTo(50);
    expect(rotationDegreesForCounts(cal, "x", 1000)).toBeCloseTo(100);
  });
});

describe("candidate ladder generation", () => {
  const baseline = { sensX: 7, sensY: 7 };

  it("includes the baseline first and sorted factors after", () => {
    const ladder = generateCandidateLadder({
      baseline,
      factors: [1.35, 1 / 1.35, 1, 1.15],
      safeRange: DEFAULT_SAFE_RANGE,
    });
    expect(ladder[0]!.origin.kind).toBe("baseline");
    expect(sameSensitivity(ladder[0]!.sensitivity, baseline)).toBe(true);
    const factors = ladder
      .slice(1)
      .map((c) =>
        c.origin.kind === "generated" ? c.origin.multiplicativeFactorVsBaseline : NaN,
      );
    expect([...factors].sort((a, b) => a - b)).toEqual([1 / 1.35, 1.15, 1.35]);
  });

  it("clamps into the safe range", () => {
    const ladder = generateCandidateLadder({
      baseline: { sensX: 18, sensY: 18 },
      factors: [2],
      safeRange: DEFAULT_SAFE_RANGE,
    });
    const boosted = ladder.find((c) => c.origin.kind === "generated")!;
    expect(boosted.sensitivity.sensX).toBe(DEFAULT_SAFE_RANGE.maxSensX);
  });

  it("deduplicates candidates that clamp to the same sensitivity", () => {
    const ladder = generateCandidateLadder({
      baseline: { sensX: 19.9, sensY: 19.9 },
      factors: [1.05, 1.1],
      safeRange: DEFAULT_SAFE_RANGE,
    });
    const generated = ladder.filter((c) => c.origin.kind === "generated");
    expect(generated.length).toBe(1);
  });

  it("rejects non-positive factors", () => {
    expect(() =>
      generateCandidateLadder({
        baseline,
        factors: [0],
        safeRange: DEFAULT_SAFE_RANGE,
      }),
    ).toThrow();
  });
});
