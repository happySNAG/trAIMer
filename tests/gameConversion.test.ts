import { describe, expect, it } from "vitest";
import {
  canonicalAim,
  canonicalFromCmPer360,
  cmPer360X,
  cmPer360Y,
} from "../src/games/canonical.ts";
import {
  ConversionError,
  availableMatching,
  canonicalFromGameSettings,
  changeDpi,
  degreesPerCountForValue,
  gameSettingsFromCanonical,
  sensitivityElasticity,
  valueForDegreesPerCount,
} from "../src/games/convert.ts";
import { MATCHING } from "../src/games/matching.ts";
import {
  GENERIC_DEGREES_PER_COUNT_AT_ONE,
  GENERIC_RAW_PROFILE,
} from "../src/games/profiles/generic.ts";
import {
  FIXTURE_INDEPENDENT_CONTINUOUS,
  FIXTURE_LINKED_STEPPED,
  FIXTURE_PER_SCOPE,
  FIXTURE_POWER_LAW,
} from "../src/games/fixtures.ts";
import {
  formatEntryValue,
  isEnterableValue,
  quantize,
  roundToDecimals,
  roundTripToleranceFraction,
} from "../src/games/rounding.ts";

const CM_PER_INCH = 2.54;

describe("generic / raw profile (requirement 12)", () => {
  it("means exactly what its unit definition says", () => {
    const aim = canonicalFromGameSettings(GENERIC_RAW_PROFILE, 800, { hipfire: 1 });
    expect(aim.degreesPerCmX).toBeCloseTo(
      (GENERIC_DEGREES_PER_COUNT_AT_ONE * 800) / CM_PER_INCH,
      12,
    );
    // The unit definition promises 57.2 cm/360 at 800 DPI.
    expect(cmPer360X(aim)).toBeCloseTo(57.15, 2);
  });

  it("is linear in the sensitivity value", () => {
    const one = canonicalFromGameSettings(GENERIC_RAW_PROFILE, 800, { hipfire: 1 });
    const two = canonicalFromGameSettings(GENERIC_RAW_PROFILE, 800, { hipfire: 2 });
    expect(two.degreesPerCmX / one.degreesPerCmX).toBeCloseTo(2, 12);
  });

  it("converts a target cm/360 back to a value that reproduces it", () => {
    for (const cm of [15, 24.7, 34.5, 45, 80]) {
      const conversion = gameSettingsFromCanonical(
        GENERIC_RAW_PROFILE,
        canonicalFromCmPer360(cm),
        { dpi: 800 },
      );
      // Relative, not absolute: the generic profile's four-decimal entry
      // grid is a fixed RELATIVE precision, so an 80 cm target is allowed a
      // proportionally larger absolute miss than a 15 cm one.
      expect(conversion.achievedCmPer360.x / cm).toBeCloseTo(1, 4);
    }
  });

  it("has independent axes, so an asymmetric aim survives the trip", () => {
    const aim = canonicalFromCmPer360(30, 45);
    const conversion = gameSettingsFromCanonical(GENERIC_RAW_PROFILE, aim, { dpi: 1600 });
    expect(conversion.vertical).not.toBeNull();
    expect(conversion.achievedCmPer360.x / 30).toBeCloseTo(1, 4);
    expect(conversion.achievedCmPer360.y / 45).toBeCloseTo(1, 4);
    expect(conversion.warnings).toEqual([]);
  });

  it("refuses a matching philosophy it cannot express", () => {
    expect(() =>
      gameSettingsFromCanonical(GENERIC_RAW_PROFILE, canonicalFromCmPer360(30), {
        dpi: 800,
        matching: MATCHING.monitorDistance100,
      }),
    ).toThrow(ConversionError);
    expect(availableMatching(GENERIC_RAW_PROFILE)).toEqual([MATCHING.physical360]);
  });

  it("rejects impossible inputs rather than producing a number", () => {
    expect(() =>
      canonicalFromGameSettings(GENERIC_RAW_PROFILE, 0, { hipfire: 1 }),
    ).toThrow(ConversionError);
    expect(() =>
      canonicalFromGameSettings(GENERIC_RAW_PROFILE, 800, { hipfire: 0 }),
    ).toThrow(ConversionError);
    expect(() =>
      gameSettingsFromCanonical(GENERIC_RAW_PROFILE, canonicalFromCmPer360(30), {
        dpi: Number.NaN,
      }),
    ).toThrow(ConversionError);
  });
});

