import { describe, expect, it } from "vitest";
import {
  GAME_PROFILE_SCHEMA_VERSION,
  profileRef,
  supportsMatching,
  zoomLevelById,
  zoomLevelsOf,
  type GameProfile,
} from "../src/games/profileSchema.ts";
import {
  InvalidGameProfileError,
  assertValidGameProfile,
  validateGameProfile,
} from "../src/games/validate.ts";
import { GENERIC_RAW_PROFILE } from "../src/games/profiles/generic.ts";
import {
  ARCHITECTURE_FIXTURE_PROFILES,
  FIXTURE_LINKED_STEPPED,
  FIXTURE_PER_SCOPE,
} from "../src/games/fixtures.ts";

/**
 * Fail-closed profile validation (Game Profile Pass 1, requirement 9).
 *
 * A bad profile must never reach a player as a sensitivity recommendation.
 * Each case below breaks exactly one thing in an otherwise-valid profile and
 * asserts the validator says so, naming the field.
 */

/** Deep clone that keeps the profile's declared type. */
function mutate(
  base: GameProfile,
  patch: (draft: Record<string, unknown>) => void,
): GameProfile {
  const draft = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  patch(draft);
  return draft as unknown as GameProfile;
}

function errorPaths(profile: GameProfile): string[] {
  return validateGameProfile(profile)
    .issues.filter((i) => i.severity === "error")
    .map((i) => i.path);
}

describe("game profile schema — the shipped profiles are valid", () => {
  it("accepts the generic/raw control profile with no issues at all", () => {
    const result = validateGameProfile(GENERIC_RAW_PROFILE);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(GENERIC_RAW_PROFILE.schemaVersion).toBe(GAME_PROFILE_SCHEMA_VERSION);
  });

  it("accepts every architecture fixture", () => {
    for (const profile of ARCHITECTURE_FIXTURE_PROFILES) {
      const result = validateGameProfile(profile);
      expect(result.valid, `${profile.id}: ${JSON.stringify(result.issues)}`).toBe(true);
    }
  });

  it("exposes zoom levels through the schema helpers", () => {
    expect(zoomLevelsOf(GENERIC_RAW_PROFILE)).toEqual([]);
    expect(zoomLevelsOf(FIXTURE_LINKED_STEPPED)).toHaveLength(1);
    expect(zoomLevelsOf(FIXTURE_PER_SCOPE).map((z) => z.id)).toEqual([
      "ads-1x",
      "ads-2x",
      "ads-4x",
      "sniper",
    ]);
    expect(zoomLevelById(FIXTURE_PER_SCOPE, "sniper")?.magnification).toBe(8);
    expect(zoomLevelById(FIXTURE_PER_SCOPE, "nope")).toBeNull();
    expect(supportsMatching(GENERIC_RAW_PROFILE, "monitor-distance")).toBe(false);
    expect(supportsMatching(FIXTURE_PER_SCOPE, "monitor-distance")).toBe(true);
    expect(profileRef(FIXTURE_PER_SCOPE)).toBe("fixture-per-scope@v2");
  });
});

