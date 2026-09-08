import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { GAME_PROFILE_REGISTRY } from "../src/games/index.ts";
import { ARCHITECTURE_FIXTURE_PROFILES } from "../src/games/fixtures.ts";
import { PUBLIC_GAME_PROFILES } from "../src/games/profiles/index.ts";

/**
 * Architectural boundaries around the game-profile layer
 * (Game Profile Pass 1, requirements 1, 13, 21, 27).
 *
 * Three of them, all statically enforced so drift fails CI rather than
 * surfacing later as a wrong number or a banned behaviour:
 *
 *  1. the MEASUREMENT engine never imports a game profile;
 *  2. the game layer never touches a game — no processes, no memory, no
 *     files, no input injection, no network;
 *  3. this pass ships exactly one public profile.
 */

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTs(full));
    else if (full.endsWith(".ts")) out.push(full.split(sep).join("/"));
  }
  return out;
}

const read = (path: string): string => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

/**
 * Every part of `src/**` that decides what a measurement MEANS. None of it
 * may know a game exists (requirement 1).
 */
const MEASUREMENT_DIRS = [
  "src/analysis",
  "src/calibration",
  "src/campaigns",
  "src/capture",
  "src/confidence",
  "src/diagnostics",
  "src/domain",
  "src/experiments",
  "src/metrics",
  "src/optimizer",
  "src/results",
  "src/scenarios",
  "src/sensmath",
  "src/sim",
  "src/validation",
];

