import { SCHEMA_VERSION, type PersistedKind } from "../domain/schema.ts";
import { APP_VERSION, ENGINE_VERSION } from "../version.ts";
import { unwrapEnvelope } from "./migrations.ts";
import type { StoreBackend } from "./backends.ts";

/**
 * Whole-database backup & validated restore (Pass 5, requirement J).
 *
 * - Export produces ONE self-describing JSON file containing every stored
 *   artifact plus a SHA-256 integrity checksum over its contents.
 * - Restore validates EVERYTHING (checksum + every envelope) BEFORE writing
 *   anything — a corrupt or partially-valid backup never mutates local data.
 * - No cloud storage; the file lives wherever the user saves it.
 */

export interface BackupFile {
  kind: "aldo-backup";
  schemaVersion: 1;
  exportedAtIso: string;
  appVersion: string;
  engineVersion: string;
  /** Sorted relative storage paths. */
  entryPaths: string[];
  /** Raw envelope JSON strings, parallel to entryPaths. */
  entries: string[];
  integrity: { algorithm: "sha256"; checksumHex: string };
}

/** Deterministic JSON serialization (sorted keys) so checksums are stable. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto unavailable: cannot compute integrity checksum");
  const bytes = new TextEncoder().encode(text);
  const digest = await subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function backupChecksumInput(paths: readonly string[], entries: readonly string[]): string {
  // Paths and contents are concatenated deterministically.
  let acc = `${SCHEMA_VERSION}|`;
  for (let i = 0; i < paths.length; i++) {
    acc += `${paths[i]!}=${entries[i] ?? ""};`;
  }
  return acc;
}

export class BackupError extends Error {
  constructor(message: string, readonly reasonCode: string) {
    super(message);
    this.name = "BackupError";
  }
}

/** Reads every artifact from the backend into one checksummed backup file. */
export async function exportBackupAll(backend: StoreBackend): Promise<BackupFile> {
  const roots = [
    "profiles",
    "sessions",
    "experiments",
    "trials",
    "recommendations",
    "optimizer-runs",
    "calibrations",
    "human-sessions",
    "audit",
    "self-tests",
  ];
  const paths: string[] = [];
  const entries: string[] = [];
  for (const root of roots) {
    for (const rel of await backend.listFiles(root)) {
      const fullPath = `${root}/${rel}`;
      const content = await backend.readFile(fullPath);
      if (content === null) continue;
      paths.push(fullPath);
      entries.push(content);
    }
  }
  const checksum = await sha256Hex(backupChecksumInput(paths, entries));
  return {
    kind: "aldo-backup",
    schemaVersion: 1,
    exportedAtIso: new Date().toISOString(),
    appVersion: APP_VERSION,
    engineVersion: ENGINE_VERSION,
    entryPaths: paths,
    entries,
    integrity: { algorithm: "sha256", checksumHex: checksum },
  };
}

export interface RestoreResult {
  restoredCount: number;
  skippedPaths: string[];
}

/** Strict storage-path whitelist: known roots + safe segments only. */
const BACKUP_PATH_PATTERN =
  /^(profiles|sessions|sessions\/checkpoints|experiments|trials|recommendations|optimizer-runs|calibrations|human-sessions|audit|self-tests|session-bundles)\/[A-Za-z0-9][A-Za-z0-9._/-]*\.json$/;

/** Validates one storage path; rejects traversal, absolutes, and unknown roots. */
export function validateBackupPath(path: string): void {
  if (
    path.includes("..") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    !BACKUP_PATH_PATTERN.test(path)
  ) {
    throw new BackupError(
      `unsafe storage path in backup: "${path}"`,
      "BACKUP_UNSAFE_PATH",
    );
  }
}

/**
 * Restores a backup after FULL validation. Throws BackupError (with no data
 * written) when the checksum mismatches, any entry fails to parse, any entry
 * is a NEWER schema version than supported, an entry's kind does not match
 * its path family, or any path escapes the whitelisted storage layout.
 */
export async function importBackupAll(
  backend: StoreBackend,
  backup: unknown,
): Promise<RestoreResult> {
  const b = backup as Partial<BackupFile> | null;
  if (!b || b.kind !== "aldo-backup" || b.schemaVersion !== 1) {
    throw new BackupError("not an Aldo Aim Lab backup file", "BACKUP_BAD_ENVELOPE");
  }
  if (
    !Array.isArray(b.entryPaths) ||
    !Array.isArray(b.entries) ||
    b.entryPaths.length !== b.entries.length
  ) {
    throw new BackupError("backup entry lists are inconsistent", "BACKUP_BAD_ENTRIES");
  }

  // ---- validation pass (no mutation) ----
  const actualChecksum =
    b.integrity?.algorithm === "sha256"
      ? await sha256Hex(backupChecksumInput(b.entryPaths, b.entries))
      : null;
  if (actualChecksum === null || actualChecksum !== b.integrity!.checksumHex) {
    throw new BackupError(
      "integrity checksum mismatch — the backup file is corrupted or was edited",
      "BACKUP_CHECKSUM_MISMATCH",
    );
  }
  for (const path of b.entryPaths) validateBackupPath(path);
  const kindsByRoot: Record<string, PersistedKind> = {
    profiles: "player-profile",
    sessions: "aim-session",
    experiments: "experiment-definition",
    trials: "trial-record",
    recommendations: "recommendation",
    "optimizer-runs": "optimizer-run",
    calibrations: "calibration-record",
    "human-sessions": "human-session",
    audit: "audit-trail",
    "self-tests": "capture-self-test",
  };
  const kindForPath = (path: string): PersistedKind | null => {
    if (path.startsWith("sessions/checkpoints/")) return "session-checkpoint";
    const root = path.split("/")[0]!;
    if (root === "session-bundles") return "session-bundle";
    return kindsByRoot[root] ?? null;
  };
  for (let i = 0; i < b.entryPaths.length; i++) {
    const path = b.entryPaths[i]!;
    const expectedKind = kindForPath(path);
    if (!expectedKind) {
      throw new BackupError(`unknown backup section "${path}"`, "BACKUP_UNKNOWN_SECTION");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(b.entries[i]!);
    } catch {
      throw new BackupError(`entry ${path} is not valid JSON`, "BACKUP_ENTRY_CORRUPT");
    }
    try {
      unwrapEnvelope(expectedKind, parsed);
    } catch (err) {
      throw new BackupError(
        `entry ${path} failed validation: ${err instanceof Error ? err.message : String(err)}`,
        "BACKUP_ENTRY_REJECTED",
      );
    }
  }

  // ---- mutation pass ----
  for (let i = 0; i < b.entryPaths.length; i++) {
    await backend.writeFile(b.entryPaths[i]!, b.entries[i]!);
  }
  return { restoredCount: b.entryPaths.length, skippedPaths: [] };
}
