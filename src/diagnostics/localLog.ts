import { releaseMetadata, type ReleaseMetadata } from "../version.ts";

/**
 * Local-only diagnostic logging (Pass 4, requirement T).
 *
 * Suitable for bug reports; NEVER leaves the machine unless the user exports
 * a diagnostic bundle deliberately. Excludes personal information by design:
 * no raw input samples, no file contents — only versions, modes, transitions,
 * validation failures, error codes and lifecycle events.
 */

export type DiagnosticLogLevel = "info" | "warn" | "error";

export interface DiagnosticLogEntry {
  seq: number;
  atIso: string;
  level: DiagnosticLogLevel;
  event: string;
  detail: Record<string, string | number | boolean | null>;
}

export interface DiagnosticBundle {
  kind: "aldo-diagnostic-bundle";
  schemaVersion: 1;
  exportedAtIso: string;
  release: ReleaseMetadata;
  captureModeSummary: string | null;
  entries: DiagnosticLogEntry[];
  notes: string[];
}

const MAX_IN_MEMORY_ENTRIES = 2000;

export class LocalDiagnosticLog {
  readonly #entries: DiagnosticLogEntry[] = [];
  #captureModeSummary: string | null = null;
  readonly #release: ReleaseMetadata;

  constructor(nowIso: () => string = () => new Date().toISOString()) {
    this.#nowIso = nowIso;
    this.#release = releaseMetadata();
  }

  readonly #nowIso: () => string;

  setCaptureMode(summary: string): void {
    this.#captureModeSummary = summary;
    this.log("info", "capture-mode", { mode: summary });
  }

  log(
    level: DiagnosticLogLevel,
    event: string,
    detail: Record<string, string | number | boolean | null> = {},
  ): void {
    this.#entries.push({
      seq: this.#entries.length,
      atIso: this.#nowIso(),
      level,
      event,
      detail,
    });
    if (this.#entries.length > MAX_IN_MEMORY_ENTRIES) {
      // Keep the most recent entries; older ones rotate out silently.
      this.#entries.splice(0, this.#entries.length - MAX_IN_MEMORY_ENTRIES);
      for (let i = 0; i < this.#entries.length; i++) {
        this.#entries[i]!.seq = i;
      }
    }
  }

  sessionTransition(from: string, to: string): void {
    this.log("info", "session-transition", { from, to });
  }

  validationFailure(trialId: string, reasonCodes: string[]): void {
    this.log("warn", "validation-failure", { trialId, reasons: reasonCodes.join("+") });
  }

  nativeLifecycle(phase: string, detail: Record<string, string | number | boolean | null> = {}): void {
    this.log("info", "native-lifecycle", { phase, ...detail });
  }

  error(code: string, message: string): void {
    this.log("error", "error", { code, message });
  }

  optimizerSummary(edpi: number, confidence: number, rounds: number): void {
    this.log("info", "optimizer-summary", {
      recommendedEdpi: Math.round(edpi),
      confidence: Number(confidence.toFixed(3)),
      rounds,
    });
  }

  entries(): readonly DiagnosticLogEntry[] {
    return this.#entries;
  }

  exportBundle(notes: string[] = []): DiagnosticBundle {
    return {
      kind: "aldo-diagnostic-bundle",
      schemaVersion: 1,
      exportedAtIso: this.#nowIso(),
      release: { ...this.#release },
      captureModeSummary: this.#captureModeSummary,
      entries: this.#entries.map((e) => ({ ...e, detail: { ...e.detail } })),
      notes,
    };
  }
}
