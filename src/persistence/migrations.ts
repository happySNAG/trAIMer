import {
  SCHEMA_VERSION,
  type PersistedKind,
  type VersionedEnvelope,
} from "../domain/schema.ts";

export interface MigrationStep {
  fromVersion: number;
  toVersion: number;
  migrate(payload: unknown): unknown;
}

const MIGRATIONS = new Map<PersistedKind, MigrationStep[]>();

export function registerMigration(
  kind: PersistedKind,
  step: MigrationStep,
): void {
  const steps = MIGRATIONS.get(kind) ?? [];
  if (!steps.some((s) => s.toVersion === step.toVersion)) {
    steps.push(step);
    steps.sort((a, b) => a.fromVersion - b.fromVersion);
    MIGRATIONS.set(kind, steps);
  }
}

export function knownMigrations(): ReadonlyMap<PersistedKind, readonly MigrationStep[]> {
  return MIGRATIONS;
}

export function wrapEnvelope<T>(
  kind: PersistedKind,
  payload: T,
  savedAtIso: string,
): VersionedEnvelope<T> {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind,
    savedAtIso,
    payload,
  };
}

export function unwrapEnvelope<T>(
  expectedKind: PersistedKind,
  raw: unknown,
): { payload: T; migratedFrom: number | null } {
  const envelope = raw as Partial<VersionedEnvelope<unknown>> | null;
  if (
    !envelope ||
    typeof envelope !== "object" ||
    typeof envelope.schemaVersion !== "number" ||
    envelope.kind !== expectedKind
  ) {
    throw new Error(
      `invalid envelope: expected kind=${expectedKind} with numeric schemaVersion`,
    );
  }
  let payload: unknown = envelope.payload;
  let version: number = envelope.schemaVersion;
  let migratedFrom: number | null = null;
  while (version < SCHEMA_VERSION) {
    const steps = MIGRATIONS.get(expectedKind) ?? [];
    const step = steps.find((s) => s.fromVersion === version);
    if (!step) {
      throw new Error(
        `no migration path for ${expectedKind} from schemaVersion ${version}`,
      );
    }
    payload = step.migrate(payload);
    version = step.toVersion;
    migratedFrom = migratedFrom ?? envelope.schemaVersion;
  }
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `${expectedKind} data at schemaVersion ${version} is newer than supported ${SCHEMA_VERSION}`,
    );
  }
  return { payload: payload as T, migratedFrom };
}

registerMigration("trial-record", {
  fromVersion: 0,
  toVersion: 1,
  migrate(legacy) {
    const l = legacy as {
      id?: string;
      samples?: { t: number; pos: { x: number; y: number } }[];
      [key: string]: unknown;
    };
    if (!l || !Array.isArray(l.samples)) {
      throw new Error("legacy trial-record payload missing samples");
    }
    let prev: { x: number; y: number } | null = null;
    const samples = l.samples.map((s) => {
      const dx = prev ? s.pos.x - prev.x : 0;
      const dy = prev ? s.pos.y - prev.y : 0;
      prev = s.pos;
      return { tMs: s.t, cursor: s.pos, dx, dy };
    });
    const { samples: _legacySamples, ...rest } = l;
    void _legacySamples;
    return { ...rest, samples };
  },
});
