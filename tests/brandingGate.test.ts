import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRODUCT = "trAIMer";
const TAGLINE = "Train. Measure. Tune.";


/**
 * THE BRANDING GATE ITSELF (Pass 13, requirement 7).
 *
 * rc.6 was already being called trAIMer in release material while the
 * installer, the installed executable, the shortcut, the window title, the
 * sidebar wordmark and the Apps & Features entry all still said Aldo Aim Lab.
 * `scripts/verify-branding.mjs` makes that a build failure — so it has to be
 * proven to FAIL on the things it claims to catch, not merely to pass today.
 */

interface BrandingContract {
  productName: string;
  tagline: string;
  patterns: string[];
  allowed: { file: string; text: string; reason: string }[];
}

/**
 * The gate's own contract, read across a PROCESS boundary as JSON.
 *
 * Importing the `.mjs` directly resolved fine on Linux and macOS and failed to
 * parse at all on the Windows CI runners; the release gate should not inherit
 * a toolchain quirk from the suite that checks it.
 */
function contract(): BrandingContract {
  const out = execFileSync(
    process.execPath,
    ["scripts/verify-branding.mjs", "--print-contract"],
    { encoding: "utf8" },
  );
  return JSON.parse(out) as BrandingContract;
}

function classify(ext: string, line: string): boolean {
  const out = execFileSync(
    process.execPath,
    ["scripts/verify-branding.mjs", "--classify", ext, "--line", line],
    { encoding: "utf8" },
  );
  return (JSON.parse(out) as { comment: boolean }).comment;
}

function runGate(...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(
      process.execPath,
      ["scripts/verify-branding.mjs", ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("the gate passes on the current tree", () => {
  it("sources and player-facing docs are clean", () => {
    const result = runGate();
    expect(result.out).toContain("PASS");
    expect(result.code).toBe(0);
  });

  it("every documented survival names a file, a string and a reason", () => {
    const { allowed } = contract();
    expect(allowed.length).toBeGreaterThan(0);
    for (const entry of allowed) {
      expect(entry.file.length).toBeGreaterThan(0);
      expect(entry.text.length).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(40);
      // The file it exempts must exist, or the exemption is stale.
      expect(() => readFileSync(entry.file, "utf8")).not.toThrow();
      // And the string it exempts must actually be there.
      expect(readFileSync(entry.file, "utf8")).toContain(entry.text.replace(/\\\\/g, "\\"));
    }
  });
});

describe("the gate fails on a shipped bundle that still says the old name", () => {
  function bundleDir(html: string, js: string): string {
    const dir = mkdtempSync(join(tmpdir(), "branding-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), html);
    writeFileSync(join(dir, "assets", "index.js"), js);
    return dir;
  }

  it("catches the legacy product name in the built JavaScript", () => {
    const dir = bundleDir(
      `<title>${PRODUCT}</title>`,
      'const brand = "Aldo Aim Lab";',
    );
    const result = runGate("--bundle", dir);
    expect(result.code).toBe(1);
    expect(result.out).toContain("Aldo Aim Lab");
  });

  it("catches a shipped page that never mentions the product at all", () => {
    const dir = bundleDir("<title>App</title>", "const x = 1;");
    const result = runGate("--bundle", dir);
    expect(result.code).toBe(1);
    expect(result.out).toContain(`does not mention "${PRODUCT}"`);
  });

  it("passes a correctly branded bundle", () => {
    const dir = bundleDir(
      `<title>${PRODUCT}</title><p>${TAGLINE}</p>`,
      'const brand = "trAIMer";',
    );
    expect(runGate("--bundle", dir).code).toBe(0);
  });
});

describe("the gate fails on a legacy-named installer or installed layout", () => {
  it("rejects an installer still called AldoAimLab-Setup", () => {
    const dir = mkdtempSync(join(tmpdir(), "branding-inst-"));
    const file = join(dir, "AldoAimLab-Setup-1.0.0-rc.7.exe");
    writeFileSync(file, "MZ");
    const result = runGate("--installer", file);
    expect(result.code).toBe(1);
    expect(result.out).toContain(`must start with "${PRODUCT}-Setup"`);
  });

  it("accepts the trAIMer installer filename", () => {
    const dir = mkdtempSync(join(tmpdir(), "branding-inst2-"));
    const file = join(dir, `${PRODUCT}-Setup-1.0.0-rc.7.exe`);
    writeFileSync(file, "MZ");
    expect(runGate("--installer", file).code).toBe(0);
  });

  it("rejects an installed app whose executable still carries the old name", () => {
    const dir = mkdtempSync(join(tmpdir(), "branding-app-"));
    writeFileSync(join(dir, "Aldo Aim Lab.exe"), "MZ");
    mkdirSync(join(dir, "resources"));
    writeFileSync(join(dir, "resources", "aldo_capture_helper.exe"), "MZ");
    const result = runGate("--installed-app", dir);
    expect(result.code).toBe(1);
    expect(result.out).toContain(`missing ${PRODUCT}.exe`);
    expect(result.out).toContain("legacy-named file");
  });

  it("accepts a correctly named installed layout", () => {
    const dir = mkdtempSync(join(tmpdir(), "branding-app2-"));
    writeFileSync(join(dir, `${PRODUCT}.exe`), "MZ");
    mkdirSync(join(dir, "resources"));
    writeFileSync(join(dir, "resources", "traimer_capture_helper.exe"), "MZ");
    expect(runGate("--installed-app", dir).code).toBe(0);
  });
});

describe("historical accuracy is preserved", () => {
  it("the pass reports still say what the product was called at the time", () => {
    const pass12 = readFileSync("PASS-12-REPORT.md", "utf8");
    expect(pass12).toContain("Aldo Aim Lab");
    // ...and the gate does not care, because history is out of scope.
    expect(runGate().code).toBe(0);
  });

  it("source comments may narrate the rename; strings may not carry it", () => {
    expect(classify(".ts", "// rc.6 was called Aldo Aim Lab")).toBe(true);
    expect(classify(".ts", " * Renamed from Aldo Aim Lab")).toBe(true);
    expect(classify(".ts", 'const name = "Aldo Aim Lab";')).toBe(false);
    expect(classify(".nsh", "; NSIS comment")).toBe(true);
    expect(classify(".yml", "# yaml comment")).toBe(true);
  });

  it("the patterns it hunts for are the ones the pass named, and the brand is right", () => {
    const c = contract();
    expect(c.patterns).toContain("Aldo Aim Lab");
    expect(c.patterns).toContain("AldoAimLab");
    expect(c.productName).toBe("trAIMer");
    expect(c.tagline).toBe("Train. Measure. Tune.");
  });
});
