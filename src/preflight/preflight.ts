import { fullReleaseMetadata, checkEngineCompatibility, type FullReleaseMetadata } from "../version.ts";
import { DEFAULT_SAFE_RANGE } from "../domain/candidate.ts";

/**
 * First-run / pre-session system check (Pass 5, requirement E).
 *
 * A pure, deterministic gate evaluated BEFORE any high-confidence test may
 * run. It inspects an injected snapshot of the environment — browser/runtime
 * support, native helper presence and protocol compatibility, active capture
 * tier with observed input rate, timestamp monotonicity, jitter/drop
 * diagnostics, DPI/X/Y configuration, calibration state, persistent storage,
 * viewport characteristics, unfinished checkpoints, and version
 * compatibility — and produces one of four verdicts with machine-readable
 * reasons:
 *
 *   READY
 *   READY_WITH_WARNINGS
 *   NOT_READY_FOR_HIGH_CONFIDENCE
 *   BLOCKED
 *
 * A broken environment must never look valid: every failing check carries a
 * stable reason code that UIs surface verbatim.
 */

export const PREFLIGHT_VERDICTS = [
  "READY",
  "READY_WITH_WARNINGS",
  "NOT_READY_FOR_HIGH_CONFIDENCE",
  "BLOCKED",
] as const;

export type PreflightVerdict = (typeof PREFLIGHT_VERDICTS)[number];

export type PreflightCheckStatus = "pass" | "warn" | "fail";

export interface PreflightCheck {
  /** Stable machine-readable check name. */
  name: PreflightCheckName;
  status: PreflightCheckStatus;
  /** Stable machine-readable reason code (null when passing cleanly). */
  reasonCode: string | null;
  detail: string;
}

export const PREFLIGHT_CHECK_NAMES = [
  "runtime-support",
  "pointer-capture-mode",
  "native-helper-presence",
  "native-protocol-compatibility",
  "active-capture-tier",
  "observed-input-rate",
  "timestamp-monotonicity",
  "jitter-and-drop-diagnostics",
  "dpi-configured",
  "xy-configured",
  "calibration-state",
  "persistent-storage",
  "viewport-display",
  "unfinished-checkpoints",
  "version-compatibility",
] as const;

export type PreflightCheckName = (typeof PREFLIGHT_CHECK_NAMES)[number];

export interface PreflightReport {
  overall: PreflightVerdict;
  checks: PreflightCheck[];
  /** Machine-readable reason codes for every warn/fail (stable identifiers). */
  reasonCodes: string[];
  generatedAtIso: string;
  release: FullReleaseMetadata;
  summaryLines: string[];
}

/** Named thresholds — presentation code reads them, never redefines them. */
export const PREFLIGHT_THRESHOLDS = {
  /** Below this observed rate, high-confidence testing is refused. */
  minObservedInputRateHz: 40,
  /** Above this fraction of dropped sequences, native capture is not trusted. */
  maxDropFraction: 0.01,
  /** Above this interval CV, timing is considered unstable for native capture. */
  maxJitterCv: 0.6,
  /** Minimum plausible mouse DPI setting. */
  minPlausibleDpi: 50,
  /** Maximum plausible mouse DPI setting. */
  maxPlausibleDpi: 26000,
  /** Minimum usable viewport side length in logical pixels. */
  minViewportSidePx: 600,
  /** Minimum available storage for raw-first persistence (bytes). */
  minAvailableStorageBytes: 10 * 1024 * 1024,
  /** Checkpoints older than this are stale and should be reviewed first. */
  staleCheckpointAgeMs: 7 * 24 * 60 * 60 * 1000,
} as const;

export interface PreflightPointerCapabilities {
  /** e.g. "pointermove-coalesced" | "pointermove" | "mousemove". */
  capturePath: string;
  pointerLockSupported: boolean;
}

export interface PreflightNativeHelperInfo {
  /** Helper reachable at its loopback URL? */
  present: boolean;
  /** Helper answered the versioned handshake? */
  protocolCompatible: boolean | null;
  /** Helper self-version matches EXPECTED_HELPER_VERSION? */
  helperVersionOk: boolean | null;
}

/**
 * Result of the most recent guided capture self-test
 * (`src/diagnostics/captureSelfTest.ts`), when one exists.
 */
export interface PreflightCaptureQualityFacts {
  observedRateHz: number | null;
  timestampsMonotonic: boolean | null;
  dropFraction: number | null;
  jitterCv: number | null;
  selfTestVerdict: "pass" | "warn" | "fail" | null;
}

