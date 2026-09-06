/**
 * Typed access to the Electron desktop shell, when the app runs inside it.
 *
 * The web frontend stays a plain static bundle: every desktop-only capability
 * is optional and behind this accessor, so the same build still runs in a
 * browser (Playwright suites, development, portable fallback) with no shell
 * present.
 */

export type DesktopHelperState =
  | "idle"
  | "starting"
  | "ready"
  | "unavailable"
  | "stopped";

export interface DesktopHelperStatus {
  state: DesktopHelperState;
  reasonCode: string | null;
  detail: string;
  port: number | null;
  pid: number | null;
  url: string | null;
  restarts: number;
  platformSupported: boolean;
}

export interface DesktopBridge {
  readonly isDesktop: true;
  readonly appVersion: string;
  readonly productName: string;
  readonly platform: string;
  /** Capture-helper handshake token minted by the shell for this launch. */
  readonly sessionToken: string;
  /** ws://127.0.0.1:<port> once the shell's helper is listening, else null. */
  readonly helperUrl: string | null;
  readonly logPath: string;
  helperStatus(): Promise<DesktopHelperStatus>;
  restartHelper(): Promise<DesktopHelperStatus>;
  openLogFolder(): Promise<boolean>;
  onHelperStatus(callback: (status: DesktopHelperStatus) => void): () => void;
}

declare global {
  interface Window {
    aldoDesktop?: DesktopBridge;
  }
}

/** Returns the desktop bridge, or null when running as a plain web page. */
export function desktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = window.aldoDesktop;
  if (!bridge || bridge.isDesktop !== true) return null;
  if (typeof bridge.sessionToken !== "string") return null;
  return bridge;
}

/** True when the app is running inside the installed desktop shell. */
export function isDesktopShell(): boolean {
  return desktopBridge() !== null;
}

/** Default helper URL: the shell's live port when known, else the documented one. */
export function defaultHelperUrl(): string {
  return desktopBridge()?.helperUrl ?? "ws://127.0.0.1:48765";
}
