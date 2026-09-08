import { describe, expect, it } from "vitest";
import {
  GameProfileRegistry,
  GameProfileRegistryError,
} from "../src/games/registry.ts";
import { GAME_PROFILE_REGISTRY } from "../src/games/index.ts";
import { PUBLIC_GAME_PROFILES } from "../src/games/profiles/index.ts";
import { GENERIC_PROFILE_ID, GENERIC_RAW_PROFILE } from "../src/games/profiles/generic.ts";
import {
  ARCHITECTURE_FIXTURE_PROFILES,
  FIXTURE_DEPRECATED,
  FIXTURE_LINKED_STEPPED,
  FIXTURE_PER_SCOPE,
} from "../src/games/fixtures.ts";
import type { GameProfile } from "../src/games/profileSchema.ts";

const ALL = [...PUBLIC_GAME_PROFILES, ...ARCHITECTURE_FIXTURE_PROFILES];

function clone(base: GameProfile, patch: Record<string, unknown>): GameProfile {
  return {
    ...(JSON.parse(JSON.stringify(base)) as Record<string, unknown>),
    ...patch,
  } as unknown as GameProfile;
}

describe("game profile registry — deterministic lookup (requirement 8)", () => {
  const registry = GameProfileRegistry.create(ALL);

  it("resolves stable ids and never throws on an unknown one", () => {
    expect(registry.get(GENERIC_PROFILE_ID)).toBe(GENERIC_RAW_PROFILE);
    expect(registry.get("no-such-game")).toBeNull();
    expect(registry.has(GENERIC_PROFILE_ID)).toBe(true);
    expect(() => registry.require("no-such-game")).toThrow(GameProfileRegistryError);
  });

  it("lists in a stable registration order across calls", () => {
    const first = registry.ids();
    const second = GameProfileRegistry.create(ALL).ids();
    expect([...second]).toEqual([...first]);
    expect(first[0]).toBe(GENERIC_PROFILE_ID);
  });

  it("filters by status and visibility", () => {
    expect(registry.list({ visibility: "public" }).map((p) => p.id)).toEqual([
      GENERIC_PROFILE_ID,
    ]);
    expect(registry.list({ status: "deprecated" }).map((p) => p.id)).toEqual([
      FIXTURE_DEPRECATED.id,
    ]);
    expect(
      registry.list({ status: ["experimental", "partially-verified"] }).map((p) => p.id),
    ).toEqual(["fixture-per-scope", "fixture-power-law"]);
    expect(registry.list({ excludeDeprecated: true }).map((p) => p.id)).not.toContain(
      FIXTURE_DEPRECATED.id,
    );
  });

  it("never offers a fixture or a deprecated profile for selection", () => {
    const selectable = registry.selectable();
    expect(selectable.map((p) => p.id)).toEqual([GENERIC_PROFILE_ID]);
    for (const profile of selectable) {
      expect(profile.visibility).toBe("public");
      expect(profile.status).not.toBe("deprecated");
    }
  });

  it("describes itself with ids and versions, never display names", () => {
    expect(registry.describe()).toContain("generic-raw@v1");
    expect(registry.describe()).toContain("fixture-per-scope@v2");
  });
});

