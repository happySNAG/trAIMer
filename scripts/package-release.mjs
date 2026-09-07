#!/usr/bin/env node
/**
 * Deterministic Windows release packager (Pass 6, requirement 1/13).
 *
 * Assembles the portable release folder:
 *
 *   trAIMer/
 *   ├── traimer_capture_helper.exe     (from --helper)
 *   ├── app/                        (from dist-app/)
 *   ├── start-traimer.ps1
 *   ├── stop-traimer.ps1
 *   ├── FIRST-RUN.md
 *   ├── manifest.json               (versions, commit, file list + hashes)
 *   └── SHA256SUMS.txt              (deterministic checksum manifest)
 *
 * Determinism: files are written in sorted order with fixed timestamps where
 * the format allows; manifests are generated from content hashes so the same
 * inputs yield byte-identical manifest/checksum outputs (logical
 * reproducibility; see docs/PASS6-REPRODUCIBILITY.md).
 *
 * Usage:
 *   node scripts/package-release.mjs [--dist dist-app] [--helper path/to/exe]
 *        [--out release] [--commit <sha>]
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { verifyHelperBinary } from "./verify-windows-artifacts.mjs";

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const distDir = arg("--dist", "dist-app");
const helperPath = arg("--helper", "native/windows/traimer_capture_helper.exe");
const outRoot = arg("--out", "release");
const commit = arg("--commit", "");

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (!existsSync(distDir)) fail(`dist folder not found: ${distDir}`);
const placeholderHelper = process.argv.includes("--allow-placeholder-helper");

/*
 * ROOT-CAUSE FIX (v1.0.0-rc.1 shipped the C source under the .exe name).
 *
 * Two rules now make that outcome structurally impossible:
 *   1. Any file placed at `traimer_capture_helper.exe` MUST pass the full
 *      PE gate (MZ header, PE signature, AMD64 machine, plausible size,
 *      not source text). No flag can bypass this.
 *   2. Dry-run mode never writes the `.exe` name at all — the placeholder
 *      gets an unmistakable filename that Windows will never execute.
 */
let helperTargetName = "traimer_capture_helper.exe";
let effectiveHelperPath = helperPath;

if (!existsSync(helperPath)) {
  if (!placeholderHelper) {
    fail(
      `helper binary not found: ${helperPath}\n` +
        `  Compile it on a Windows host first (scripts/build-native-windows.bat) — this packager does NOT fabricate binaries.\n` +
        `  (Structural dry-runs may pass --allow-placeholder-helper; the placeholder is NOT named .exe.)`,
    );
  }
  const placeholder = join(outRoot, "PLACEHOLDER-helper-not-compiled.txt");
  mkdirSync(outRoot, { recursive: true });
  writeFileSync(
    placeholder,
    "PLACEHOLDER — not a real binary. A release with helperBinaryIsPlaceholder:true must never ship.\n",
  );
  effectiveHelperPath = placeholder;
  helperTargetName = "traimer_capture_helper.exe.PLACEHOLDER-NOT-EXECUTABLE";
} else {
  const check = verifyHelperBinary(helperPath);
  if (!check.ok) {
    fail(
      `refusing to package ${helperPath} as traimer_capture_helper.exe:\n` +
        check.problems.map((problem) => `    - ${problem}`).join("\n") +
        `\n  Compile the helper on Windows (scripts/build-native-windows.bat) and package that.`,
    );
  }
  console.log(
    `✓ helper verified: real PE, ${check.report.sizeBytes} bytes, machine ${check.report.machineName}`,
  );
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;

/** Rejects unsafe relative paths for archive members (release-zip hygiene). */
export function isSafeArchivePath(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) return false;
  if (/^[A-Za-z]:/.test(relPath)) return false; // drive letters
  if (relPath.includes("\\")) return false; // windows separators only from us
  const parts = relPath.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return false;
  return true;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function listFilesRecursive(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

// ---- assemble ---------------------------------------------------------------
const releaseName = `trAIMer-v${version}`;
const releaseDir = join(outRoot, releaseName);
rmrf(releaseDir);
mkdirSync(releaseDir, { recursive: true });

cpSync(distDir, join(releaseDir, "app"), { recursive: true });
copyFileSync(effectiveHelperPath, join(releaseDir, helperTargetName));
copyFileSync("scripts/release/windows/start-traimer.ps1", join(releaseDir, "start-traimer.ps1"));
copyFileSync("scripts/release/windows/stop-traimer.ps1", join(releaseDir, "stop-traimer.ps1"));
copyFileSync("scripts/release/windows/FIRST-RUN.md", join(releaseDir, "FIRST-RUN.md"));

// ---- manifests ---------------------------------------------------------------
const files = listFilesRecursive(releaseDir);
const entries = [];
for (const fullPath of files) {
  const rel = relative(releaseDir, fullPath).split(sep).join("/");
  if (!isSafeArchivePath(rel)) fail(`unsafe archive member produced: ${rel}`);
  entries.push({
    path: rel,
    bytes: statSync(fullPath).size,
    sha256: sha256(readFileSync(fullPath)),
  });
}
entries.sort((a, b) => (a.path < b.path ? -1 : 1));

let dependencyLockHash = null;
if (existsSync("package-lock.json")) {
  dependencyLockHash = sha256(readFileSync("package-lock.json"));
}

const helperSha256 = entries.find((e) => e.path === helperTargetName)?.sha256 ?? null;

const manifest = {
  manifestKind: "aldo-release-manifest",
  manifestVersion: 1,
  appName: pkg.name,
  appVersion: version,
  gitCommit: commit || null,
  engineVersion: extractConstant("src/version.ts", "ENGINE_VERSION"),
  optimizerVersion: extractConstant("src/version.ts", "OPTIMIZER_VERSION"),
  nativeProtocolVersion: Number(extractConstant("src/version.ts", "NATIVE_PROTOCOL_VERSION")),
  expectedHelperVersion: stripQuotes(extractConstant("src/version.ts", "EXPECTED_HELPER_VERSION")),
  // True ONLY in dry-run/CI-structural runs where a real compiled helper was
  // unavailable. A manifest with this flag must never ship to players.
  helperBinaryIsPlaceholder: placeholderHelper,
  helperFileName: helperTargetName,
  helperSha256,
  dependencyLockHash,
  artifactSha256: sha256(Buffer.concat(entries.map((e) => Buffer.from(e.sha256, "hex")))),
  files: entries,
};

writeFileSync(join(releaseDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const sums = [...entries, { path: "manifest.json", sha256: manifest.artifactSha256 }]
  .map((e) => `${e.sha256}  ${e.path}`)
  .sort()
  .join("\n");
writeFileSync(join(releaseDir, "..", `${releaseName}-SHA256SUMS.txt`), `${sums}\n`);

console.log(`✓ packaged ${releaseDir}`);
console.log(`  files: ${entries.length} | checksums: ${releaseName}-SHA256SUMS.txt`);
console.log(`  artifact digest: ${manifest.artifactSha256.slice(0, 16)}…`);

// ---- helpers -----------------------------------------------------------------
function rmrf(path) {
  rmSync(path, { recursive: true, force: true });
}

function extractConstant(file, name) {
  const src = readFileSync(file, "utf8");
  const m = new RegExp(`export const ${name} = ("?[^";\\n]+)?`).exec(src);
  return m?.[1]?.replace(/^"|"$/g, "") ?? null;
}
function stripQuotes(v) {
  return typeof v === "string" ? v.replace(/^"|"$/g, "") : v;
}
