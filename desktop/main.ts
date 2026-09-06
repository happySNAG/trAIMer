/**
 * Aldo Aim Lab — Windows desktop shell (Electron main process).
 *
 * This process is the product's entry point on Windows. Installed by
 * AldoAimLab-Setup.exe and launched from the Start Menu / Desktop shortcut,
 * it owns:
 *
 *   - the application window,
 *   - local static delivery of the built frontend (aldo:// scheme),
 *   - the native capture helper's whole lifecycle (start, health, restart,
 *     deterministic shutdown),
 *   - startup readiness + honest error reporting,
 *   - single-instance behaviour (a second launch focuses the first window),
 *   - the installed user-data path (%APPDATA%\AldoAimLab).
 *
 * There is no PowerShell, no terminal window, no manual browser step, and no
 * developer tooling requirement on the player's PC.
 *
 * Safety boundary is unchanged: the helper only OBSERVES Raw Input on
 * loopback. Nothing injects, hooks, reads foreign process memory, touches
 * anti-cheat, or synthesizes input.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from "electron";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { APP_DIR_NAME, APP_ORIGIN, PRODUCT_NAME } from "./config";
import { CaptureHelper, type HelperStatus } from "./captureHelper";
import { registerAppSchemePrivileges, registerFrontendProtocol } from "./frontendProtocol";
import { DesktopLog } from "./logging";
import { frontendRoot, helperExecutablePath, preloadPath } from "./paths";
import { mintSessionToken } from "./sessionToken";

// Fixes the installed user-data path to %APPDATA%\AldoAimLab regardless of
// how the package is named. Must run before any getPath("userData") call.
app.setName(APP_DIR_NAME);
app.setAppUserModelId("com.aldoaimlab.desktop");

const SMOKE_TEST = process.argv.includes("--smoke-test");
const REQUIRE_HELPER = process.argv.includes("--require-helper");
/**
 * Where the smoke test writes its JSON verdict. Electron is a GUI-subsystem
 * process on Windows, so stdout does not reliably reach the launching shell —
 * CI reads this file instead.
 */
const SMOKE_OUT = readFlagValue("--smoke-out");
const SMOKE_TEST_TIMEOUT_MS = 90_000;

/** Reads `--flag value` from argv, or null when absent. */
function readFlagValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value !== undefined && !value.startsWith("--") ? value : null;
}

// Privileged scheme registration must happen before the app is ready.
registerAppSchemePrivileges();

const sessionToken = mintSessionToken();
let log: DesktopLog;
let helper: CaptureHelper;
let mainWindow: BrowserWindow | null = null;
let shuttingDown = false;
let exitCode = 0;

// ---------------------------------------------------------------------------
// Single instance: a second launch must never spawn a second helper/server.
// ---------------------------------------------------------------------------
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  if (SMOKE_TEST) {
    // Never let "another copy was already running" masquerade as a pass.
    console.error("SMOKE-TEST-ABORT another instance already holds the single-instance lock");
    app.exit(3);
  }
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  void main();
}