describe("DPI handling (requirement 4)", () => {
  it("keeps cm/360 fixed and moves the game value instead", () => {
    const change = changeDpi(GENERIC_RAW_PROFILE, { hipfire: 2 }, 800, 1600);
    expect(change.cmPer360).toBeCloseTo(cmPer360X(change.canonical), 12);
    expect(change.after.achievedCmPer360.x / change.cmPer360).toBeCloseTo(1, 4);
    // Twice the DPI, half the sensitivity, same physical sensitivity.
    expect(change.after.hipfire.value.ui).toBeCloseTo(1, 4);
    expect(change.before.hipfire.value.ui).toBeCloseTo(2, 4);
    expect(change.unreachableAtNewDpi).toBe(false);
  });

  it("does not hardcode 800 DPI anywhere in the path", () => {
    for (const dpi of [400, 500, 800, 1200, 1600, 3200, 6400]) {
      const aim = canonicalFromCmPer360(34.5);
      const conversion = gameSettingsFromCanonical(GENERIC_RAW_PROFILE, aim, { dpi });
      expect(conversion.dpi).toBe(dpi);
      // Held to the profile's OWN declared precision rather than a magic
      // constant: at 400 DPI the generic value is smaller, so four decimal
      // places buy proportionally less.
      expect(conversion.roundingErrorFraction).toBeLessThanOrEqual(
        conversion.roundTripTolerance,
      );
    }
  });

  it("says so when the new DPI cannot reach the same physical sensitivity", () => {
    // The stepped fixture stops at 50%; at a very low DPI the equivalent
    // value is off the top of its slider.
    const change = changeDpi(FIXTURE_LINKED_STEPPED, { hipfire: 20 }, 1600, 100);
    expect(change.unreachableAtNewDpi).toBe(true);
    expect(change.after.hipfire.value.clampedToMax).toBe(true);
    expect(change.after.notes.join(" ")).toContain("Raise your DPI");
  });
});

