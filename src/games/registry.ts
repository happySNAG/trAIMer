/**
 * The central game-profile registry (Game Profile Pass 1, requirements 8, 20).
 *
 * One place resolves a profile id to a profile. There is no switch statement
 * on a game name anywhere in the app, and adding a profile in a later pass is
 * a one-line change to the array in `profiles/index.ts` plus the profile file
 * itself.
 *
 * The registry FAILS CLOSED: it validates every profile as it loads, refuses
 * duplicate ids, refuses foreign schema versions, and throws rather than
 * silently dropping a bad profile. A profile that cannot be trusted must not
 * be able to produce a sensitivity recommendation (requirement 9).
 */

import {
  GAME_PROFILE_SCHEMA_VERSION,
  profileRef,
  type GameProfile,
  type ProfileStatus,
  type ProfileVisibility,
} from "./profileSchema.ts";
import {
  validateGameProfile,
  type ProfileIssue,
  type ProfileValidation,
} from "./validate.ts";

export interface RegistryProblem {
  readonly profileId: string;
  readonly issues: readonly ProfileIssue[];
}

export class GameProfileRegistryError extends Error {
  readonly problems: readonly RegistryProblem[];
  constructor(problems: readonly RegistryProblem[]) {
    super(
      "game profile registry refused to load: " +
        problems
          .map(
            (p) =>
              `${p.profileId} [${p.issues
                .filter((i) => i.severity === "error")
                .map((i) => `${i.path}: ${i.message}`)
                .join("; ")}]`,
          )
          .join(" | "),
    );
    this.name = "GameProfileRegistryError";
    this.problems = problems;
  }
}

export interface ProfileFilter {
  readonly status?: ProfileStatus | readonly ProfileStatus[] | undefined;
  readonly visibility?: ProfileVisibility | undefined;
  /** Excludes deprecated profiles. Defaults to false (everything is listed). */
  readonly excludeDeprecated?: boolean | undefined;
}

/** How a saved selection relates to the profile the registry holds today. */
export type SelectionCompatibility =
  | { readonly status: "ok"; readonly profile: GameProfile }
  | {
      readonly status: "profile-updated";
      readonly profile: GameProfile;
      readonly savedVersion: number;
      readonly currentVersion: number;
      readonly message: string;
    }
  | {
      readonly status: "profile-newer-than-build";
      readonly profile: GameProfile;
      readonly savedVersion: number;
      readonly currentVersion: number;
      readonly message: string;
    }
  | {
      readonly status: "profile-deprecated";
      readonly profile: GameProfile;
      readonly replacement: GameProfile | null;
      readonly message: string;
    }
  | { readonly status: "unknown-profile"; readonly message: string };

export class GameProfileRegistry {
  readonly #byId: ReadonlyMap<string, GameProfile>;
  readonly #order: readonly string[];
  readonly #validations: ReadonlyMap<string, ProfileValidation>;

  private constructor(
    byId: Map<string, GameProfile>,
    order: string[],
    validations: Map<string, ProfileValidation>,
  ) {
    this.#byId = byId;
    this.#order = order;
    this.#validations = validations;
  }

  /**
   * Builds a registry, or throws. Every profile is validated; duplicate ids,
   * foreign schema versions and validation errors all refuse the whole load
   * rather than quietly shipping a partial registry.
   */
  static create(profiles: readonly GameProfile[]): GameProfileRegistry {
    const result = GameProfileRegistry.tryCreate(profiles);
    if (!result.registry) throw new GameProfileRegistryError(result.problems);
    return result.registry;
  }

  /** Non-throwing form, for tooling that wants to report every problem. */
  static tryCreate(profiles: readonly GameProfile[]): {
    registry: GameProfileRegistry | null;
    problems: readonly RegistryProblem[];
    validations: readonly ProfileValidation[];
  } {
    const byId = new Map<string, GameProfile>();
    const order: string[] = [];
    const validations = new Map<string, ProfileValidation>();
    const problems: RegistryProblem[] = [];

    for (const profile of profiles) {
      const id = typeof profile?.id === "string" ? profile.id : "<no id>";
      if (profile?.schemaVersion !== GAME_PROFILE_SCHEMA_VERSION) {
        problems.push({
          profileId: id,
          issues: [
            {
              severity: "error",
              path: "schemaVersion",
              message: `profile declares schemaVersion ${String(profile?.schemaVersion)}; this build reads ${GAME_PROFILE_SCHEMA_VERSION}`,
            },
          ],
        });
        continue;
      }
      if (byId.has(id)) {
        problems.push({
          profileId: id,
          issues: [
            {
              severity: "error",
              path: "id",
              message: `duplicate profile id "${id}" — ids are the persistence key and must be unique`,
            },
          ],
        });
        continue;
      }
      const validation = validateGameProfile(profile);
      validations.set(id, validation);
      if (!validation.valid) {
        problems.push({ profileId: id, issues: validation.issues });
        continue;
      }
      byId.set(id, profile);
      order.push(id);
    }

    // A successor named by a deprecated profile must actually exist, or the
    // migration message would point a player at nothing.
    for (const id of order) {
      const profile = byId.get(id)!;
      if (profile.supersededByProfileId && !byId.has(profile.supersededByProfileId)) {
        problems.push({
          profileId: id,
          issues: [
            {
              severity: "error",
              path: "supersededByProfileId",
              message: `names a replacement profile "${profile.supersededByProfileId}" that this registry does not contain`,
            },
          ],
        });
      }
    }

    if (problems.length > 0) {
      return { registry: null, problems, validations: [...validations.values()] };
    }
    return {
      registry: new GameProfileRegistry(byId, order, validations),
      problems: [],
      validations: [...validations.values()],
    };
  }

