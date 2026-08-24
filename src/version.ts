/**
 * Explicit application and engine version metadata (V1 release candidate).
 *
 * Every persisted artifact that records a decision (human session, optimizer
 * run, recommendation, export bundle, audit data, capture self-test) embeds
 * these strings so any historical result can be traced to the exact code that
 * produced it.
 *
 * The V1 release candidate is identified as 1.0.0-rc.2 (Pass 8 pre-hardware
 * audit: fail-closed helper-version handshake, per-session experiment
 * identity). rc.1 never shipped to hardware; rc.N increments mark each
 * distinct candidate until hardware validation freezes one. All component
 * versions below are frozen for that release line; see docs/RELEASE.md for
 * the full compatibility matrix describing which builds can read which
 * persisted artifacts.
 */

export const APP_NAME = "aldo-aim-lab";

/** Application release version for the V1 release candidate. */
export const APP_VERSION = "1.0.0-rc.2";

/**
 * Engine contract version: bump when a persisted engine-facing data contract
 * changes shape in a way consumers must detect.
 */
export const ENGINE_VERSION = "engine-v4";

/** Optimizer implementation version (paired fit + adequacy gating + change-point). */
export const OPTIMIZER_VERSION = "optimizer-v3";

/**
 * Back-compat alias used by older call sites; identical to OPTIMIZER_VERSION.
 * Do not introduce a second optimizer version without a migration plan.
 */
export const OPTIMIZER_VERSION_V4 = OPTIMIZER_VERSION;

/**
 * Scoring-model version: dimension definitions and composite utility weights
 * (accuracy .28 / speed .14 / trackingPrecision .14 / correctionEfficiency
 * .12 / overshootControl .11 / undershootControl .11 / consistency .10).
 */
export const SCORING_MODEL_VERSION = "scoring-v1";

/**
 * Native transport protocol version. Must equal PROTOCOL_VERSION embedded in
 * native/windows/aldo_capture_helper.c — enforced by
 * tests/nativeProtocolConstants.test.ts and CI.
 */
export const NATIVE_PROTOCOL_VERSION = 1;

/**
 * Native helper implementation version expected by this build. The helper's
 * self-reported HELPER_VERSION must match exactly (fail-closed handshake).
 */
export const EXPECTED_HELPER_VERSION = "helper-1.0.0";

/**
 * Calibration workflow version: multi-turn reps, median/MAD robust fitting,
 * adequacy gates, staleness fingerprints.
 */
export const CALIBRATION_VERSION = "calibration-v2";

/**
 * Resume checkpoint schema version (inner payload of `session-checkpoint`).
 */
export const RESUME_SCHEMA_VERSION = 2;

export interface ReleaseMetadata {
  appName: string;
  appVersion: string;
  engineVersion: string;
  optimizerVersion: string;
  schemaVersion: number;
}

export interface FullReleaseMetadata extends ReleaseMetadata {
  scoringModelVersion: string;
  nativeProtocolVersion: number;
  expectedHelperVersion: string;
  calibrationVersion: string;
  resumeSchemaVersion: number;
}

let currentSchemaVersion = 1;

/** Registers the active schema version so metadata can carry it. */
export function setActiveSchemaVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`invalid schema version: ${version}`);
  }
  currentSchemaVersion = version;
}

export function releaseMetadata(): ReleaseMetadata {
  return {
    appName: APP_NAME,
    appVersion: APP_VERSION,
    engineVersion: ENGINE_VERSION,
    optimizerVersion: OPTIMIZER_VERSION,
    schemaVersion: currentSchemaVersion,
  };
}

export function fullReleaseMetadata(): FullReleaseMetadata {
  return {
    ...releaseMetadata(),
    scoringModelVersion: SCORING_MODEL_VERSION,
    nativeProtocolVersion: NATIVE_PROTOCOL_VERSION,
    expectedHelperVersion: EXPECTED_HELPER_VERSION,
    calibrationVersion: CALIBRATION_VERSION,
    resumeSchemaVersion: RESUME_SCHEMA_VERSION,
  };
}

/**
 * Compatibility check used at load time: an artifact produced by a DIFFERENT
 * engine version must be rejected loudly unless it predates version tagging
 * (null/undefined). We have no cross-engine migration path, so strict
 * equality is the honest contract.
 */
export function checkEngineCompatibility(
  artifactEngineVersion: string | null | undefined,
): { compatible: boolean; reason: string | null } {
  if (artifactEngineVersion === null || artifactEngineVersion === undefined) {
    return { compatible: true, reason: null };
  }
  if (artifactEngineVersion === ENGINE_VERSION) {
    return { compatible: true, reason: null };
  }
  return {
    compatible: false,
    reason: `artifact was produced by ${artifactEngineVersion} but this build is ${ENGINE_VERSION}`,
  };
}

/**
 * Compatibility matrix entry describing which artifact generations this
 * build can read. Used by preflight and by docs/RELEASE.md (the prose copy
 * of this table is generated from these constants at release time).
 */
export interface ArtifactCompatibility {
  /** Envelope kind or artifact family. */
  artifact: string;
  /** Schema/inner versions readable by THIS build. */
  readableVersions: string;
  /** What happens to artifacts outside those versions. */
  olderPolicy: "migrated" | "rejected" | "flagged-stale";
  newerPolicy: "rejected" | "flagged";
}

export const ARTIFACT_COMPATIBILITY_MATRIX: readonly ArtifactCompatibility[] = [
  { artifact: "trial-record / experiment-definition / recommendation (envelope)", readableVersions: "schemaVersion 1", olderPolicy: "migrated", newerPolicy: "rejected" },
  { artifact: "resume checkpoint (session-checkpoint)", readableVersions: `resume schemaVersion ${RESUME_SCHEMA_VERSION}`, olderPolicy: "rejected", newerPolicy: "rejected" },
  { artifact: "session bundle import", readableVersions: "schemaVersion <= 1", olderPolicy: "migrated", newerPolicy: "rejected" },
  { artifact: "calibration record", readableVersions: "schemaVersion 1 (optional Pass-4 fields)", olderPolicy: "flagged-stale", newerPolicy: "rejected" },
  { artifact: "engine-tagged artifacts", readableVersions: `${ENGINE_VERSION} or untagged`, olderPolicy: "rejected", newerPolicy: "rejected" },
  { artifact: "native transport frames", readableVersions: `protocolVersion ${NATIVE_PROTOCOL_VERSION}`, olderPolicy: "rejected", newerPolicy: "rejected" },
];
