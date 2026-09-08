import { describe, expect, it } from "vitest";
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
  roundTrip,
} from "../src/games/convert.ts";
import { hipfireFovFactor, resolveFovModel, resolveScaledFov, resolveFov } from "../src/games/fov.ts";
import { MATCHING } from "../src/games/matching.ts";
import { validateGameProfile } from "../src/games/validate.ts";
import { GameProfileRegistry } from "../src/games/registry.ts";
import { GAME_PROFILE_REGISTRY } from "../src/games/index.ts";
import { buildGameRecommendationExport, importCurrentSensitivity } from "../src/games/export.ts";
import { zoomLevelsOf, type GameProfile } from "../src/games/profileSchema.ts";
import {
  BATTLEFIELD_6_DEFAULT_COEFFICIENT,
  BATTLEFIELD_6_DEGREES_PER_COUNT_AT_ONE,
  BATTLEFIELD_6_PROFILE,
  FORTNITE_PROFILE,
  MARVEL_RIVALS_DEGREES_PER_COUNT_AT_ONE,
  MARVEL_RIVALS_PROFILE,
  NAMED_GAME_PROFILE_IDS,
  OVERWATCH_2_PROFILE,
  OVERWATCH_DEGREES_PER_COUNT_AT_ONE,
  PASS_2_GAME_PROFILE_IDS,
  PASS_3_GAME_PROFILE_IDS,
  PUBG_DEGREES_PER_COUNT_AT_ONE,
  PUBG_PROFILE,
  PUBLIC_GAME_PROFILES,
  RAINBOW_SIX_SIEGE_PROFILE,
  SIEGE_DEGREES_PER_COUNT_AT_ONE,
  SIEGE_NEUTRAL_ADS_VALUE,
  THE_FINALS_DEGREES_PER_COUNT_AT_ONE,
  THE_FINALS_PROFILE,
} from "../src/games/profiles/index.ts";

/**
 * The six public profiles of Game Profile Campaign Pass 3 (requirements
 * 3–8, 12–18).
 *
 * As in Pass 2, every asserted number is either derived from the profile's
 * own declared constant, or is a figure an independent reference publishes
 * (Overwatch's 37.89 / 51.47, the professional-settings cm/360 tables the
 * Pass 3 constants were fitted to).
 */

const CM_PER_INCH = 2.54;
const NEW = [
  OVERWATCH_2_PROFILE,
  RAINBOW_SIX_SIEGE_PROFILE,
  MARVEL_RIVALS_PROFILE,
  PUBG_PROFILE,
  THE_FINALS_PROFILE,
  BATTLEFIELD_6_PROFILE,
];
const CM_PER_360 = [8, 15, 22.3, 34.5, 45, 60, 91.7];
const DPIS = [400, 800, 1200, 1600, 3200];

function expectedCm(degPerCountAtOne: number, value: number, dpi: number): number {
  return (360 / (degPerCountAtOne * value * dpi)) * CM_PER_INCH;
}

function mutate(base: GameProfile, patch: (draft: Record<string, unknown>) => void): GameProfile {
  const draft = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  patch(draft);
  return draft as unknown as GameProfile;
}

const tan = (deg: number): number => Math.tan((deg * Math.PI) / 360);

// ---------------------------------------------------------------------------
// Overwatch 2
// ---------------------------------------------------------------------------

