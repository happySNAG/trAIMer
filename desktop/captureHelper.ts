/**
 * Native capture helper lifecycle owner.
 *
 * The desktop shell — not the player, not a script, not the renderer — starts
 * and stops `traimer_capture_helper.exe`. Contract:
 *
 *   start()  mints nothing (see sessionToken.ts), picks a free loopback port,
 *            spawns the helper with an ARGUMENT ARRAY (never a shell string),
 *            and waits until the helper actually accepts a TCP connection.
 *   stop()   terminates the child deterministically and waits for its exit.
 *
 * Failure is always reported as structured status, never as a silent
 * degradation: if the helper cannot run, the app still opens and the UI says
 * capture is limited to the browser tier.
 *
 * Safety boundary is unchanged from the helper itself: Raw Input observation
 * on loopback only. Nothing here injects, hooks, or synthesizes input.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { existsSync } from "node:fs";
import {
  HELPER_BASE_PORT,
  HELPER_MAX_RESTARTS,
  HELPER_PORT_SCAN,
  HELPER_READY_TIMEOUT_MS,
  HELPER_STOP_GRACE_MS,
} from "./config";
import type { DesktopLog } from "./logging";

export type HelperState =
  | "idle"
  | "starting"
  | "ready"
  | "unavailable"
  | "stopped";

export interface HelperStatus {
  state: HelperState;
  /** Stable machine-readable reason when not ready (null while healthy). */
  reasonCode: string | null;
  /** Human-readable one-liner suitable for direct display. */
  detail: string;
  port: number | null;
  pid: number | null;
  /** Loopback WebSocket URL the renderer should use, or null. */
  url: string | null;
  restarts: number;
  /** False on non-Windows hosts, where no native helper is shipped. */
  platformSupported: boolean;
}

