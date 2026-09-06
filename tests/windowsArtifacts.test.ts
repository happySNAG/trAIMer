import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The gate lives in plain .mjs release tooling so `node scripts/...` works
 * with no build step. It is loaded through an explicit file:// URL rather
 * than a bare relative specifier: on Windows a bare specifier to a .mjs
 * outside the Vite root resolves to a bare drive path, which the ESM loader
 * rejects — the suite failed only on the Windows CI runner.
 */
const gate = (await import(
  pathToFileURL(resolve("scripts/verify-windows-artifacts.mjs")).href
)) as {
  IMAGE_FILE_MACHINE_AMD64: number;
  IMAGE_FILE_MACHINE_I386: number;
  MIN_HELPER_BYTES: number;
  MIN_INSTALLER_BYTES: number;
  inspectPortableExecutable: (buffer: Buffer) => {
    sizeBytes: number;
    hasMzHeader: boolean;
    hasPeSignature: boolean;
    peOffset: number | null;
    machine: number | null;
    machineName: string | null;
    isX64: boolean;
    isExecutableImage: boolean;
    isDll: boolean;
    looksLikeSourceText: boolean;
    problems: string[];
  };
  looksLikeSourceText: (buffer: Buffer) => boolean;
  verifyFrontendAssets: (dir: string) => { ok: boolean; problems: string[] };
  verifyHelperBinary: (path: string) => {
    ok: boolean;
    report: { sizeBytes: number; machineName: string | null } | null;
    problems: string[];
  };
  verifyInstalledApp: (dir: string) => { ok: boolean; problems: string[] };
  verifyInstaller: (path: string) => { ok: boolean; problems: string[] };
};

const {
  IMAGE_FILE_MACHINE_AMD64,
  IMAGE_FILE_MACHINE_I386,
  MIN_HELPER_BYTES,
  MIN_INSTALLER_BYTES,
  inspectPortableExecutable,
  looksLikeSourceText,
  verifyFrontendAssets,
  verifyHelperBinary,
  verifyInstalledApp,
  verifyInstaller,
} = gate;

/**
 * Regression suite for the v1.0.0-rc.1 release-blocking defect: the shipped
 * `aldo_capture_helper.exe` was, byte for byte, `aldo_capture_helper.c`.
 * Windows answered "The specified executable is not a valid application for
 * this OS platform." Nothing in the pipeline had ever inspected the bytes.
 *
 * These tests run on ANY host (they are pure byte inspection), so the gate is
 * proven on macOS/Linux long before a Windows runner is involved.
 */

/** Builds a syntactically valid minimal PE image for a given machine type. */
function synthesizePe(options: {
  machine?: number;
  characteristics?: number;
  padTo?: number;
  subsystem?: number;
}): Buffer {
  const machine = options.machine ?? IMAGE_FILE_MACHINE_AMD64;
  const characteristics = options.characteristics ?? 0x0022; // EXECUTABLE_IMAGE | LARGE_ADDRESS_AWARE
  const peOffset = 0x80;
  const optionalHeaderSize = 240;
  const size = Math.max(options.padTo ?? 0, peOffset + 24 + optionalHeaderSize);
  const buffer = Buffer.alloc(size);

  buffer.write("MZ", 0, "latin1");
  // A real DOS stub is mostly binary; emulate that so the printability
  // heuristic does not mistake the fixture for text.
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
  buffer.writeUInt16LE(options.subsystem ?? 3, optional + 68); // console
  return buffer;
}