describe("Overwatch 2", () => {
  it("known sensitivity + DPI → canonical physical result", () => {
    const aim = canonicalFromGameSettings(OVERWATCH_2_PROFILE, 800, { hipfire: 5 });
    expect(cmPer360X(aim)).toBeCloseTo(expectedCm(OVERWATCH_DEGREES_PER_COUNT_AT_ONE, 5, 800), 9);
    expect(cmPer360X(aim)).toBeCloseTo(34.64, 1);
    // Shares Call of Duty's constant: equal values are equal physical aims.
    const cod = canonicalFromGameSettings(GAME_PROFILE_REGISTRY.require("call-of-duty-warzone"), 800, { hipfire: 5 });
    expect(maxRelativeDifference(aim, cod)).toBeLessThan(1e-12);
  });

  it("converts to two decimals and round-trips", () => {
    const conversion = gameSettingsFromCanonical(OVERWATCH_2_PROFILE, canonicalFromCmPer360(30), { dpi: 800 });
    expect(conversion.hipfire.value.exact).toBeCloseTo(5.7727, 3);
    expect(conversion.hipfire.value.ui).toBe(5.77);
    for (const cm of CM_PER_360) {
      for (const dpi of DPIS) {
        const result = roundTrip(OVERWATCH_2_PROFILE, canonicalFromCmPer360(cm), { dpi });
        expect(result.withinTolerance, `${cm}cm @${dpi}`).toBe(true);
        expect(result.verticalExpressible).toBe(false);
      }
    }
  });

  it("clamps to 1.00 and 100.00", () => {
    const tooSlow = gameSettingsFromCanonical(OVERWATCH_2_PROFILE, canonicalFromCmPer360(5000), { dpi: 400 });
    expect(tooSlow.hipfire.value.clampedToMin).toBe(true);
    const tooFast = gameSettingsFromCanonical(OVERWATCH_2_PROFILE, canonicalFromCmPer360(0.3), { dpi: 3200 });
    expect(tooFast.hipfire.value.clampedToMax).toBe(true);
    expect(tooFast.hipfire.value.ui).toBe(100);
  });

  it("asks for the FOV slider, because the hero scoped FOVs do not move with it", () => {
    expect(OVERWATCH_2_PROFILE.fov).toMatchObject({
      kind: "configurable",
      axis: "horizontal-at-16-9",
      minDegrees: 80,
      maxDegrees: 103,
      stepDegrees: 0.5,
      affectsHipfireSensitivity: false,
    });
    expect(conversionUsesFov(OVERWATCH_2_PROFILE)).toBe(true);
    // Hip-fire itself is unaffected by the slider.
    const a = gameSettingsFromCanonical(OVERWATCH_2_PROFILE, canonicalFromCmPer360(30), { dpi: 800, fovDegrees: 80 });
    const b = gameSettingsFromCanonical(OVERWATCH_2_PROFILE, canonicalFromCmPer360(30), { dpi: 800, fovDegrees: 103 });
    expect(a.hipfire.value.ui).toBe(b.hipfire.value.ui);
  });

  it("reproduces the published FOV-relative relative-zoom values at 103 FOV", () => {
    const conversion = gameSettingsFromCanonical(OVERWATCH_2_PROFILE, canonicalFromCmPer360(30), {
      dpi: 800,
      matching: MATCHING.fovRelative,
    });
    const byId = Object.fromEntries(conversion.zooms.map((z) => [z.zoomId, z]));
    // Widowmaker / Ana 37.89, Ashe 51.47 — the numbers every OW guide quotes.
    expect(byId.widowmaker!.setting!.value.exact).toBeCloseTo(37.89, 2);
    expect(byId.ana!.setting!.value.exact).toBeCloseTo(37.89, 2);
    expect(byId.ashe!.setting!.value.exact).toBeCloseTo(51.47, 2);
    expect(byId.widowmaker!.setting!.value.exact).toBeCloseTo((tan(50.94) / tan(103)) * 100, 9);
    expect(byId.widowmaker!.setting!.display).toBe("37.89%");
    // Each hero has its own setting.
    expect(new Set(conversion.zooms.map((z) => z.setting!.field)).size).toBe(3);
  });

  it("the relative value is a pure multiplier: same physical sensitivity is 100%, game default 30%", () => {
    const physical = gameSettingsFromCanonical(OVERWATCH_2_PROFILE, canonicalFromCmPer360(30), {
      dpi: 800,
      matching: MATCHING.physical360,
    });
    for (const zoom of physical.zooms) {
      expect(zoom.setting!.value.ui).toBe(100);
      expect(zoom.achievedCmPer360).toBeCloseTo(physical.achievedCmPer360.x, 6);
    }
    const native = gameSettingsFromCanonical(OVERWATCH_2_PROFILE, canonicalFromCmPer360(30), {
      dpi: 800,
      matching: MATCHING.gameNative,
    });
    for (const zoom of native.zooms) expect(zoom.setting!.value.ui).toBe(30);
  });

  it("a lower FOV slider changes the FOV-relative value, as the profile says it must", () => {
    const at90 = gameSettingsFromCanonical(OVERWATCH_2_PROFILE, canonicalFromCmPer360(30), {
      dpi: 800,
      fovDegrees: 90,
      matching: MATCHING.fovRelative,
    });
    const widow = at90.zooms.find((z) => z.zoomId === "widowmaker")!;
    expect(widow.setting!.value.exact).toBeCloseTo((tan(50.94) / tan(90)) * 100, 9);
    expect(widow.setting!.value.exact).toBeGreaterThan(37.89);
  });
});

// ---------------------------------------------------------------------------
// Rainbow Six Siege
// ---------------------------------------------------------------------------