describe("X/Y model (requirement 5)", () => {
  it("linked axes cannot express an independent vertical, and say so", () => {
    const aim = canonicalFromCmPer360(30, 30);
    const conversion = gameSettingsFromCanonical(FIXTURE_LINKED_STEPPED, aim, {
      dpi: 800,
    });
    expect(conversion.vertical).toBeNull();
    // This fixture's engine runs pitch at 0.75 of yaw, so a symmetric request
    // is impossible and the conversion says exactly that.
    expect(conversion.warnings.join(" ")).toContain("single sensitivity");
    expect(conversion.achievedCmPer360.y).toBeCloseTo(
      conversion.achievedCmPer360.x / 0.75,
      3,
    );
  });

  it("does not blame the axis model for what rounding did", () => {
    // A coarse slider misses a symmetric target by the width of its own
    // step. That is a ROUNDING note, not "this game has one sensitivity" —
    // the per-scope fixture has linked axes at a 1:1 ratio and can express a
    // symmetric aim exactly.
    const conversion = gameSettingsFromCanonical(
      FIXTURE_PER_SCOPE,
      canonicalFromCmPer360(37.3),
      { dpi: 800, fovDegrees: 60 },
    );
    expect(conversion.hipfire.value.roundingLoss).toBe(true);
    expect(conversion.warnings.join(" ")).not.toContain("single sensitivity");
  });

  it("honours a built-in vertical ratio when reading settings back", () => {
    const aim = canonicalFromGameSettings(FIXTURE_LINKED_STEPPED, 800, { hipfire: 10 });
    expect(aim.degreesPerCmY / aim.degreesPerCmX).toBeCloseTo(0.75, 12);
  });

  it("independent absolute axes reproduce both requested axes", () => {
    const aim = canonicalFromCmPer360(28, 36);
    const conversion = gameSettingsFromCanonical(FIXTURE_INDEPENDENT_CONTINUOUS, aim, {
      dpi: 800,
    });
    expect(conversion.vertical?.label).toBe("Vertical sensitivity");
    expect(conversion.achievedCmPer360.x / 28).toBeCloseTo(1, 3);
    expect(conversion.achievedCmPer360.y / 36).toBeCloseTo(1, 3);
  });

  it("a vertical MULTIPLIER is expressed relative to the rounded horizontal", () => {
    const aim = canonicalFromCmPer360(30, 40);
    const conversion = gameSettingsFromCanonical(FIXTURE_POWER_LAW, aim, { dpi: 800 });
    expect(conversion.vertical).not.toBeNull();
    // The multiplier applies to the value the player actually types.
    const hip = conversion.hipfire.value.ui;
    const mult = conversion.vertical!.value.ui;
    const rebuilt = canonicalFromGameSettings(FIXTURE_POWER_LAW, 800, {
      hipfire: hip,
      vertical: mult,
    });
    expect(rebuilt.degreesPerCmY).toBeCloseTo(conversion.achieved.degreesPerCmY, 9);
    expect(cmPer360Y(rebuilt)).toBeGreaterThan(cmPer360X(rebuilt));
  });

  it("reads a missing vertical value as 'same as horizontal' or a neutral 1.0", () => {
    const absolute = canonicalFromGameSettings(FIXTURE_INDEPENDENT_CONTINUOUS, 800, {
      hipfire: 2,
    });
    expect(absolute.degreesPerCmY).toBeCloseTo(absolute.degreesPerCmX, 12);
    const multiplier = canonicalFromGameSettings(FIXTURE_POWER_LAW, 800, { hipfire: 4 });
    expect(multiplier.degreesPerCmY).toBeCloseTo(multiplier.degreesPerCmX, 12);
  });
});

describe("slider granularity and rounding (requirement 15)", () => {
  it("never hides the difference between exact and enterable", () => {
    // Chosen to land between two 0.1% notches on the stepped fixture.
    const target = canonicalFromGameSettings(FIXTURE_LINKED_STEPPED, 800, {
      hipfire: 6.347,
    });
    const conversion = gameSettingsFromCanonical(FIXTURE_LINKED_STEPPED, target, {
      dpi: 800,
    });
    expect(conversion.hipfire.value.exact).toBeCloseTo(6.347, 6);
    expect(conversion.hipfire.value.ui).toBe(6.3);
    expect(conversion.hipfire.value.roundingLoss).toBe(true);
    expect(conversion.hipfire.display).toBe("6.3%");
    const note = conversion.notes.join(" ");
    expect(note).toContain("Exact equivalent 6.347%");
    expect(note).toContain("steps of 0.1%");
    expect(note).toContain("enter 6.3%");
  });

  it("reports no loss when the value lands exactly on the grid", () => {
    const target = canonicalFromGameSettings(FIXTURE_LINKED_STEPPED, 800, {
      hipfire: 6.3,
    });
    const conversion = gameSettingsFromCanonical(FIXTURE_LINKED_STEPPED, target, {
      dpi: 800,
    });
    expect(conversion.hipfire.value.roundingLoss).toBe(false);
    expect(conversion.notes).toEqual([]);
    expect(conversion.roundingErrorFraction).toBeLessThan(1e-9);
  });

  it("offers a config-file value when a game accepts finer precision there", () => {
    const target = canonicalFromGameSettings(FIXTURE_PER_SCOPE, 800, { hipfire: 1.237 });
    const conversion = gameSettingsFromCanonical(FIXTURE_PER_SCOPE, target, { dpi: 800 });
    expect(conversion.hipfire.value.ui).toBe(1.25);
    expect(conversion.hipfire.value.config).toBeCloseTo(1.237, 5);
    expect(conversion.notes.join(" ")).toContain("configuration file accepts 5 decimal places");
  });

  it("clamps to the game's own limits and explains which way to move DPI", () => {
    const tooFast = canonicalFromCmPer360(1);
    const high = gameSettingsFromCanonical(FIXTURE_LINKED_STEPPED, tooFast, { dpi: 400 });
    expect(high.hipfire.value.clampedToMax).toBe(true);
    expect(high.notes.join(" ")).toContain("Raise your DPI");

    const tooSlow = canonicalFromCmPer360(5000);
    const low = gameSettingsFromCanonical(FIXTURE_LINKED_STEPPED, tooSlow, { dpi: 3200 });
    expect(low.hipfire.value.clampedToMin).toBe(true);
    expect(low.notes.join(" ")).toContain("Lower your DPI");
  });

  it("keeps a clamped value ON the game's step grid", () => {
    const spec = {
      min: 0.15,
      max: 4.85,
      step: 0.5,
      stepOrigin: 0,
      uiDecimals: 2,
      configDecimals: null,
      rounding: "nearest" as const,
      unitSuffix: "",
    };
    const high = quantize(spec, 99);
    expect(high.ui).toBeLessThanOrEqual(spec.max);
    expect(roundToDecimals(high.ui / 0.5, 6) % 1).toBeCloseTo(0, 9);
    const low = quantize(spec, 0.0001);
    expect(low.ui).toBeGreaterThanOrEqual(spec.min);
    expect(roundToDecimals(low.ui / 0.5, 6) % 1).toBeCloseTo(0, 9);
  });
});

