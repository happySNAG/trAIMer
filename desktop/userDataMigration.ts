/**
 * Carries a player's training data across the Aldo Aim Lab -> trAIMer rename.
 *
 * Everything the app persists — IndexedDB training history, calibration,
 * settings, diagnostics logs — lives under Electron's userData directory,
 * which is named after the app. Renaming the app therefore points the next
 * launch at an EMPTY directory unless the old one is moved first. A player
 * who installs trAIMer must never open it and find their sessions gone.
 *
 * The decision is a pure function so it can be tested without a filesystem;
 * the apply step is deliberately conservative: move if possible, copy if a
 * move is refused, and if BOTH fail keep using the legacy directory rather
 * than silently starting empty.
 */

export type UserDataPlan =
  /** The trAIMer directory already exists — nothing to do. */
  | { action: "use-current"; dir: string }
  /** Only the legacy directory exists: move it. */
  | { action: "migrate"; from: string; to: string }
  /** Neither exists: a first run. */
  | { action: "fresh"; dir: string };

export interface UserDataPaths {
  currentDir: string;
  legacyDir: string;
  currentExists: boolean;
  legacyExists: boolean;
}

/**
 * Decides what to do with the two candidate directories.
 *
 * Note the ordering: an existing trAIMer directory ALWAYS wins. If both
 * exist, the legacy one is left untouched rather than merged — merging two
 * live Chromium storage trees is not something to attempt silently, and the
 * legacy copy stays on disk as an intact backup.
 */
export function planUserDataMigration(paths: UserDataPaths): UserDataPlan {
  if (paths.currentExists) return { action: "use-current", dir: paths.currentDir };
  if (paths.legacyExists) {
    return { action: "migrate", from: paths.legacyDir, to: paths.currentDir };
  }
  return { action: "fresh", dir: paths.currentDir };
}

export interface MigrationFs {
  existsSync(path: string): boolean;
  renameSync(from: string, to: string): void;
  cpSync(from: string, to: string, options: { recursive: true }): void;
}

export interface MigrationResult {
  /** The directory the app should actually use for userData. */
  dir: string;
  plan: UserDataPlan["action"];
  /** "moved" | "copied" | "none" | "failed-using-legacy" */
  outcome: "moved" | "copied" | "none" | "failed-using-legacy";
  detail: string;
}

/**
 * Applies the plan. Never throws: a migration failure downgrades to "keep
 * using the old directory", which preserves the data even though the folder
 * on disk keeps the old name.
 */
export function migrateUserData(
  paths: UserDataPaths,
  fs: MigrationFs,
): MigrationResult {
  const plan = planUserDataMigration(paths);
  if (plan.action === "use-current") {
    return {
      dir: plan.dir,
      plan: plan.action,
      outcome: "none",
      detail: "trAIMer user data directory already present",
    };
  }
  if (plan.action === "fresh") {
    return {
      dir: plan.dir,
      plan: plan.action,
      outcome: "none",
      detail: "first run: no previous user data to carry over",
    };
  }
  try {
    fs.renameSync(plan.from, plan.to);
    return {
      dir: plan.to,
      plan: plan.action,
      outcome: "moved",
      detail: `moved ${plan.from} to ${plan.to}`,
    };
  } catch (renameErr) {
    try {
      fs.cpSync(plan.from, plan.to, { recursive: true });
      return {
        dir: plan.to,
        plan: plan.action,
        outcome: "copied",
        detail: `copied ${plan.from} to ${plan.to} (move refused: ${describe(renameErr)})`,
      };
    } catch (copyErr) {
      // Both failed. Keeping the legacy directory means the folder still has
      // the old name, but every session the player has ever recorded is still
      // there and still readable. Losing it would be the only unacceptable
      // outcome.
      return {
        dir: plan.from,
        plan: plan.action,
        outcome: "failed-using-legacy",
        detail: `could not migrate user data (${describe(copyErr)}); continuing to use ${plan.from} so nothing is lost`,
      };
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
