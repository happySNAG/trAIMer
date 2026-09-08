import { describe, expect, it } from "vitest";
import {
  canonicalFromCmPer360,
  cmPer360X,
  maxRelativeDifference,
} from "../src/games/canonical.ts";
import {
  canonicalFromGameSettings,
  gameSettingsFromCanonical,
  roundTrip,
} from "../src/games/convert.ts";
import {
  DEFAULT_ASPECT_RATIO,
  horizontalToVertical,
  resolveFov,
  resolveFovModel,
  verticalToHorizontal,
} from "../src/games/fov.ts";
import {
  MATCHING,
  MatchingError,
  describeMatching,
  fovFromMagnification,
  zoomSensitivityRatio,
} from "../src/games/matching.ts";
import { GENERIC_RAW_PROFILE } from "../src/games/profiles/generic.ts";
import {
  ARCHITECTURE_FIXTURE_PROFILES,
  FIXTURE_INDEPENDENT_CONTINUOUS,
  FIXTURE_LINKED_STEPPED,
  FIXTURE_PER_SCOPE,
  FIXTURE_POWER_LAW,
} from "../src/games/fixtures.ts";

/**
 * Round-trip accuracy (Game Profile Pass 1, requirement 16).
 *
 * `canonical → profile → canonical` must land inside the tolerance the
 * profile's OWN entry grid allows, across low / typical / high sensitivity,
 * several DPIs, both axis models, stepped and continuous entry, and a
 * non-linear scale.
 */

const PROFILES = [GENERIC_RAW_PROFILE, ...ARCHITECTURE_FIXTURE_PROFILES];
const CM_PER_360 = [8, 15, 22.3, 34.5, 45, 60, 91.7, 150];
const DPIS = [400, 800, 1200, 1600, 3200, 6400];

