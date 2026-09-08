import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  canonicalFromCmPer360,
  cmPer360X,
  cmPer360Y,
  maxRelativeDifference,
} from "../src/games/canonical.ts";
import {
  ConversionError,
  availableMatching,
  canonicalFromGameSettings,
  conversionUsesFov,
  gameSettingsFromCanonical,
  monitorDistanceCoefficientFor,
  roundTrip,
} from "../src/games/convert.ts";
import { resolveFovModel } from "../src/games/fov.ts";
import { MATCHING } from "../src/games/matching.ts";
import { validateGameProfile } from "../src/games/validate.ts";
import { GameProfileRegistry } from "../src/games/registry.ts";
import { GAME_PROFILE_REGISTRY } from "../src/games/index.ts";
import { buildGameRecommendationExport, importCurrentSensitivity } from "../src/games/export.ts";
import { zoomLevelsOf, type GameProfile } from "../src/games/profileSchema.ts";
import {
  APEX_DEGREES_PER_COUNT_AT_ONE,
  APEX_LEGENDS_PROFILE,
  CALL_OF_DUTY_WARZONE_PROFILE,
  COD_DEFAULT_MONITOR_DISTANCE_COEFFICIENT,
  COD_DEGREES_PER_COUNT_AT_ONE,
  COUNTER_STRIKE_2_PROFILE,
  CS2_DEGREES_PER_COUNT_AT_ONE,
  FORTNITE_DEGREES_PER_COUNT_PER_PERCENT,
  FORTNITE_PROFILE,
  GENERIC_RAW_PROFILE,
  NAMED_GAME_PROFILE_IDS,
  PUBLIC_GAME_PROFILES,
  VALORANT_DEGREES_PER_COUNT_AT_ONE,
  VALORANT_PROFILE,
} from "../src/games/profiles/index.ts";

/**
 * The five public game profiles (Game Profile Campaign, Pass 2,
 * requirements 3–7, 13–15).
 *
 * Every number asserted here is either derived from the profile's own
 * declared constant — so the test is really "the converter applies the
 * profile as written" — or is a value an independent reference publishes,
 * which is the only kind of external check a formula can get without the
 * game running.
 */

const CM_PER_INCH = 2.54;
const NAMED = [
  FORTNITE_PROFILE,
  VALORANT_PROFILE,
  COUNTER_STRIKE_2_PROFILE,
  APEX_LEGENDS_PROFILE,
  CALL_OF_DUTY_WARZONE_PROFILE,
];
const CM_PER_360 = [8, 15, 22.3, 34.5, 45, 60, 91.7];
const DPIS = [400, 800, 1200, 1600, 3200];

/** cm/360 from a linear yaw constant, DPI and setting value. */
function expectedCm(degPerCountAtOne: number, value: number, dpi: number): number {
  return (360 / (degPerCountAtOne * value * dpi)) * CM_PER_INCH;
}

/** Deep clone that keeps the profile's declared type. */
function mutate(base: GameProfile, patch: (draft: Record<string, unknown>) => void): GameProfile {
  const draft = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  patch(draft);
  return draft as unknown as GameProfile;
}

const tan = (deg: number): number => Math.tan((deg * Math.PI) / 360);

// ---------------------------------------------------------------------------
// Fortnite
// ---------------------------------------------------------------------------

