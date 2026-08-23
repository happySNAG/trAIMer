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
  /** Number of full rotations performed in this rep (Pass 4, default 1). */
  turns?: number | undefined;
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
  /** Pass 4 additions (additive, optional for old persisted records). */
  estimator?: "median-mad" | "mean";
  qualityScore?: number | null;
  consistency?: {
    medianDegPerCount: number;
    madDegPerCount: number;
    robustCvFraction: number;
    spreadBand: { low: number; high: number };
  } | null;
  contextFingerprint?: {
    dpi: number | null;
    deviceId: string | null;
    captureSourceKind: string | null;
    relevantSettingsHash: string | null;
  } | null;
}

export interface CalibrationDerivationOptions {
  minRetainedSamples: number;
  maxCoefficientOfVariation: number;
  outlierMadMultiple: number;
  /**
   * Robust center: median/MAD (default) resists endpoint error far better
   * than a mean on small samples of human rotations.
   */
  estimator?: "median-mad" | "mean";
}

export const DEFAULT_CALIBRATION_OPTIONS: CalibrationDerivationOptions = {
  minRetainedSamples: 4,
  maxCoefficientOfVariation: 0.15,
  outlierMadMultiple: 2.5,
  estimator: "median-mad",
};

export function degreesPerCountForRep(
  measurement: Omit<CalibrationMeasurement, "rejected" | "rejectReason">,
): number {
  if (measurement.countsX <= 0 || measurement.thetaDeg <= 0) return Number.NaN;
  const sensFraction = measurement.sensPercent / 100;
  const turns = measurement.turns && measurement.turns > 0 ? measurement.turns : 1;
  return (measurement.thetaDeg * turns) / (measurement.countsX * sensFraction);
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
  const estimator = options.estimator ?? "median-mad";
  const perRep = rawMeasurements.map((m) => {
    const counts = axis === "x" ? m.countsX : m.countsY;
    const turns = m.turns && m.turns > 0 ? m.turns : 1;
    return {
      measurement: m,
      value: axis === "x" ? m.countsX : m.countsY,
      degPerCount:
        counts > 0 && m.thetaDeg > 0
          ? (m.thetaDeg * turns) / (counts * (m.sensPercent / 100))
          : Number.NaN,
    };
  });

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

  // Robust center + spread over retained reps.
  const retainedValues = retained.map((r) => r.degPerCount).filter((v) => Number.isFinite(v));
  const sorted = [...retainedValues].sort((a, b) => a - b);
  const med =
    sorted.length > 0
      ? sorted[Math.floor((sorted.length - 1) / 2)]!
      : Number.NaN;
  const devs = retainedValues.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const mad =
    devs.length > 0 ? devs[Math.floor((devs.length - 1) / 2)]! : Number.NaN;
  const robustSigma = mad * 1.4826;

  let value: number | null = null;
  let se: number | null = null;
  if (estimator === "median-mad") {
    if (Number.isFinite(med) && med > 0 && retainedValues.length > 0) {
      value = med;
      // SE of a median ≈ 1.2533 σ/√n (asymptotic normal-efficiency factor).
      se = (1.2533 * robustSigma) / Math.sqrt(retainedValues.length);
    }
  } else {
    const stats = meanAndStandardError(retained.map((r) => r.degPerCount));
    if (stats) {
      value = stats.mean;
      se = stats.standardError;
    }
  }

  let cv: number | null = null;
  if (
    Number.isFinite(med) &&
    med !== 0 &&
    Number.isFinite(mad) &&
    retainedValues.length > 0
  ) {
    cv = robustSigma / Math.abs(med);
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
    value !== null &&
    se !== null &&
    retainedValues.length >= options.minRetainedSamples;

  const ci95 =
    value !== null && se !== null
      ? { min: value - 1.96 * se, max: value + 1.96 * se }
      : null;

  // Measurement quality score: consistency-dominated [0,1].
  let qualityScore: number | null = null;
  if (cv !== null && Number.isFinite(cv)) {
    qualityScore = Math.max(0, Math.min(1, 1 - cv / options.maxCoefficientOfVariation));
    const retentionFraction =
      rawMeasurements.length > 0
        ? retained.length / rawMeasurements.length
        : 1;
    qualityScore *= 0.7 + 0.3 * retentionFraction;
    if (!adequate) qualityScore = Math.min(qualityScore ?? 0, 0.35);
  }

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
    estimator,
    qualityScore,
    consistency: {
      medianDegPerCount: Number.isFinite(med) ? med : 0,
      madDegPerCount: Number.isFinite(mad) ? mad : 0,
      robustCvFraction: cv ?? Number.NaN,
      spreadBand: {
        low: Number.isFinite(med) && Number.isFinite(mad) ? med - 2.5 * mad : Number.NaN,
        high: Number.isFinite(med) && Number.isFinite(mad) ? med + 2.5 * mad : Number.NaN,
      },
    },
    contextFingerprint: null,
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
