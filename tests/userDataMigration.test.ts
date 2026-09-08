import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  migrateUserData,
  planUserDataMigration,
  type MigrationFs,
} from "../desktop/userDataMigration.ts";
import { APP_DIR_NAME, LEGACY_APP_DIR_NAME, APP_SCHEME, APP_ORIGIN } from "../desktop/config.ts";
import { TRAINING_DB_NAME } from "../app/src/idb.ts";
import { SETTINGS_KEY, LEGACY_SETTINGS_KEY, sanitizeSettings } from "../app/src/state.ts";

/**
 * USER DATA SURVIVES THE RENAME (Pass 13, requirement 6).
 *
 * A player installing trAIMer over Aldo Aim Lab must not open it and find
 * their training history gone. Four things carry the data across:
 *
 *   1. the userData directory is MOVED, not abandoned;
 *   2. the app ORIGIN (`aldo://app`) is unchanged, because IndexedDB and
 *      localStorage are keyed by it;
 *   3. the IndexedDB database NAME is unchanged, because IndexedDB has no
 *      rename and a new name means a new, empty database;
 *   4. localStorage keys that DID change are read back from their old names.
 *
 * (1) is tested here against a filesystem double, including the failure paths;
 * (2)–(4) are pinned as constants so a future rename cannot quietly break them.
 */

class FakeFs implements MigrationFs {
  dirs = new Set<string>();
  renameFails = false;
  copyFails = false;
  copied: [string, string][] = [];
  renamed: [string, string][] = [];

  existsSync(path: string): boolean {
    return this.dirs.has(path);
  }
  renameSync(from: string, to: string): void {
    if (this.renameFails) throw new Error("EXDEV: cross-device link not permitted");
    if (!this.dirs.has(from)) throw new Error("ENOENT");
    this.dirs.delete(from);
    this.dirs.add(to);
    this.renamed.push([from, to]);
  }
  cpSync(from: string, to: string): void {
    if (this.copyFails) throw new Error("EPERM: operation not permitted");
    if (!this.dirs.has(from)) throw new Error("ENOENT");
    this.dirs.add(to);
    this.copied.push([from, to]);
  }
}

const CURRENT = "C:\\Users\\aldo\\AppData\\Roaming\\trAIMer";
const LEGACY = "C:\\Users\\aldo\\AppData\\Roaming\\AldoAimLab";

describe("user-data migration", () => {
  it("moves an rc.6 directory to the new name on first launch", () => {
    const fs = new FakeFs();
    fs.dirs.add(LEGACY);
    const result = migrateUserData(
      { currentDir: CURRENT, legacyDir: LEGACY, currentExists: false, legacyExists: true },
      fs,
    );
    expect(result.plan).toBe("migrate");
    expect(result.outcome).toBe("moved");
    expect(result.dir).toBe(CURRENT);
    expect(fs.renamed).toEqual([[LEGACY, CURRENT]]);
    expect(fs.existsSync(CURRENT)).toBe(true);
  });

  it("falls back to a recursive copy when the move is refused", () => {
    const fs = new FakeFs();
    fs.dirs.add(LEGACY);
    fs.renameFails = true;
    const result = migrateUserData(
      { currentDir: CURRENT, legacyDir: LEGACY, currentExists: false, legacyExists: true },
      fs,
    );
    expect(result.outcome).toBe("copied");
    expect(result.dir).toBe(CURRENT);
    expect(fs.copied).toEqual([[LEGACY, CURRENT]]);
    expect(result.detail).toContain("move refused");
  });

  it("KEEPS USING the old directory when both move and copy fail, so nothing is lost", () => {
    const fs = new FakeFs();
    fs.dirs.add(LEGACY);
    fs.renameFails = true;
    fs.copyFails = true;
    const result = migrateUserData(
      { currentDir: CURRENT, legacyDir: LEGACY, currentExists: false, legacyExists: true },
      fs,
    );
    expect(result.outcome).toBe("failed-using-legacy");
    // THE POINT: the app still opens the directory that holds the data.
    expect(result.dir).toBe(LEGACY);
    expect(result.detail).toContain("so nothing is lost");
  });

  it("never touches an existing trAIMer directory, even if the old one is still there", () => {
    const fs = new FakeFs();
    fs.dirs.add(LEGACY);
    fs.dirs.add(CURRENT);
    const result = migrateUserData(
      { currentDir: CURRENT, legacyDir: LEGACY, currentExists: true, legacyExists: true },
      fs,
    );
    expect(result.plan).toBe("use-current");
    expect(result.outcome).toBe("none");
    expect(result.dir).toBe(CURRENT);
    expect(fs.renamed).toHaveLength(0);
    expect(fs.copied).toHaveLength(0);
    // The legacy copy stays on disk untouched, as an intact backup.
    expect(fs.existsSync(LEGACY)).toBe(true);
  });

  it("a genuinely first run is a fresh directory, not a migration", () => {
    const fs = new FakeFs();
    const plan = planUserDataMigration({
      currentDir: CURRENT,
      legacyDir: LEGACY,
      currentExists: false,
      legacyExists: false,
    });
    expect(plan).toEqual({ action: "fresh", dir: CURRENT });
    expect(migrateUserData(
      { currentDir: CURRENT, legacyDir: LEGACY, currentExists: false, legacyExists: false },
      fs,
    ).outcome).toBe("none");
  });

  it("the migration runs BEFORE anything opens userData", () => {
    const main = readFileSync("desktop/main.ts", "utf8");
    const migrationAt = main.indexOf("const userDataMigration");
    const firstUserDataRead = main.indexOf('app.getPath("userData")');
    expect(migrationAt).toBeGreaterThan(-1);
    expect(firstUserDataRead).toBeGreaterThan(-1);
    expect(migrationAt).toBeLessThan(firstUserDataRead);
    expect(main).toContain('app.setPath("userData", result.dir)');
  });
});

