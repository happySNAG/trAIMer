/**
 * Pass 4: golden cases taken from OUTSIDE this repository.
 *
 * Every other profile test in this tree ultimately asks the engine to agree
 * with a constant this repository chose. That is worth having — it catches
 * regressions — but it cannot catch a constant that was wrong when it was
 * written, because both sides of the assertion come from the same file.
 *
 * The cases here are different in kind: each expected value was PUBLISHED by
 * someone else, in a form that does not name our constants, and the test
 * makes the engine reproduce it. None of these assertions mentions a
 * `*_DEGREES_PER_COUNT_AT_ONE`. If a profile's constant were replaced with a
 * plausible-looking wrong one, the tests below would fail and the rest of the
 * suite would not.
 */

import { describe, expect, it } from "vitest";

import { canonicalFromCmPer360, cmPer360X } from "../src/games/canonical.ts";
import { gameSettingsFromCanonical, roundTrip } from "../src/games/convert.ts";
import { canonicalFromGameSettings } from "../src/games/convert.ts";
import { MATCHING } from "../src/games/matching.ts";
import { PUBLIC_GAME_PROFILES } from "../src/games/profiles/index.ts";
import {
  APEX_LEGENDS_PROFILE,
  BATTLEFIELD_6_PROFILE,
  CALL_OF_DUTY_WARZONE_PROFILE,
  COUNTER_STRIKE_2_PROFILE,
  FORTNITE_PROFILE,
  GENERIC_RAW_PROFILE,
  MARVEL_RIVALS_PROFILE,
  OVERWATCH_2_PROFILE,
  PUBG_PROFILE,
  RAINBOW_SIX_SIEGE_PROFILE,
  THE_FINALS_PROFILE,
  VALORANT_PROFILE,
} from "../src/games/profiles/index.ts";
import { zoomLevelsOf, type GameProfile } from "../src/games/profileSchema.ts";
import { validateGameProfile } from "../src/games/validate.ts";

// ---------------------------------------------------------------------------
// 1. The published cm/360 band — an external check on eight base constants
// ---------------------------------------------------------------------------

/**
 * A long-standing technical reference publishes, for each game it supports,
 * the in-game sensitivity range that puts a player at 800 DPI inside its
 * stated band of 20 to 80 cm per 360° turn.
 *
 * That is a statement about CENTIMETRES, not about any game's internals, and
 * it pins a base constant directly: whatever number a profile needs in order
 * to produce a 20 cm/360 turn at 800 DPI must be the number that reference
 * prints, to the precision it prints it at. So this table is eight
 * independent checks on eight constants, and it is what settled Marvel
 * Rivals — where four different constants were in circulation.
 *
 * `fast` is the value at 20 cm/360, `slow` the value at 80 cm/360, written
 * exactly as published so the tolerance can be read off the last digit.
 */
const PUBLISHED_BAND: { profile: GameProfile; fast: string; slow: string }[] = [
  { profile: VALORANT_PROFILE, fast: "0.816", slow: "0.204" },
  { profile: APEX_LEGENDS_PROFILE, fast: "2.6", slow: "0.65" },
  { profile: FORTNITE_PROFILE, fast: "10.3", slow: "2.6" },
  { profile: MARVEL_RIVALS_PROFILE, fast: "3.27", slow: "0.82" },
  { profile: OVERWATCH_2_PROFILE, fast: "8.66", slow: "2.16" },
  { profile: CALL_OF_DUTY_WARZONE_PROFILE, fast: "8.66", slow: "2.16" },
  { profile: THE_FINALS_PROFILE, fast: "57", slow: "14" },
  { profile: RAINBOW_SIX_SIEGE_PROFILE, fast: "10", slow: "2" },
];

/** Half a unit in the last place the published number actually shows. */
function printedTolerance(published: string): number {
  const dot = published.indexOf(".");
  const decimals = dot < 0 ? 0 : published.length - dot - 1;
  return 0.5 * 10 ** -decimals;
}