describe("game profile validation — malformed profiles fail closed", () => {
  it("rejects a foreign schema version", () => {
    const bad = mutate(GENERIC_RAW_PROFILE, (d) => {
      d.schemaVersion = 99;
    });
    expect(errorPaths(bad)).toContain("schemaVersion");
  });

  it("rejects missing required identity fields", () => {
    expect(errorPaths(mutate(GENERIC_RAW_PROFILE, (d) => { d.id = "Not Kebab"; }))).toContain("id");
    expect(errorPaths(mutate(GENERIC_RAW_PROFILE, (d) => { d.displayName = ""; }))).toContain("displayName");
    expect(errorPaths(mutate(GENERIC_RAW_PROFILE, (d) => { d.unitDefinition = ""; }))).toContain("unitDefinition");
    expect(errorPaths(mutate(GENERIC_RAW_PROFILE, (d) => { d.platforms = []; }))).toContain("platforms");
  });

  it("rejects invalid versioning", () => {
    expect(errorPaths(mutate(GENERIC_RAW_PROFILE, (d) => { d.profileVersion = 0; }))).toContain("profileVersion");
    expect(errorPaths(mutate(GENERIC_RAW_PROFILE, (d) => { d.profileVersion = 1.5; }))).toContain("profileVersion");
    expect(errorPaths(mutate(GENERIC_RAW_PROFILE, (d) => { d.profileVersion = -3; }))).toContain("profileVersion");
  });

  it("rejects impossible sensitivity ranges", () => {
    const inverted = mutate(GENERIC_RAW_PROFILE, (d) => {
      (d.hipfireField as { entry: Record<string, unknown> }).entry.min = 10;
      (d.hipfireField as { entry: Record<string, unknown> }).entry.max = 1;
    });
    expect(errorPaths(inverted)).toContain("hipfireField.entry");
    const negative = mutate(GENERIC_RAW_PROFILE, (d) => {
      (d.hipfireField as { entry: Record<string, unknown> }).entry.min = -1;
    });
    expect(errorPaths(negative)).toContain("hipfireField.entry");
  });

  it("rejects invalid step sizes", () => {
    const zeroStep = mutate(FIXTURE_LINKED_STEPPED, (d) => {
      (d.hipfireField as { entry: Record<string, unknown> }).entry.step = 0;
    });
    expect(errorPaths(zeroStep)).toContain("hipfireField.entry.step");
    const hugeStep = mutate(FIXTURE_LINKED_STEPPED, (d) => {
      (d.hipfireField as { entry: Record<string, unknown> }).entry.step = 1000;
    });
    expect(errorPaths(hugeStep)).toContain("hipfireField.entry.step");
  });

  it("rejects invalid rounding rules and decimal precision", () => {
    const badRounding = mutate(GENERIC_RAW_PROFILE, (d) => {
      (d.hipfireField as { entry: Record<string, unknown> }).entry.rounding = "sideways";
    });
    expect(errorPaths(badRounding)).toContain("hipfireField.entry.rounding");
    const badDecimals = mutate(GENERIC_RAW_PROFILE, (d) => {
      (d.hipfireField as { entry: Record<string, unknown> }).entry.uiDecimals = 42;
    });
    expect(errorPaths(badDecimals)).toContain("hipfireField.entry.uiDecimals");
    const inverted = mutate(FIXTURE_PER_SCOPE, (d) => {
      (d.hipfireField as { entry: Record<string, unknown> }).entry.configDecimals = 1;
    });
    expect(errorPaths(inverted)).toContain("hipfireField.entry.configDecimals");
  });

  it("rejects impossible yaw/pitch constants", () => {
    expect(
      errorPaths(
        mutate(GENERIC_RAW_PROFILE, (d) => {
          (d.sensitivityModel as Record<string, unknown>).yawDegreesPerCountAtOne = 0;
        }),
      ),
    ).toContain("sensitivityModel.yawDegreesPerCountAtOne");
    expect(
      errorPaths(
        mutate(GENERIC_RAW_PROFILE, (d) => {
          (d.sensitivityModel as Record<string, unknown>).yawDegreesPerCountAtOne = 180;
        }),
      ),
    ).toContain("sensitivityModel.yawDegreesPerCountAtOne");
    expect(
      errorPaths(
        mutate(GENERIC_RAW_PROFILE, (d) => {
          (d.sensitivityModel as Record<string, unknown>).pitchDegreesPerCountAtOne = -0.01;
        }),
      ),
    ).toContain("sensitivityModel.pitchDegreesPerCountAtOne");
  });

  it("rejects unknown conversion types", () => {
    const unknownModel = mutate(GENERIC_RAW_PROFILE, (d) => {
      (d.sensitivityModel as Record<string, unknown>).kind = "vibes";
    });
    expect(errorPaths(unknownModel)).toContain("sensitivityModel.kind");
    const unknownMatching = mutate(GENERIC_RAW_PROFILE, (d) => {
      (d.defaultMatching as Record<string, unknown>).kind = "vibes";
    });
    expect(errorPaths(unknownMatching)).toContain("defaultMatching.kind");
    const unknownSupported = mutate(GENERIC_RAW_PROFILE, (d) => {
      d.supportedMatching = ["telepathy"];
    });
    expect(errorPaths(unknownSupported)).toContain("supportedMatching");
  });

  it("rejects a non-invertible power-law exponent", () => {
    const bad = mutate(
      { ...ARCHITECTURE_FIXTURE_PROFILES[3]! },
      (d) => {
        (d.sensitivityModel as Record<string, unknown>).yawExponent = 0;
      },
    );
    expect(errorPaths(bad)).toContain("sensitivityModel.yawExponent");
  });

  it("rejects invalid FOV ranges", () => {
    const bad = mutate(FIXTURE_LINKED_STEPPED, (d) => {
      (d.fov as Record<string, unknown>).minDegrees = 130;
      (d.fov as Record<string, unknown>).maxDegrees = 100;
    });
    expect(errorPaths(bad)).toContain("fov.minDegrees");
    const outsideLimits = mutate(FIXTURE_LINKED_STEPPED, (d) => {
      (d.fov as Record<string, unknown>).defaultDegrees = 200;
    });
    expect(errorPaths(outsideLimits)).toContain("fov.defaultDegrees");
    const impossible = mutate(FIXTURE_LINKED_STEPPED, (d) => {
      (d.fov as Record<string, unknown>).axis = "sideways";
    });
    expect(errorPaths(impossible)).toContain("fov.axis");
  });

  it("rejects unsupported ADS model combinations", () => {
    const noSetting = mutate(FIXTURE_LINKED_STEPPED, (d) => {
      ((d.zoom as Record<string, unknown>).zoom as Record<string, unknown>).setting = null;
    });
    expect(errorPaths(noSetting)).toContain("zoom[0].setting");

    const fovRelativeWithoutFov = mutate(FIXTURE_LINKED_STEPPED, (d) => {
      const zoom = (d.zoom as Record<string, unknown>).zoom as Record<string, unknown>;
      zoom.nativeBehavior = "fov-relative-multiplier";
      zoom.fov = { kind: "none" };
    });
    expect(errorPaths(fovRelativeWithoutFov)).toContain("zoom[0].fov");

    const unknownBehavior = mutate(FIXTURE_LINKED_STEPPED, (d) => {
      ((d.zoom as Record<string, unknown>).zoom as Record<string, unknown>).nativeBehavior = "magic";
    });
    expect(errorPaths(unknownBehavior)).toContain("zoom[0].nativeBehavior");

    const unknownZoomKind = mutate(FIXTURE_LINKED_STEPPED, (d) => {
      (d.zoom as Record<string, unknown>).kind = "sometimes";
    });
    expect(errorPaths(unknownZoomKind)).toContain("zoom.kind");
  });

  it("rejects duplicate zoom ids inside one profile", () => {
    const dup = mutate(FIXTURE_PER_SCOPE, (d) => {
      const zooms = (d.zoom as { zooms: Record<string, unknown>[] }).zooms;
      zooms[1]!.id = zooms[0]!.id;
    });
    expect(errorPaths(dup)).toContain("zoom[1].id");
  });

  it("rejects monitor-distance support without a hip-fire FOV", () => {
    const bad = mutate(GENERIC_RAW_PROFILE, (d) => {
      d.supportedMatching = ["physical-360-distance", "monitor-distance"];
    });
    expect(errorPaths(bad)).toContain("supportedMatching");
  });

  it("rejects a default matching philosophy the profile does not support", () => {
    const bad = mutate(FIXTURE_PER_SCOPE, (d) => {
      d.supportedMatching = ["physical-360-distance"];
    });
    expect(errorPaths(bad)).toContain("defaultMatching");
  });

  it("rejects contradictory axis models (requirement 5)", () => {
    const independentWithoutField = mutate(GENERIC_RAW_PROFILE, (d) => {
      (d.axes as Record<string, unknown>).verticalField = null;
    });
    expect(errorPaths(independentWithoutField)).toContain("axes.verticalField");

    const linkedWithField = mutate(FIXTURE_LINKED_STEPPED, (d) => {
      (d.axes as Record<string, unknown>).verticalField = {
        field: "y",
        label: "Y",
        entry: { min: 0.1, max: 10, step: null, uiDecimals: 2, configDecimals: null, rounding: "nearest", unitSuffix: "" },
      };
    });
    expect(errorPaths(linkedWithField)).toContain("axes.verticalField");

    const linkedWithSemantics = mutate(FIXTURE_LINKED_STEPPED, (d) => {
      (d.axes as Record<string, unknown>).verticalSemantics = "absolute";
    });
    expect(errorPaths(linkedWithSemantics)).toContain("axes.verticalSemantics");

    const impossibleRatio = mutate(FIXTURE_LINKED_STEPPED, (d) => {
      (d.axes as Record<string, unknown>).builtInVerticalRatio = -1;
    });
    expect(errorPaths(impossibleRatio)).toContain("axes.builtInVerticalRatio");
  });

  it("rejects a vertical relationship declared twice", () => {
    const doubled = mutate(FIXTURE_LINKED_STEPPED, (d) => {
      (d.sensitivityModel as Record<string, unknown>).pitchDegreesPerCountAtOne = 0.002;
    });
    expect(errorPaths(doubled)).toContain("axes.builtInVerticalRatio");
  });

  it("rejects a non-count-based DPI model", () => {
    const bad = mutate(GENERIC_RAW_PROFILE, (d) => {
      (d.dpi as Record<string, unknown>).countBased = false;
    });
    expect(errorPaths(bad)).toContain("dpi.countBased");
  });
});