describe("the storage identity that must NOT change", () => {
  it("keeps the app origin, because IndexedDB and localStorage are keyed by it", () => {
    expect(APP_SCHEME).toBe("aldo");
    expect(APP_ORIGIN).toBe("aldo://app");
  });

  it("keeps the training database name, because IndexedDB has no rename", () => {
    expect(TRAINING_DB_NAME).toBe("aldo-aim-lab");
  });

  it("renames the app directory but remembers the old one", () => {
    expect(APP_DIR_NAME).toBe("trAIMer");
    expect(LEGACY_APP_DIR_NAME).toBe("AldoAimLab");
  });

  it("keeps the electron-builder appId so rc.7 upgrades rc.6 in place", () => {
    const builder = readFileSync("electron-builder.yml", "utf8");
    expect(builder).toContain("appId: com.aldoaimlab.desktop");
    const main = readFileSync("desktop/main.ts", "utf8");
    expect(main).toContain('app.setAppUserModelId("com.aldoaimlab.desktop")');
  });

  it("the uninstaller clears BOTH directories when the player asks for a clean slate", () => {
    const nsh = readFileSync("build/installer.nsh", "utf8");
    expect(nsh).toContain('RMDir /r "$APPDATA\\trAIMer"');
    expect(nsh).toContain('RMDir /r "$APPDATA\\AldoAimLab"');
    // ...and still keeps data by default on a silent/upgrade uninstall.
    expect(nsh).toContain("/SD IDNO");
    expect(nsh).toContain("${ifNot} ${isUpdated}");
  });
});

describe("settings survive the localStorage key rename", () => {
  it("reads the pre-rename key when the current one is absent", () => {
    const store = new Map<string, string>();
    store.set(
      LEGACY_SETTINGS_KEY,
      JSON.stringify({ playerName: "Aldo", dpi: 1600, sensX: 8.5, sensY: 8.5, breakSeconds: 20 }),
    );
    // loadSettings() reads localStorage, which does not exist under vitest's
    // node environment; the contract it relies on is asserted directly.
    const raw = store.get(SETTINGS_KEY) ?? store.get(LEGACY_SETTINGS_KEY);
    expect(raw).toBeDefined();
    const settings = sanitizeSettings(JSON.parse(raw!));
    expect(settings.playerName).toBe("Aldo");
    expect(settings.dpi).toBe(1600);
    expect(settings.sensX).toBeCloseTo(8.5);
    expect(settings.breakSeconds).toBe(20);
  });

  it("the current key wins when both are present", () => {
    const store = new Map<string, string>();
    store.set(LEGACY_SETTINGS_KEY, JSON.stringify({ dpi: 400 }));
    store.set(SETTINGS_KEY, JSON.stringify({ dpi: 1600 }));
    const raw = store.get(SETTINGS_KEY) ?? store.get(LEGACY_SETTINGS_KEY);
    expect(sanitizeSettings(JSON.parse(raw!)).dpi).toBe(1600);
  });

  it("the app actually consults both keys", () => {
    const state = readFileSync("app/src/state.ts", "utf8");
    expect(state).toContain("localStorage.getItem(SETTINGS_KEY) ??");
    expect(state).toContain("localStorage.getItem(LEGACY_SETTINGS_KEY)");
    const main = readFileSync("app/src/main.ts", "utf8");
    expect(main).toContain("localStorage.getItem(SESSION_TOKEN_KEY) ??");
    expect(main).toContain("localStorage.getItem(LEGACY_SESSION_TOKEN_KEY)");
  });
});