describe("Fortnite", () => {
  it("known sensitivity + DPI → canonical physical result", () => {
    const aim = canonicalFromGameSettings(FORTNITE_PROFILE, 800, { hipfire: 8 });
    expect(aim.degreesPerCmX).toBeCloseTo(
      (FORTNITE_DEGREES_PER_COUNT_PER_PERCENT * 8 * 800) / CM_PER_INCH,
      12,
    );
    // 8% at 800 DPI is the 25.7 cm the unit definition promises.
    expect(cmPer360X(aim)).toBeCloseTo(25.72, 1);
    expect(cmPer360X(aim)).toBeCloseTo(expectedCm(FORTNITE_DEGREES_PER_COUNT_PER_PERCENT, 8, 800), 9);
  });

  it("canonical physical result → game sensitivity, on the 0.1% grid", () => {
    const conversion = gameSettingsFromCanonical(FORTNITE_PROFILE, canonicalFromCmPer360(25.72), {
      dpi: 800,
    });
    expect(conversion.hipfire.value.ui).toBe(8);
    expect(conversion.hipfire.display).toBe("8.0%");
    expect(conversion.vertical?.value.ui).toBe(8);
  });

  it("round-trips within its own slider tolerance across sensitivities and DPIs", () => {
    for (const cm of CM_PER_360) {
      for (const dpi of DPIS) {
        const result = roundTrip(FORTNITE_PROFILE, canonicalFromCmPer360(cm), { dpi });
        expect(result.withinTolerance, `${cm}cm @${dpi}`).toBe(true);
        expect(result.inverseConsistent).toBe(true);
        expect(result.verticalExpressible).toBe(true);
      }
    }
  });

  it("clamps to 1.0% and 100.0% and says so", () => {
    const tooSlow = gameSettingsFromCanonical(FORTNITE_PROFILE, canonicalFromCmPer360(500), { dpi: 400 });
    expect(tooSlow.hipfire.value.clampedToMin).toBe(true);
    expect(tooSlow.hipfire.value.ui).toBe(1);
    expect(tooSlow.notes.join(" ")).toContain("lowest accepted value is 1.0%");
    const tooFast = gameSettingsFromCanonical(FORTNITE_PROFILE, canonicalFromCmPer360(0.3), { dpi: 3200 });
    expect(tooFast.hipfire.value.clampedToMax).toBe(true);
    expect(tooFast.hipfire.value.ui).toBe(100);
  });

  it("rounds to the 0.1% step and reports the loss", () => {
    const conversion = gameSettingsFromCanonical(FORTNITE_PROFILE, canonicalFromCmPer360(30), { dpi: 800 });
    expect(conversion.hipfire.value.exact).toBeCloseTo(6.859, 3);
    expect(conversion.hipfire.value.ui).toBe(6.9);
    expect(conversion.hipfire.value.roundingLoss).toBe(true);
    expect(conversion.notes.join(" ")).toContain("steps of 0.1%");
    expect(conversion.notes.join(" ")).toContain("X-axis sensitivity: ");
  });

  it("keeps X and Y independent and converts an asymmetric aim exactly", () => {
    const aim = canonicalFromGameSettings(FORTNITE_PROFILE, 800, { hipfire: 8, vertical: 6.4 });
    expect(cmPer360Y(aim) / cmPer360X(aim)).toBeCloseTo(8 / 6.4, 9);
    const back = gameSettingsFromCanonical(FORTNITE_PROFILE, aim, { dpi: 800 });
    expect(back.hipfire.value.ui).toBe(8);
    expect(back.vertical?.value.ui).toBe(6.4);
    expect(back.warnings.some((w) => w.includes("single sensitivity"))).toBe(false);
  });

  it("converts a symmetric recommendation to equal X and Y", () => {
    const conversion = gameSettingsFromCanonical(FORTNITE_PROFILE, canonicalFromCmPer360(34.5), { dpi: 1600 });
    expect(conversion.vertical?.value.ui).toBe(conversion.hipfire.value.ui);
  });

  it("targeting is a plain multiplier at the hip-fire FOV: 100% under every offered philosophy", () => {
    for (const method of availableMatching(FORTNITE_PROFILE)) {
      const conversion = gameSettingsFromCanonical(FORTNITE_PROFILE, canonicalFromCmPer360(30), {
        dpi: 800,
        matching: method,
      });
      const targeting = conversion.zooms.find((z) => z.zoomId === "targeting")!;
      expect(targeting.setting?.value.ui).toBe(100);
      expect(targeting.setting?.display).toBe("100.0%");
      expect(targeting.achievedCmPer360).toBeCloseTo(conversion.achievedCmPer360.x, 9);
    }
    expect(availableMatching(FORTNITE_PROFILE).map((m) => m.kind)).toEqual([
      "physical-360-distance",
    ]);
  });

  it("does not convert scope sensitivity and says why", () => {
    expect(FORTNITE_PROFILE.zoom.kind).toBe("single-scalar");
    expect(zoomLevelsOf(FORTNITE_PROFILE).map((z) => z.setting?.field)).toEqual([
      "mouseTargetingSensitivity",
    ]);
    expect(FORTNITE_PROFILE.knownEdgeCases.join(" ")).toContain("Scope sensitivity is not converted");
    expect(FORTNITE_PROFILE.status).toBe("partially-verified");
  });

  it("models no field of view rather than a fake slider", () => {
    expect(FORTNITE_PROFILE.fov.kind).toBe("none");
    expect(conversionUsesFov(FORTNITE_PROFILE)).toBe(false);
    expect(() =>
      gameSettingsFromCanonical(FORTNITE_PROFILE, canonicalFromCmPer360(30), {
        dpi: 800,
        matching: MATCHING.fovRelative,
      }),
    ).toThrow(ConversionError);
  });
});

// ---------------------------------------------------------------------------
// Valorant
// ---------------------------------------------------------------------------

