export const SCHEMA_VERSION = 1 as const;

export type SchemaVersion = typeof SCHEMA_VERSION;

export interface VersionedEnvelope<T> {
  schemaVersion: SchemaVersion;
  kind: PersistedKind;
  savedAtIso: string;
  payload: T;
}

export const PERSISTED_KINDS = [
  "player-profile",
  "mouse-configuration",
  "aim-session",
  "experiment-definition",
  "trial-record",
  "candidate-evaluation",
  "recommendation",
  "optimizer-run",
  "calibration-record",
  "session-checkpoint",
  "session-bundle",
  "human-session",
  "native-capture-fixture",
  "reliability-summary",
  "audit-trail",
] as const;

export type PersistedKind = (typeof PERSISTED_KINDS)[number];