describe("sensitivity models", () => {
  it("inverts a linear model exactly", () => {
    const model = GENERIC_RAW_PROFILE.sensitivityModel;
    for (const value of [0.01, 1, 3.7, 55]) {
      const deg = degreesPerCountForValue(model, value);
      expect(valueForDegreesPerCount(model, deg)).toBeCloseTo(value, 12);
    }
    expect(sensitivityElasticity(model)).toBe(1);
  });

  it("inverts a power-law model exactly and reports its elasticity", () => {
    const model = FIXTURE_POWER_LAW.sensitivityModel;
    for (const value of [0.5, 2.25, 9, 24.75]) {
      const deg = degreesPerCountForValue(model, value);
      expect(valueForDegreesPerCount(model, deg)).toBeCloseTo(value, 10);
    }
    expect(sensitivityElasticity(model)).toBeCloseTo(1.4, 12);
  });

  it("refuses non-physical arguments", () => {
    const model = GENERIC_RAW_PROFILE.sensitivityModel;
    expect(() => degreesPerCountForValue(model, 0)).toThrow(ConversionError);
    expect(() => degreesPerCountForValue(model, -1)).toThrow(ConversionError);
    expect(() => valueForDegreesPerCount(model, 0)).toThrow(ConversionError);
  });
});

