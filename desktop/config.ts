/**
 * Shared constants for the trAIMer desktop shell.
 *
 * The desktop shell is the ONLY supported way players launch trAIMer on
 * Windows (installer -> Start Menu / Desktop shortcut -> this process). It
 * owns the window, the local frontend delivery, and the native capture
 * helper's whole lifecycle. No PowerShell, no terminal, no manual steps.
 */

/** Electron app name -> %APPDATA%\trAIMer (installed user-data path). */
export const APP_DIR_NAME = "trAIMer";

/**
 * The user-data directory used by builds up to and including 1.0.0-rc.6,
 * when the product was called Aldo Aim Lab.
 *
 * Everything a player has ever recorded lives here: IndexedDB training
 * history, calibration, settings and diagnostics. The rename must MOVE it,
 * never orphan it — see desktop/userDataMigration.ts.
 */
export const LEGACY_APP_DIR_NAME = "AldoAimLab";

/** Human-facing product name (window title, installer, shortcuts). */
export const PRODUCT_NAME = "trAIMer";

/** Shown beside the product name wherever there is room for it. */
export const PRODUCT_TAGLINE = "Train. Measure. Tune.";

/**
 * Custom scheme used to deliver the built frontend.
 *
 * DELIBERATELY NOT RENAMED with the product. IndexedDB, localStorage and every
 * other web-storage bucket is keyed by ORIGIN: changing `aldo://app` to
 * `traimer://app` would present every existing player with an empty app and
 * no way back to their training history. The scheme never appears in any
 * user-facing surface — the shell has no address bar — so it carries no
 * branding weight, and it is allowlisted in the branding gate for exactly
 * this reason (scripts/verify-branding.mjs).
 *
 * Registered as standard + secure + corsEnabled so the renderer gets a
 * stable, potentially-trustworthy origin. That matters for three reasons:
 *   1. Pointer Lock requires a secure context.
 *   2. IndexedDB (all training history) is keyed by origin — a fixed scheme
 *      keeps history across launches, upgrades, reinstalls AND renames.
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
