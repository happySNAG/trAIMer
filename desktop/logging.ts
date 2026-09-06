/**
 * Local-only rotating log for the desktop shell.
 *
 * Everything a player might need to diagnose a failed launch (helper spawn,
 * port selection, readiness, exits, shutdown) lands in one text file under
 * the installed user-data path. Nothing is ever transmitted anywhere.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 512 * 1024;

export type LogLevel = "info" | "warn" | "error";

export class DesktopLog {
  readonly filePath: string;
  readonly #dir: string;

  constructor(userDataDir: string) {
    this.#dir = join(userDataDir, "logs");
    this.filePath = join(this.#dir, "desktop.log");
  }

  log(level: LogLevel, event: string, detail?: Record<string, unknown>): void {
    const line = JSON.stringify({
      t: new Date().toISOString(),
      level,
      event,
      ...(detail ?? {}),
    });
    // Console output keeps `--smoke-test` runs and dev sessions readable.
    if (level === "error") console.error(line);
    else console.log(line);
    try {
      if (!existsSync(this.#dir)) mkdirSync(this.#dir, { recursive: true });
      if (existsSync(this.filePath) && statSync(this.filePath).size > MAX_BYTES) {
        renameSync(this.filePath, `${this.filePath}.1`);
      }
      appendFileSync(this.filePath, `${line}\n`, "utf8");
    } catch {
      // A log that cannot be written must never take the app down.
    }
  }

  info(event: string, detail?: Record<string, unknown>): void {
    this.log("info", event, detail);
  }
  warn(event: string, detail?: Record<string, unknown>): void {
    this.log("warn", event, detail);
  }
  error(event: string, detail?: Record<string, unknown>): void {
    this.log("error", event, detail);
  }
}