describe("ADS and scope conversion (requirement 6)", () => {
  const target = canonicalFromCmPer360(30);

  it("a single ADS scalar under physical-360 matching is exactly 1.00", () => {
    const conversion = gameSettingsFromCanonical(FIXTURE_LINKED_STEPPED, target, {
      dpi: 800,
      matching: MATCHING.physical360,
    });
    const ads = conversion.zooms.find((z) => z.zoomId === "ads")!;
    expect(ads.setting?.value.ui).toBeCloseTo(1, 6);
    expect(ads.achievedCmPer360).toBeCloseTo(conversion.achievedCmPer360.x, 6);
  });

  it("the same scalar under FOV-relative matching scales by the tangent ratio", () => {
    const conversion = gameSettingsFromCanonical(FIXTURE_LINKED_STEPPED, target, {
      dpi: 800,
      fovDegrees: 100,
      matching: MATCHING.fovRelative,
    });
    const ads = conversion.zooms.find((z) => z.zoomId === "ads")!;
    const tan = (deg: number): number => Math.tan((deg * Math.PI) / 360);
    expect(ads.setting?.value.exact).toBeCloseTo(tan(65) / tan(100), 6);
    expect(ads.setting!.value.ui).toBeLessThan(1);
  });

  it("game-native matching leaves each optic at the developers' value", () => {
    const conversion = gameSettingsFromCanonical(FIXTURE_PER_SCOPE, target, {
      dpi: 800,
      matching: MATCHING.gameNative,
    });
    for (const zoom of conversion.zooms) {
      expect(zoom.setting?.value.ui).toBeCloseTo(1, 6);
      expect(zoom.notes.join(" ")).toContain("game's own default");
    }
  });

  it("per-optic multipliers differ from each other under FOV-relative matching", () => {
    const conversion = gameSettingsFromCanonical(FIXTURE_PER_SCOPE, target, {
      dpi: 800,
      fovDegrees: 60,
      matching: MATCHING.fovRelative,
    });
    const values = conversion.zooms.map((z) => z.setting?.value.ui ?? null);
    expect(new Set(values).size).toBeGreaterThan(1);
    const byId = new Map(conversion.zooms.map((z) => [z.zoomId, z]));
    // More magnification, slower optic.
    expect(byId.get("ads-2x")!.setting!.value.ui).toBeGreaterThan(
      byId.get("sniper")!.setting!.value.ui,
    );
  });

  it("an optic the game already scales by FOV needs no multiplier for that philosophy", () => {
    const conversion = gameSettingsFromCanonical(FIXTURE_PER_SCOPE, target, {
      dpi: 800,
      fovDegrees: 60,
      matching: MATCHING.fovRelative,
    });
    const fourX = conversion.zooms.find((z) => z.zoomId === "ads-4x")!;
    expect(fourX.nativeBehavior).toBe("fov-relative-multiplier");
    expect(fourX.setting!.value.exact).toBeCloseTo(1, 9);
  });

  it("clamps an optic whose exact multiplier is off its slider, and says so", () => {
    const conversion = gameSettingsFromCanonical(FIXTURE_PER_SCOPE, target, {
      dpi: 800,
      fovDegrees: 60,
      matching: MATCHING.physical360,
    });
    const fourX = conversion.zooms.find((z) => z.zoomId === "ads-4x")!;
    // Undoing the game's own FOV scaling needs more than its slider allows.
    expect(fourX.setting!.value.clampedToMax).toBe(true);
    expect(fourX.notes.join(" ")).toContain("highest accepted value");
  });

  it("reports the cm/360 each optic actually ends up at", () => {
    const conversion = gameSettingsFromCanonical(FIXTURE_PER_SCOPE, target, {
      dpi: 800,
      fovDegrees: 60,
      matching: MATCHING.physical360,
    });
    const oneX = conversion.zooms.find((z) => z.zoomId === "ads-1x")!;
    expect(oneX.achievedCmPer360).toBeCloseTo(conversion.achievedCmPer360.x, 6);
  });

  it("a profile with no optics produces no zoom rows", () => {
    const conversion = gameSettingsFromCanonical(GENERIC_RAW_PROFILE, target, { dpi: 800 });
    expect(conversion.zooms).toEqual([]);
  });
});

describe("FOV handling (requirement 7)", () => {
  it("carries the resolved hip-fire FOV on the conversion", () => {
    const conversion = gameSettingsFromCanonical(
      FIXTURE_LINKED_STEPPED,
      canonicalFromCmPer360(30),
      { dpi: 800, fovDegrees: 103 },
    );
    expect(conversion.fov?.statedDeg).toBe(103);
    expect(conversion.fov?.horizontalDeg).toBeCloseTo(103, 9);
    expect(conversion.fov!.verticalDeg).toBeLessThan(103);
  });

  it("clamps an out-of-range FOV and warns rather than extrapolating", () => {
    const conversion = gameSettingsFromCanonical(
      FIXTURE_LINKED_STEPPED,
      canonicalFromCmPer360(30),
      { dpi: 800, fovDegrees: 170, matching: MATCHING.fovRelative },
    );
    expect(conversion.fov?.statedDeg).toBe(120);
    expect(conversion.warnings.join(" ")).toContain("outside");
  });

  it("has no FOV at all for a profile that does not model one", () => {
    const conversion = gameSettingsFromCanonical(
      GENERIC_RAW_PROFILE,
      canonicalFromCmPer360(30),
      { dpi: 800, fovDegrees: 90 },
    );
    expect(conversion.fov).toBeNull();
  });

  it("uses a different aspect ratio without changing the stated number", () => {
    const wide = gameSettingsFromCanonical(
      FIXTURE_LINKED_STEPPED,
      canonicalFromCmPer360(30),
      { dpi: 800, fovDegrees: 90, aspectRatio: 21 / 9 },
    );
    expect(wide.fov?.statedDeg).toBe(90);
    expect(wide.fov!.verticalDeg).toBeLessThan(
      // A 90° horizontal FOV covers less vertically on an ultrawide display.
      gameSettingsFromCanonical(FIXTURE_LINKED_STEPPED, canonicalFromCmPer360(30), {
        dpi: 800,
        fovDegrees: 90,
      }).fov!.verticalDeg,
    );
  });
});