export interface PreflightEnvironment {
  runtime: {
    /** Browser/runtime name reported by the environment probe. */
    browserName: string;
    isSupportedChromiumRuntime: boolean;
    pointer: PreflightPointerCapabilities;
  };
  nativeHelper: PreflightNativeHelperInfo | null;
  /** Active negotiated tier: 1 validated native, 2 coalesced, 3 basic mouse; null = none yet. */
  activeCaptureTier: 1 | 2 | 3 | null;
  captureQuality: PreflightCaptureQualityFacts;
  dpi: number | null;
  sensXPercent: number | null;
  sensYPercent: number | null;
  calibration: {
    hasAdequateCalibration: boolean;
    stale: boolean;
  } | null;
  storage: { availableBytes: number | null };
  viewport: { widthPx: number; heightPx: number } | null;
  unfinishedCheckpoints: { ageMs: number }[];
  /** Engine versions recorded on stored decision artifacts (null = untagged/pre-versioning). */
  storedArtifactEngineVersions: (string | null)[];
  nowIso?: string | undefined;
}

function fail(name: PreflightCheckName, code: string, detail: string): PreflightCheck {
  return { name, status: "fail", reasonCode: code, detail };
}
function warn(name: PreflightCheckName, code: string, detail: string): PreflightCheck {
  return { name, status: "warn", reasonCode: code, detail };
}
function pass(name: PreflightCheckName, detail: string): PreflightCheck {
  return { name, status: "pass", reasonCode: null, detail };
}

const TIER_LABELS: Record<number, string> = {
  1: "validated native capture",
  2: "browser coalesced pointer events",
  3: "browser basic mouse events",
};

/**
 * Aggregation rules:
 * - BLOCKED: environment cannot run the app safely at all (no Pointer Lock,
 *   no persistent storage, or incompatible stored artifacts).
 * - NOT_READY_FOR_HIGH_CONFIDENCE: measurement quality gates failed
 *   (capture tier/rate/timestamps/jitter/drops/DPI/X-Y).
 * - READY_WITH_WARNINGS: only advisory problems (stale calibration,
 *   unfinished checkpoints, degraded-but-usable capture mode).
 * - READY otherwise.
 */