describe("Rainbow Six Siege", () => {
  it("known sensitivity + DPI → canonical physical result", () => {
    const aim = canonicalFromGameSettings(RAINBOW_SIX_SIEGE_PROFILE, 400, { hipfire: 12 });
    expect(cmPer360X(aim)).toBeCloseTo(expectedCm(SIEGE_DEGREES_PER_COUNT_AT_ONE, 12, 400), 9);
    // Shaiiko, 400 DPI, 12: 33.2 cm — the published figure the constant fits.
    expect(cmPer360X(aim)).toBeCloseTo(33.2, 0);
    // Pengu, 1600 DPI, 2: 49.9 cm.
    expect(cmPer360X(canonicalFromGameSettings(RAINBOW_SIX_SIEGE_PROFILE, 1600, { hipfire: 2 }))).toBeCloseTo(49.9, 0);
  });

  it("horizontal and vertical are separate whole numbers", () => {
    expect(RAINBOW_SIX_SIEGE_PROFILE.axes.independentAxes).toBe(true);
    expect(RAINBOW_SIX_SIEGE_PROFILE.hipfireField.entry.step).toBe(1);
    const aim = canonicalFromGameSettings(RAINBOW_SIX_SIEGE_PROFILE, 400, { hipfire: 12, vertical: 10 });
    expect(cmPer360Y(aim) / cmPer360X(aim)).toBeCloseTo(12 / 10, 9);
    const back = gameSettingsFromCanonical(RAINBOW_SIX_SIEGE_PROFILE, aim, { dpi: 400 });
    expect(back.hipfire.value.ui).toBe(12);
    expect(back.vertical?.value.ui).toBe(10);
    const conversion = gameSettingsFromCanonical(RAINBOW_SIX_SIEGE_PROFILE, canonicalFromCmPer360(30), { dpi: 800 });
    expect(conversion.hipfire.display).toBe("7");
    expect(conversion.hipfire.value.roundingLoss).toBe(true);
  });

  it("round-trips within the whole-number grid", () => {
    for (const cm of CM_PER_360) {
      for (const dpi of DPIS) {
        const result = roundTrip(RAINBOW_SIX_SIEGE_PROFILE, canonicalFromCmPer360(cm), { dpi });
        expect(result.withinTolerance, `${cm}cm @${dpi}: ${result.relativeError} > ${result.tolerance}`).toBe(true);
      }
    }
  });

  it("clamps to 1 and 100", () => {
    expect(gameSettingsFromCanonical(RAINBOW_SIX_SIEGE_PROFILE, canonicalFromCmPer360(2000), { dpi: 400 }).hipfire.value.clampedToMin).toBe(true);
    expect(gameSettingsFromCanonical(RAINBOW_SIX_SIEGE_PROFILE, canonicalFromCmPer360(0.4), { dpi: 3200 }).hipfire.value.clampedToMax).toBe(true);
    // A whole-number grid cannot "round" 0.54 up to 1 and call it rounding:
    // the exact value is below the floor and the profile says so.
    const belowFloor = gameSettingsFromCanonical(RAINBOW_SIX_SIEGE_PROFILE, canonicalFromCmPer360(91.7), { dpi: 3200 });
    expect(belowFloor.hipfire.value.exact).toBeLessThan(1);
    expect(belowFloor.hipfire.value.clampedToMin).toBe(true);
    expect(belowFloor.hipfire.value.ui).toBe(1);
  });

  it("uses a vertical FOV of 60–90 and asks for it", () => {
    expect(RAINBOW_SIX_SIEGE_PROFILE.fov).toMatchObject({ kind: "configurable", axis: "vertical", minDegrees: 60, maxDegrees: 90 });
    expect(conversionUsesFov(RAINBOW_SIX_SIEGE_PROFILE)).toBe(true);
    const resolved = resolveFovModel(RAINBOW_SIX_SIEGE_PROFILE.fov, 60, 16 / 9)!;
    expect(resolved.verticalDeg).toBeCloseTo(60, 9);
  });

  it("every optic's FOV is the hip-fire vertical FOV scaled by its factor", () => {
    const zooms = zoomLevelsOf(RAINBOW_SIX_SIEGE_PROFILE);
    expect(zooms.map((z) => z.id)).toEqual([
      "ads-1x", "ads-1-5x", "ads-2x", "ads-2-5x", "ads-3x", "ads-4x", "ads-5x", "ads-12x",
    ]);
    const factors = zooms.map((z) => (z.fov.kind === "scaled-from-hipfire" ? z.fov.factor : NaN));
    expect(factors).toEqual([0.9, 0.59, 0.49, 0.42, 0.35, 0.3, 0.22, 0.092]);
    const hip = resolveFov(60, "vertical", 16 / 9);
    expect(resolveScaledFov(0.9, hip).verticalDeg).toBeCloseTo(54, 9);
    expect(resolveFovModel(zooms[0]!.fov, null)).toBeNull();
  });

  it("50 is the game's own focal-length-scaled neutral: game default and FOV-relative agree", () => {
    for (const method of [MATCHING.gameNative, MATCHING.fovRelative]) {
      const conversion = gameSettingsFromCanonical(RAINBOW_SIX_SIEGE_PROFILE, canonicalFromCmPer360(30), {
        dpi: 800,
        matching: method,
      });
      for (const zoom of conversion.zooms) {
        expect(zoom.setting!.value.ui).toBe(SIEGE_NEUTRAL_ADS_VALUE);
      }
    }
  });

  it("same physical sensitivity needs 50 divided by each optic's tangent ratio, on the 1–200 grid", () => {
    const conversion = gameSettingsFromCanonical(RAINBOW_SIX_SIEGE_PROFILE, canonicalFromCmPer360(30), {
      dpi: 800,
      fovDegrees: 60,
      matching: MATCHING.physical360,
    });
    const oneX = conversion.zooms.find((z) => z.zoomId === "ads-1x")!;
    expect(oneX.setting!.value.exact).toBeCloseTo(50 / (tan(54) / tan(60)), 6);
    expect(oneX.setting!.value.ui).toBe(57);
    expect(oneX.achievedCmPer360).toBeCloseTo(conversion.achievedCmPer360.x, 0);
    // The 12× optic cannot reach it on a 200 cap, and the profile says so.
    const twelve = conversion.zooms.find((z) => z.zoomId === "ads-12x")!;
    expect(twelve.setting!.value.clampedToMax).toBe(true);
    expect(twelve.setting!.value.ui).toBe(200);
    expect(twelve.notes.join(" ")).not.toContain("DPI");
  });

  it("carries an official source for the ADS model and states the yaw dispute", () => {
    expect(RAINBOW_SIX_SIEGE_PROFILE.source.type).toBe("official-documentation");
    expect(RAINBOW_SIX_SIEGE_PROFILE.source.url).toContain("ubisoft.com");
    expect(RAINBOW_SIX_SIEGE_PROFILE.source.uncertaintyNotes.join(" ")).toContain("0.00223");
  });
});