describe("the measurement core stays game-agnostic (requirement 1)", () => {
  it("no measurement module imports the game-profile layer", () => {
    const offenders: string[] = [];
    for (const dir of MEASUREMENT_DIRS) {
      for (const file of listTs(dir)) {
        if (/from\s+"[^"]*games\//.test(read(file))) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the two modules that DO know about game records import them as records only", () => {
    // The persisted session record carries an optional conversion field, and
    // the History API reads it back. Both are storage concerns; neither feeds
    // a measurement.
    const humanSession = read("src/session/humanSession.ts");
    expect(humanSession).toContain('import type { SessionGameConversionRecord }');
    // Type-only: nothing from the game layer exists at runtime in this module.
    expect(/^import\s+\{[^}]*\}\s+from\s+"\.\.\/games\//m.test(humanSession)).toBe(false);

    const history = read("src/history/api.ts");
    expect(history).toContain("readSessionGameConversionRecord");
    // ...and it is only ever used to READ, never to convert.
    expect(history).not.toContain("gameSettingsFromCanonical");
    expect(history).not.toContain("buildGameRecommendationExport");
  });

  it("the game layer never reaches back into the optimizer or the session runner", () => {
    for (const file of listTs("src/games")) {
      const src = read(file);
      expect(/from\s+"\.\.\/optimizer\//.test(src), file).toBe(false);
      expect(/from\s+"\.\.\/session\//.test(src), file).toBe(false);
      expect(/from\s+"\.\.\/scenarios\//.test(src), file).toBe(false);
      expect(/from\s+"\.\.\/capture\//.test(src), file).toBe(false);
    }
  });
});

describe("safety boundary — profiles are informational only (requirement 21)", () => {
  const GAME_LAYER = [
    ...listTs("src/games"),
    "app/src/gameProfileView.ts",
    "app/src/gameConversionBridge.ts",
  ];

  /**
   * Anything that would let trAIMer touch a running game, its files, or its
   * input. The product tells the player what to set; the player sets it.
   */
  const FORBIDDEN: [string, RegExp][] = [
    ["child process", /child_process|spawn\s*\(|execFile|execSync/],
    ["filesystem access", /\bnode:fs\b|require\(["']fs["']\)|readFileSync|writeFileSync/],
    ["process memory", /ReadProcessMemory|WriteProcessMemory|OpenProcess|VirtualAlloc/],
    ["input injection", /SendInput|keybd_event|mouse_event|robotjs|\.dispatchEvent\s*\(/],
    ["window/process hooking", /SetWindowsHookEx|FindWindow|GetForegroundWindow|inject/i],
    ["network", /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/],
    ["shell", /\bexec\s*\(\s*["'`]|powershell|cmd\.exe/i],
  ];

  it("contains none of the capabilities anti-cheat exists to stop", () => {
    const offenders: string[] = [];
    for (const file of GAME_LAYER) {
      const src = read(file);
      for (const [name, pattern] of FORBIDDEN) {
        if (pattern.test(src)) offenders.push(`${file}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no public profile ships a game file path or config location to edit", () => {
    for (const profile of GAME_PROFILE_REGISTRY.list()) {
      const serialized = JSON.stringify(profile);
      expect(serialized).not.toMatch(/[A-Za-z]:\\\\/); // Windows path
      expect(serialized).not.toContain("%APPDATA%");
      expect(serialized).not.toContain("Program Files");
    }
  });

  it("makes no network request for provenance URLs", () => {
    // A source URL is displayed text. Nothing in the layer can fetch it; a
    // named game cites one (https only), the control and the fixtures none.
    for (const profile of [...PUBLIC_GAME_PROFILES, ...ARCHITECTURE_FIXTURE_PROFILES]) {
      if (profile.source.url !== null) {
        expect(profile.source.type).not.toBe("unit-definition");
        expect(profile.source.url).toMatch(/^https:\/\/[^\s"']+$/);
      }
    }
    for (const fixture of ARCHITECTURE_FIXTURE_PROFILES) {
      expect(fixture.source.url).toBeNull();
    }
  });

  it("the no-telemetry audit only exempts URLs a profile actually declares", () => {
    const audit = read("scripts/audit-no-telemetry.mjs");
    expect(audit).toContain("profileUrlAllowlist");
    expect(audit).toContain("src/games/profiles");
    // The allowlist is derived from the profile sources, never hand-written.
    expect(audit).not.toMatch(/profileUrlAllowlist\.add\("https:/);
  });
});

describe("the public profile set (Pass 2, requirement 8)", () => {
  it("the public list is the five named games and the generic/raw control", () => {
    expect(PUBLIC_GAME_PROFILES.map((p) => p.id)).toEqual([
      "apex-legends",
      "battlefield-6",
      "call-of-duty-warzone",
      "counter-strike-2",
      "fortnite",
      "marvel-rivals",
      "overwatch-2",
      "pubg-battlegrounds",
      "rainbow-six-siege",
      "the-finals",
      "valorant",
      "generic-raw",
    ]);
  });

  it("no fixture is reachable through the public registry", () => {
    const publicIds = new Set(GAME_PROFILE_REGISTRY.ids());
    for (const fixture of ARCHITECTURE_FIXTURE_PROFILES) {
      expect(publicIds.has(fixture.id)).toBe(false);
    }
  });

  it("fixtures live in their own module, never in the profiles directory", () => {
    const profileFiles = listTs("src/games/profiles");
    expect(profileFiles.sort()).toEqual([
      "src/games/profiles/apexLegends.ts",
      "src/games/profiles/battlefield6.ts",
      "src/games/profiles/callOfDutyWarzone.ts",
      "src/games/profiles/counterStrike2.ts",
      "src/games/profiles/fortnite.ts",
      "src/games/profiles/generic.ts",
      "src/games/profiles/index.ts",
      "src/games/profiles/marvelRivals.ts",
      "src/games/profiles/overwatch2.ts",
      "src/games/profiles/pubg.ts",
      "src/games/profiles/rainbowSixSiege.ts",
      "src/games/profiles/theFinals.ts",
      "src/games/profiles/valorant.ts",
    ]);
    for (const file of profileFiles) {
      expect(read(file)).not.toContain("fixture");
    }
  });

  it("the fixtures module is not imported by any shipped view", () => {
    for (const file of listTs("app/src")) {
      expect(read(file).includes("games/fixtures"), file).toBe(false);
    }
  });
});

describe("player-facing language (requirement 22)", () => {
  it("keeps conversion-engine jargon out of profile labels and definitions", () => {
    const jargon = ["canonical", "deg/count", "degreesPerCm", "elasticity", "quantize"];
    for (const profile of GAME_PROFILE_REGISTRY.list()) {
      const visible = [
        profile.displayName,
        profile.hipfireField.label,
        profile.unitDefinition,
        ...profile.knownEdgeCases,
        ...profile.warnings,
      ].join(" ");
      for (const word of jargon) {
        expect(visible.toLowerCase(), profile.id).not.toContain(word.toLowerCase());
      }
    }
  });

  it("says trAIMer and never the pre-rename product name", () => {
    for (const file of listTs("src/games")) {
      const src = read(file);
      expect(src.includes("Aldo Aim Lab"), file).toBe(false);
      expect(src.includes("AldoAimLab"), file).toBe(false);
    }
  });
});
