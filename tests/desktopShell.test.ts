import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CONTENT_SECURITY_POLICY,
  MIME_TYPES,
  mimeTypeFor,
  resolveWithinRoot,
} from "../desktop/staticFiles.ts";

/**
 * Contract suite for the Windows desktop shell (Electron main process).
 *
 * The shell replaced the PowerShell launcher as the shipped launch path, so
 * every guarantee the launcher was contract-tested for must now be proven
 * here: loopback-only, argument-array process spawning, traversal-guarded
 * static serving, a MIME allowlist, deterministic teardown, and a single
 * instance. Static assertions mirror the style of the retired ps1 contract
 * tests in securityRoundTwo.test.ts; the path/MIME rules are executed for
 * real because they were extracted into a dependency-free module.
 */

const read = (relPath: string): string => readFileSync(relPath, "utf8");
const mainSource = read("desktop/main.ts");
const helperSource = read("desktop/captureHelper.ts");
const protocolSource = read("desktop/frontendProtocol.ts");
const preloadSource = read("desktop/preload.ts");
const builderConfig = read("electron-builder.yml");
const installerScript = read("build/installer.nsh");

describe("static file serving (executed rules)", () => {
  const root = resolve("dist-app");

  it("serves index.html for the bare origin", () => {
    expect(resolveWithinRoot(root, "/")).toBe(resolve(root, "index.html"));
    expect(resolveWithinRoot(root, "")).toBe(resolve(root, "index.html"));
  });

  it("resolves normal asset paths inside the root", () => {
    expect(resolveWithinRoot(root, "/assets/index.js")).toBe(
      resolve(root, "assets/index.js"),
    );
  });

  it.each([
    "/../secrets.txt",
    "/assets/../../etc/passwd",
    "/%2e%2e/%2e%2e/etc/passwd",
    "/..%2f..%2fetc%2fpasswd",
    "/a/../../..",
    "/./../../etc/passwd",
  ])("refuses traversal attempt %s", (attempt) => {
    expect(resolveWithinRoot(root, attempt)).toBeNull();
  });

  it("refuses NUL bytes, backslashes and undecodable escapes", () => {
    expect(resolveWithinRoot(root, "/index.html%00.png")).toBeNull();
    expect(resolveWithinRoot(root, "/assets\\..\\evil")).toBeNull();
    expect(resolveWithinRoot(root, "/%zz")).toBeNull();
  });

  it("serves only allowlisted MIME types and never guesses", () => {
    expect(mimeTypeFor("/app/index.html")).toBe("text/html; charset=utf-8");
    expect(mimeTypeFor("/app/assets/index.js")).toBe("text/javascript; charset=utf-8");
    expect(mimeTypeFor("/app/assets/index.css")).toBe("text/css; charset=utf-8");
    expect(mimeTypeFor("/app/helper.exe")).toBeNull();
    expect(mimeTypeFor("/app/notes.ps1")).toBeNull();
    expect(mimeTypeFor("/app/config")).toBeNull();
  });

  it("never allowlists an executable or script extension", () => {
    for (const ext of Object.keys(MIME_TYPES)) {
      expect([".exe", ".dll", ".bat", ".cmd", ".ps1", ".msi"]).not.toContain(ext);
    }
  });
});

describe("content security policy", () => {
  it("forbids every non-loopback connection", () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self' ws://127.0.0.1:*");
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)/);
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("form-action 'none'");
  });

  it("is actually attached to responses", () => {
    expect(protocolSource).toContain('"content-security-policy": CONTENT_SECURITY_POLICY');
    expect(protocolSource).toContain('"x-content-type-options": "nosniff"');
  });

  it("refuses non-GET methods", () => {
    expect(protocolSource).toContain('request.method !== "GET"');
  });
});

