import type { SensitivityConfiguration } from "../domain/settings.ts";
import type { CalibrationParameters } from "./calibration.ts";

export function edpi(dpi: number, sensValue: number): number {
  return dpi * sensValue;
}

export function edpiOf(
  config: SensitivityConfiguration,
  dpi: number,
): number {
  return edpi(dpi, config.sensX);
}

export interface NormalizedComparison {
  linearRatio: number;
  log2Ratio: number;
  percentDifferenceVsReference: number;
}

export function compareSensitivity(
  candidate: number,
  reference: number,
): NormalizedComparison {
  return {
    linearRatio: candidate / reference,
    log2Ratio: Math.log2(candidate / reference),
    percentDifferenceVsReference: ((candidate - reference) / reference) * 100,
  };
}

export function multiplicativeChange(
  base: SensitivityConfiguration,
  factor: number,
): SensitivityConfiguration {
  return { sensX: base.sensX * factor, sensY: base.sensY * factor };
}

export function percentageChange(
  base: SensitivityConfiguration,
  percent: number,
): SensitivityConfiguration {
  return multiplicativeChange(base, 1 + percent / 100);
}

export function rotationDegreesForCounts(
  calibration: CalibrationParameters,
  axis: "x" | "y",
  counts: number,
): number | null {
  const constant =
    axis === "x"
      ? calibration.degreesPerCountAt100X
      : calibration.degreesPerCountAt100Y;
  if (constant === null) return null;
  return counts * constant;
}

export function countsForRotationDegrees(
  calibration: CalibrationParameters,
  axis: "x" | "y",
  degrees: number,
): number | null {
  const rotation = rotationDegreesForCounts(calibration, axis, 1);
  if (rotation === null) return null;
  return degrees / rotation;
}

export function physicalCmPer360(
  calibration: CalibrationParameters,
  dpi: number,
  axis: "x" | "y",
  sensPercent?: number,
): number | null {
  const counts = countsForRotationDegrees(calibration, axis, 360);
  if (counts === null || dpi <= 0) return null;
  const effectiveCounts =
    sensPercent !== undefined && sensPercent > 0
      ? counts * (100 / sensPercent)
      : counts;
  return (effectiveCounts / dpi) * 2.54;
}