describe("published 20–80 cm/360 band at 800 DPI (external golden cases)", () => {
  for (const { profile, fast, slow } of PUBLISHED_BAND) {
    it(`${profile.displayName}: reproduces the published ${slow}–${fast} at 800 DPI`, () => {
      for (const [cm, published] of [
        [20, fast],
        [80, slow],
      ] as [number, string][]) {
        const exact = gameSettingsFromCanonical(profile, canonicalFromCmPer360(cm), {
          dpi: 800,
        }).hipfire.value.exact;
        expect(Math.abs(exact - Number(published))).toBeLessThanOrEqual(
          printedTolerance(published),
        );
      }
    });
  }

  it("the rival Marvel Rivals constants are excluded, not merely out-voted", () => {
    // Each rival would have forced the reference to print a different fast
    // end. Reproducing 3.27 is only evidence if 0.022, 0.0066 and 0.07 do
    // not also reproduce it — so state what they would have produced.
    const exact = gameSettingsFromCanonical(
      MARVEL_RIVALS_PROFILE,
      canonicalFromCmPer360(20),
      { dpi: 800 },
    ).hipfire.value.exact;
    const perCount = (360 * 2.54) / (20 * 800 * exact);
    expect(perCount).toBeCloseTo(Math.PI / 180, 4);
    for (const rival of [0.022, 0.0066, 0.07]) {
      const wouldPrint = (360 * 2.54) / (20 * 800 * rival);
      expect(Math.abs(wouldPrint - 3.27)).toBeGreaterThan(0.05);
    }
  });

  it("PUBG is deliberately absent: its published band does not decide the question", () => {
    // The same reference prints 23–53 for PUBG, a span of 2.3×, where a
    // 20–80 cm/360 band on a linear scale must span exactly 4×. That is
    // either a curve or a PUBG-specific band, and the two cannot be told
    // apart from outside the game — so the profile stays experimental and
    // claims no external confirmation here.
    expect(PUBLISHED_BAND.map((b) => b.profile.id)).not.toContain(PUBG_PROFILE.id);
    expect(PUBG_PROFILE.status).toBe("experimental");
    expect(53 / 23).toBeLessThan(4);
    expect(PUBG_PROFILE.source.uncertaintyNotes.join(" ")).toContain("LINEAR");
  });
});

// ---------------------------------------------------------------------------
// 2. Zoom constants other people published
// ---------------------------------------------------------------------------