  /** Deterministic lookup. Returns null for an unknown id — never throws. */
  get(id: string): GameProfile | null {
    return this.#byId.get(id) ?? null;
  }

  /** Lookup that throws; use where a missing profile is a programming error. */
  require(id: string): GameProfile {
    const profile = this.get(id);
    if (!profile) throw new GameProfileRegistryError([
      { profileId: id, issues: [{ severity: "error", path: "id", message: "no such profile" }] },
    ]);
    return profile;
  }

  has(id: string): boolean {
    return this.#byId.has(id);
  }

  /** Ids in registration order — stable across runs. */
  ids(): readonly string[] {
    return this.#order;
  }

  /** Profiles, filtered, always in registration order. */
  list(filter: ProfileFilter = {}): readonly GameProfile[] {
    const statuses =
      filter.status === undefined
        ? null
        : Array.isArray(filter.status)
          ? filter.status
          : [filter.status as ProfileStatus];
    return this.#order
      .map((id) => this.#byId.get(id)!)
      .filter((p) => (statuses ? statuses.includes(p.status) : true))
      .filter((p) => (filter.visibility ? p.visibility === filter.visibility : true))
      .filter((p) => (filter.excludeDeprecated ? p.status !== "deprecated" : true));
  }

  /** The profiles a player may pick from today. */
  selectable(): readonly GameProfile[] {
    return this.list({ visibility: "public", excludeDeprecated: true });
  }

  /** Validation result for one profile (warnings included). */
  validationFor(id: string): ProfileValidation | null {
    return this.#validations.get(id) ?? null;
  }

  /**
   * Relates a SAVED selection to the profile as it exists now
   * (requirements 17 and 20).
   *
   * A profile-version bump is never applied silently: the caller is told the
   * definition changed so it can say so rather than reinterpret an old
   * recommendation under new arithmetic.
   */
  checkSelection(saved: {
    profileId: string;
    profileVersion: number;
  }): SelectionCompatibility {
    const profile = this.get(saved.profileId);
    if (!profile) {
      return {
        status: "unknown-profile",
        message: `This build has no profile called "${saved.profileId}". Its saved values are kept but cannot be converted.`,
      };
    }
    if (profile.status === "deprecated") {
      const replacement = profile.supersededByProfileId
        ? this.get(profile.supersededByProfileId)
        : null;
      return {
        status: "profile-deprecated",
        profile,
        replacement,
        message: replacement
          ? `The ${profile.displayName} profile is no longer maintained. ${profile.deprecationNote ?? ""} Use ${replacement.displayName} instead.`.replace(/\s+/g, " ").trim()
          : `The ${profile.displayName} profile is no longer maintained. ${profile.deprecationNote ?? ""}`.trim(),
      };
    }
    if (saved.profileVersion > profile.profileVersion) {
      return {
        status: "profile-newer-than-build",
        profile,
        savedVersion: saved.profileVersion,
        currentVersion: profile.profileVersion,
        message: `Your saved ${profile.displayName} settings were made under conversion definition v${saved.profileVersion}, which is newer than the v${profile.profileVersion} this build knows. They are shown unchanged and not re-converted.`,
      };
    }
    if (saved.profileVersion < profile.profileVersion) {
      return {
        status: "profile-updated",
        profile,
        savedVersion: saved.profileVersion,
        currentVersion: profile.profileVersion,
        message: `Your saved ${profile.displayName} values were created under conversion definition v${saved.profileVersion}; this build uses v${profile.profileVersion}. Re-run the conversion to get values under the current definition — the saved ones are left as they were.`,
      };
    }
    return { status: "ok", profile };
  }

  /** Human-readable identity for logs: "generic-raw@v1, fixture-…@v2". */
  describe(): string {
    return this.list()
      .map((p) => profileRef(p))
      .join(", ");
  }
}