describe("game profile validation — source and provenance (requirement 10)", () => {
  it("requires complete source metadata on a public verified profile", () => {
    const noVersion = mutate(FIXTURE_LINKED_STEPPED, (d) => {
      d.visibility = "public";
      (d.source as Record<string, unknown>).type = "in-game-measurement";
      (d.source as Record<string, unknown>).gameVersion = null;
    });
    expect(errorPaths(noVersion)).toContain("source.gameVersion");
  });

  it("exempts a unit definition, which has no game build", () => {
    // The generic profile IS public and verified and legitimately has no
    // game version: its constant is a definition, not a measurement.
    expect(GENERIC_RAW_PROFILE.source.type).toBe("unit-definition");
    expect(GENERIC_RAW_PROFILE.source.gameVersion).toBeNull();
    expect(validateGameProfile(GENERIC_RAW_PROFILE).valid).toBe(true);
  });

  it("rejects missing or malformed verification dates", () => {
    expect(
      errorPaths(mutate(GENERIC_RAW_PROFILE, (d) => { (d.source as Record<string, unknown>).verifiedAtIso = "soon"; })),
    ).toContain("source.verifiedAtIso");
    const reviewedBeforeVerified = mutate(GENERIC_RAW_PROFILE, (d) => {
      (d.source as Record<string, unknown>).verifiedAtIso = "2026-09-07";
      (d.source as Record<string, unknown>).lastReviewedAtIso = "2026-01-01";
    });
    expect(errorPaths(reviewedBeforeVerified)).toContain("source.lastReviewedAtIso");
  });

  it("refuses to call a low-confidence profile verified", () => {
    const bad = mutate(GENERIC_RAW_PROFILE, (d) => {
      (d.source as Record<string, unknown>).confidence = "low";
    });
    expect(errorPaths(bad)).toContain("source.confidence");
  });

  it("rejects unknown source types and confidence levels", () => {
    expect(
      errorPaths(mutate(GENERIC_RAW_PROFILE, (d) => { (d.source as Record<string, unknown>).type = "vibes"; })),
    ).toContain("source.type");
    expect(
      errorPaths(mutate(GENERIC_RAW_PROFILE, (d) => { (d.source as Record<string, unknown>).confidence = "vibes"; })),
    ).toContain("source.confidence");
  });
});

