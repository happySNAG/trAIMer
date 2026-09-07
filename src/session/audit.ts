export const AUDIT_CATEGORIES = [
  "experiment-created",
  "allocation-decided",
  "trial-started",
  "trial-ended",
  "trial-invalidated",
  "rest-started",
  "rest-ended",
  "paused",
  "resumed",
  "session-resumed",
  "capture-source-changed",
  /** The session could not obtain the input path it needs (Pass 10). */
  "capture-unavailable",
  /** The mouse was handed back for an interlude — a break or a pause (rc.6). */
  "capture-suspended",
  /** The mouse was taken back after an interlude (rc.6). */
  "capture-resumed",
  "boundary-expansion-proposed",
  "adaptive-allocation-decision",
  "extra-block-requested",
  "retest-linked",
  "recommendation-created",
] as const;

export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export interface AuditEntry {
  seq: number;
  tIso: string;
  category: AuditCategory;
  detail: Record<string, string | number | boolean | null>;
}

export class AuditLog {
  readonly #entries: AuditEntry[] = [];

  append(
    tIso: string,
    category: AuditCategory,
    detail: Record<string, string | number | boolean | null> = {},
  ): void {
    this.#entries.push({
      seq: this.#entries.length,
      tIso,
      category,
      detail,
    });
  }

  /**
   * Restores a previously persisted entry (resume support). Sequence numbers
   * must continue monotonically; a mismatch is corruption and fails loudly.
   */
  restore(entry: AuditEntry): void {
    if (entry.seq !== this.#entries.length) {
      throw new Error(
        `corrupted audit trail: expected seq ${this.#entries.length}, got ${entry.seq}`,
      );
    }
    this.#entries.push({ ...entry, detail: { ...entry.detail } });
  }

  entries(): readonly AuditEntry[] {
    return this.#entries;
  }

  toJSON(): string {
    return JSON.stringify({ schemaVersion: 1, entries: this.#entries }, null, 2);
  }

  has(category: AuditCategory): boolean {
    return this.#entries.some((e) => e.category === category);
  }
}