async function main(): Promise<void> {
  await app.whenReady();
  log = new DesktopLog(app.getPath("userData"));
  log.info("shell-start", {
    productVersion: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    smokeTest: SMOKE_TEST,
  });

  registerFrontendProtocol(frontendRoot(), log);
  hardenSession();

  helper = new CaptureHelper(helperExecutablePath(), sessionToken, log);
  helper.onStatus((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("aldo:helper-status", status);
    }
  });

  registerIpc();

  // Start the helper and the window concurrently: the UI must never wait on
  // capture hardware, and capture must never wait on paint.
  const helperStarted = helper.start();
  const window = createWindow();
  mainWindow = window;

  const loaded = await loadFrontend(window);
  const helperStatus = await helperStarted;

  if (!loaded.ok) {
    reportFatal(
      "The Aldo Aim Lab interface could not be loaded.",
      `${loaded.detail}\n\nInstalled frontend: ${frontendRoot()}\nLog: ${log.filePath}`,
    );
  }

  if (SMOKE_TEST) {
    await runSmokeTest(window, loaded, helperStatus);
    return;
  }

  window.show();
  if (helperStatus.state !== "ready") {
    log.warn("helper-not-ready-at-startup", {
      reasonCode: helperStatus.reasonCode,
      detail: helperStatus.detail,
    });
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow(): BrowserWindow {
  // No application menu: the product has no File/Edit affordances and a menu
  // bar would only invite accidental navigation.
  Menu.setApplicationMenu(null);

  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: "#0d1015",
    title: PRODUCT_NAME,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  // F12 keeps a diagnostic escape hatch without shipping a menu bar.
  window.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && input.key === "F12") {
      window.webContents.toggleDevTools();
    }
  });

  // The shell renders exactly one origin. Anything else is refused, and real
  // external links (there are none today) go to the system browser.
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) {
      event.preventDefault();
      log.warn("navigation-refused", { url: url.slice(0, 200) });
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  window.on("closed", () => {
    mainWindow = null;
  });
  return window;
}

interface LoadResult {
  ok: boolean;
  detail: string;
}

async function loadFrontend(window: BrowserWindow): Promise<LoadResult> {
  // Held in an object so TypeScript does not narrow away the async callback
  // assignment below.
  const state: { failure: string | null } = { failure: null };
  window.webContents.once(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL) => {
      state.failure = `${errorDescription} (${errorCode}) loading ${validatedURL}`;
    },
  );
  try {
    await window.loadURL(`${APP_ORIGIN}/index.html`);
  } catch (error) {
    state.failure = error instanceof Error ? error.message : String(error);
  }
  if (state.failure !== null) {
    log.error("frontend-load-failed", { detail: state.failure });
    return { ok: false, detail: state.failure };
  }
  log.info("frontend-loaded", { origin: APP_ORIGIN });
  return { ok: true, detail: "loaded" };
}

/**
 * Denies every permission the product does not need. Pointer Lock (the whole
 * point of an aim trainer) and fullscreen are the only grants.
 */
function hardenSession(): void {
  const allowed = new Set<string>(["pointerLock", "fullscreen"]);
  const defaults = session.defaultSession;
  defaults.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(allowed.has(permission));
  });
  defaults.setPermissionCheckHandler((_contents, permission) => allowed.has(permission));
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function registerIpc(): void {
  ipcMain.on("aldo:bootstrap", (event) => {
    event.returnValue = {
      appVersion: app.getVersion(),
      productName: PRODUCT_NAME,
      sessionToken,
      helperUrl: helper.status.url,
      platform: process.platform,
      logPath: log.filePath,
    };
  });
  ipcMain.handle("aldo:helper-status", () => helper.status);
  ipcMain.handle("aldo:helper-restart", async () => helper.restart());
  ipcMain.handle("aldo:open-log-folder", async () => {
    await shell.openPath(dirname(log.filePath));
    return true;
  });
}

