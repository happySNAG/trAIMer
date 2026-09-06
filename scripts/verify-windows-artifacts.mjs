#!/usr/bin/env node
/**
 * Windows release gates (Pass 9).
 *
 * The v1.0.0-rc.1 USB build shipped `aldo_capture_helper.exe` that was, byte
 * for byte, the C SOURCE FILE — Windows refused it with "not a valid
 * application for this OS platform". Nothing in the pipeline ever looked at
 * the bytes it was packaging. This module is that missing check, and it is
 * wired into both the packager and CI.
 *
 * Gates implemented here (all fail-closed, non-zero exit):
 *   - helper present
 *   - helper is not source text (the exact rc.1 failure)
 *   - helper is not zero/implausibly small
 *   - helper is a real PE: MZ header, PE\0\0 signature, machine = AMD64,
 *     executable image, not a DLL
 *   - installer present and of plausible size
 *   - required frontend assets present
 *   - installed application layout complete
 *
 * "Can it actually execute on Windows x64" is asserted by CI running the
 * freshly built binary with `--version`; this file proves the FORMAT, CI
 * proves the EXECUTION, and the desktop smoke test proves the APP STARTS.
 *
 * Usage:
 *   node scripts/verify-windows-artifacts.mjs --helper <path>
 *        [--frontend dist-app] [--installer <path>] [--installed-app <dir>]
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Machine types we may legitimately ship. Aldo's PC reports AMD64. */
export const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
export const IMAGE_FILE_MACHINE_I386 = 0x014c;
export const IMAGE_FILE_MACHINE_ARM64 = 0xaa64;

const MACHINE_NAMES = new Map([
  [IMAGE_FILE_MACHINE_AMD64, "x64 (AMD64)"],
  [IMAGE_FILE_MACHINE_I386, "x86 (i386)"],
  [IMAGE_FILE_MACHINE_ARM64, "arm64"],
]);

const IMAGE_FILE_EXECUTABLE_IMAGE = 0x0002;
const IMAGE_FILE_DLL = 0x2000;

/**
 * Smallest believable compiled helper. The real MSVC /O2 build is tens of
 * kilobytes; anything under this is a stub, a truncated download, or a
 * placeholder that must never reach a player.
 */
export const MIN_HELPER_BYTES = 16 * 1024;
/** A Raw Input helper that grew past this is not the program we think it is. */
export const MAX_HELPER_BYTES = 32 * 1024 * 1024;
/** An Electron NSIS installer is ~60-120 MB; well under 20 MB means broken. */
export const MIN_INSTALLER_BYTES = 20 * 1024 * 1024;

/** Textual openings that betray a source/script file wearing an .exe name. */
const SOURCE_TEXT_PREFIXES = [
  "/*",
  "//",
  "#include",
  "#define",
  "#!",
  "<?xml",
  "<!DOCTYPE",
  "{",
  "import ",
  "using ",
  "package ",
];

/**
 * Parses the PE/COFF headers of a buffer.
 *
 * Returns a structured report rather than throwing so callers can present
 * every problem at once.
 */
