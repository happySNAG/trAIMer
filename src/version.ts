/**
 * Explicit application and engine version metadata (Pass 4).
 *
 * Every persisted artifact that records a decision (human session, optimizer
 * run, recommendation, export bundle, audit data) embeds these strings so any
 * historical result can be traced to the exact code that produced it.
 */

export const APP_NAME = "aldo-aim-lab";

/** Application release version for V1. */
export const APP_VERSION = "1.0.0-rc.1";

/**
 * Engine contract version: bump when a persisted engine-facing data contract
 * changes shape in a way consumers must detect.
 */
export const ENGINE_VERSION = "engine-v4";

/** Optimizer implementation version (bumped from optimizer-v2 in Pass 4). */
export const OPTIMIZER_VERSION_V4 = "optimizer-v3";

export interface ReleaseMetadata {
  appName: string;
  appVersion: string;
  engineVersion: string;
  optimizerVersion: string;
  schemaVersion: number;
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
    optimizerVersion: OPTIMIZER_VERSION_V4,
    schemaVersion: currentSchemaVersion,
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
