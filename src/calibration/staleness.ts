import type { CalibrationMeasurement } from "./core.ts";

/**
 * Calibration staleness detection (Pass 4, requirement N).
 *
 * A stored calibration becomes STALE (must not silently be used as current)
 * when the measurement context changed materially:
 *   - DPI changed,
 *   - the mouse/device identity changed,
 *   - the capture source class changed materially
 *     (native high-rate vs browser coalesced count differently),
 *   - the user explicitly changed a calibration-relevant setting.
 *
 * Old records are never deleted; they are flagged so the UI can show history.
 */

export interface CalibrationContextFingerprint {
  dpi: number;
  /** Stable device identifier from capture metadata, when available. */
  deviceId: string | null;
  /** Capture source kind used during measurement ("native", "browser-pointer-lock", ...). */
  captureSourceKind: string | null;
  /** Hash of user settings relevant to calibration counts. */
  relevantSettingsHash: string | null;
}

export type CalibrationStalenessCode =
  | "DPI_CHANGED"
  | "DEVICE_CHANGED"
  | "CAPTURE_SOURCE_CHANGED"
  | "SETTINGS_CHANGED";

export interface CalibrationStalenessResult {
  stale: boolean;
  reasons: CalibrationStalenessCode[];
  detailLines: string[];
}

export function checkCalibrationStaleness(
  recorded: CalibrationContextFingerprint | null | undefined,
  current: CalibrationContextFingerprint,
): CalibrationStalenessResult {
  const reasons: CalibrationStalenessCode[] = [];
  const lines: string[] = [];
  if (!recorded) {
    return {
      stale: false,
      reasons: [],
      detailLines: ["no context fingerprint recorded with this calibration"],
    };
  }
  if (recorded.dpi !== current.dpi) {
    reasons.push("DPI_CHANGED");
    lines.push(`calibrated at ${recorded.dpi} DPI; current DPI is ${current.dpi}`);
  }
  if (
    recorded.deviceId !== null &&
    current.deviceId !== null &&
    recorded.deviceId !== current.deviceId
  ) {
    reasons.push("DEVICE_CHANGED");
    lines.push(`device changed from ${recorded.deviceId} to ${current.deviceId}`);
  }
  if (
    recorded.captureSourceKind !== null &&
    current.captureSourceKind !== null &&
    isMaterialSourceChange(recorded.captureSourceKind, current.captureSourceKind)
  ) {
    reasons.push("CAPTURE_SOURCE_CHANGED");
    lines.push(
      `capture source changed from ${recorded.captureSourceKind} to ${current.captureSourceKind}`,
    );
  }
  if (
    recorded.relevantSettingsHash !== null &&
    current.relevantSettingsHash !== null &&
    recorded.relevantSettingsHash !== current.relevantSettingsHash
  ) {
    reasons.push("SETTINGS_CHANGED");
    lines.push("calibration-relevant settings were changed by the user");
  }
  return { stale: reasons.length > 0, reasons, detailLines: lines };
}

/** Native vs browser counting differs materially; browser variants do not. */
function isMaterialSourceChange(a: string, b: string): boolean {
  const native = (s: string): boolean => s.startsWith("native");
  return native(a) !== native(b);
}

/**
 * Consistency data contract for the visualization layer: per-rep values plus
 * robust center/spread so a UI can draw rep dots around a median band without
 * recomputing statistics.
 */
export interface CalibrationConsistencyView {
  perRepDegPerCount: { repIndex: number; value: number; rejected: boolean }[];
  medianDegPerCount: number;
  madDegPerCount: number;
  robustCvFraction: number;
  spreadBand: { low: number; high: number };
}

export function buildConsistencyView(
  measurements: readonly Pick<CalibrationMeasurement, "repIndex" | "rejected">[],
  degPerCountValues: readonly number[],
): CalibrationConsistencyView {
  const retained = degPerCountValues.filter((v) => Number.isFinite(v));
  const sorted = [...retained].sort((a, b) => a - b);
  const med =
    sorted.length > 0
      ? sorted[Math.floor((sorted.length - 1) / 2)]!
      : Number.NaN;
  const devs = retained.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const mad =
    devs.length > 0 ? devs[Math.floor((devs.length - 1) / 2)]! : Number.NaN;
  const robustCv = med !== 0 && Number.isFinite(mad) ? (mad * 1.4826) / med : Number.NaN;
  const bandHalfWidth = Number.isFinite(mad) ? mad * 2.5 : Number.NaN;
  return {
    perRepDegPerCount: measurements.map((m, i) => ({
      repIndex: m.repIndex,
      value: degPerCountValues[i] ?? Number.NaN,
      rejected: m.rejected,
    })),
    medianDegPerCount: med,
    madDegPerCount: mad,
    robustCvFraction: robustCv,
    spreadBand: {
      low: med - bandHalfWidth,
      high: med + bandHalfWidth,
    },
  };
}
