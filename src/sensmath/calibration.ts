export interface CalibrationParameters {
  readonly degreesPerCountAt100X: number | null;
  readonly degreesPerCountAt100Y: number | null;
  readonly source: string;
}

export const UNCALIBRATED: CalibrationParameters = {
  degreesPerCountAt100X: null,
  degreesPerCountAt100Y: null,
  source: "uncalibrated",
};

export function calibrationFromEmpiricalMeasurement(input: {
  degreesPerCountAt100X: number;
  degreesPerCountAt100Y: number;
  source: string;
}): CalibrationParameters {
  if (
    !Number.isFinite(input.degreesPerCountAt100X) ||
    !Number.isFinite(input.degreesPerCountAt100Y) ||
    input.degreesPerCountAt100X <= 0 ||
    input.degreesPerCountAt100Y <= 0
  ) {
    throw new Error("Calibration constants must be positive finite numbers");
  }
  return { ...input };
}