export function runPreflightChecks(env: PreflightEnvironment): PreflightReport {
  const checks: PreflightCheck[] = [];
  const t = PREFLIGHT_THRESHOLDS;

  // ---- runtime support ----
  if (!env.runtime.pointer.pointerLockSupported) {
    checks.push(fail("runtime-support", "POINTER_LOCK_UNSUPPORTED", `${env.runtime.browserName} cannot grant Pointer Lock`));
  } else {
    checks.push(pass("runtime-support", `${env.runtime.browserName} supports Pointer Lock`));
  }

  // ---- pointer capture mode ----
  const path = env.runtime.pointer.capturePath;
  if (path === "pointermove-coalesced") {
    checks.push(pass("pointer-capture-mode", "coalesced pointer events available"));
  } else if (path === "pointermove") {
    checks.push(warn("pointer-capture-mode", "NO_COALESCED_EVENTS", "pointer events without getCoalescedEvents(); sampling may be frame-limited"));
  } else {
    checks.push(warn("pointer-capture-mode", "MOUSEMOVE_ONLY_FALLBACK", "only legacy mousemove deltas; frame-coalesced and silent while still"));
  }
  if (!env.runtime.isSupportedChromiumRuntime) {
    checks.push(warn("runtime-support", "UNTESTED_BROWSER_ENGINE", `${env.runtime.browserName} is outside the tested Chromium matrix`));
  }

  // ---- native helper ----
  const helper = env.nativeHelper;
  if (!helper || !helper.present) {
    checks.push(warn("native-helper-presence", "NATIVE_HELPER_ABSENT", "native capture helper not reachable; browser fallback will be used"));
    checks.push({ name: "native-protocol-compatibility", status: "pass", reasonCode: null, detail: "skipped: no helper present" });
  } else {
    checks.push(pass("native-helper-presence", "helper reachable on loopback"));
    if (helper.protocolCompatible === false) {
      checks.push(fail("native-protocol-compatibility", "PROTOCOL_MISMATCH", "helper speaks a different wire protocol than this app build"));
    } else if (helper.helperVersionOk === false) {
      checks.push(fail("native-protocol-compatibility", "HELPER_VERSION_MISMATCH", "helper version does not match the version expected by this build"));
    } else {
      checks.push(pass("native-protocol-compatibility", "protocol and helper version match this build"));
    }
  }

  // ---- active capture tier ----
  const tier = env.activeCaptureTier;
  const nativeValidated =
    tier === 1 &&
    helper !== null &&
    helper.present &&
    env.captureQuality.selfTestVerdict === "pass";
  if (tier === null) {
    checks.push(fail("active-capture-tier", "NO_CAPTURE_SOURCE", "no capture source negotiated"));
  } else if (tier === 1 && !nativeValidated) {
    checks.push(warn("active-capture-tier", "NATIVE_NOT_VALIDATED", "native tier active but no passing self-test on record; treat as unvalidated"));
  } else {
    checks.push(pass("active-capture-tier", TIER_LABELS[tier] ?? `tier ${tier}`));
  }

  // ---- observed input rate ----
  const rate = env.captureQuality.observedRateHz;
  const rateIsNativeRelevant = tier === 1;
  if (rate === null) {
    if (env.captureQuality.selfTestVerdict === null) {
      checks.push(warn("observed-input-rate", "NO_SELF_TEST_RUN", "no capture self-test has been run yet"));
    } else {
      checks.push(warn("observed-input-rate", "RATE_UNKNOWN", "input rate unknown"));
    }
  } else if (rate < t.minObservedInputRateHz) {
    checks.push(
      fail(
        "observed-input-rate",
        "INPUT_RATE_TOO_LOW",
        `observed ${Math.round(rate)} Hz < ${t.minObservedInputRateHz} Hz minimum`,
      ),
    );
  } else {
    checks.push(pass("observed-input-rate", `observed ${Math.round(rate)} Hz`));
  }

  // ---- timestamp monotonicity ----
  const monotonic = env.captureQuality.timestampsMonotonic;
  if (monotonic === false) {
    checks.push(fail("timestamp-monotonicity", "TIMESTAMPS_NON_MONOTONIC", "non-monotonic timestamps observed in capture stream"));
  } else if (monotonic === null) {
    checks.push(warn("timestamp-monotonicity", "MONOTONICITY_UNVERIFIED", "timestamp monotonicity not verified by a completed self-test"));
  } else {
    checks.push(pass("timestamp-monotonicity", "timestamps strictly increasing"));
  }

  // ---- jitter / drops ----
  const dropFraction = env.captureQuality.dropFraction;
  const jitterCv = env.captureQuality.jitterCv;
  let jitterOrDropFailed = false;
  if (dropFraction !== null) {
    if (dropFraction > t.maxDropFraction) {
      checks.push(fail("jitter-and-drop-diagnostics", "EXCESS_DROPPED_SEQUENCES", `drop fraction ${(dropFraction * 100).toFixed(2)}% > ${(t.maxDropFraction * 100).toFixed(2)}%`));
      jitterOrDropFailed = true;
    }
  }
  if (jitterCv !== null && rateIsNativeRelevant && jitterCv > t.maxJitterCv) {
    checks.push(warn("jitter-and-drop-diagnostics", "HIGH_TIMING_JITTER", `interval CV ${jitterCv.toFixed(2)} above native threshold ${t.maxJitterCv}`));
  }
  if (!jitterOrDropFailed && (dropFraction !== null || jitterCv !== null)) {
    checks.push(pass("jitter-and-drop-diagnostics", "within thresholds where measured"));
  }
  if (dropFraction === null && jitterCv === null) {
    checks.push(warn("jitter-and-drop-diagnostics", "JITTER_UNMEASURED", "no jitter/drop diagnostics recorded yet"));
  }

  // ---- DPI ----
  const dpi = env.dpi;
  if (dpi === null || !Number.isFinite(dpi)) {
    checks.push(fail("dpi-configured", "DPI_NOT_CONFIGURED", "mouse DPI is required to compute eDPI"));
  } else if (dpi < t.minPlausibleDpi || dpi > t.maxPlausibleDpi) {
    checks.push(fail("dpi-configured", "DPI_IMPLAUSIBLE", `DPI ${dpi} outside plausible range [${t.minPlausibleDpi}, ${t.maxPlausibleDpi}]`));
  } else {
    checks.push(pass("dpi-configured", `DPI ${dpi}`));
  }

  // ---- X/Y configuration ----
  const sx = env.sensXPercent;
  const sy = env.sensYPercent;
  const inRange = (v: number | null): boolean =>
    v !== null && Number.isFinite(v) && v >= DEFAULT_SAFE_RANGE.minSensX && v <= DEFAULT_SAFE_RANGE.maxSensX;
  if (!inRange(sx) || !inRange(sy)) {
    checks.push(fail("xy-configured", "SENSITIVITY_NOT_CONFIGURED", "baseline Fortnite X/Y sensitivities are missing or outside the safe range"));
  } else {
    checks.push(pass("xy-configured", `X ${sx}% · Y ${sy}% within safe range`));
  }

  // ---- calibration state ----
  const cal = env.calibration;
  if (cal === null || !cal.hasAdequateCalibration) {
    checks.push(warn("calibration-state", "CALIBRATION_MISSING", "no adequate physical calibration; cm/360 outputs unavailable"));
  } else if (cal.stale) {
    checks.push(warn("calibration-state", "CALIBRATION_STALE", "existing calibration is flagged stale (context changed); re-run before trusting physical units"));
  } else {
    checks.push(pass("calibration-state", "adequate and current"));
  }

  // ---- persistent storage ----
  const storageBytes = env.storage.availableBytes;
  if (storageBytes === null) {
    checks.push(fail("persistent-storage", "STORAGE_UNAVAILABLE", "persistent storage quota could not be confirmed"));
  } else if (storageBytes < t.minAvailableStorageBytes) {
    checks.push(fail("persistent-storage", "STORAGE_EXHAUSTED", `only ${(storageBytes / 1024 / 1024).toFixed(1)} MB free; raw trial persistence needs more headroom`));
  } else {
    checks.push(pass("persistent-storage", `${(storageBytes / 1024 / 1024).toFixed(0)}+ MB available`));
  }

  // ---- viewport ----
  const vp = env.viewport;
  if (
    vp === null ||
    vp.widthPx < t.minViewportSidePx ||
    vp.heightPx < t.minViewportSidePx
  ) {
    checks.push(warn("viewport-display", "VIEWPORT_SMALL", vp ? `viewport ${vp.widthPx}x${vp.heightPx} below recommended ${t.minViewportSidePx}px sides` : "viewport size unknown"));
  } else {
    checks.push(pass("viewport-display", `${vp.widthPx}x${vp.heightPx}`));
  }

  // ---- unfinished checkpoints ----
  const openCheckpoints = env.unfinishedCheckpoints;
  if (openCheckpoints.length > 0) {
    const staleCount = openCheckpoints.filter((c) => c.ageMs > t.staleCheckpointAgeMs).length;
    checks.push(
      staleCount > 0
        ? warn("unfinished-checkpoints", "STALE_CHECKPOINTS_PRESENT", `${openCheckpoints.length} unfinished session(s), ${staleCount} older than 7 days — resume or discard from Setup`)
        : warn("unfinished-checkpoints", "CHECKPOINTS_PRESENT", `${openCheckpoints.length} unfinished session(s) can be resumed from Setup`),
    );
  } else {
    checks.push(pass("unfinished-checkpoints", "none"));
  }

  // ---- version compatibility ----
  const incompatible = env.storedArtifactEngineVersions
    .map((v) => ({ v, ...checkEngineCompatibility(v) }))
    .filter((r) => !r.compatible);
  if (incompatible.length > 0) {
    checks.push(
      fail(
        "version-compatibility",
        "STORED_ARTIFACT_VERSION_MISMATCH",
        `${incompatible.length} stored artifact(s) produced by ${incompatible[0]!.v} cannot be read by ${fullReleaseMetadata().engineVersion}`,
      ),
    );
  } else {
    checks.push(pass("version-compatibility", "all stored artifacts compatible with this build"));
  }

  // ---- aggregate ----
  const blockingCodes = new Set([
    "POINTER_LOCK_UNSUPPORTED",
    "STORAGE_UNAVAILABLE",
    "STORAGE_EXHAUSTED",
    "PROTOCOL_MISMATCH",
    "HELPER_VERSION_MISMATCH",
    "STORED_ARTIFACT_VERSION_MISMATCH",
    "NO_CAPTURE_SOURCE",
  ]);
  const qualityCodes = new Set([
    "INPUT_RATE_TOO_LOW",
    "TIMESTAMPS_NON_MONOTONIC",
    "EXCESS_DROPPED_SEQUENCES",
    "DPI_NOT_CONFIGURED",
    "DPI_IMPLAUSIBLE",
    "SENSITIVITY_NOT_CONFIGURED",
  ]);

  let overall: PreflightVerdict;
  const fails = checks.filter((c) => c.status === "fail");
  if (fails.some((c) => blockingCodes.has(c.reasonCode ?? ""))) {
    overall = "BLOCKED";
  } else if (fails.some((c) => qualityCodes.has(c.reasonCode ?? ""))) {
    overall = "NOT_READY_FOR_HIGH_CONFIDENCE";
  } else if (checks.some((c) => c.status === "warn")) {
    overall = "READY_WITH_WARNINGS";
  } else {
    overall = "READY";
  }
  void fails;

  const reasonCodes = checks
    .filter((c) => c.reasonCode !== null)
    .map((c) => c.reasonCode as string);

  return {
    overall,
    checks,
    reasonCodes,
    generatedAtIso: env.nowIso ?? new Date().toISOString(),
    release: fullReleaseMetadata(),
    summaryLines: summarize(checks),
  };
}

function summarize(checks: readonly PreflightCheck[]): string[] {
  return checks
    .filter((c) => c.status !== "pass")
    .map((c) => `${c.name}: ${c.reasonCode} — ${c.detail}`);
}