describe("renderer isolation", () => {
  it("runs the renderer sandboxed with context isolation and no Node", () => {
    expect(mainSource).toMatch(/contextIsolation:\s*true/);
    expect(mainSource).toMatch(/nodeIntegration:\s*false/);
    expect(mainSource).toMatch(/sandbox:\s*true/);
    expect(mainSource).toMatch(/webSecurity:\s*true/);
    expect(mainSource).not.toMatch(/webSecurity:\s*false/);
    expect(mainSource).not.toMatch(/allowRunningInsecureContent/);
  });

  it("exposes only an explicit frozen API over the context bridge", () => {
    expect(preloadSource).toContain("contextBridge.exposeInMainWorld");
    expect(preloadSource).toContain("Object.freeze(");
    expect(preloadSource).not.toContain("require(");
    expect(preloadSource).not.toMatch(/exposeInMainWorld\(\s*["']\w+["']\s*,\s*ipcRenderer/);
  });

  it("registers the frontend scheme as standard, secure and CORS-enabled", () => {
    // secure -> Pointer Lock works; standard -> IndexedDB keeps history across
    // launches; corsEnabled is required alongside supportFetchAPI.
    expect(protocolSource).toMatch(/standard:\s*true/);
    expect(protocolSource).toMatch(/secure:\s*true/);
    expect(protocolSource).toMatch(/corsEnabled:\s*true/);
    expect(protocolSource).toMatch(/allowServiceWorkers:\s*false/);
  });

  it("refuses navigation away from the app origin", () => {
    expect(mainSource).toContain('"will-navigate"');
    expect(mainSource).toContain("event.preventDefault()");
    expect(mainSource).toContain("setWindowOpenHandler");
    expect(mainSource).toContain('action: "deny"');
  });

  it("grants only pointer lock and fullscreen permissions", () => {
    expect(mainSource).toContain('new Set<string>(["pointerLock", "fullscreen"])');
    expect(mainSource).toContain("setPermissionRequestHandler");
    expect(mainSource).toContain("setPermissionCheckHandler");
  });
});

describe("native helper lifecycle", () => {
  it("spawns the helper with an argument array and never through a shell", () => {
    expect(helperSource).toMatch(/spawn\(\s*this\.exePath,\s*\[/);
    expect(helperSource).toMatch(/"--port",\s*String\(port\),\s*"--token",\s*this\.sessionToken/);
    expect(helperSource).toMatch(/shell:\s*false/);
    expect(helperSource).not.toMatch(/shell:\s*true/);
    expect(helperSource).toMatch(/windowsHide:\s*true/);
  });

  it("only ever talks to loopback", () => {
    expect(helperSource).toContain('host: "127.0.0.1"');
    expect(helperSource).toContain('server.listen(port, "127.0.0.1")');
    expect(helperSource).toContain("ws://127.0.0.1:${port}");
    expect(helperSource).not.toMatch(/0\.0\.0\.0/);
  });

  it("waits for real readiness instead of assuming the helper started", () => {
    expect(helperSource).toContain("#waitForReady");
    expect(helperSource).toContain("HELPER_READY_TIMEOUT_MS");
    expect(helperSource).toContain('reasonCode: "HELPER_NOT_READY"');
  });

  it("reports missing or unrunnable helpers with stable reason codes", () => {
    for (const code of [
      "HELPER_MISSING",
      "HELPER_SPAWN_FAILED",
      "HELPER_NOT_READY",
      "HELPER_CRASHED",
      "HELPER_NO_FREE_PORT",
      "HELPER_PLATFORM_UNSUPPORTED",
    ]) {
      expect(helperSource).toContain(code);
    }
  });

  it("tears the helper down deterministically on shutdown", () => {
    expect(helperSource).toMatch(/async stop\(\)/);
    expect(helperSource).toContain("HELPER_STOP_GRACE_MS");
    expect(helperSource).toContain('child.kill("SIGKILL")');
    expect(mainSource).toContain('app.on("before-quit"');
    expect(mainSource).toContain("await helper?.stop()");
    expect(mainSource).toContain('app.on("window-all-closed"');
  });

  it("bounds automatic restarts instead of looping forever", () => {
    expect(helperSource).toContain("HELPER_MAX_RESTARTS");
    expect(helperSource).toMatch(/restarts >= HELPER_MAX_RESTARTS/);
  });
});

describe("single instance", () => {
  it("takes the single-instance lock and focuses the existing window", () => {
    expect(mainSource).toContain("app.requestSingleInstanceLock()");
    expect(mainSource).toContain('app.on("second-instance"');
    expect(mainSource).toMatch(/if \(!gotTheLock\) \{[\s\S]{0,400}?app\.quit\(\);/);
    // A duplicate launch during a smoke test must fail loudly, never look
    // like a pass because the lock was already held.
    expect(mainSource).toContain("SMOKE-TEST-ABORT");
    // A second launch must never reach helper startup.
    const lockIndex = mainSource.indexOf("requestSingleInstanceLock");
    const mainCallIndex = mainSource.indexOf("void main();");
    expect(lockIndex).toBeGreaterThan(-1);
    expect(mainCallIndex).toBeGreaterThan(lockIndex);
  });

  it("scans for a free helper port so a stale helper cannot block startup", () => {
    expect(helperSource).toContain("findFreeHelperPort");
    expect(helperSource).toContain("HELPER_PORT_SCAN");
  });
});

describe("no telemetry, no remote code", () => {
  it("keeps the shell free of network egress APIs", () => {
    for (const source of [mainSource, helperSource, protocolSource, preloadSource]) {
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toContain("XMLHttpRequest");
      expect(source).not.toContain("sendBeacon");
      expect(source).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)[a-z]/i);
    }
  });

  it("loads the UI from the packaged origin only", () => {
    expect(mainSource).toContain("`${APP_ORIGIN}/index.html`");
    expect(mainSource).not.toMatch(/loadURL\(["']http/);
  });
});

describe("installer contract", () => {
  it("produces one double-clickable NSIS setup with shortcuts", () => {
    expect(builderConfig).toContain("target: nsis");
    expect(builderConfig).toContain("createDesktopShortcut: always");
    expect(builderConfig).toContain("createStartMenuShortcut: true");
    expect(builderConfig).toContain("AldoAimLab-Setup-${version}.${ext}");
    expect(builderConfig).toMatch(/- x64/);
  });

  it("installs per-user without elevation (no admin, no services, no drivers)", () => {
    expect(builderConfig).toContain("perMachine: false");
    expect(builderConfig).toContain("allowElevation: false");
    expect(builderConfig).toContain("requestedExecutionLevel: asInvoker");
  });

  it("ships the compiled helper outside the asar so it can be spawned", () => {
    expect(builderConfig).toContain("extraResources:");
    expect(builderConfig).toContain("native/windows/aldo_capture_helper.exe");
    expect(builderConfig).toContain("asar: true");
  });

  it("preserves user data on uninstall unless explicitly chosen otherwise", () => {
    expect(builderConfig).toContain("deleteAppDataOnUninstall: false");
    expect(installerScript).toContain("customUnInstall");
    expect(installerScript).toContain("/SD IDNO");
    expect(installerScript).toContain("$APPDATA\\AldoAimLab");
  });

  it("never ships PowerShell in the installed launch path", () => {
    expect(builderConfig).not.toMatch(/\.ps1/);
    const filesSection = builderConfig.slice(
      builderConfig.indexOf("files:"),
      builderConfig.indexOf("extraResources:"),
    );
    expect(filesSection).not.toContain("scripts/");
  });
});