function reportFatal(summary: string, detail: string): void {
  log.error("fatal", { summary, detail });
  exitCode = 1;
  if (!SMOKE_TEST) {
    dialog.showErrorBox(`${PRODUCT_NAME} — startup problem`, `${summary}\n\n${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Shutdown: closing the app must stop every child process it started.
// ---------------------------------------------------------------------------
app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  void shutdown().finally(() => app.exit(exitCode));
});

async function shutdown(): Promise<void> {
  try {
    log?.info("shell-shutdown-begin");
    await helper?.stop();
    log?.info("shell-shutdown-complete", { exitCode });
  } catch (error) {
    log?.error("shell-shutdown-error", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.quit();
  });
}

// ---------------------------------------------------------------------------
// CI smoke test: launch -> frontend renders -> helper ready -> clean shutdown.
// ---------------------------------------------------------------------------
async function runSmokeTest(
  window: BrowserWindow,
  loaded: LoadResult,
  helperStatus: HelperStatus,
): Promise<void> {
  const watchdog = setTimeout(() => {
    console.error("SMOKE-TEST TIMEOUT");
    app.exit(1);
  }, SMOKE_TEST_TIMEOUT_MS);
  watchdog.unref?.();

  let domOk = false;
  let domDetail = "not evaluated";
  if (loaded.ok) {
    try {
      // Assert the real application shell rendered, not a blank document.
      domOk = (await window.webContents.executeJavaScript(
        "Boolean(document.getElementById('tabs') && document.getElementById('app'))",
      )) as boolean;
      domDetail = domOk ? "app shell present" : "#app/#tabs missing";
    } catch (error) {
      domDetail = error instanceof Error ? error.message : String(error);
    }
  }

  const bridgeOk = loaded.ok
    ? ((await window.webContents.executeJavaScript(
        "Boolean(window.aldoDesktop && /^[0-9a-f]{32}$/.test(window.aldoDesktop.sessionToken))",
      )) as boolean)
    : false;

  // All training history lives in IndexedDB on the aldo:// origin. If the
  // custom scheme ever lost storage access, sessions would silently fail to
  // persist — so the smoke test does a real write/read round trip.
  let storageOk = false;
  let storageDetail = "not evaluated";
  if (loaded.ok) {
    try {
      const probe = (await window.webContents.executeJavaScript(
        `new Promise((resolve) => {
           try {
             const open = indexedDB.open("aldo-smoke-test", 1);
             open.onupgradeneeded = () => open.result.createObjectStore("kv");
             open.onerror = () => resolve("open failed: " + String(open.error));
             open.onsuccess = () => {
               const db = open.result;
               const tx = db.transaction("kv", "readwrite");
               tx.objectStore("kv").put({ ok: true }, "probe");
               tx.oncomplete = () => {
                 const read = db.transaction("kv").objectStore("kv").get("probe");
                 read.onsuccess = () => {
                   db.close();
                   indexedDB.deleteDatabase("aldo-smoke-test");
                   resolve(read.result && read.result.ok === true ? "ok" : "readback mismatch");
                 };
                 read.onerror = () => resolve("read failed");
               };
               tx.onerror = () => resolve("write failed: " + String(tx.error));
             };
           } catch (error) { resolve("threw: " + String(error)); }
         })`,
      )) as string;
      storageOk = probe === "ok";
      storageDetail = probe;
    } catch (error) {
      storageDetail = error instanceof Error ? error.message : String(error);
    }
  }

  const helperOk = helperStatus.state === "ready";
  const pass = loaded.ok && domOk && bridgeOk && storageOk && (helperOk || !REQUIRE_HELPER);

  const result = {
    smokeTest: "aldo-aim-lab-desktop",
    pass,
    frontendLoaded: loaded.ok,
    frontendDetail: loaded.detail,
    appShellRendered: domOk,
    appShellDetail: domDetail,
    desktopBridgeReady: bridgeOk,
    persistentStorage: storageOk,
    persistentStorageDetail: storageDetail,
    helperState: helperStatus.state,
    helperReasonCode: helperStatus.reasonCode,
    helperDetail: helperStatus.detail,
    helperPort: helperStatus.port,
    helperRequired: REQUIRE_HELPER,
    appVersion: app.getVersion(),
  };
  console.log(`SMOKE-TEST-RESULT ${JSON.stringify(result)}`);
  const destinations = [join(app.getPath("userData"), "smoke-test-result.json")];
  if (SMOKE_OUT) destinations.push(SMOKE_OUT);
  for (const destination of destinations) {
    try {
      writeFileSync(destination, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    } catch (error) {
      console.error(`could not write ${destination}: ${String(error)}`);
    }
  }
  exitCode = pass ? 0 : 1;
  clearTimeout(watchdog);
  app.quit();
}