// ---------------------------------------------------------------------------
// Marvel Rivals
// ---------------------------------------------------------------------------

describe("Marvel Rivals", () => {
  it("known sensitivity + DPI → canonical physical result", () => {
    const aim = canonicalFromGameSettings(MARVEL_RIVALS_PROFILE, 800, { hipfire: 3.5 });
    expect(cmPer360X(aim)).toBeCloseTo(expectedCm(MARVEL_RIVALS_DEGREES_PER_COUNT_AT_ONE, 3.5, 800), 9);
    // Published: Felix, 800 DPI, 3.5 → 18.6 cm; dafran, 1600 DPI, 1.7 → 19.1 cm.
    expect(cmPer360X(aim)).toBeCloseTo(18.7, 0);
    expect(cmPer360X(canonicalFromGameSettings(MARVEL_RIVALS_PROFILE, 1600, { hipfire: 1.7 }))).toBeCloseTo(19.1, 0);
    // π/180 exactly, as the profile says.
    expect(MARVEL_RIVALS_DEGREES_PER_COUNT_AT_ONE).toBeCloseTo(Math.PI / 180, 5);
  });

  it("converts to two decimals, round-trips, and links both axes", () => {
    const conversion = gameSettingsFromCanonical(MARVEL_RIVALS_PROFILE, canonicalFromCmPer360(30), { dpi: 800 });
    expect(conversion.hipfire.value.ui).toBe(2.18);
    expect(conversion.vertical).toBeNull();
    for (const cm of CM_PER_360) {
      for (const dpi of DPIS) {
        expect(roundTrip(MARVEL_RIVALS_PROFILE, canonicalFromCmPer360(cm), { dpi }).withinTolerance).toBe(true);
      }
    }
  });

  it("models no FOV, no zoom, and only physical matching", () => {
    expect(MARVEL_RIVALS_PROFILE.fov.kind).toBe("none");
    expect(MARVEL_RIVALS_PROFILE.zoom.kind).toBe("none");
    expect(availableMatching(MARVEL_RIVALS_PROFILE)).toEqual([MATCHING.physical360]);
    expect(MARVEL_RIVALS_PROFILE.knownEdgeCases.join(" ")).toContain("Black Widow");
    expect(MARVEL_RIVALS_PROFILE.source.uncertaintyNotes.join(" ")).toContain("0.022");
    expect(MARVEL_RIVALS_PROFILE.source.confidence).toBe("moderate");
  });
});

// ---------------------------------------------------------------------------
// PUBG
// ---------------------------------------------------------------------------