describe("conversion output shape", () => {
  it("carries the profile identity and both canonical aims", () => {
    const aim = canonicalAim(6.3);
    const conversion = gameSettingsFromCanonical(GENERIC_RAW_PROFILE, aim, { dpi: 800 });
    expect(conversion.contract).toBe("game-conversion-v1");
    expect(conversion.profileId).toBe("generic-raw");
    expect(conversion.profileVersion).toBe(1);
    expect(conversion.requested).toBe(aim);
    expect(conversion.requestedCmPer360.x).toBeCloseTo(cmPer360X(aim), 12);
    expect(conversion.achievedCmPer360.x).toBeCloseTo(cmPer360X(conversion.achieved), 12);
  });
});

describe("value-entry helpers", () => {
  const stepped = FIXTURE_LINKED_STEPPED.hipfireField.entry;
  const continuous = GENERIC_RAW_PROFILE.hipfireField.entry;

  it("rounds to a fixed precision without binary-representation dust", () => {
    expect(roundToDecimals(1.005, 2)).toBe(1.01);
    expect(roundToDecimals(2.675, 2)).toBe(2.68);
    expect(roundToDecimals(-1.005, 2)).toBe(-1.01);
    expect(roundToDecimals(6.3499999, 1)).toBe(6.3);
    expect(roundToDecimals(Number.NaN, 2)).toBeNaN();
    // The correction must scale with the magnitude being rounded. A fixed
    // relative epsilon that works at two decimals moves the answer by twelve
    // whole units at ten, which silently corrupted deep-precision values.
    expect(roundToDecimals(1.2345, 10)).toBe(1.2345);
    expect(roundToDecimals(1.23456789, 12)).toBe(1.23456789);
  });

  it("knows which values a game will actually accept", () => {
    expect(isEnterableValue(stepped, 6.3)).toBe(true);
    expect(isEnterableValue(stepped, 6.35)).toBe(false);
    expect(isEnterableValue(stepped, 0.05)).toBe(false); // below min
    expect(isEnterableValue(stepped, 50.1)).toBe(false); // above max
    expect(isEnterableValue(continuous, 1.2345)).toBe(true);
    expect(isEnterableValue(continuous, 1.23456)).toBe(false);
    expect(isEnterableValue(continuous, Number.NaN)).toBe(false);
  });

  it("formats a value the way the game's own screen shows it", () => {
    expect(formatEntryValue(stepped, 6.3)).toBe("6.3%");
    expect(formatEntryValue(continuous, 1.5)).toBe("1.5000");
  });

  it("refuses to quantize a value that is not a number", () => {
    expect(() => quantize(stepped, Number.NaN)).toThrow(RangeError);
    expect(() => quantize(stepped, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("declares a tolerance no finer than the grid it describes", () => {
    // Half a step, relative to the value.
    expect(roundTripToleranceFraction(stepped, 10)).toBeCloseTo(0.005, 4);
    expect(roundTripToleranceFraction(stepped, 1)).toBeCloseTo(0.05, 4);
    // A continuous control is bounded by its decimal precision instead.
    expect(roundTripToleranceFraction(continuous, 1)).toBeCloseTo(5e-5, 8);
  });
});