export function inspectPortableExecutable(buffer) {
  const report = {
    sizeBytes: buffer.length,
    hasMzHeader: false,
    hasPeSignature: false,
    peOffset: null,
    machine: null,
    machineName: null,
    isX64: false,
    isExecutableImage: false,
    isDll: false,
    subsystem: null,
    optionalHeaderMagic: null,
    looksLikeSourceText: looksLikeSourceText(buffer),
    problems: [],
  };

  if (buffer.length < 2) {
    report.problems.push("file is empty or truncated (fewer than 2 bytes)");
    return report;
  }
  report.hasMzHeader = buffer[0] === 0x4d && buffer[1] === 0x5a; // "MZ"
  if (!report.hasMzHeader) {
    const head = JSON.stringify(buffer.subarray(0, 24).toString("latin1"));
    report.problems.push(
      `missing the Windows "MZ" DOS header — first bytes are ${head}`,
    );
    return report;
  }
  if (buffer.length < 0x40) {
    report.problems.push("truncated: no room for e_lfanew at offset 0x3C");
    return report;
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  report.peOffset = peOffset;
  if (peOffset <= 0 || peOffset + 24 > buffer.length) {
    report.problems.push(`e_lfanew (0x${peOffset.toString(16)}) points outside the file`);
    return report;
  }
  report.hasPeSignature =
    buffer[peOffset] === 0x50 &&
    buffer[peOffset + 1] === 0x45 &&
    buffer[peOffset + 2] === 0x00 &&
    buffer[peOffset + 3] === 0x00; // "PE\0\0"
  if (!report.hasPeSignature) {
    report.problems.push('missing the "PE\\0\\0" signature — DOS stub only, not a Windows program');
    return report;
  }

  const coff = peOffset + 4;
  report.machine = buffer.readUInt16LE(coff);
  report.machineName = MACHINE_NAMES.get(report.machine) ?? `unknown (0x${report.machine.toString(16)})`;
  report.isX64 = report.machine === IMAGE_FILE_MACHINE_AMD64;
  const characteristics = buffer.readUInt16LE(coff + 18);
  report.isExecutableImage = (characteristics & IMAGE_FILE_EXECUTABLE_IMAGE) !== 0;
  report.isDll = (characteristics & IMAGE_FILE_DLL) !== 0;

  const sizeOfOptionalHeader = buffer.readUInt16LE(coff + 16);
  const optional = coff + 20;
  if (sizeOfOptionalHeader >= 70 && optional + 70 <= buffer.length) {
    report.optionalHeaderMagic = buffer.readUInt16LE(optional);
    report.subsystem = buffer.readUInt16LE(optional + 68);
  }

  if (!report.isX64) {
    report.problems.push(
      `wrong architecture: ${report.machineName}; Aldo's PC reports PROCESSOR_ARCHITECTURE=AMD64`,
    );
  }
  if (!report.isExecutableImage) {
    report.problems.push("COFF characteristics do not mark this as an executable image");
  }
  if (report.isDll) {
    report.problems.push("this is a DLL, not an application");
  }
  return report;
}

/** Heuristic: does this file open like human-readable source rather than a binary? */
export function looksLikeSourceText(buffer) {
  const head = buffer.subarray(0, 512);
  if (head.length === 0) return false;
  const text = head.toString("latin1");
  const trimmed = text.replace(/^\uFEFF/, "").trimStart();
  if (SOURCE_TEXT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return true;
  // Fall back to a printability ratio: real PE headers are full of NULs.
  let printable = 0;
  for (const byte of head) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127)) printable++;
  }
  return printable / head.length > 0.95;
}

function formatProblems(label, problems) {
  return problems.map((p) => `  ✗ ${label}: ${p}`).join("\n");
}

/** Full helper gate. Returns { ok, report, problems }. */
export function verifyHelperBinary(helperPath) {
  const problems = [];
  if (!existsSync(helperPath)) {
    return { ok: false, report: null, problems: [`helper binary is missing: ${helperPath}`] };
  }
  const buffer = readFileSync(helperPath);
  const report = inspectPortableExecutable(buffer);

  if (report.looksLikeSourceText) {
    problems.push(
      "the file begins with SOURCE TEXT, not a compiled binary — this is exactly the " +
        "v1.0.0-rc.1 defect (the .c file was copied over the .exe name)",
    );
  }
  if (buffer.length === 0) {
    problems.push("the file is zero bytes");
  } else if (buffer.length < MIN_HELPER_BYTES) {
    problems.push(
      `implausibly small: ${buffer.length} bytes (a compiled helper is at least ${MIN_HELPER_BYTES})`,
    );
  } else if (buffer.length > MAX_HELPER_BYTES) {
    problems.push(`implausibly large: ${buffer.length} bytes`);
  }
  problems.push(...report.problems);
  return { ok: problems.length === 0, report, problems };
}