describe("PUBG: Battlegrounds", () => {
  it("known sensitivity + DPI → canonical physical result at the reference FOV", () => {
    const aim = canonicalFromGameSettings(PUBG_PROFILE, 800, { hipfire: 25 });
    expect(cmPer360X(aim)).toBeCloseTo(expectedCm(PUBG_DEGREES_PER_COUNT_AT_ONE, 25, 800), 9);
    // chocoTaco, 800 DPI, 25 → 20.6 cm.
    expect(cmPer360X(aim)).toBeCloseTo(20.6, 0);
  });

  it("scales hip-fire with the FOV slider and says the conversion is for that FOV", () => {
    expect(hipfireFovFactor(PUBG_PROFILE.fov, 103)).toBeCloseTo(103 / 80, 12);
    expect(hipfireFovFactor(PUBG_PROFILE.fov, null)).toBe(1);
    expect(hipfireFovFactor(FORTNITE_PROFILE.fov, 90)).toBe(1);
    const at80 = canonicalFromGameSettings(PUBG_PROFILE, 800, { hipfire: 25, fovDegrees: 80 });
    const at103 = canonicalFromGameSettings(PUBG_PROFILE, 800, { hipfire: 25, fovDegrees: 103 });
    expect(at103.degreesPerCmX / at80.degreesPerCmX).toBeCloseTo(103 / 80, 12);
    const back = gameSettingsFromCanonical(PUBG_PROFILE, at103, { dpi: 800, fovDegrees: 103 });
    expect(back.hipfire.value.ui).toBe(25);
    expect(back.warnings.join(" ")).toContain("103°");
    expect(conversionUsesFov(PUBG_PROFILE)).toBe(true);
    for (const fov of [80, 90, 103]) {
      for (const dpi of DPIS) {
        expect(roundTrip(PUBG_PROFILE, canonicalFromCmPer360(30), { dpi, fovDegrees: fov }).withinTolerance).toBe(true);
      }
    }
  });

  it("is experimental, and every conversion says so", () => {
    expect(PUBG_PROFILE.status).toBe("experimental");
    expect(PUBG_PROFILE.source.confidence).toBe("low");
    const conversion = gameSettingsFromCanonical(PUBG_PROFILE, canonicalFromCmPer360(30), { dpi: 800 });
    expect(conversion.warnings.join(" ")).toContain("experimental");
    expect(conversion.hipfire.value.ui).toBe(17);
  });

  it("does not collapse its other controls into the general value", () => {
    expect(PUBG_PROFILE.zoom.kind).toBe("none");
    expect(PUBG_PROFILE.knownEdgeCases.join(" ")).toContain("Targeting, ADS and the per-scope sliders");
    expect(PUBG_PROFILE.knownEdgeCases.join(" ")).toContain("vertical sensitivity multiplier");
  });
});

// ---------------------------------------------------------------------------
// The Finals
// ---------------------------------------------------------------------------

describe("The Finals", () => {
  it("known sensitivity + DPI → canonical physical result", () => {
    const aim = canonicalFromGameSettings(THE_FINALS_PROFILE, 800, { hipfire: 40 });
    expect(cmPer360X(aim)).toBeCloseTo(expectedCm(THE_FINALS_DEGREES_PER_COUNT_AT_ONE, 40, 800), 9);
    // Published: commit, 800 DPI, 26 → 43.6 cm; UNI, 800 DPI, 38 → 29.8 cm.
    expect(cmPer360X(canonicalFromGameSettings(THE_FINALS_PROFILE, 800, { hipfire: 26 }))).toBeCloseTo(43.6, 0);
    expect(cmPer360X(canonicalFromGameSettings(THE_FINALS_PROFILE, 800, { hipfire: 38 }))).toBeCloseTo(29.8, 0);
  });

  it("is a whole number from 1 to 100 that round-trips within its grid", () => {
    const conversion = gameSettingsFromCanonical(THE_FINALS_PROFILE, canonicalFromCmPer360(30), { dpi: 800 });
    expect(conversion.hipfire.value.exact).toBeCloseTo(38.1, 1);
    expect(conversion.hipfire.value.ui).toBe(38);
    for (const cm of CM_PER_360) {
      for (const dpi of DPIS) {
        expect(roundTrip(THE_FINALS_PROFILE, canonicalFromCmPer360(cm), { dpi }).withinTolerance).toBe(true);
      }
    }
  });

  it("offers only the game's own zoom relationship, and does not pretend to know the zoomed rotation", () => {
    expect(availableMatching(THE_FINALS_PROFILE)).toEqual([MATCHING.gameNative]);
    const conversion = gameSettingsFromCanonical(THE_FINALS_PROFILE, canonicalFromCmPer360(30), { dpi: 800 });
    const zoom = conversion.zooms[0]!;
    expect(zoom.setting!.display).toBe("100%");
    expect(zoom.achievedCmPer360).toBeNull();
    expect(zoom.notes.join(" ")).toContain("focal-length");
    expect(() =>
      gameSettingsFromCanonical(THE_FINALS_PROFILE, canonicalFromCmPer360(30), {
        dpi: 800,
        matching: MATCHING.physical360,
      }),
    ).toThrow(ConversionError);
  });
});

// ---------------------------------------------------------------------------
// Battlefield 6
// ---------------------------------------------------------------------------