describe("published zoom constants (external golden cases)", () => {
  it("Counter-Strike 2: FOV-relative at the AWP's first zoom is the published 0.818933027", () => {
    // Published independently as
    //   zoom_sensitivity_ratio = (hipFOV / zoomFOV) × tan(zoomFOV/2) × cot(hipFOV/2)
    // which is exactly this profile's linear-ratio native scaling. The value
    // the community has used for over a decade is published as
    // 0.818933027098955175, which is more digits than a double carries — the
    // nine below are all of it that survives a JavaScript number literal.
    const zoom = gameSettingsFromCanonical(
      COUNTER_STRIKE_2_PROFILE,
      canonicalFromCmPer360(30),
      { dpi: 800, matching: MATCHING.fovRelative },
    ).zooms[0]!;
    expect(zoom.setting!.value.exact).toBeCloseTo(0.818933027, 9);
  });

  it("Valorant: FOV-relative multipliers are the published 0.870439 and 0.747462", () => {
    // Published independently as
    //   multiplier = magnification × tan(zoomFOV/2) ÷ tan(51.5°)
    // with the field of view locked at 103° and the zoomed view 103/zoom.
    const zooms = gameSettingsFromCanonical(VALORANT_PROFILE, canonicalFromCmPer360(30), {
      dpi: 800,
      matching: MATCHING.fovRelative,
    }).zooms;
    const byId = Object.fromEntries(zooms.map((z) => [z.zoomId, z]));
    expect(byId["ads-rifle"]!.setting!.value.exact).toBeCloseTo(0.870439, 6);
    expect(byId["scoped-operator"]!.setting!.value.exact).toBeCloseTo(0.747462, 6);
  });

  it("Overwatch 2: the published 37.89 / 51.47, and never the 49.46 that is a different ratio", () => {
    // Both numbers circulate as "1:1 scoped". From the same 50.94° scoped
    // FOV, 37.89% is the ratio of the tangents of the half-angles and 49.46%
    // is the ratio of the angles. Only the first is a matching philosophy;
    // producing the second would mean the engine had confused the two.
    const zooms = gameSettingsFromCanonical(OVERWATCH_2_PROFILE, canonicalFromCmPer360(30), {
      dpi: 800,
      fovDegrees: 103,
      matching: MATCHING.fovRelative,
    }).zooms;
    const byId = Object.fromEntries(zooms.map((z) => [z.zoomId, z]));
    for (const hero of ["widowmaker", "ana"]) {
      expect(byId[hero]!.setting!.value.exact).toBeCloseTo(37.89, 2);
      expect(byId[hero]!.setting!.value.exact).not.toBeCloseTo(49.46, 1);
    }
    expect(byId["ashe"]!.setting!.value.exact).toBeCloseTo(51.47, 2);
    // Same physical sensitivity is the one philosophy under which the
    // multiplier is exactly the game's 100%.
    const physical = gameSettingsFromCanonical(
      OVERWATCH_2_PROFILE,
      canonicalFromCmPer360(30),
      { dpi: 800, fovDegrees: 103, matching: MATCHING.physical360 },
    ).zooms[0]!;
    expect(physical.setting!.value.exact).toBeCloseTo(100, 9);
  });

  it("Rainbow Six Siege: Ubisoft's own neutral of 50 at every magnification", () => {
    // Ubisoft, "Guide to ADS Sensitivity in Y5S3": new players get an ADS
    // value of 50 at every zoom level, described as scaling linearly so a
    // given mouse distance always matches the same monitor distance — which
    // is the focal-length limit this profile models.
    const zooms = gameSettingsFromCanonical(
      RAINBOW_SIX_SIEGE_PROFILE,
      canonicalFromCmPer360(30),
      { dpi: 400, fovDegrees: 60, matching: MATCHING.gameNative },
    ).zooms;
    expect(zooms.length).toBe(8);
    for (const zoom of zooms) {
      expect(zoom.setting!.value.ui).toBe(50);
    }
    // The engine's own focal-length answer agrees with the developers': the
    // game already applies the scaling, so FOV-relative is also 50.
    const fovRelative = gameSettingsFromCanonical(
      RAINBOW_SIX_SIEGE_PROFILE,
      canonicalFromCmPer360(30),
      { dpi: 400, fovDegrees: 60, matching: MATCHING.fovRelative },
    ).zooms;
    for (const zoom of fovRelative) {
      expect(zoom.setting!.value.ui).toBe(50);
    }
  });

  it("Rainbow Six Siege: the yaw is 1e-4 radians per count per unit, a round engine constant", () => {
    // 0.00572958 is not a fitted number: it is 1e-4 rad expressed in
    // degrees, i.e. 0.005 rad per count per unit of
    // (sensitivity × MouseSensitivityMultiplierUnit) at the stock 0.02.
    const aim = canonicalFromGameSettings(RAINBOW_SIX_SIEGE_PROFILE, 400, { hipfire: 1 });
    const degreesPerCount = (aim.degreesPerCmX * 2.54) / 400;
    // The profile stores the constant to eight significant figures, so that
    // is the precision the identity can be checked to.
    expect(degreesPerCount).toBeCloseTo((1e-4 * 180) / Math.PI, 8);
  });
});

// ---------------------------------------------------------------------------
// 3. Monitor-distance coefficients: the aspect ratio IS the published value
// ---------------------------------------------------------------------------

describe("Uniform Soldier Aiming / Relative-mode coefficients (external golden cases)", () => {
  it("Battlefield 6: the published per-aspect-ratio table falls out of the aspect ratio alone", () => {
    // Published: 4:3 → 133.3%, 16:9 → 177.7%, 21:9 → 233.3%, 32:9 → 355.5%.
    // Those are the aspect ratios themselves, which is what makes the
    // coefficient a fraction of the VERTICAL half-screen. The engine is
    // never told the table; it computes each one.
    const table: [number, number][] = [
      [4 / 3, 133.3],
      [16 / 9, 177.8],
      [21 / 9, 233.3],
      [32 / 9, 355.6],
    ];
    for (const [aspectRatio, expected] of table) {
      const zoom = gameSettingsFromCanonical(
        BATTLEFIELD_6_PROFILE,
        canonicalFromCmPer360(30),
        { dpi: 800, aspectRatio, matching: MATCHING.monitorDistance100 },
      ).zooms[0]!;
      expect(zoom.setting!.value.ui).toBeCloseTo(expected, 1);
    }
  });

  it("Battlefield 6: the game's stock coefficient is 133.3%, not the 16:9 full-width 177.8%", () => {
    // The correction this pass made. 133.3 is what Battlefield ships;
    // 177.8 is what a 16:9 player must set for a full-width match. Pass 3
    // recorded the second as the first, which made two distinct
    // philosophies produce one answer.
    const run = (matching: typeof MATCHING.gameNative) =>
      gameSettingsFromCanonical(BATTLEFIELD_6_PROFILE, canonicalFromCmPer360(30), {
        dpi: 800,
        matching,
      }).zooms[0]!.setting!.display;
    expect(run(MATCHING.gameNative)).toBe("133.3%");
    expect(run(MATCHING.monitorDistance100)).toBe("177.8%");
    expect(run(MATCHING.fovRelative)).toBe("0.0%");
  });

  it("Call of Duty: the documented 1.33 default, and 1.78 for a full-width 16:9 match", () => {
    const run = (matching: typeof MATCHING.gameNative) =>
      gameSettingsFromCanonical(
        CALL_OF_DUTY_WARZONE_PROFILE,
        canonicalFromCmPer360(30),
        { dpi: 800, matching },
      ).zooms[0]!.setting!.display;
    expect(run(MATCHING.gameNative)).toBe("1.33");
    expect(run(MATCHING.monitorDistance100)).toBe("1.78");
    expect(run(MATCHING.fovRelative)).toBe("0.00");
  });
});

