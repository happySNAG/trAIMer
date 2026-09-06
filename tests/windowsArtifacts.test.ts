import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Regression suite for the v1.0.0-rc.1 release-blocking defect: the shipped
 * `aldo_capture_helper.exe` was, byte for byte, `aldo_capture_helper.c`.
 * Windows answered "The specified executable is not a valid application for
 * this OS platform." Nothing in the pipeline had ever inspected the bytes.
 *
 * The gate is exercised the way CI and the packager actually invoke it — as
 * the `node scripts/verify-windows-artifacts.mjs` command line — so these
 * tests cover the real entry point rather than internals that could drift
 * from it. (Importing the .mjs directly also fails to load under vitest on
 * Windows, and the repo's other script-facing suite works around that by
 * keeping a hand-copied "mirror" of the script's logic — a mirror cannot
 * fail when the script does.)
 *
 * Everything here is pure byte inspection, so the gate is proven on macOS and
 * Linux long before a Windows runner is involved.
 */

const SCRIPT = "scripts/verify-windows-artifacts.mjs";
const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const IMAGE_FILE_MACHINE_I386 = 0x014c;

interface GateResult {
  ok: boolean;
  output: string;
}

/** Runs the gate CLI. Never throws: a non-zero exit is the thing under test. */
function runGate(...args: string[]): GateResult {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: stdout };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${err.stdout ?? ""}\n${err.stderr ?? ""}` };
  }
}

/** Builds a syntactically valid minimal PE image for a given machine type. */
function synthesizePe(
  options: { machine?: number; characteristics?: number; padTo?: number } = {},
): Buffer {
  const machine = options.machine ?? IMAGE_FILE_MACHINE_AMD64;
  // EXECUTABLE_IMAGE | LARGE_ADDRESS_AWARE
  const characteristics = options.characteristics ?? 0x0022;
  const peOffset = 0x80;
  const optionalHeaderSize = 240;
  const size = Math.max(options.padTo ?? 0, peOffset + 24 + optionalHeaderSize);
  const buffer = Buffer.alloc(size);

  buffer.write("MZ", 0, "latin1");
  // A real DOS stub is mostly binary; emulate that so the printability
  // heuristic does not mistake the fixture for source text.
  for (let i = 2; i < 0x3c; i++) buffer[i] = i % 7 === 0 ? 0x00 : 0x90;
  buffer.writeUInt32LE(peOffset, 0x3c);

  buffer.write("PE\0\0", peOffset, "latin1");
  const coff = peOffset + 4;
  buffer.writeUInt16LE(machine, coff);
  buffer.writeUInt16LE(4, coff + 2); // NumberOfSections
  buffer.writeUInt16LE(optionalHeaderSize, coff + 16);
  buffer.writeUInt16LE(characteristics, coff + 18);

  const optional = coff + 20;
  buffer.writeUInt16LE(0x20b, optional); // PE32+
  buffer.writeUInt16LE(3, optional + 68); // console subsystem
  return buffer;
}

let workDir: string;
const fixture = (name: string, contents: Buffer | string): string => {
  const path = join(workDir, name);
  writeFileSync(path, contents);
  return path;
};

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "aldo-gate-"));
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("helper release gate", () => {
  it("accepts a well-formed 64-bit Windows executable", () => {
    const path = fixture("good.exe", synthesizePe({ padTo: 64 * 1024 }));
    const result = runGate("--helper", path);
    expect(result.output).toContain("x64 (AMD64)");
    expect(result.ok).toBe(true);
  });

  it("REJECTS the exact artifact that shipped on the rc.1 USB stick", () => {
    // rc.1's aldo_capture_helper.exe was this file, copied verbatim.
    const result = runGate("--helper", "native/windows/aldo_capture_helper.c");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("SOURCE TEXT");
    expect(result.output).toContain("MZ");
  });

  it("rejects a 32-bit binary on an AMD64 target", () => {
    const path = fixture(
      "x86.exe",
      synthesizePe({ machine: IMAGE_FILE_MACHINE_I386, padTo: 64 * 1024 }),
    );
    const result = runGate("--helper", path);
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/wrong architecture/);
  });

  it("rejects a DLL masquerading as the helper", () => {
    const path = fixture(
      "lib.exe",
      synthesizePe({ characteristics: 0x2022, padTo: 64 * 1024 }),
    );
    const result = runGate("--helper", path);
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/DLL, not an application/);
  });

  it("rejects an MZ stub whose PE signature is missing", () => {
    const buffer = synthesizePe({ padTo: 64 * 1024 });
    buffer.write("XX\0\0", 0x80, "latin1");
    const result = runGate("--helper", fixture("stub.exe", buffer));
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/signature/);
  });

  it("rejects an e_lfanew pointing past the end of the file", () => {
    const buffer = synthesizePe({ padTo: 64 * 1024 });
    buffer.writeUInt32LE(0x00ff_0000, 0x3c);
    const result = runGate("--helper", fixture("lfanew.exe", buffer));
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/outside the file/);
  });

  it("rejects an empty file", () => {
    const result = runGate("--helper", fixture("empty.exe", Buffer.alloc(0)));
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/zero bytes|empty or truncated/);
  });

  it("rejects a real PE that is implausibly small", () => {
    // Structurally valid but far below any compiled Raw Input helper.
    const result = runGate("--helper", fixture("tiny.exe", synthesizePe()));
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/implausibly small/);
  });

  it.each([
    ["c-source", "/* Aldo Aim Lab — Windows native mouse capture helper.\n"],
    ["preprocessor", "#include <winsock2.h>\n"],
    ["shell-script", "#!/usr/bin/env bash\necho hi\n"],
    ["json", '{\n  "name": "aldo"\n}\n'],
    ["line-comment", "// nothing to see here\n"],
  ])("rejects %s wearing an .exe name", (name, text) => {
    const path = fixture(`${name}.exe`, text.repeat(400));
    const result = runGate("--helper", path);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("SOURCE TEXT");
  });

  it("reports a missing helper rather than passing silently", () => {
    const result = runGate("--helper", join(workDir, "definitely-not-here.exe"));
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/missing/);
  });
});

describe("frontend, installer and installed-app gates", () => {
  it("fails when the frontend directory is absent", () => {
    const result = runGate("--frontend", join(workDir, "no-dist"));
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/missing/);
  });

  it("fails when the installer file is absent", () => {
    const result = runGate("--installer", join(workDir, "AldoAimLab-Setup.exe"));
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/missing/);
  });

  it("fails an installer that is a real PE but implausibly small", () => {
    const path = fixture("Setup.exe", synthesizePe({ padTo: 64 * 1024 }));
    const result = runGate("--installer", path);
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/implausibly small/);
  });

  it("fails when the installed application directory is absent", () => {
    const result = runGate("--installed-app", join(workDir, "no-install"));
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/missing/);
  });

  it("refuses to pass when given nothing to check", () => {
    const result = runGate();
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/nothing to verify/);
  });
});