describe("game profile validation — deprecation bookkeeping (requirement 20)", () => {
  it("requires a deprecated profile to say why", () => {
    const bad = mutate(FIXTURE_LINKED_STEPPED, (d) => {
      d.status = "deprecated";
      d.deprecationNote = null;
    });
    expect(errorPaths(bad)).toContain("deprecationNote");
  });

  it("refuses a successor on a profile that is not deprecated", () => {
    const bad = mutate(FIXTURE_LINKED_STEPPED, (d) => {
      d.supersededByProfileId = "something-else";
    });
    expect(errorPaths(bad)).toContain("supersededByProfileId");
  });

  it("refuses a profile that supersedes itself", () => {
    const bad = mutate(FIXTURE_LINKED_STEPPED, (d) => {
      d.status = "deprecated";
      d.deprecationNote = "replaced";
      d.supersededByProfileId = FIXTURE_LINKED_STEPPED.id;
    });
    expect(errorPaths(bad)).toContain("supersededByProfileId");
  });
});

describe("assertValidGameProfile", () => {
  it("throws with every error attached", () => {
    const bad = mutate(GENERIC_RAW_PROFILE, (d) => {
      d.profileVersion = 0;
      d.displayName = "";
    });
    expect(() => assertValidGameProfile(bad)).toThrow(InvalidGameProfileError);
    try {
      assertValidGameProfile(bad);
    } catch (err) {
      const issues = (err as InvalidGameProfileError).issues;
      expect(issues.map((i) => i.path)).toEqual(
        expect.arrayContaining(["profileVersion", "displayName"]),
      );
    }
  });

  it("returns the profile untouched when it is valid", () => {
    expect(assertValidGameProfile(GENERIC_RAW_PROFILE)).toBe(GENERIC_RAW_PROFILE);
  });
});