// ---------------------------------------------------------------------------
// 4. Fail-closed behaviour (requirement 24)
// ---------------------------------------------------------------------------

describe("fail-closed: the engine qualifies or refuses rather than inventing precision", () => {
  it("a profile whose hip-fire scales with FOV says so when no FOV was given", () => {
    const quiet = gameSettingsFromCanonical(PUBG_PROFILE, canonicalFromCmPer360(30), {
      dpi: 800,
    });
    expect(quiet.warnings.join(" ")).toContain("No field of view was given");
    const stated = gameSettingsFromCanonical(PUBG_PROFILE, canonicalFromCmPer360(30), {
      dpi: 800,
      fovDegrees: 90,
    });
    expect(stated.warnings.join(" ")).not.toContain("No field of view was given");
  });

  it("only PUBG raises that warning, because only PUBG scales hip-fire with FOV", () => {
    for (const profile of PUBLIC_GAME_PROFILES) {
      const warnings = gameSettingsFromCanonical(profile, canonicalFromCmPer360(30), {
        dpi: 800,
      }).warnings.join(" ");
      expect(warnings.includes("No field of view was given")).toBe(
        profile.id === PUBG_PROFILE.id,
      );
    }
  });

  it("an unsupported zoom yields no setting and an explanation, never a number", () => {
    for (const profile of [FORTNITE_PROFILE, APEX_LEGENDS_PROFILE, MARVEL_RIVALS_PROFILE]) {
      const text = [...profile.knownEdgeCases, ...profile.source.uncertaintyNotes]
        .join(" ")
        .toLowerCase();
      expect(text).toMatch(/not converted|not verified|are not used|no ads/);
    }
    // Apex and Marvel Rivals expose no zoom setting at all rather than a
    // guessed one; Fortnite exposes targeting but not scope.
    expect(APEX_LEGENDS_PROFILE.zoom.kind).toBe("none");
    expect(MARVEL_RIVALS_PROFILE.zoom.kind).toBe("none");
    const fortniteZooms = gameSettingsFromCanonical(
      FORTNITE_PROFILE,
      canonicalFromCmPer360(30),
      { dpi: 800 },
    ).zooms;
    expect(fortniteZooms.map((z) => z.zoomId)).toEqual(["targeting"]);
  });

  it("every public profile refuses a matching philosophy it does not declare", () => {
    for (const profile of PUBLIC_GAME_PROFILES) {
      for (const method of [
        MATCHING.physical360,
        MATCHING.monitorDistance100,
        MATCHING.gameNative,
      ]) {
        const supported = profile.supportedMatching.includes(method.kind);
        const call = () =>
          gameSettingsFromCanonical(profile, canonicalFromCmPer360(30), {
            dpi: 800,
            fovDegrees: profile.fov.kind === "configurable" ? profile.fov.defaultDegrees : null,
            matching: method,
          });
        if (supported) expect(call).not.toThrow();
        else expect(call).toThrow(/does not support/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 4b. FOV conventions (requirement 20)
// ---------------------------------------------------------------------------

describe("FOV conventions are never mixed within a profile", () => {
  it("every zoom states its field of view on the hip-fire convention, or inherits it", () => {
    for (const profile of PUBLIC_GAME_PROFILES) {
      for (const zoom of zoomLevelsOf(profile)) {
        if (zoom.fov.kind === "none" || zoom.fov.kind === "scaled-from-hipfire") continue;
        expect(profile.fov.kind === "fixed" || profile.fov.kind === "configurable").toBe(true);
        if (profile.fov.kind === "fixed" || profile.fov.kind === "configurable") {
          expect(zoom.fov.axis).toBe(profile.fov.axis);
        }
      }
    }
  });

  it("the validator now rejects a profile that mixes them", () => {
    // Built from a real profile so the only thing wrong is the axis.
    const mixed = structuredClone(VALORANT_PROFILE) as GameProfile;
    const zoom = (mixed.zoom as unknown as { zooms: { fov: { axis: string } }[] }).zooms[0]!;
    zoom.fov.axis = "vertical";
    const result = validateGameProfile(mixed);
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.message).join(" ")).toContain(
      "same convention as the hip-fire",
    );
  });

  it("a 4:3-quoted and a 16:9-quoted profile disagree about the same number, as they must", () => {
    // Counter-Strike's 90 and Valorant's 103 are both "horizontal", on
    // different bases. If the layer ever treated them as the same kind of
    // number, CS2's hip-fire would resolve to 90° on a 16:9 display instead
    // of 106.26°, and every zoom ratio built on it would move.
    const cs2 = gameSettingsFromCanonical(COUNTER_STRIKE_2_PROFILE, canonicalFromCmPer360(30), {
      dpi: 800,
    }).fov!;
    expect(cs2.statedDeg).toBe(90);
    expect(cs2.statedAxis).toBe("horizontal-at-4-3");
    expect(cs2.horizontalDeg).toBeCloseTo(106.26, 2);
    const valorant = gameSettingsFromCanonical(VALORANT_PROFILE, canonicalFromCmPer360(30), {
      dpi: 800,
    }).fov!;
    expect(valorant.statedDeg).toBe(103);
    expect(valorant.horizontalDeg).toBeCloseTo(103, 6);
  });
});

// ---------------------------------------------------------------------------
// 4c. Currentness (requirement 18)
// ---------------------------------------------------------------------------

describe("currentness: no profile is left behind by a later pass", () => {
  const DAY = 24 * 60 * 60 * 1000;
  /**
   * How far a profile may lag the most recently reviewed one before it is
   * stale. There is no clock in this test on purpose — a date-dependent
   * assertion would start failing on a calendar boundary rather than on a
   * change to the tree. What it catches is the failure that actually
   * happens: a pass adds or re-checks one game and quietly leaves the other
   * eleven on last year's evidence.
   */
  const MAX_LAG_DAYS = 120;

  it("every public profile carries a verification and review date, reviewed no earlier", () => {
    for (const profile of PUBLIC_GAME_PROFILES) {
      const verified = Date.parse(profile.source.verifiedAtIso);
      const reviewed = Date.parse(profile.source.lastReviewedAtIso);
      expect(Number.isFinite(verified)).toBe(true);
      expect(Number.isFinite(reviewed)).toBe(true);
      expect(reviewed).toBeGreaterThanOrEqual(verified);
    }
  });

  it("no profile lags the freshest one by more than the staleness window", () => {
    const reviewed = PUBLIC_GAME_PROFILES.map((p) => Date.parse(p.source.lastReviewedAtIso));
    const freshest = Math.max(...reviewed);
    const stale = PUBLIC_GAME_PROFILES.filter(
      (p) => (freshest - Date.parse(p.source.lastReviewedAtIso)) / DAY > MAX_LAG_DAYS,
    );
    expect(stale.map((p) => `${p.id} (${p.source.lastReviewedAtIso})`)).toEqual([]);
  });

  it("every profile whose numbers are tied to a build says which build", () => {
    for (const profile of PUBLIC_GAME_PROFILES) {
      if (profile.source.type === "unit-definition") {
        // A definition is exact by construction and has no game build.
        expect(profile.source.gameVersion).toBeNull();
        continue;
      }
      expect(profile.source.gameVersion).toBeTruthy();
      expect(profile.source.gameVersion).toMatch(/20\d\d/);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Cross-profile equivalence audit (requirement 25)
// ---------------------------------------------------------------------------

describe("cross-profile equivalence: A → canonical → B → canonical", () => {
  const CM = [15, 20, 27.5, 34.6, 50, 80];
  const DPI = [400, 800, 1600, 3200];

  it("every ordered pair of public profiles preserves the physical aim within B's own grid", () => {
    const failures: string[] = [];
    for (const from of PUBLIC_GAME_PROFILES) {
      for (const to of PUBLIC_GAME_PROFILES) {
        for (const cm of CM) {
          for (const dpi of DPI) {
            const fovA = from.fov.kind === "configurable" ? from.fov.defaultDegrees : null;
            const fovB = to.fov.kind === "configurable" ? to.fov.defaultDegrees : null;
            // A: express the aim in game A, then read it back as a player would.
            const inA = gameSettingsFromCanonical(from, canonicalFromCmPer360(cm), {
              dpi,
              fovDegrees: fovA,
            });
            if (inA.hipfire.value.clampedToMin || inA.hipfire.value.clampedToMax) continue;
            const viaA = canonicalFromGameSettings(from, dpi, {
              hipfire: inA.hipfire.value.ui,
              vertical: inA.vertical?.value.ui ?? null,
              fovDegrees: fovA,
            });
            // B: the same physical aim, expressed in game B.
            const result = roundTrip(to, viaA, { dpi, fovDegrees: fovB });
            if (!result.withinTolerance) {
              failures.push(
                `${from.id} → ${to.id} @ ${cm}cm/${dpi}dpi: ` +
                  `${(result.relativeError * 100).toFixed(4)}% > ` +
                  `${(result.tolerance * 100).toFixed(4)}%`,
              );
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("the control profile's inverse is exactly its inverse, and its only loss is its own grid", () => {
    // Pass 4 audit of the reference profile. Two different properties, and
    // conflating them is how a control profile stops being one:
    //
    //  - The arithmetic is exact. Reading the produced settings back must
    //    reproduce what the conversion said it achieved, to float precision,
    //    at every value. This is the property that makes the profile a
    //    control, and it holds unconditionally.
    //  - The GRID is not infinite. The settings field takes four decimals,
    //    so a slow sensitivity at a high DPI (0.1786 at 3200 DPI for an
    //    80 cm/360 turn) cannot be typed exactly, and the round trip carries
    //    the grid's error — which the profile reports rather than hides.
    for (const cm of CM) {
      for (const dpi of DPI) {
        const result = roundTrip(GENERIC_RAW_PROFILE, canonicalFromCmPer360(cm), { dpi });
        expect(result.inverseConsistent).toBe(true);
        expect(result.withinTolerance).toBe(true);
        expect(result.relativeError).toBeLessThanOrEqual(result.tolerance);
        // No profile in the registry rounds more finely than the control.
        expect(result.tolerance).toBeLessThan(1e-3);
      }
    }
  });

  it("the control profile is exact wherever its four-decimal grid can express the value", () => {
    for (const sensitivity of [0.25, 0.5, 1, 1.5, 2.5, 7.62, 12.3456]) {
      for (const dpi of DPI) {
        const aim = canonicalFromGameSettings(GENERIC_RAW_PROFILE, dpi, {
          hipfire: sensitivity,
        });
        const back = gameSettingsFromCanonical(GENERIC_RAW_PROFILE, aim, { dpi });
        expect(back.hipfire.value.ui).toBe(sensitivity);
        expect(back.hipfire.value.roundingLoss).toBe(false);
        expect(back.roundingErrorFraction).toBeLessThan(1e-12);
      }
    }
  });

  it("the control profile carries no game-specific behaviour at all", () => {
    expect(GENERIC_RAW_PROFILE.fov.kind).toBe("none");
    expect(GENERIC_RAW_PROFILE.zoom.kind).toBe("none");
    expect(GENERIC_RAW_PROFILE.source.type).toBe("unit-definition");
    expect(GENERIC_RAW_PROFILE.source.confidence).toBe("exact");
    // Its unit is a definition, so it is exact by construction: 1.00 is
    // 0.02°/count, which at 800 DPI is 57.2 cm/360.
    const aim = canonicalFromGameSettings(GENERIC_RAW_PROFILE, 800, { hipfire: 1 });
    expect(cmPer360X(aim)).toBeCloseTo((360 * 2.54) / (800 * 0.02), 9);
  });
});
