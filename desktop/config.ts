/**
 * Shared constants for the Aldo Aim Lab desktop shell.
 *
 * The desktop shell is the ONLY supported way players launch Aldo Aim Lab on
 * Windows (installer -> Start Menu / Desktop shortcut -> this process). It
 * owns the window, the local frontend delivery, and the native capture
 * helper's whole lifecycle. No PowerShell, no terminal, no manual steps.
 */

/** Electron app name -> %APPDATA%\AldoAimLab (installed user-data path). */
export const APP_DIR_NAME = "AldoAimLab";

/** Human-facing product name (window title, installer, shortcuts). */
export const PRODUCT_NAME = "Aldo Aim Lab";

/**
 * Custom scheme used to deliver the built frontend.
 *
 * Registered as standard + secure + corsEnabled so the renderer gets a
 * stable, potentially-trustworthy origin (`aldo://app`). That matters for
 * three reasons:
 *   1. Pointer Lock requires a secure context.
 *   2. IndexedDB (all training history) is keyed by origin — a fixed scheme
 *      keeps history across launches, upgrades and reinstalls, whereas an
 *      ephemeral `http://127.0.0.1:<port>` origin would silently orphan it.
 *   3. No listening TCP socket is needed to show the UI at all.
 */
export const APP_SCHEME = "aldo";

/** Authority component of the frontend origin: aldo://app/... */
export const APP_HOST = "app";

export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** First port tried for the native capture helper; we scan upward from here. */
export const HELPER_BASE_PORT = 48765;

/** How many consecutive ports to try before giving up. */
export const HELPER_PORT_SCAN = 12;

/** Maximum time to wait for the helper to accept loopback connections. */
export const HELPER_READY_TIMEOUT_MS = 10_000;

/** Automatic restarts allowed after an unexpected helper exit. */
export const HELPER_MAX_RESTARTS = 2;

/** Grace period for a polite helper shutdown before force-killing. */
export const HELPER_STOP_GRACE_MS = 3_000;