describe("round trip — the full matrix", () => {
  it("stays inside each profile's declared tolerance at every sensitivity and DPI", () => {
    const failures: string[] = [];
    for (const profile of PROFILES) {
      for (const cm of CM_PER_360) {
        for (const dpi of DPIS) {
          const result = roundTrip(profile, canonicalFromCmPer360(cm), { dpi });
          if (!result.withinTolerance) {
            failures.push(
              `${profile.id} @${dpi} ${cm}cm: ${result.relativeError} > ${result.tolerance}`,
            );
          }
          // The inverse is always exactly the inverse, clamping included.
          expect(result.inverseConsistent, `${profile.id} @${dpi} ${cm}cm`).toBe(true);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("round-trips an asymmetric aim on profiles that can express one", () => {
    for (const profile of [
      GENERIC_RAW_PROFILE,
      FIXTURE_INDEPENDENT_CONTINUOUS,
      FIXTURE_POWER_LAW,
    ]) {
      for (const dpi of DPIS) {
        const result = roundTrip(profile, canonicalFromCmPer360(30, 42), { dpi });
        expect(result.verticalExpressible).toBe(true);
        expect(
          result.withinTolerance,
          `${profile.id} @${dpi}: ${result.relativeError} > ${result.tolerance}`,
        ).toBe(true);
      }
    }
  });

  it("marks the vertical axis inexpressible on a single-slider game", () => {
    const result = roundTrip(FIXTURE_LINKED_STEPPED, canonicalFromCmPer360(30), {
      dpi: 800,
    });
    expect(result.verticalExpressible).toBe(false);
    expect(result.withinTolerance).toBe(true);
  });

  it("reports clamping instead of pretending a boundary value round-trips", () => {
    const tooFast = roundTrip(FIXTURE_LINKED_STEPPED, canonicalFromCmPer360(0.5), {
      dpi: 400,
    });
    expect(tooFast.clamped).toBe(true);
    const tooSlow = roundTrip(FIXTURE_LINKED_STEPPED, canonicalFromCmPer360(9000), {
      dpi: 3200,
    });
    expect(tooSlow.clamped).toBe(true);
  });

  it("is exact on the continuous control profile to within float precision", () => {
    // The generic profile's grid is fine enough that the error is a fraction
    // of a percent of a percent, at every DPI.
    for (const dpi of DPIS) {
      const result = roundTrip(GENERIC_RAW_PROFILE, canonicalFromCmPer360(34.5), { dpi });
      expect(result.relativeError).toBeLessThan(1e-3);
    }
  });

  it("survives min and max boundary values on a stepped profile", () => {
    const entry = FIXTURE_LINKED_STEPPED.hipfireField.entry;
    for (const value of [entry.min, entry.max, entry.min + entry.step!, entry.max - entry.step!]) {
      const aim = canonicalFromGameSettings(FIXTURE_LINKED_STEPPED, 800, { hipfire: value });
      const back = gameSettingsFromCanonical(FIXTURE_LINKED_STEPPED, aim, { dpi: 800 });
      expect(back.hipfire.value.ui).toBeCloseTo(value, 6);
    }
  });

  it("round-trips through the game's own units, not just through cm/360", () => {
    for (const value of [0.5, 1.5, 6.3, 24.9, 49.9]) {
      const aim = canonicalFromGameSettings(FIXTURE_LINKED_STEPPED, 1600, {
        hipfire: value,
      });
      const back = gameSettingsFromCanonical(FIXTURE_LINKED_STEPPED, aim, { dpi: 1600 });
      expect(back.hipfire.value.ui).toBeCloseTo(value, 6);
      expect(back.hipfire.value.roundingLoss).toBe(false);
    }
  });

  it("never reports a unit mismatch as a small error", () => {
    // A deliberate inches/centimetres slip would show up as a factor of 2.54.
    const aim = canonicalFromCmPer360(34.5);
    const conversion = gameSettingsFromCanonical(GENERIC_RAW_PROFILE, aim, { dpi: 800 });
    const wrongUnits = canonicalFromCmPer360(34.5 / 2.54);
    expect(
      conversion.achieved.degreesPerCmX / wrongUnits.degreesPerCmX,
    ).toBeCloseTo(1 / 2.54, 4);
    expect(maxRelativeDifference(conversion.achieved, wrongUnits)).toBeGreaterThan(0.5);
  });
});

describe("FOV maths (requirement 7)", () => {
  it("horizontal and vertical conversions are exact inverses", () => {
    for (const aspect of [4 / 3, 16 / 10, 16 / 9, 21 / 9, 32 / 9]) {
      for (const h of [70, 90, 103, 120]) {
        expect(verticalToHorizontal(horizontalToVertical(h, aspect), aspect)).toBeCloseTo(
          h,
          9,
        );
      }
    }
  });

  it("a 4:3-quoted horizontal FOV widens on a 16:9 display", () => {
    const resolved = resolveFov(90, "horizontal-at-4-3", 16 / 9);
    expect(resolved.statedDeg).toBe(90);
    expect(resolved.horizontalDeg).toBeGreaterThan(90);
    // The vertical angle is the one the engine preserves.
    expect(resolved.verticalDeg).toBeCloseTo(horizontalToVertical(90, 4 / 3), 9);
  });

  it("a vertical FOV is unchanged by the display aspect", () => {
    for (const aspect of [16 / 9, 21 / 9]) {
      expect(resolveFov(60, "vertical", aspect).verticalDeg).toBeCloseTo(60, 12);
    }
  });

  it("refuses angles outside (0, 180)", () => {
    expect(() => resolveFov(0, "horizontal")).toThrow(RangeError);
    expect(() => resolveFov(180, "horizontal")).toThrow(RangeError);
    expect(() => resolveFov(90, "horizontal", 0)).toThrow(RangeError);
  });

  it("resolves nothing for a profile with no FOV model", () => {
    expect(resolveFovModel({ kind: "none" }, 90)).toBeNull();
    expect(resolveFovModel(FIXTURE_LINKED_STEPPED.fov, null)?.statedDeg).toBe(90);
    expect(resolveFovModel(FIXTURE_LINKED_STEPPED.fov, 300)?.statedDeg).toBe(120);
  });

  it("derives a scope FOV from magnification the way an optic behaves", () => {
    const hip = resolveFov(90, "horizontal", DEFAULT_ASPECT_RATIO);
    const twoX = fovFromMagnification(hip, 2);
    const tan = (deg: number): number => Math.tan((deg * Math.PI) / 360);
    expect(tan(twoX.horizontalDeg)).toBeCloseTo(tan(hip.horizontalDeg) / 2, 9);
    expect(() => fovFromMagnification(hip, 0)).toThrow(MatchingError);
  });
});

describe("matching philosophies (requirement 6)", () => {
  const hip = resolveFov(103, "horizontal");
  const scope = resolveFov(30, "horizontal");
  const tan = (deg: number): number => Math.tan((deg * Math.PI) / 360);

  it("physical-360 matching is a ratio of exactly one", () => {
    expect(zoomSensitivityRatio(MATCHING.physical360, hip, scope)).toBe(1);
  });

  it("game-native matching has no externally computed ratio", () => {
    expect(zoomSensitivityRatio(MATCHING.gameNative, hip, scope)).toBeNull();
  });

  it("FOV-relative matching is the tangent ratio", () => {
    expect(zoomSensitivityRatio(MATCHING.fovRelative, hip, scope)).toBeCloseTo(
      tan(30) / tan(103),
      12,
    );
  });

  it("monitor distance approaches the tangent ratio as the coefficient goes to zero", () => {
    const limit = tan(30) / tan(103);
    let previous = Number.POSITIVE_INFINITY;
    for (const c of [1, 0.5, 0.1, 0.01, 0.001]) {
      const ratio = zoomSensitivityRatio(
        { kind: "monitor-distance", coefficient: c, axis: "horizontal" },
        hip,
        scope,
      )!;
      const distance = Math.abs(ratio - limit);
      expect(distance).toBeLessThan(previous);
      previous = distance;
    }
    expect(previous).toBeLessThan(1e-5);
  });

  it("100% monitor distance is a different, larger answer than FOV-relative", () => {
    const mdh = zoomSensitivityRatio(MATCHING.monitorDistance100, hip, scope)!;
    const focal = zoomSensitivityRatio(MATCHING.fovRelative, hip, scope)!;
    expect(mdh).toBeGreaterThan(focal);
    expect(mdh).toBeLessThan(1);
  });

  it("matches on the requested axis", () => {
    const horizontal = zoomSensitivityRatio(
      { kind: "monitor-distance", coefficient: 1, axis: "horizontal" },
      hip,
      scope,
    )!;
    const vertical = zoomSensitivityRatio(
      { kind: "monitor-distance", coefficient: 1, axis: "vertical" },
      hip,
      scope,
    )!;
    expect(horizontal).not.toBeCloseTo(vertical, 6);
  });

  it("refuses to invent an FOV equivalence when the profile has none", () => {
    expect(() => zoomSensitivityRatio(MATCHING.fovRelative, null, scope)).toThrow(
      MatchingError,
    );
    expect(() =>
      zoomSensitivityRatio(
        { kind: "monitor-distance", coefficient: 2, axis: "horizontal" },
        hip,
        scope,
      ),
    ).toThrow(MatchingError);
  });

  it("describes every philosophy in player language", () => {
    for (const method of [
      MATCHING.physical360,
      MATCHING.fovRelative,
      MATCHING.monitorDistance100,
      MATCHING.gameNative,
    ]) {
      const described = describeMatching(method);
      expect(described.label.length).toBeGreaterThan(0);
      expect(described.detail.length).toBeGreaterThan(0);
      // No conversion-engine jargon in the default wording (requirement 22).
      expect(described.label).not.toContain("deg/count");
      expect(described.label).not.toContain("canonical");
    }
  });

  it("keeps every optic at the same cm/360 under physical-360 matching", () => {
    const aim = canonicalFromCmPer360(30);
    const conversion = gameSettingsFromCanonical(FIXTURE_PER_SCOPE, aim, {
      dpi: 800,
      fovDegrees: 60,
      matching: MATCHING.physical360,
    });
    for (const zoom of conversion.zooms) {
      if (zoom.setting?.value.clampedToMax || zoom.setting?.value.clampedToMin) continue;
      expect(zoom.achievedCmPer360! / conversion.achievedCmPer360.x).toBeCloseTo(1, 1);
    }
    expect(cmPer360X(conversion.achieved)).toBeCloseTo(conversion.achievedCmPer360.x, 12);
  });
});