/** Resolves true when something is listening on 127.0.0.1:port. */
function probePort(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (ok: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** True when 127.0.0.1:port can be bound right now (i.e. nothing owns it). */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.once("listening", () => server.close(() => resolvePromise(true)));
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Picks the first free loopback port at/after the base.
 *
 * This is what makes a second launch safe: even if a stale helper is still
 * holding the default port, a new instance never collides with it. (The
 * single-instance lock means we normally never get here twice at all.)
 */
export async function findFreeHelperPort(
  base = HELPER_BASE_PORT,
  scan = HELPER_PORT_SCAN,
): Promise<number | null> {
  for (let port = base; port < base + scan; port++) {
    if (await portIsFree(port)) return port;
  }
  return null;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export class CaptureHelper {
  #child: ChildProcess | null = null;
  #status: HelperStatus;
  #stopping = false;
  #listeners = new Set<(status: HelperStatus) => void>();

  constructor(
    private readonly exePath: string,
    private readonly sessionToken: string,
    private readonly log: DesktopLog,
  ) {
    this.#status = {
      state: "idle",
      reasonCode: null,
      detail: "not started",
      port: null,
      pid: null,
      url: null,
      restarts: 0,
      platformSupported: process.platform === "win32",
    };
  }

  get status(): HelperStatus {
    return { ...this.#status };
  }

  onStatus(listener: (status: HelperStatus) => void): void {
    this.#listeners.add(listener);
  }

  #set(patch: Partial<HelperStatus>): void {
    this.#status = { ...this.#status, ...patch };
    const snapshot = this.status;
    for (const listener of this.#listeners) listener(snapshot);
  }

  /**
   * Starts the helper and resolves once it is ready OR definitively
   * unavailable. Never rejects: an unavailable helper is a product state, not
   * a crash.
   */
  async start(): Promise<HelperStatus> {
    if (this.#status.state === "ready" || this.#status.state === "starting") {
      return this.status;
    }
    if (!this.#status.platformSupported) {
      this.#set({
        state: "unavailable",
        reasonCode: "HELPER_PLATFORM_UNSUPPORTED",
        detail:
          "The native capture helper ships for Windows x64 only; running with browser capture.",
      });
      return this.status;
    }
    if (!existsSync(this.exePath)) {
      this.#set({
        state: "unavailable",
        reasonCode: "HELPER_MISSING",
        detail: `traimer_capture_helper.exe was not found at ${this.exePath}. Reinstall trAIMer.`,
      });
      this.log.error("helper-missing", { exePath: this.exePath });
      return this.status;
    }

    this.#set({ state: "starting", reasonCode: null, detail: "starting native capture helper…" });

    const port = await findFreeHelperPort();
    if (port === null) {
      this.#set({
        state: "unavailable",
        reasonCode: "HELPER_NO_FREE_PORT",
        detail: `No free loopback port in ${HELPER_BASE_PORT}-${HELPER_BASE_PORT + HELPER_PORT_SCAN - 1}.`,
      });
      return this.status;
    }

    // Argument ARRAY, no shell: the token can never be reinterpreted by a
    // command interpreter.
    //
    // --parent-pid lets the helper watch THIS process and exit on its own if
    // the shell is killed hard (Task Manager, crash) rather than quitting
    // cleanly. stop() below is the normal path; this is the backstop that
    // makes an orphaned helper holding the loopback port impossible.
    const args = [
      "--port",
      String(port),
      "--token",
      this.sessionToken,
      "--parent-pid",
      String(process.pid),
    ];
    const child = spawn(this.exePath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: false,
    });
    this.#child = child;
    this.#set({ port, pid: child.pid ?? null });
    this.log.info("helper-spawned", { pid: child.pid ?? null, port, exePath: this.exePath });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.log.warn("helper-stderr", { text: text.slice(0, 500) });
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.log.info("helper-stdout", { text: text.slice(0, 500) });
    });

    child.once("error", (err: Error) => {
      this.log.error("helper-spawn-error", { message: err.message });
      this.#set({
        state: "unavailable",
        reasonCode: "HELPER_SPAWN_FAILED",
        detail: `The capture helper could not be started: ${err.message}`,
        url: null,
      });
    });

    child.once("exit", (code, signal) => {
      this.#child = null;
      if (this.#stopping) {
        this.#set({ state: "stopped", detail: "helper stopped", url: null, pid: null });
        return;
      }
      this.log.warn("helper-exited", { code, signal });
      void this.#handleUnexpectedExit(code);
    });

    const ready = await this.#waitForReady(port, child);
    if (!ready) {
      this.#terminate(child);
      this.#set({
        state: "unavailable",
        reasonCode: "HELPER_NOT_READY",
        detail:
          "The capture helper started but never accepted a local connection; running with browser capture.",
        url: null,
      });
      return this.status;
    }

    this.#set({
      state: "ready",
      reasonCode: null,
      detail: "native capture helper ready",
      url: `ws://127.0.0.1:${port}`,
    });
    this.log.info("helper-ready", { port, pid: child.pid ?? null });
    return this.status;
  }

  async #waitForReady(port: number, child: ChildProcess): Promise<boolean> {
    const deadline = Date.now() + HELPER_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      if (await probePort(port, 500)) return true;
      await sleep(150);
    }
    return false;
  }

  async #handleUnexpectedExit(code: number | null): Promise<void> {
    if (this.#status.restarts >= HELPER_MAX_RESTARTS) {
      this.#set({
        state: "unavailable",
        reasonCode: "HELPER_CRASHED",
        detail: `The capture helper exited unexpectedly (code ${code ?? "?"}) and was not restarted again. Running with browser capture.`,
        url: null,
        pid: null,
      });
      return;
    }
    this.#set({
      state: "starting",
      restarts: this.#status.restarts + 1,
      detail: "capture helper exited; restarting…",
      url: null,
      pid: null,
    });
    await sleep(400);
    if (this.#stopping) return;
    await this.start();
  }

  #terminate(child: ChildProcess): void {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }

  /** Deterministic teardown: polite kill, hard kill after the grace period. */
  async stop(): Promise<void> {
    this.#stopping = true;
    const child = this.#child;
    if (!child) {
      this.#set({ state: "stopped", detail: "helper stopped", url: null, pid: null });
      return;
    }
    const exited = new Promise<void>((resolvePromise) => {
      child.once("exit", () => resolvePromise());
    });
    this.#terminate(child);
    let settled = false;
    await Promise.race([
      exited.then(() => {
        settled = true;
      }),
      sleep(HELPER_STOP_GRACE_MS),
    ]);
    if (!settled) {
      this.log.warn("helper-force-kill", { pid: child.pid ?? null });
      try {
        child.kill("SIGKILL");
      } catch {
        // Nothing else we can do; the OS reaps it with our process tree.
      }
    }
    this.#child = null;
    this.#set({ state: "stopped", detail: "helper stopped", url: null, pid: null });
    this.log.info("helper-stopped");
  }

  /** Manual restart used by the in-app "retry capture helper" affordance. */
  async restart(): Promise<HelperStatus> {
    await this.stop();
    this.#stopping = false;
    this.#set({ state: "idle", restarts: 0, reasonCode: null, detail: "restarting…" });
    return this.start();
  }
}