describe("Valorant", () => {
  it("known sensitivity + DPI → canonical physical result", () => {
    const aim = canonicalFromGameSettings(VALORANT_PROFILE, 800, { hipfire: 0.4 });
    expect(cmPer360X(aim)).toBeCloseTo(expectedCm(VALORANT_DEGREES_PER_COUNT_AT_ONE, 0.4, 800), 9);
    expect(cmPer360X(aim)).toBeCloseTo(40.82, 1);
    // A widely quoted equivalence: Valorant 0.314 at 800 DPI ≈ CS 1.0 at 800.
    const val = canonicalFromGameSettings(VALORANT_PROFILE, 800, { hipfire: 0.314 });
    const cs = canonicalFromGameSettings(COUNTER_STRIKE_2_PROFILE, 800, { hipfire: 1 });
    expect(maxRelativeDifference(val, cs)).toBeLessThan(0.002);
  });

  it("canonical → game value to three decimals, with the loss reported", () => {
    const conversion = gameSettingsFromCanonical(VALORANT_PROFILE, canonicalFromCmPer360(30), { dpi: 800 });
    expect(conversion.hipfire.value.exact).toBeCloseTo(0.5443, 4);
    expect(conversion.hipfire.value.ui).toBe(0.544);
    expect(conversion.hipfire.display).toBe("0.544");
    expect(conversion.notes.join(" ")).toContain("3 decimal places");
  });

  it("round-trips within tolerance and has one sensitivity for both axes", () => {
    for (const cm of CM_PER_360) {
      for (const dpi of DPIS) {
        const result = roundTrip(VALORANT_PROFILE, canonicalFromCmPer360(cm), { dpi });
        expect(result.withinTolerance, `${cm}cm @${dpi}`).toBe(true);
        expect(result.verticalExpressible).toBe(false);
      }
    }
    const asym = gameSettingsFromCanonical(VALORANT_PROFILE, canonicalFromCmPer360(30, 40), { dpi: 800 });
    expect(asym.vertical).toBeNull();
    expect(asym.warnings.join(" ")).toContain("single sensitivity");
  });

  it("respects its 0.001–10 bounds", () => {
    const entry = VALORANT_PROFILE.hipfireField.entry;
    expect(entry.min).toBe(0.001);
    expect(entry.max).toBe(10);
    expect(entry.uiDecimals).toBe(3);
    const tooSlow = gameSettingsFromCanonical(VALORANT_PROFILE, canonicalFromCmPer360(100000), { dpi: 400 });
    expect(tooSlow.hipfire.value.clampedToMin).toBe(true);
  });

  it("locks the field of view at 103° horizontal instead of exposing a setting", () => {
    expect(VALORANT_PROFILE.fov).toEqual({ kind: "fixed", axis: "horizontal-at-16-9", degrees: 103 });
    expect(conversionUsesFov(VALORANT_PROFILE)).toBe(false);
    const resolved = resolveFovModel(VALORANT_PROFILE.fov, null, 16 / 9)!;
    expect(resolved.horizontalDeg).toBeCloseTo(103, 9);
  });

  it("reproduces the published FOV-relative multipliers under its linear-ratio native scaling", () => {
    const conversion = gameSettingsFromCanonical(VALORANT_PROFILE, canonicalFromCmPer360(30), {
      dpi: 800,
      matching: MATCHING.fovRelative,
    });
    const ads = conversion.zooms.find((z) => z.zoomId === "ads-rifle")!;
    const scoped = conversion.zooms.find((z) => z.zoomId === "scoped-operator")!;
    // Independently published: 0.870439 (1.25× rifles) and 0.747462 (Operator).
    expect(ads.setting!.value.exact).toBeCloseTo(0.870439, 5);
    expect(scoped.setting!.value.exact).toBeCloseTo(0.747462, 5);
    // ...and both are exactly tan-ratio ÷ linear-ratio from the profile's own FOVs.
    expect(ads.setting!.value.exact).toBeCloseTo((tan(103 / 1.25) / tan(103)) / (1 / 1.25), 12);
    expect(scoped.setting!.value.exact).toBeCloseTo((tan(103 / 2.5) / tan(103)) / (1 / 2.5), 12);
    expect(ads.setting!.display).toBe("0.870");
    expect(scoped.setting!.display).toBe("0.747");
  });

  it("same physical sensitivity needs the zoom factor itself; the game's own default is 1.000", () => {
    const physical = gameSettingsFromCanonical(VALORANT_PROFILE, canonicalFromCmPer360(30), {
      dpi: 800,
      matching: MATCHING.physical360,
    });
    expect(physical.zooms.find((z) => z.zoomId === "ads-rifle")!.setting!.value.ui).toBe(1.25);
    expect(physical.zooms.find((z) => z.zoomId === "scoped-operator")!.setting!.value.ui).toBe(2.5);
    for (const zoom of physical.zooms) {
      expect(zoom.achievedCmPer360).toBeCloseTo(physical.achievedCmPer360.x, 6);
    }
    const native = gameSettingsFromCanonical(VALORANT_PROFILE, canonicalFromCmPer360(30), {
      dpi: 800,
      matching: MATCHING.gameNative,
    });
    for (const zoom of native.zooms) {
      expect(zoom.setting!.value.ui).toBe(1);
      expect(zoom.notes.join(" ")).toContain("game's own default");
    }
  });

  it("defaults to the game's own relationship so nothing changes unasked", () => {
    expect(VALORANT_PROFILE.defaultMatching).toEqual(MATCHING.gameNative);
    expect(availableMatching(VALORANT_PROFILE)).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Counter-Strike 2
// ---------------------------------------------------------------------------

describe("Counter-Strike 2", () => {
  it("known sensitivity + DPI → canonical physical result", () => {
    const aim = canonicalFromGameSettings(COUNTER_STRIKE_2_PROFILE, 800, { hipfire: 2 });
    expect(cmPer360X(aim)).toBeCloseTo(expectedCm(CS2_DEGREES_PER_COUNT_AT_ONE, 2, 800), 9);
    expect(cmPer360X(aim)).toBeCloseTo(25.98, 1);
    // eDPI 800 ≈ 51.96 cm/360, the number every CS player knows.
    expect(cmPer360X(canonicalFromGameSettings(COUNTER_STRIKE_2_PROFILE, 400, { hipfire: 2 }))).toBeCloseTo(51.96, 1);
  });

  it("converts to two settings-screen decimals and a six-decimal console value", () => {
    const conversion = gameSettingsFromCanonical(COUNTER_STRIKE_2_PROFILE, canonicalFromCmPer360(30), { dpi: 800 });
    expect(conversion.hipfire.value.exact).toBeCloseTo(1.731818, 5);
    expect(conversion.hipfire.value.ui).toBe(1.73);
    expect(conversion.hipfire.value.config).toBeCloseTo(1.731818, 6);
    expect(conversion.notes.join(" ")).toContain("configuration file accepts 6 decimal places");
  });

  it("round-trips within tolerance and links both axes", () => {
    for (const cm of CM_PER_360) {
      for (const dpi of DPIS) {
        const result = roundTrip(COUNTER_STRIKE_2_PROFILE, canonicalFromCmPer360(cm), { dpi });
        expect(result.withinTolerance, `${cm}cm @${dpi}`).toBe(true);
        expect(result.inverseConsistent).toBe(true);
      }
    }
    expect(COUNTER_STRIKE_2_PROFILE.axes.independentAxes).toBe(false);
  });

  it("uses the yaw-based model with a fixed 90° (4:3) field of view", () => {
    expect(COUNTER_STRIKE_2_PROFILE.sensitivityModel).toEqual({
      kind: "linear-yaw",
      yawDegreesPerCountAtOne: 0.022,
      pitchDegreesPerCountAtOne: null,
    });
    const resolved = resolveFovModel(COUNTER_STRIKE_2_PROFILE.fov, null, 16 / 9)!;
    expect(resolved.statedDeg).toBe(90);
    expect(resolved.horizontalDeg).toBeCloseTo(106.26, 2);
    expect(conversionUsesFov(COUNTER_STRIKE_2_PROFILE)).toBe(false);
  });

  it("derives the community's 0.818933 zoom ratio for FOV-relative matching", () => {
    const conversion = gameSettingsFromCanonical(COUNTER_STRIKE_2_PROFILE, canonicalFromCmPer360(30), {
      dpi: 800,
      matching: MATCHING.fovRelative,
    });
    const awp = conversion.zooms[0]!;
    expect(awp.setting!.field).toBe("zoom_sensitivity_ratio");
    expect(awp.setting!.value.exact).toBeCloseTo(0.818933, 6);
    expect(awp.setting!.value.ui).toBe(0.82);
    expect(awp.setting!.value.config).toBeCloseTo(0.818933, 6);
    // The ratio must be formed on the game's own 4:3 numbers (40/90), not on
    // the 16:9 horizontal angles — that would give a different answer.
    expect(awp.setting!.value.exact).toBeCloseTo((tan(40) / tan(90)) / (40 / 90), 12);
  });

  it("same physical sensitivity is 90/40 = 2.25; game-native is 1.00; 100% monitor distance sits between", () => {
    const physical = gameSettingsFromCanonical(COUNTER_STRIKE_2_PROFILE, canonicalFromCmPer360(30), {
      dpi: 800,
      matching: MATCHING.physical360,
    });
    expect(physical.zooms[0]!.setting!.value.ui).toBe(2.25);
    expect(physical.zooms[0]!.achievedCmPer360).toBeCloseTo(physical.achievedCmPer360.x, 6);
    const native = gameSettingsFromCanonical(COUNTER_STRIKE_2_PROFILE, canonicalFromCmPer360(30), {
      dpi: 800,
      matching: MATCHING.gameNative,
    });
    expect(native.zooms[0]!.setting!.value.ui).toBe(1);
    const mdh = gameSettingsFromCanonical(COUNTER_STRIKE_2_PROFILE, canonicalFromCmPer360(30), {
      dpi: 800,
      matching: MATCHING.monitorDistance100,
    });
    expect(mdh.zooms[0]!.setting!.value.exact).toBeGreaterThan(0.818933);
    expect(mdh.zooms[0]!.setting!.value.exact).toBeLessThan(2.25);
  });

  it("is the one profile in this pass marked fully verified, and says what is still open", () => {
    expect(COUNTER_STRIKE_2_PROFILE.status).toBe("verified");
    expect(COUNTER_STRIKE_2_PROFILE.source.uncertaintyNotes.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Apex Legends
// ---------------------------------------------------------------------------

describe("Apex Legends", () => {
  it("known sensitivity + DPI → canonical physical result", () => {
    const aim = canonicalFromGameSettings(APEX_LEGENDS_PROFILE, 800, { hipfire: 1.5 });
    expect(cmPer360X(aim)).toBeCloseTo(expectedCm(APEX_DEGREES_PER_COUNT_AT_ONE, 1.5, 800), 9);
    expect(cmPer360X(aim)).toBeCloseTo(34.64, 1);
  });

  it("shares Counter-Strike's yaw so equal values are equal physical sensitivities", () => {
    const apex = canonicalFromGameSettings(APEX_LEGENDS_PROFILE, 800, { hipfire: 2 });
    const cs = canonicalFromGameSettings(COUNTER_STRIKE_2_PROFILE, 800, { hipfire: 2 });
    expect(maxRelativeDifference(apex, cs)).toBeLessThan(1e-12);
  });

  it("snaps to the 0.1 slider step and offers the six-decimal config value", () => {
    const conversion = gameSettingsFromCanonical(APEX_LEGENDS_PROFILE, canonicalFromCmPer360(30), { dpi: 800 });
    expect(conversion.hipfire.value.exact).toBeCloseTo(1.7318, 3);
    expect(conversion.hipfire.value.ui).toBe(1.7);
    expect(conversion.hipfire.value.config).toBeCloseTo(1.731818, 6);
    expect(conversion.hipfire.value.roundingLoss).toBe(true);
    expect(conversion.roundingErrorFraction).toBeGreaterThan(0.01);
  });

  it("round-trips within its coarse slider tolerance", () => {
    for (const cm of CM_PER_360) {
      for (const dpi of DPIS) {
        const result = roundTrip(APEX_LEGENDS_PROFILE, canonicalFromCmPer360(cm), { dpi });
        expect(result.withinTolerance, `${cm}cm @${dpi}: ${result.relativeError} > ${result.tolerance}`).toBe(true);
      }
    }
  });

  it("clamps to 0.1 and 20.0", () => {
    const tooSlow = gameSettingsFromCanonical(APEX_LEGENDS_PROFILE, canonicalFromCmPer360(5000), { dpi: 400 });
    expect(tooSlow.hipfire.value.clampedToMin).toBe(true);
    expect(tooSlow.hipfire.value.ui).toBe(0.1);
    const tooFast = gameSettingsFromCanonical(APEX_LEGENDS_PROFILE, canonicalFromCmPer360(0.5), { dpi: 3200 });
    expect(tooFast.hipfire.value.clampedToMax).toBe(true);
    expect(tooFast.hipfire.value.ui).toBe(20);
  });

  it("declares the 70–110 (4:3-horizontal) FOV, which no conversion reads", () => {
    expect(APEX_LEGENDS_PROFILE.fov).toMatchObject({
      kind: "configurable",
      axis: "horizontal-at-4-3",
      minDegrees: 70,
      maxDegrees: 110,
      affectsHipfireSensitivity: false,
    });
    expect(conversionUsesFov(APEX_LEGENDS_PROFILE)).toBe(false);
    const at70 = gameSettingsFromCanonical(APEX_LEGENDS_PROFILE, canonicalFromCmPer360(30), { dpi: 800, fovDegrees: 70 });
    const at110 = gameSettingsFromCanonical(APEX_LEGENDS_PROFILE, canonicalFromCmPer360(30), { dpi: 800, fovDegrees: 110 });
    expect(at110.hipfire.value.ui).toBe(at70.hipfire.value.ui);
  });

  it("exposes no ADS or per-optic value and says why, rather than guessing", () => {
    expect(APEX_LEGENDS_PROFILE.zoom.kind).toBe("none");
    expect(APEX_LEGENDS_PROFILE.status).toBe("partially-verified");
    expect(APEX_LEGENDS_PROFILE.knownEdgeCases.join(" ")).toContain("ADS and per-optic sensitivity are not converted");
    expect(APEX_LEGENDS_PROFILE.source.uncertaintyNotes.join(" ")).toContain("conflict");
    const conversion = gameSettingsFromCanonical(APEX_LEGENDS_PROFILE, canonicalFromCmPer360(30), { dpi: 800 });
    expect(conversion.zooms).toEqual([]);
    expect(availableMatching(APEX_LEGENDS_PROFILE)).toEqual([MATCHING.physical360]);
  });
});

// ---------------------------------------------------------------------------
// Call of Duty / Warzone
// ---------------------------------------------------------------------------

describe("Call of Duty / Warzone", () => {
  it("known sensitivity + DPI → canonical physical result", () => {
    const aim = canonicalFromGameSettings(CALL_OF_DUTY_WARZONE_PROFILE, 800, { hipfire: 6 });
    expect(cmPer360X(aim)).toBeCloseTo(expectedCm(COD_DEGREES_PER_COUNT_AT_ONE, 6, 800), 9);
    expect(cmPer360X(aim)).toBeCloseTo(28.86, 1);
  });

  it("converts to two decimals with the vertical multiplier at 1.00 for a symmetric aim", () => {
    const conversion = gameSettingsFromCanonical(CALL_OF_DUTY_WARZONE_PROFILE, canonicalFromCmPer360(30), { dpi: 800 });
    expect(conversion.hipfire.value.exact).toBeCloseTo(5.7727, 3);
    expect(conversion.hipfire.value.ui).toBe(5.77);
    expect(conversion.vertical?.field).toBe("verticalSensitivityMultiplier");
    expect(conversion.vertical?.value.ui).toBe(1);
  });

  it("expresses an asymmetric aim through the vertical multiplier", () => {
    const aim = canonicalFromGameSettings(CALL_OF_DUTY_WARZONE_PROFILE, 800, { hipfire: 6, vertical: 0.8 });
    expect(cmPer360Y(aim) / cmPer360X(aim)).toBeCloseTo(1 / 0.8, 9);
    const back = gameSettingsFromCanonical(CALL_OF_DUTY_WARZONE_PROFILE, aim, { dpi: 800 });
    expect(back.hipfire.value.ui).toBe(6);
    expect(back.vertical?.value.ui).toBe(0.8);
  });

  it("round-trips within tolerance on both axes", () => {
    for (const cm of CM_PER_360) {
      for (const dpi of DPIS) {
        const result = roundTrip(CALL_OF_DUTY_WARZONE_PROFILE, canonicalFromCmPer360(cm), { dpi });
        expect(result.withinTolerance, `${cm}cm @${dpi}`).toBe(true);
        expect(result.verticalExpressible).toBe(true);
      }
    }
  });

  it("translates the matching philosophy into the game's Monitor Distance Coefficient", () => {
    const run = (matching: typeof MATCHING.fovRelative) =>
      gameSettingsFromCanonical(CALL_OF_DUTY_WARZONE_PROFILE, canonicalFromCmPer360(30), {
        dpi: 800,
        matching,
      }).zooms[0]!;
    const fovRelative = run(MATCHING.fovRelative);
    expect(fovRelative.setting!.field).toBe("monitorDistanceCoefficient");
    expect(fovRelative.setting!.value.ui).toBe(0);
    expect(fovRelative.setting!.display).toBe("0.00");
    // 100% of the horizontal width on 16:9 is 177.8% of the vertical height.
    const edge = run(MATCHING.monitorDistance100);
    expect(edge.setting!.value.exact).toBeCloseTo(16 / 9, 9);
    expect(edge.setting!.value.ui).toBe(1.78);
    expect(edge.notes.join(" ")).toContain("vertical axis");
    expect(edge.notes.join(" ")).toContain("16:9");
    const native = run(MATCHING.gameNative);
    expect(native.setting!.value.ui).toBe(COD_DEFAULT_MONITOR_DISTANCE_COEFFICIENT);
    // No single achieved value exists: every optic lands somewhere different.
    expect(native.achievedCmPer360).toBeNull();
    expect(native.notes.join(" ")).toContain("Relative");
  });

  it("clamps a coefficient the game cannot express instead of inventing one", () => {
    const wide = gameSettingsFromCanonical(CALL_OF_DUTY_WARZONE_PROFILE, canonicalFromCmPer360(30), {
      dpi: 800,
      matching: MATCHING.monitorDistance100,
      aspectRatio: 32 / 9,
    }).zooms[0]!;
    expect(wide.setting!.value.exact).toBeCloseTo(32 / 9, 9);
    expect(wide.setting!.value.clampedToMax).toBe(true);
    expect(wide.setting!.value.ui).toBe(2);
    expect(wide.notes.join(" ")).not.toContain("DPI");
  });

  it("refuses same-physical-sensitivity matching because a coefficient cannot express it", () => {
    expect(availableMatching(CALL_OF_DUTY_WARZONE_PROFILE).map((m) => m.kind)).toEqual([
      "monitor-distance",
      "monitor-distance",
      "game-native",
    ]);
    expect(() =>
      gameSettingsFromCanonical(CALL_OF_DUTY_WARZONE_PROFILE, canonicalFromCmPer360(30), {
        dpi: 800,
        matching: MATCHING.physical360,
      }),
    ).toThrow(ConversionError);
    expect(monitorDistanceCoefficientFor(MATCHING.physical360, "vertical", 16 / 9)).toBeNull();
  });

  it("declares the 60–120 horizontal FOV, which does not change hip-fire or the coefficient", () => {
    expect(CALL_OF_DUTY_WARZONE_PROFILE.fov).toMatchObject({
      kind: "configurable",
      axis: "horizontal",
      minDegrees: 60,
      maxDegrees: 120,
      affectsHipfireSensitivity: false,
    });
    expect(conversionUsesFov(CALL_OF_DUTY_WARZONE_PROFILE)).toBe(false);
    const a = gameSettingsFromCanonical(CALL_OF_DUTY_WARZONE_PROFILE, canonicalFromCmPer360(30), {
      dpi: 800,
      fovDegrees: 60,
      matching: MATCHING.monitorDistance100,
    });
    const b = gameSettingsFromCanonical(CALL_OF_DUTY_WARZONE_PROFILE, canonicalFromCmPer360(30), {
      dpi: 800,
      fovDegrees: 120,
      matching: MATCHING.monitorDistance100,
    });
    expect(a.zooms[0]!.setting!.value.ui).toBe(b.zooms[0]!.setting!.value.ui);
    expect(a.hipfire.value.ui).toBe(b.hipfire.value.ui);
  });

  it("does not flatten ADS into a scalar: the entry line is the coefficient plus the mode to set", () => {
    const exported = buildGameRecommendationExport({
      profile: CALL_OF_DUTY_WARZONE_PROFILE,
      dpi: 800,
      recommended: { aim: canonicalFromCmPer360(30), derivation: "game-profile", basis: "test" },
      current: null,
      matching: MATCHING.fovRelative,
    });
    expect(exported.entryLines).toContain("Monitor Distance Coefficient: 0.00");
    expect(exported.precisionNotes.join(" ")).toContain("ADS Sensitivity Type to Relative");
    expect(exported.precisionNotes.join(" ")).toContain("Custom Sensitivity Per Zoom off");
  });
});

// ---------------------------------------------------------------------------
// Everything a public profile must carry (requirements 13, 14)
// ---------------------------------------------------------------------------

describe("version and source metadata on every named profile", () => {
  it.each(NAMED.map((p) => [p.id, p] as const))("%s", (_id, profile) => {
    expect(profile.profileVersion).toBe(1);
    expect(profile.schemaVersion).toBe(1);
    expect(profile.visibility).toBe("public");
    expect(profile.platforms).toContain("pc");
    // Pass 4 re-verified every one of these from scratch, so they carry the
    // Pass 4 date rather than the Pass 2 one they were first written on.
    expect(profile.source.verifiedAtIso).toBe("2026-09-08");
    expect(profile.source.lastReviewedAtIso).toBe("2026-09-08");
    expect(profile.source.gameVersion).toMatch(/2026|2025/);
    expect(profile.source.url).toMatch(/^https:\/\//);
    expect(profile.source.type).toBe("community-reference");
    expect(profile.source.confidence).toBe("high");
    expect(profile.source.uncertaintyNotes.length).toBeGreaterThan(0);
    expect(["verified", "partially-verified"]).toContain(profile.status);
    expect(profile.unitDefinition).toContain("800 DPI");
    expect(validateGameProfile(profile)).toMatchObject({ valid: true });
  });

  it("the unit definition's worked example is arithmetically true for every named game", () => {
    const cases: [GameProfile, number, number][] = [
      [FORTNITE_PROFILE, 8, 25.7],
      [VALORANT_PROFILE, 0.4, 40.8],
      [COUNTER_STRIKE_2_PROFILE, 2, 26.0],
      [APEX_LEGENDS_PROFILE, 1.5, 34.6],
      [CALL_OF_DUTY_WARZONE_PROFILE, 6, 28.9],
    ];
    for (const [profile, value, cm] of cases) {
      expect(profile.unitDefinition).toContain(`${cm.toFixed(1)} cm`);
      expect(cmPer360X(canonicalFromGameSettings(profile, 800, { hipfire: value }))).toBeCloseTo(cm, 1);
    }
  });

  it("a partially verified profile is never silent about what it does not cover", () => {
    for (const profile of NAMED) {
      if (profile.status !== "partially-verified") continue;
      expect(profile.knownEdgeCases.length + profile.source.uncertaintyNotes.length).toBeGreaterThan(1);
      const conversion = gameSettingsFromCanonical(profile, canonicalFromCmPer360(30), { dpi: 800 });
      expect(conversion.warnings.join(" ")).toContain("unverified");
    }
  });

  it("the current-settings import works for every named game before any calibration", () => {
    const cases: [GameProfile, number][] = [
      [FORTNITE_PROFILE, 8],
      [VALORANT_PROFILE, 0.4],
      [COUNTER_STRIKE_2_PROFILE, 2],
      [APEX_LEGENDS_PROFILE, 1.5],
      [CALL_OF_DUTY_WARZONE_PROFILE, 6],
    ];
    for (const [profile, value] of cases) {
      const imported = importCurrentSensitivity(profile, 800, { hipfire: value });
      expect(imported.profileId).toBe(profile.id);
      expect(imported.profileVersion).toBe(1);
      expect(imported.cmPer360X).toBeGreaterThan(20);
      expect(imported.cmPer360X).toBeLessThan(45);
      expect(imported.summary).toContain(profile.displayName);
    }
  });
});

describe("malformed versions of the named profiles fail closed", () => {
  it.each(NAMED.map((p) => [p.id, p] as const))("%s", (_id, profile) => {
    const broken: [string, GameProfile][] = [
      ["zero yaw", mutate(profile, (d) => { (d.sensitivityModel as Record<string, unknown>).yawDegreesPerCountAtOne = 0; })],
      ["inverted range", mutate(profile, (d) => { ((d.hipfireField as Record<string, unknown>).entry as Record<string, unknown>).min = 1000; })],
      ["no game version", mutate(profile, (d) => { (d.source as Record<string, unknown>).gameVersion = null; })],
      ["version zero", mutate(profile, (d) => { d.profileVersion = 0; })],
      ["foreign schema", mutate(profile, (d) => { d.schemaVersion = 7; })],
      ["low confidence yet verified", mutate(profile, (d) => { d.status = "verified"; (d.source as Record<string, unknown>).confidence = "low"; })],
    ];
    for (const [what, bad] of broken) {
      expect(validateGameProfile(bad).valid, what).toBe(false);
      expect(GameProfileRegistry.tryCreate([bad]).registry, what).toBeNull();
    }
  });

  it("a coefficient that forgets it must accept zero is refused", () => {
    const bad = mutate(CALL_OF_DUTY_WARZONE_PROFILE, (d) => {
      const zoom = (d.zoom as Record<string, unknown>).zoom as Record<string, unknown>;
      const entry = (zoom.setting as Record<string, unknown>).entry as Record<string, unknown>;
      entry.allowZero = false;
    });
    const result = validateGameProfile(bad);
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.path)).toContain("zoom[0].setting.entry");
  });

  it("a linear-ratio zoom without a field of view is refused", () => {
    const bad = mutate(VALORANT_PROFILE, (d) => {
      const zooms = (d.zoom as Record<string, unknown>).zooms as Record<string, unknown>[];
      zooms[0]!.fov = { kind: "none" };
      zooms[0]!.magnification = null;
    });
    expect(validateGameProfile(bad).issues.map((i) => i.path)).toContain("zoom[0].fov");
  });
});

// ---------------------------------------------------------------------------
// Cross-profile equivalence — always through the canonical representation
// ---------------------------------------------------------------------------

describe("cross-profile equivalence through the canonical representation", () => {
  const chain: [GameProfile, number, GameProfile][] = [
    [FORTNITE_PROFILE, 8, VALORANT_PROFILE],
    [VALORANT_PROFILE, 0.4, COUNTER_STRIKE_2_PROFILE],
    [COUNTER_STRIKE_2_PROFILE, 2, APEX_LEGENDS_PROFILE],
    [APEX_LEGENDS_PROFILE, 1.5, CALL_OF_DUTY_WARZONE_PROFILE],
  ];

  it.each(chain.map(([a, v, b]) => [a.id, b.id, a, v, b] as const))(
    "%s → canonical → %s preserves the physical sensitivity to within the target's own grid",
    (_a, _b, from, value, to) => {
      for (const dpi of [400, 800, 1600]) {
        const canonical = canonicalFromGameSettings(from, dpi, { hipfire: value });
        const converted = gameSettingsFromCanonical(to, canonical, { dpi });
        expect(converted.requestedCmPer360.x).toBeCloseTo(cmPer360X(canonical), 9);
        expect(converted.roundingErrorFraction).toBeLessThanOrEqual(converted.roundTripTolerance);
        // Reading the target's numbers back lands on the same physical aim.
        const recovered = canonicalFromGameSettings(to, dpi, {
          hipfire: converted.hipfire.value.ui,
          vertical: converted.vertical?.value.ui ?? null,
        });
        expect(maxRelativeDifference(recovered, canonical)).toBeLessThanOrEqual(
          converted.roundTripTolerance,
        );
      }
    },
  );

  it("the well-known ratios fall out of the constants (CS 1.0 ≈ Valorant 0.314 ≈ Fortnite 3.96%)", () => {
    const cs = canonicalFromGameSettings(COUNTER_STRIKE_2_PROFILE, 800, { hipfire: 1 });
    expect(gameSettingsFromCanonical(VALORANT_PROFILE, cs, { dpi: 800 }).hipfire.value.exact).toBeCloseTo(0.3143, 3);
    expect(gameSettingsFromCanonical(FORTNITE_PROFILE, cs, { dpi: 800 }).hipfire.value.exact).toBeCloseTo(3.96, 2);
    expect(gameSettingsFromCanonical(APEX_LEGENDS_PROFILE, cs, { dpi: 800 }).hipfire.value.exact).toBeCloseTo(1, 9);
    expect(gameSettingsFromCanonical(CALL_OF_DUTY_WARZONE_PROFILE, cs, { dpi: 800 }).hipfire.value.exact).toBeCloseTo(3.3333, 3);
  });

  it("the whole chain round-trips back to where it started", () => {
    let aim = canonicalFromGameSettings(FORTNITE_PROFILE, 800, { hipfire: 8 });
    const start = aim;
    for (const profile of [VALORANT_PROFILE, COUNTER_STRIKE_2_PROFILE, APEX_LEGENDS_PROFILE, CALL_OF_DUTY_WARZONE_PROFILE, GENERIC_RAW_PROFILE, FORTNITE_PROFILE]) {
      const converted = gameSettingsFromCanonical(profile, aim, { dpi: 800 });
      aim = canonicalFromGameSettings(profile, 800, {
        hipfire: converted.hipfire.value.ui,
        vertical: converted.vertical?.value.ui ?? null,
      });
    }
    // Apex's 0.1 slider is the coarsest link (about 2%); everything else is finer.
    expect(maxRelativeDifference(aim, start)).toBeLessThan(0.03);
  });

  it("no profile file knows about any other game, and the converter names none", () => {
    const dir = "src/games/profiles";
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "index.ts");
    for (const file of files) {
      const src = readFileSync(`${dir}/${file}`, "utf8");
      for (const other of files) {
        if (other === file) continue;
        expect(src, `${file} imports ${other}`).not.toContain(`./${other.replace(/\.ts$/, "")}`);
      }
    }
    const converter = readFileSync("src/games/convert.ts", "utf8").toLowerCase();
    for (const name of ["fortnite", "valorant", "counter-strike", "apex", "warzone", "call of duty"]) {
      expect(converter, name).not.toContain(name);
    }
  });

  it("the registry order is the picker order and every id is stable kebab-case", () => {
    expect(GAME_PROFILE_REGISTRY.ids()).toEqual([...NAMED_GAME_PROFILE_IDS, "generic-raw"]);
    for (const profile of PUBLIC_GAME_PROFILES) {
      expect(profile.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });
});