describe("PE header inspection", () => {
  it("accepts a well-formed 64-bit Windows executable", () => {
    const report = inspectPortableExecutable(synthesizePe({ padTo: 64 * 1024 }));
    expect(report.hasMzHeader).toBe(true);
    expect(report.hasPeSignature).toBe(true);
    expect(report.isX64).toBe(true);
    expect(report.isExecutableImage).toBe(true);
    expect(report.isDll).toBe(false);
    expect(report.machineName).toContain("x64");
    expect(report.problems).toEqual([]);
  });

  it("rejects a 32-bit binary on an AMD64 target", () => {
    const report = inspectPortableExecutable(
      synthesizePe({ machine: IMAGE_FILE_MACHINE_I386, padTo: 64 * 1024 }),
    );
    expect(report.isX64).toBe(false);
    expect(report.problems.join(" ")).toMatch(/wrong architecture/);
  });

  it("rejects a DLL masquerading as the helper", () => {
    const report = inspectPortableExecutable(
      synthesizePe({ characteristics: 0x2022, padTo: 64 * 1024 }),
    );
    expect(report.isDll).toBe(true);
    expect(report.problems.join(" ")).toMatch(/DLL, not an application/);
  });

  it("rejects an MZ stub whose PE signature is missing", () => {
    const buffer = synthesizePe({ padTo: 64 * 1024 });
    buffer.write("XX\0\0", 0x80, "latin1");
    const report = inspectPortableExecutable(buffer);
    expect(report.hasMzHeader).toBe(true);
    expect(report.hasPeSignature).toBe(false);
    expect(report.problems.join(" ")).toMatch(/PE.*signature/);
  });

  it("rejects an e_lfanew pointing past the end of the file", () => {
    const buffer = synthesizePe({ padTo: 64 * 1024 });
    buffer.writeUInt32LE(0x00ff_0000, 0x3c);
    const report = inspectPortableExecutable(buffer);
    expect(report.problems.join(" ")).toMatch(/outside the file/);
  });

  it("rejects an empty file", () => {
    const report = inspectPortableExecutable(Buffer.alloc(0));
    expect(report.hasMzHeader).toBe(false);
    expect(report.problems.join(" ")).toMatch(/empty or truncated/);
  });
});

describe("source-text detection (the exact rc.1 failure mode)", () => {
  it("flags the real native helper C source", () => {
    const source = readFileSync("native/windows/aldo_capture_helper.c");
    expect(looksLikeSourceText(source)).toBe(true);
  });

  it.each([
    ["C source", "/* Aldo Aim Lab — Windows native mouse capture helper.\n"],
    ["preprocessor", "#include <winsock2.h>\n"],
    ["shell script", "#!/usr/bin/env bash\necho hi\n"],
    ["JSON", '{\n  "name": "aldo"\n}\n'],
    ["line comment", "// nothing to see here\n"],
  ])("flags %s", (_label, text) => {
    expect(looksLikeSourceText(Buffer.from(text.repeat(20), "utf8"))).toBe(true);
  });

  it("does not flag a genuine PE image", () => {
    expect(looksLikeSourceText(synthesizePe({ padTo: 64 * 1024 }))).toBe(false);
  });
});

describe("helper release gate", () => {
  it("REJECTS the exact artifact that shipped on the rc.1 USB stick", () => {
    // The rc.1 helper was this file, copied verbatim under the .exe name.
    const result = verifyHelperBinary("native/windows/aldo_capture_helper.c");
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/SOURCE TEXT/);
    expect(result.problems.join(" ")).toMatch(/MZ/);
  });

  it("reports a missing helper rather than passing silently", () => {
    const result = verifyHelperBinary("native/windows/definitely-not-here.exe");
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/missing/);
  });

  it("has an honest minimum-size floor", () => {
    // A compiled Raw Input helper is tens of kilobytes; a few hundred bytes
    // means a stub or a truncated artifact.
    expect(MIN_HELPER_BYTES).toBeGreaterThanOrEqual(8 * 1024);
    expect(MIN_INSTALLER_BYTES).toBeGreaterThanOrEqual(10 * 1024 * 1024);
  });
});

describe("frontend + installed-app gates", () => {
  it("passes on a built dist-app/ and fails on a missing one", () => {
    if (existsSync("dist-app")) {
      expect(verifyFrontendAssets("dist-app").ok).toBe(true);
    }
    const missing = verifyFrontendAssets("dist-app-does-not-exist");
    expect(missing.ok).toBe(false);
    expect(missing.problems.join(" ")).toMatch(/missing/);
  });

  it("fails when the installed application directory is absent", () => {
    const result = verifyInstalledApp("no/such/install");
    expect(result.ok).toBe(false);
  });

  it("fails when the installer file is absent", () => {
    const result = verifyInstaller("no/such/AldoAimLab-Setup.exe");
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/missing/);
  });
});
