#!/usr/bin/env node
/**
 * Release-artifact verification (Pass 5).
 *
 * Validates that the repository is internally consistent and, when a
 * production build exists, that the shipped artifacts match the declared
 * release. Exits non-zero on any mismatch.
 *
 * Checks:
 *  1. package.json version === src/version.ts APP_VERSION
 *  2. native helper C constants (protocol + version) match TS expectations
 *  3. dist-app/ (when present) contains index.html + hashed asset, and the
 *     bundle embeds the declared APP_VERSION string
 *  4. artifact compatibility matrix is present and well-formed
 *  5. required release docs exist
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---- 1. version consistency ----
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const versionTs = readFileSync("src/version.ts", "utf8");
const appVersionMatch = /export const APP_VERSION = "([^"]+)"/.exec(versionTs);
check(
  "package.json version matches APP_VERSION",
  appVersionMatch !== null && pkg.version === appVersionMatch[1],
  `${pkg.version} vs ${appVersionMatch?.[1] ?? "?"}`,
);

// ---- 2. native constants ----
if (existsSync("native/windows/traimer_capture_helper.c")) {
  const c = readFileSync("native/windows/traimer_capture_helper.c", "utf8");
  const proto = /#define\s+PROTOCOL_VERSION\s+(\d+)/.exec(c);
  const helperVer = /#define\s+HELPER_VERSION\s+"([^"]+)"/.exec(c);
  const protoTs = /export const NATIVE_PROTOCOL_VERSION = (\d+)/.exec(versionTs);
  const helperTs = /export const EXPECTED_HELPER_VERSION = "([^"]+)"/.exec(versionTs);
  check(
    "native protocol version parity",
    proto && protoTs && Number(proto[1]) === Number(protoTs[1]),
    `C=${proto?.[1]} TS=${protoTs?.[1]}`,
  );
  check(
    "native helper version parity",
    helperVer && helperTs && helperVer[1] === helperTs[1],
    `C=${helperVer?.[1]} TS=${helperTs?.[1]}`,
  );
} else {
  check("native helper source present", false, "native/windows/traimer_capture_helper.c missing");
}

// ---- 3. production bundle ----
if (existsSync("dist-app")) {
  const htmlPath = "dist-app/index.html";
  check("dist-app/index.html exists", existsSync(htmlPath));
  const assetsDir = "dist-app/assets";
  if (existsSync(assetsDir)) {
    const assets = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
    check("bundle contains a JS asset", assets.length > 0);
    if (assets.length > 0) {
      const js = readFileSync(join(assetsDir, assets[0]), "utf8");
      check(
        "bundle embeds the declared APP_VERSION",
        js.includes(appVersionMatch?.[1] ?? "\u0000never"),
      );
      // The engine tag ships in the bundle so stored artifacts can always be
      // attributed to the producing build.
      const engineTag = /export const ENGINE_VERSION = "([^"]+)"/.exec(versionTs)?.[1];
      check("bundle embeds ENGINE_VERSION", engineTag !== null && js.includes(engineTag));
    }
  } else {
    check("dist-app/assets exists", false);
  }
} else {
  console.log("ℹ dist-app/ not built — run `npm run build` for full verification");
}

// ---- 4. compatibility matrix ----
check(
  "artifact compatibility matrix present",
  /ARTIFACT_COMPATIBILITY_MATRIX/.test(versionTs),
);

// ---- 5. release docs ----
for (const doc of [
  "docs/RELEASE.md",
  "docs/PACKAGING-WINDOWS.md",
  "docs/SECURITY-REVIEW.md",
  // Public-release documents (Pass 5). A release without these is not
  // shareable; scripts/verify-docs.mjs checks their CONTENT.
  "README.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "PRIVACY.md",
  "CHANGELOG.md",
  "docs/RELEASE-NOTES.md",
  "docs/SUPPORT-MATRIX.md",
  "docs/INSTALL-WINDOWS.md",
  "docs/CODE-SIGNING.md",
]) {
  check(`release doc ${doc} exists`, existsSync(doc));
}

// ---- 6. packaged release folder (Pass 6, --release-dir <path>) ----
const releaseDirIdx = process.argv.indexOf("--release-dir");
if (releaseDirIdx >= 0 && process.argv[releaseDirIdx + 1]) {
  const releasePath = process.argv[releaseDirIdx + 1];
  check("release folder exists", existsSync(releasePath), releasePath);
  if (existsSync(releasePath)) {
    for (const required of [
      "traimer_capture_helper.exe",
      "start-traimer.ps1",
      "stop-traimer.ps1",
      "FIRST-RUN.md",
      "manifest.json",
      join("app", "index.html"),
    ]) {
      check(`release contains ${required}`, existsSync(join(releasePath, required)));
    }
    const manifestPath = join(releasePath, "manifest.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      check(
        "release manifest declares the current app version",
        manifest.appVersion === pkg.version,
        `${manifest.appVersion} vs ${pkg.version}`,
      );
      check(
        "release helper is NOT a placeholder binary",
        manifest.helperBinaryIsPlaceholder !== true,
      );
      // Recompute every file hash from disk and compare to the manifest.
      const { createHash } = await import("node:crypto");
      let allMatch = true;
      for (const entry of manifest.files ?? []) {
        const full = join(releasePath, entry.path);
        if (!existsSync(full)) {
          allMatch = false;
          break;
        }
        const actual = createHash("sha256").update(readFileSync(full)).digest("hex");
        if (actual !== entry.sha256) {
          allMatch = false;
          console.log(`  hash mismatch: ${entry.path}`);
          break;
        }
      }
      check("every packaged file matches its manifest SHA-256", allMatch);
    }
  }
}

// ---- 7. Windows desktop application (Pass 9) ----
// The shipped Windows product is an installed desktop app, so its build
// inputs are part of release verification, not an optional extra.
check("desktop shell entry point declared", pkg.main === "dist-desktop/main.js", pkg.main ?? "(unset)");
for (const required of [
  "desktop/main.ts",
  "desktop/preload.ts",
  "desktop/captureHelper.ts",
  "desktop/frontendProtocol.ts",
  "desktop/staticFiles.ts",
  "electron-builder.yml",
  "build/installer.nsh",
  "build/icon.ico",
  "docs/INSTALL-WINDOWS.md",
  "docs/DESKTOP-SHELL.md",
]) {
  check(`desktop build input ${required} exists`, existsSync(required));
}
if (existsSync("electron-builder.yml")) {
  const builder = readFileSync("electron-builder.yml", "utf8");
  check("installer target is NSIS x64", /target:\s*nsis/.test(builder) && /- x64/.test(builder));
  check("installer creates Start Menu + Desktop shortcuts",
    builder.includes("createDesktopShortcut: always") && builder.includes("createStartMenuShortcut: true"));
  check("uninstall preserves user data by default", builder.includes("deleteAppDataOnUninstall: false"));
  check("compiled helper ships as an extraResource (spawnable, outside asar)",
    builder.includes("native/windows/traimer_capture_helper.exe"));
  check("no PowerShell in the installed launch path", !/\.ps1/.test(builder));
}
if (existsSync("build/icon.ico")) {
  const ico = readFileSync("build/icon.ico");
  const looksLikeIco = ico.length > 1024 && ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1;
  check("application icon is a real .ico", looksLikeIco, `${ico.length} bytes`);
}
if (existsSync("dist-desktop")) {
  check("compiled desktop main present", existsSync("dist-desktop/main.js"));
  check("compiled preload present", existsSync("dist-desktop/preload.js"));
} else {
  console.log("ℹ dist-desktop/ not built — run `npm run build:desktop` for full verification");
}

process.exit(failures > 0 ? 1 : 0);