/** Required built frontend assets for the desktop shell to render anything. */
export function verifyFrontendAssets(frontendDir) {
  const problems = [];
  if (!existsSync(frontendDir)) {
    return { ok: false, problems: [`frontend directory is missing: ${frontendDir}`] };
  }
  const indexPath = join(frontendDir, "index.html");
  if (!existsSync(indexPath)) {
    problems.push(`missing ${indexPath}`);
  } else if (statSync(indexPath).size < 200) {
    problems.push(`${indexPath} is implausibly small`);
  }
  const assetsDir = join(frontendDir, "assets");
  if (!existsSync(assetsDir)) {
    problems.push(`missing ${assetsDir}`);
  } else {
    const entries = readdirSync(assetsDir);
    if (!entries.some((f) => f.endsWith(".js"))) problems.push("no JS bundle in assets/");
    if (!entries.some((f) => f.endsWith(".css"))) problems.push("no CSS bundle in assets/");
  }
  return { ok: problems.length === 0, problems };
}

/** Installer presence + plausibility gate. */
export function verifyInstaller(installerPath) {
  if (!existsSync(installerPath)) {
    return { ok: false, problems: [`installer is missing: ${installerPath}`] };
  }
  const problems = [];
  const buffer = readFileSync(installerPath);
  const report = inspectPortableExecutable(buffer);
  problems.push(...report.problems.filter((p) => !p.startsWith("wrong architecture")));
  if (!report.hasMzHeader || !report.hasPeSignature) {
    problems.push("installer is not a Windows executable");
  }
  if (buffer.length < MIN_INSTALLER_BYTES) {
    problems.push(
      `installer is implausibly small: ${buffer.length} bytes (expected at least ${MIN_INSTALLER_BYTES})`,
    );
  }
  return { ok: problems.length === 0, problems, report };
}

/**
 * Post-install layout gate: what must exist on disk after
 * `AldoAimLab-Setup.exe /S` has run.
 */
export function verifyInstalledApp(installDir) {
  const problems = [];
  if (!existsSync(installDir)) {
    return { ok: false, problems: [`installed app directory is missing: ${installDir}`] };
  }
  const required = [
    "Aldo Aim Lab.exe",
    join("resources", "app.asar"),
    join("resources", "aldo_capture_helper.exe"),
  ];
  for (const rel of required) {
    if (!existsSync(join(installDir, rel))) problems.push(`installed app is missing ${rel}`);
  }
  const helper = join(installDir, "resources", "aldo_capture_helper.exe");
  if (existsSync(helper)) {
    const helperCheck = verifyHelperBinary(helper);
    problems.push(...helperCheck.problems.map((p) => `installed helper: ${p}`));
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function arg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

const isMain =
  process.argv[1] !== undefined &&
  process.argv[1].endsWith("verify-windows-artifacts.mjs");

if (isMain) {
  let failed = 0;
  const run = (label, result, describe) => {
    if (result.ok) {
      console.log(`✓ ${label}${describe ? ` — ${describe}` : ""}`);
    } else {
      failed++;
      console.error(`✗ ${label}`);
      console.error(formatProblems(label, result.problems));
    }
  };

  const helperPath = arg("--helper");
  if (helperPath) {
    const result = verifyHelperBinary(helperPath);
    run(
      `helper is a real Windows x64 PE (${helperPath})`,
      result,
      result.report
        ? `${result.report.sizeBytes} bytes, machine ${result.report.machineName}`
        : undefined,
    );
  }

  const frontendDir = arg("--frontend");
  if (frontendDir) {
    run(`frontend assets present (${frontendDir})`, verifyFrontendAssets(frontendDir));
  }

  const installerPath = arg("--installer");
  if (installerPath) {
    const result = verifyInstaller(installerPath);
    run(
      `installer present and plausible (${installerPath})`,
      result,
      result.report ? `${result.report.sizeBytes} bytes` : undefined,
    );
  }

  const installedDir = arg("--installed-app");
  if (installedDir) {
    run(`installed application layout (${installedDir})`, verifyInstalledApp(installedDir));
  }

  if (!helperPath && !frontendDir && !installerPath && !installedDir) {
    console.error("nothing to verify — pass --helper / --frontend / --installer / --installed-app");
    process.exit(2);
  }
  if (failed > 0) {
    console.error(`\nWindows artifact verification FAILED (${failed} gate(s)).`);
    process.exit(1);
  }
  console.log("\nWindows artifact verification: all gates passed.");
}