describe("game profile registry — fail-closed loading (requirement 9)", () => {
  it("rejects duplicate ids", () => {
    const dup = clone(GENERIC_RAW_PROFILE, { displayName: "A copy" });
    const result = GameProfileRegistry.tryCreate([GENERIC_RAW_PROFILE, dup]);
    expect(result.registry).toBeNull();
    expect(result.problems[0]!.issues[0]!.message).toContain("duplicate profile id");
    expect(() => GameProfileRegistry.create([GENERIC_RAW_PROFILE, dup])).toThrow(
      GameProfileRegistryError,
    );
  });

  it("rejects a foreign schema version before it validates anything else", () => {
    const foreign = clone(GENERIC_RAW_PROFILE, { schemaVersion: 2, id: "foreign" });
    const result = GameProfileRegistry.tryCreate([foreign]);
    expect(result.registry).toBeNull();
    expect(result.problems[0]!.issues[0]!.path).toBe("schemaVersion");
  });

  it("refuses the WHOLE registry when any one profile is malformed", () => {
    const broken = clone(GENERIC_RAW_PROFILE, { id: "broken", profileVersion: 0 });
    expect(() =>
      GameProfileRegistry.create([GENERIC_RAW_PROFILE, broken]),
    ).toThrow(GameProfileRegistryError);
  });

  it("refuses a deprecated profile whose successor does not exist", () => {
    const orphan = clone(FIXTURE_DEPRECATED, {
      id: "fixture-orphan",
      supersededByProfileId: "a-profile-that-is-not-here",
    });
    const result = GameProfileRegistry.tryCreate([orphan]);
    expect(result.registry).toBeNull();
    expect(result.problems[0]!.issues[0]!.path).toBe("supersededByProfileId");
  });

  it("keeps every profile's validation result for tooling", () => {
    const registry = GameProfileRegistry.create(ALL);
    expect(registry.validationFor(GENERIC_PROFILE_ID)?.valid).toBe(true);
    expect(registry.validationFor("nope")).toBeNull();
  });
});

describe("game profile registry — saved selections (requirements 17, 20)", () => {
  const registry = GameProfileRegistry.create(ALL);

  it("accepts a selection made under the current definition", () => {
    const check = registry.checkSelection({
      profileId: GENERIC_PROFILE_ID,
      profileVersion: 1,
    });
    expect(check.status).toBe("ok");
  });

  it("reports — never silently applies — a profile version bump", () => {
    const check = registry.checkSelection({
      profileId: FIXTURE_PER_SCOPE.id,
      profileVersion: 1,
    });
    expect(check.status).toBe("profile-updated");
    if (check.status !== "profile-updated") throw new Error("unreachable");
    expect(check.savedVersion).toBe(1);
    expect(check.currentVersion).toBe(2);
    expect(check.message).toContain("v1");
    expect(check.message).toContain("v2");
    // The saved values are explicitly NOT reinterpreted.
    expect(check.message).toContain("left as they were");
  });

  it("reports a saved selection newer than the build understands", () => {
    const check = registry.checkSelection({
      profileId: GENERIC_PROFILE_ID,
      profileVersion: 99,
    });
    expect(check.status).toBe("profile-newer-than-build");
    if (check.status !== "profile-newer-than-build") throw new Error("unreachable");
    expect(check.message).toContain("not re-converted");
  });

  it("reports deprecation and names the replacement", () => {
    const check = registry.checkSelection({
      profileId: FIXTURE_DEPRECATED.id,
      profileVersion: 1,
    });
    expect(check.status).toBe("profile-deprecated");
    if (check.status !== "profile-deprecated") throw new Error("unreachable");
    expect(check.replacement?.id).toBe(FIXTURE_LINKED_STEPPED.id);
    expect(check.message).toContain("no longer maintained");
  });

  it("keeps an unknown profile readable rather than erroring", () => {
    const check = registry.checkSelection({
      profileId: "some-game-from-a-later-build",
      profileVersion: 3,
    });
    expect(check.status).toBe("unknown-profile");
    if (check.status !== "unknown-profile") throw new Error("unreachable");
    expect(check.message).toContain("kept");
  });
});

describe("the shipped public registry (requirement 27)", () => {
  it("contains exactly the generic/raw control profile", () => {
    expect(GAME_PROFILE_REGISTRY.ids()).toEqual([GENERIC_PROFILE_ID]);
    expect(PUBLIC_GAME_PROFILES).toHaveLength(1);
  });

  it("ships no named-game profile", () => {
    for (const profile of GAME_PROFILE_REGISTRY.list()) {
      expect(profile.publisher).toBeNull();
      expect(profile.source.type).toBe("unit-definition");
    }
  });

  it("does not contain any architecture fixture", () => {
    for (const fixture of ARCHITECTURE_FIXTURE_PROFILES) {
      expect(GAME_PROFILE_REGISTRY.has(fixture.id)).toBe(false);
      expect(fixture.visibility).toBe("fixture");
    }
  });
});
