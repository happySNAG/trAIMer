/**
 * Resource resolution for both `npm run desktop` (unpackaged) and the
 * installed NSIS build (packaged).
 */
import { app } from "electron";
import { join } from "node:path";

/** Built static frontend (dist-app/), packaged inside the asar archive. */
export function frontendRoot(): string {
  return app.isPackaged
    ? join(app.getAppPath(), "dist-app")
    : join(__dirname, "..", "dist-app");
}

/**
 * Compiled Windows Raw Input helper.
 *
 * Packaged builds ship it as an extraResource (OUTSIDE the asar) because a
 * child process cannot be spawned from inside an archive.
 */
export function helperExecutablePath(): string {
  const exeName = "aldo_capture_helper.exe";
  return app.isPackaged
    ? join(process.resourcesPath, exeName)
    : join(__dirname, "..", "native", "windows", exeName);
}

/** Preload script beside the compiled main process bundle. */
export function preloadPath(): string {
  return join(__dirname, "preload.js");
}
