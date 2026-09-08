/**
 * Context bridge between the Electron shell and the existing web frontend.
 *
 * Runs sandboxed with context isolation: the renderer gets a small, frozen,
 * explicitly-enumerated API and no Node access whatsoever.
 */
import { contextBridge, ipcRenderer } from "electron";

interface Bootstrap {
  appVersion: string;
  productName: string;
  sessionToken: string;
  helperUrl: string | null;
  platform: string;
  logPath: string;
}

interface HelperStatus {
  state: string;
  reasonCode: string | null;
  detail: string;
  port: number | null;
  pid: number | null;
  url: string | null;
  restarts: number;
  platformSupported: boolean;
}

const bootstrap = ipcRenderer.sendSync("aldo:bootstrap") as Bootstrap;

const api = Object.freeze({
  isDesktop: true as const,
  appVersion: bootstrap.appVersion,
  productName: bootstrap.productName,
  platform: bootstrap.platform,
  /** Capture-helper handshake token for THIS launch. */
  sessionToken: bootstrap.sessionToken,
  /** ws://127.0.0.1:<port> when the helper is up, else null. */
  helperUrl: bootstrap.helperUrl,
  /** Where the shell writes its local diagnostic log. */
  logPath: bootstrap.logPath,
  helperStatus: (): Promise<HelperStatus> => ipcRenderer.invoke("aldo:helper-status"),
  restartHelper: (): Promise<HelperStatus> => ipcRenderer.invoke("aldo:helper-restart"),
  openLogFolder: (): Promise<boolean> => ipcRenderer.invoke("aldo:open-log-folder"),
  onHelperStatus: (callback: (status: HelperStatus) => void): (() => void) => {
    const listener = (_event: unknown, status: HelperStatus): void => callback(status);
    ipcRenderer.on("aldo:helper-status", listener);
    return () => ipcRenderer.removeListener("aldo:helper-status", listener);
  },
});

contextBridge.exposeInMainWorld("aldoDesktop", api);
