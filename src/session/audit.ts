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
  "boundary-expansion-proposed",
  "adaptive-allocation-decision",
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
