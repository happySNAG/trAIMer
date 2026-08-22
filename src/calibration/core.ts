import {
  calibrationFromEmpiricalMeasurement,
  type CalibrationParameters,
} from "../sensmath/calibration.ts";
import { meanAndStandardError, median } from "../metrics/stats.ts";

export const CALIBRATION_RECORD_VERSION = 1;

export interface CalibrationMeasurement {
  repIndex: number;
  countsX: number;
  countsY: number;
  thetaDeg: number;
  dpi: number;
  sensPercent: number;
  capturedAtIso: string;
  method: "full-rotation" | "landmark-angle";
  rejected: boolean;
  rejectReason?: string | undefined;
}

export interface CalibrationRecord {
  version: number;
  createdAtIso: string;
  axis: "x" | "y";
  method: CalibrationMeasurement["method"];
  measurements: CalibrationMeasurement[];
  adequate: boolean;
  inadequacyReasons: string[];
  degreesPerCountAt100: number | null;
  standardErrorDegreesPerCountAt100: number | null;
  ci95DegreesPerCountAt100: { min: number; max: number } | null;
  coefficientOfVariation: number | null;
}

export interface CalibrationDerivationOptions {
  minRetainedSamples: number;
  maxCoefficientOfVariation: number;
  outlierMadMultiple: number;
}

export const DEFAULT_CALIBRATION_OPTIONS: CalibrationDerivationOptions = {
  minRetainedSamples: 4,
  maxCoefficientOfVariation: 0.15,
  outlierMadMultiple: 2.5,
};

export function degreesPerCountForRep(
  measurement: Omit<CalibrationMeasurement, "rejected" | "rejectReason">,
): number {
  if (measurement.countsX <= 0 || measurement.thetaDeg <= 0) return Number.NaN;
  const sensFraction = measurement.sensPercent / 100;
  return measurement.thetaDeg / (measurement.countsX * sensFraction);
}

export function rejectOutliers(
  values: readonly number[],
  madMultiple: number,
): boolean[] {
  const finite = values.map((v) => (Number.isFinite(v) ? v : Number.NaN));
  const valid = finite.filter((v) => Number.isFinite(v));
  if (valid.length === 0) return finite.map(() => true);
  const med = median(valid);
  const deviations = valid.map((v) => Math.abs(v - med));
  const mad = median(deviations);
  return finite.map(
    (v) =>
      !Number.isFinite(v) ||
      Math.abs(v - med) > madMultiple * (mad > 0 ? mad : Math.abs(med) * 1e-9 + 1e-12),
  );
}

export function deriveCalibration(
  axis: "x" | "y",
  method: CalibrationMeasurement["method"],
  rawMeasurements: readonly Omit<CalibrationMeasurement, "rejected" | "rejectReason">[],
  options: CalibrationDerivationOptions = DEFAULT_CALIBRATION_OPTIONS,
): CalibrationRecord {
  const perRep = rawMeasurements.map((m) => ({
    measurement: m,
    value:
      axis === "x"
        ? m.countsX
        : m.countsY,
    degPerCount: (() => {
      const counts = axis === "x" ? m.countsX : m.countsY;
      if (counts <= 0 || m.thetaDeg <= 0) return Number.NaN;
      return m.thetaDeg / (counts * (m.sensPercent / 100));
    })(),
  }));

  const outlierFlags = rejectOutliers(
    perRep.map((r) => r.degPerCount),
    options.outlierMadMultiple,
  );

  const measurements: CalibrationMeasurement[] = perRep.map((r, i) => ({
    ...r.measurement,
    rejected: outlierFlags[i]!,
    rejectReason: outlierFlags[i]
      ? `deg/count ${Number.isFinite(r.degPerCount) ? r.degPerCount.toFixed(6) : "NaN"} is an outlier (> ${options.outlierMadMultiple} MAD)`
      : undefined,
  }));

  const retained = perRep.filter(
    (_, i) => !outlierFlags[i],
  );
  const inadequacyReasons: string[] = [];
  if (retained.length < options.minRetainedSamples) {
    inadequacyReasons.push(
      `only ${retained.length} retained samples; need at least ${options.minRetainedSamples}`,
    );
  }
  for (const r of retained) {
    if (!(r.degPerCount > 0)) {
      inadequacyReasons.push("retained sample has non-positive counts or angle");
      break;
    }
  }

  const stats = meanAndStandardError(retained.map((r) => r.degPerCount));
  let cv: number | null = null;
  if (stats && stats.mean > 0) {
    const sd = stats.standardError * Math.sqrt(stats.sampleCount);
    cv = sd / stats.mean;
    if (cv > options.maxCoefficientOfVariation) {
      inadequacyReasons.push(
        `coefficient of variation ${(cv * 100).toFixed(1)}% exceeds limit ${(options.maxCoefficientOfVariation * 100).toFixed(1)}%`,
      );
    }
  } else if (retained.length > 0) {
    inadequacyReasons.push("could not compute statistics over retained samples");
  }

  const adequate =
    inadequacyReasons.length === 0 &&
    stats !== null &&
    stats.sampleCount >= options.minRetainedSamples;

  const value = stats?.mean ?? null;
  const se = stats?.standardError ?? null;
  const ci95 =
    value !== null && se !== null
      ? { min: value - 1.96 * se, max: value + 1.96 * se }
      : null;

  return {
    version: CALIBRATION_RECORD_VERSION,
    createdAtIso: new Date().toISOString(),
    axis,
    method,
    measurements,
    adequate,
    inadequacyReasons,
    degreesPerCountAt100: value,
    standardErrorDegreesPerCountAt100: se,
    ci95DegreesPerCountAt100: ci95,
    coefficientOfVariation: cv,
  };
}

export function calibrationParametersFromRecords(
  xRecord: CalibrationRecord | null,
  yRecord: CalibrationRecord | null,
): CalibrationParameters | null {
  const pick = (
    record: CalibrationRecord | null,
    axis: "x" | "y",
  ): number | null =>
    record && record.axis === axis && record.adequate
      ? record.degreesPerCountAt100
      : null;
  const xValue = pick(xRecord, "x");
  const yValue = pick(yRecord, "y");
  if (xValue === null || yValue === null) return null;
  return calibrationFromEmpiricalMeasurement({
    degreesPerCountAt100X: xValue,
    degreesPerCountAt100Y: yValue,
    source: `measured:${xRecord!.method}:${xRecord!.createdAtIso}`,
  });
}