describe("Battlefield 6", () => {
  it("is named for the one title it supports", () => {
    expect(BATTLEFIELD_6_PROFILE.displayName).toBe("Battlefield 6");
    expect(BATTLEFIELD_6_PROFILE.id).toBe("battlefield-6");
    expect(BATTLEFIELD_6_PROFILE.knownEdgeCases.join(" ")).toContain("Battlefield 2042 and earlier");
    expect(BATTLEFIELD_6_PROFILE.status).toBe("experimental");
  });

  it("reproduces the one published measurement it is built on", () => {
    const aim = canonicalFromGameSettings(BATTLEFIELD_6_PROFILE, 1600, { hipfire: 6 });
    expect(cmPer360X(aim)).toBeCloseTo(37.98, 1);
    expect(cmPer360X(aim)).toBeCloseTo(expectedCm(BATTLEFIELD_6_DEGREES_PER_COUNT_AT_ONE, 6, 1600), 9);
  });

  it("uses the 0.1-step menu grid and round-trips", () => {
    const conversion = gameSettingsFromCanonical(BATTLEFIELD_6_PROFILE, canonicalFromCmPer360(30), { dpi: 800 });
    expect(conversion.hipfire.value.exact).toBeCloseTo(15.19, 2);
    expect(conversion.hipfire.value.ui).toBe(15.2);
    expect(conversion.hipfire.value.config).toBeNull();
    for (const cm of CM_PER_360) {
      for (const dpi of DPIS) {
        expect(roundTrip(BATTLEFIELD_6_PROFILE, canonicalFromCmPer360(cm), { dpi }).withinTolerance).toBe(true);
      }
    }
  });

  it("translates the philosophy into the Uniform Soldier Aiming coefficient, in percent", () => {
    const run = (matching: typeof MATCHING.fovRelative) =>
      gameSettingsFromCanonical(BATTLEFIELD_6_PROFILE, canonicalFromCmPer360(30), { dpi: 800, matching }).zooms[0]!;
    expect(run(MATCHING.fovRelative).setting!.display).toBe("0.0%");
    const edge = run(MATCHING.monitorDistance100);
    expect(edge.setting!.value.exact).toBeCloseTo((16 / 9) * 100, 6);
    expect(edge.setting!.display).toBe("177.8%");
    expect(run(MATCHING.gameNative).setting!.value.ui).toBe(BATTLEFIELD_6_DEFAULT_COEFFICIENT * 100);
    expect(edge.achievedCmPer360).toBeNull();
    expect(availableMatching(BATTLEFIELD_6_PROFILE).map((m) => m.kind)).not.toContain("physical-360-distance");
    expect(() =>
      gameSettingsFromCanonical(BATTLEFIELD_6_PROFILE, canonicalFromCmPer360(30), { dpi: 800, matching: MATCHING.physical360 }),
    ).toThrow(ConversionError);
  });

  it("declares its FOV slider without reading it", () => {
    expect(BATTLEFIELD_6_PROFILE.fov).toMatchObject({ kind: "configurable", axis: "horizontal", affectsHipfireSensitivity: false });
    expect(conversionUsesFov(BATTLEFIELD_6_PROFILE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Metadata, fail-closed, and the cross-profile chain
// ---------------------------------------------------------------------------

describe("metadata on every Pass 3 profile", () => {
  it.each(NEW.map((p) => [p.id, p] as const))("%s", (_id, profile) => {
    expect(profile.profileVersion).toBe(1);
    expect(profile.visibility).toBe("public");
    expect(profile.source.verifiedAtIso).toBe("2026-09-08");
    expect(profile.source.url).toMatch(/^https:\/\//);
    expect(profile.source.gameVersion).toMatch(/2026|2025/);
    expect(profile.source.uncertaintyNotes.length).toBeGreaterThan(0);
    expect(["verified", "partially-verified", "experimental"]).toContain(profile.status);
    expect(profile.unitDefinition).toMatch(/DPI/);
    expect(validateGameProfile(profile)).toMatchObject({ valid: true });
    expect(PASS_3_GAME_PROFILE_IDS).toContain(profile.id);
  });

  it("the worked example in each unit definition is arithmetically true", () => {
    const cases: [GameProfile, number, number, number][] = [
      [OVERWATCH_2_PROFILE, 5, 800, 34.6],
      [RAINBOW_SIX_SIEGE_PROFILE, 12, 400, 33.2],
      [MARVEL_RIVALS_PROFILE, 3.5, 800, 18.7],
      [PUBG_PROFILE, 25, 800, 20.6],
      [THE_FINALS_PROFILE, 40, 800, 28.6],
      [BATTLEFIELD_6_PROFILE, 6, 1600, 38.0],
    ];
    for (const [profile, value, dpi, cm] of cases) {
      expect(profile.unitDefinition).toContain(`${cm.toFixed(1)} cm`);
      expect(cmPer360X(canonicalFromGameSettings(profile, dpi, { hipfire: value }))).toBeCloseTo(cm, 1);
    }
  });

  it("no experimental profile reads as verified anywhere in its export", () => {
    for (const profile of [PUBG_PROFILE, BATTLEFIELD_6_PROFILE]) {
      const exported = buildGameRecommendationExport({
        profile,
        dpi: 800,
        recommended: { aim: canonicalFromCmPer360(30), derivation: "game-profile", basis: "test" },
        current: null,
      });
      expect(exported.profileStatus).toBe("experimental");
      expect(exported.warnings.join(" ")).toContain("experimental");
      expect(exported.provenance.confidence).not.toBe("exact");
    }
  });

  it("the current-settings import works for every new game before any calibration", () => {
    const cases: [GameProfile, number][] = [
      [OVERWATCH_2_PROFILE, 5],
      [RAINBOW_SIX_SIEGE_PROFILE, 12],
      [MARVEL_RIVALS_PROFILE, 3.5],
      [PUBG_PROFILE, 25],
      [THE_FINALS_PROFILE, 40],
      [BATTLEFIELD_6_PROFILE, 15],
    ];
    for (const [profile, value] of cases) {
      const imported = importCurrentSensitivity(profile, 800, { hipfire: value });
      expect(imported.profileVersion).toBe(1);
      expect(imported.cmPer360X).toBeGreaterThan(10);
      expect(imported.cmPer360X).toBeLessThan(60);
    }
  });
});

describe("fail-closed behaviour on the Pass 3 profiles", () => {
  it.each(NEW.map((p) => [p.id, p] as const))("%s refuses malformed variants", (_id, profile) => {
    const broken: [string, GameProfile][] = [
      ["zero yaw", mutate(profile, (d) => { (d.sensitivityModel as Record<string, unknown>).yawDegreesPerCountAtOne = 0; })],
      ["inverted range", mutate(profile, (d) => { ((d.hipfireField as Record<string, unknown>).entry as Record<string, unknown>).min = 1e6; })],
      ["version zero", mutate(profile, (d) => { d.profileVersion = 0; })],
      ["foreign schema", mutate(profile, (d) => { d.schemaVersion = 9; })],
      ["bad date", mutate(profile, (d) => { (d.source as Record<string, unknown>).verifiedAtIso = "yesterday"; })],
      ["verified on low confidence", mutate(profile, (d) => { d.status = "verified"; (d.source as Record<string, unknown>).confidence = "low"; })],
      ["unknown matching", mutate(profile, (d) => { d.supportedMatching = ["vibes"]; })],
    ];
    for (const [what, bad] of broken) {
      expect(validateGameProfile(bad).valid, what).toBe(false);
      expect(GameProfileRegistry.tryCreate([bad]).registry, what).toBeNull();
    }
  });

  it("refuses impossible FOV, a scaled zoom without a hip-fire FOV, and hip-fire scaling without the flag", () => {
    const badFov = mutate(RAINBOW_SIX_SIEGE_PROFILE, (d) => { (d.fov as Record<string, unknown>).maxDegrees = 200; });
    expect(validateGameProfile(badFov).issues.map((i) => i.path)).toContain("fov.maxDegrees");
    const badFactor = mutate(RAINBOW_SIX_SIEGE_PROFILE, (d) => {
      (((d.zoom as Record<string, unknown>).zooms as Record<string, unknown>[])[0]!.fov as Record<string, unknown>).factor = 1.5;
    });
    expect(validateGameProfile(badFactor).issues.map((i) => i.path)).toContain("zoom[0].fov.factor");
    const noHip = mutate(RAINBOW_SIX_SIEGE_PROFILE, (d) => {
      d.fov = { kind: "none" };
      d.supportedMatching = ["game-native"];
      d.defaultMatching = { kind: "game-native" };
    });
    expect(validateGameProfile(noHip).issues.map((i) => i.path)).toContain("zoom[0].fov");
    const scaledHip = mutate(PUBG_PROFILE, (d) => { d.fov = { kind: "scaled-from-hipfire", factor: 0.5 }; });
    expect(validateGameProfile(scaledHip).issues.map((i) => i.path)).toContain("fov.kind");
    const noFlag = mutate(PUBG_PROFILE, (d) => { (d.fov as Record<string, unknown>).affectsHipfireSensitivity = false; });
    expect(validateGameProfile(noFlag).issues.map((i) => i.path)).toContain("fov.hipfireScaling");
  });

  it("a focal-length zoom without a FOV is allowed only when the game's own default is the sole philosophy", () => {
    const widened = mutate(THE_FINALS_PROFILE, (d) => {
      d.supportedMatching = ["physical-360-distance", "game-native"];
    });
    expect(validateGameProfile(widened).issues.map((i) => i.path)).toContain("zoom[0].fov");
  });

  it("refuses conversion input it cannot honour", () => {
    expect(() => canonicalFromGameSettings(OVERWATCH_2_PROFILE, 0, { hipfire: 5 })).toThrow(ConversionError);
    expect(() => canonicalFromGameSettings(OVERWATCH_2_PROFILE, 800, { hipfire: -1 })).toThrow(ConversionError);
    expect(() => canonicalFromGameSettings(THE_FINALS_PROFILE, Number.NaN, { hipfire: 40 })).toThrow(ConversionError);
    // An impossible monitor-distance coefficient never becomes a number under
    // that philosophy: every optic is warned about and left at the game's own
    // value instead.
    const impossible = gameSettingsFromCanonical(RAINBOW_SIX_SIEGE_PROFILE, canonicalFromCmPer360(30), {
      dpi: 800,
      matching: { kind: "monitor-distance", coefficient: 3, axis: "horizontal" },
    });
    expect(impossible.warnings.filter((w) => w.includes("coefficient")).length).toBe(impossible.zooms.length);
    for (const zoom of impossible.zooms) {
      expect(zoom.setting!.value.ui).toBe(SIEGE_NEUTRAL_ADS_VALUE);
      expect(zoom.notes.join(" ")).toContain("game's own default");
    }
  });
});

describe("cross-profile equivalence through the canonical representation (Pass 3 chain)", () => {
  const chain: [GameProfile, number, GameProfile][] = [
    [OVERWATCH_2_PROFILE, 5, RAINBOW_SIX_SIEGE_PROFILE],
    [RAINBOW_SIX_SIEGE_PROFILE, 12, MARVEL_RIVALS_PROFILE],
    [MARVEL_RIVALS_PROFILE, 3.5, PUBG_PROFILE],
    [PUBG_PROFILE, 25, THE_FINALS_PROFILE],
    [THE_FINALS_PROFILE, 40, BATTLEFIELD_6_PROFILE],
    [BATTLEFIELD_6_PROFILE, 15, FORTNITE_PROFILE],
  ];

  it.each(chain.map(([a, v, b]) => [a.id, b.id, a, v, b] as const))(
    "%s → canonical → %s preserves the physical sensitivity to within the target's own grid",
    (_a, _b, from, value, to) => {
      for (const dpi of [400, 800, 1600]) {
        const canonical = canonicalFromGameSettings(from, dpi, { hipfire: value });
        const converted = gameSettingsFromCanonical(to, canonical, { dpi });
        expect(converted.requestedCmPer360.x).toBeCloseTo(cmPer360X(canonical), 9);
        expect(converted.roundingErrorFraction).toBeLessThanOrEqual(converted.roundTripTolerance);
        const recovered = canonicalFromGameSettings(to, dpi, {
          hipfire: converted.hipfire.value.ui,
          vertical: converted.vertical?.value.ui ?? null,
        });
        expect(maxRelativeDifference(recovered, canonical)).toBeLessThanOrEqual(converted.roundTripTolerance);
      }
    },
  );

  it("the ratios between constants are what the references publish", () => {
    const ow = canonicalFromGameSettings(OVERWATCH_2_PROFILE, 800, { hipfire: 5 });
    // The Finals is 6.6× Overwatch's number for the same aim.
    expect(gameSettingsFromCanonical(THE_FINALS_PROFILE, ow, { dpi: 800 }).hipfire.value.exact).toBeCloseTo(33, 6);
    // Siege is Overwatch × 0.0066 / 0.00572958.
    expect(gameSettingsFromCanonical(RAINBOW_SIX_SIEGE_PROFILE, ow, { dpi: 800 }).hipfire.value.exact).toBeCloseTo(5 * 0.0066 / 0.00572958, 6);
    // Marvel Rivals is Overwatch × 0.0066 / (π/180).
    expect(gameSettingsFromCanonical(MARVEL_RIVALS_PROFILE, ow, { dpi: 800 }).hipfire.value.exact).toBeCloseTo(5 * 0.0066 / 0.017453, 5);
  });

  it("the twelve-profile chain returns to where it started within the coarsest grid", () => {
    let aim = canonicalFromGameSettings(FORTNITE_PROFILE, 800, { hipfire: 8 });
    const start = aim;
    for (const profile of PUBLIC_GAME_PROFILES) {
      const converted = gameSettingsFromCanonical(profile, aim, { dpi: 800 });
      aim = canonicalFromGameSettings(profile, 800, {
        hipfire: converted.hipfire.value.ui,
        vertical: converted.vertical?.value.ui ?? null,
      });
    }
    expect(maxRelativeDifference(aim, start)).toBeLessThan(0.08);
  });

  it("no profile file knows another game, and the picker order is alphabetical with the control last", () => {
    expect(NAMED_GAME_PROFILE_IDS).toHaveLength(11);
    expect(new Set([...PASS_2_GAME_PROFILE_IDS, ...PASS_3_GAME_PROFILE_IDS])).toEqual(new Set(NAMED_GAME_PROFILE_IDS));
    const names = PUBLIC_GAME_PROFILES.slice(0, -1).map((p) => p.displayName);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
    expect(PUBLIC_GAME_PROFILES.at(-1)!.id).toBe("generic-raw");
  });
});
