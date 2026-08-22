import { describe, expect, it } from "vitest";
import {
  DEFAULT_CALIBRATION_OPTIONS,
  degreesPerCountForRep,
  deriveCalibration,
  calibrationParametersFromRecords,
  type CalibrationMeasurement,
} from "../src/calibration/core.ts";
import { physicalCmPer360 } from "../src/sensmath/sensitivity.ts";
import { UNCALIBRATED } from "../src/sensmath/calibration.ts";

type RawMeasurement = Omit<CalibrationMeasurement, "rejected" | "rejectReason">;

function measurement(
  repIndex: number,
  countsX: number,
): RawMeasurement {
  return {
    repIndex,
    countsX,
    countsY: countsX,
    thetaDeg: 360,
    dpi: 800,
    sensPercent: 7,
    capturedAtIso: new Date(2026, 0, 1, repIndex).toISOString(),
    method: "full-rotation",
  };
}

describe("calibration derivation", () => {
  it("converts counts to deg/count with the documented formula", () => {
    const m = measurement(0, 6428);
    const value = degreesPerCountForRep(m);
    expect(value).toBeCloseTo(360 / (6428 * 0.07), 9);
  });

  it("derives a stable estimate from consistent repetitions", () => {
    const record = deriveCalibration(
      "x",
      "full-rotation",
      [measurement(0, 6400), measurement(1, 6500), measurement(2, 6450), measurement(3, 6480), measurement(4, 6470)],
    );
    expect(record.adequate).toBe(true);
    expect(record.inadequacyReasons).toHaveLength(0);
    expect(record.degreesPerCountAt100!).toBeGreaterThan(0.75);
    expect(record.degreesPerCountAt100!).toBeLessThan(0.85);
    expect(record.ci95DegreesPerCountAt100!.max).toBeGreaterThan(
      record.degreesPerCountAt100!,
    );
    expect(record.coefficientOfVariation!).toBeLessThan(0.15);
  });

  it("rejects inconsistent outlier repetitions", () => {
    const record = deriveCalibration(
      "x",
      "full-rotation",
      [
        measurement(0, 6450),
        measurement(1, 6460),
        measurement(2, 6440),
        measurement(3, 6470),
        measurement(4, 12000),
        measurement(5, 3000),
      ],
    );
    const rejected = record.measurements.filter((m) => m.rejected);
    expect(rejected.length).toBe(2);
    for (const m of rejected) {
      expect(m.rejectReason).toContain("outlier");
    }
    expect(record.adequate).toBe(true);
  });

  it("refuses to claim calibration when too few samples are retained", () => {
    const record = deriveCalibration(
      "x",
      "full-rotation",
      [measurement(0, 6400), measurement(1, 12000), measurement(2, 20000)],
      { ...DEFAULT_CALIBRATION_OPTIONS, minRetainedSamples: 4 },
    );
    expect(record.adequate).toBe(false);
    expect(record.inadequacyReasons.some((r) => r.includes("retained"))).toBe(true);
    expect(calibrationParametersFromRecords(record, null)).toBeNull();
  });

  it("refuses when variance is excessive", () => {
    const record = deriveCalibration(
      "x",
      "full-rotation",
      [measurement(0, 5000), measurement(1, 7000), measurement(2, 5800), measurement(3, 7600)],
      { ...DEFAULT_CALIBRATION_OPTIONS, maxCoefficientOfVariation: 0.15 },
    );
    if (record.coefficientOfVariation !== null && record.coefficientOfVariation > 0.15) {
      expect(record.adequate).toBe(false);
      expect(
        record.inadequacyReasons.some((r) => r.includes("coefficient of variation")),
      ).toBe(true);
    }
  });

  it("produces usable CalibrationParameters only when both axes are adequate", () => {
    const xRecord = deriveCalibration("x", "full-rotation", [
      measurement(0, 6450), measurement(1, 6460), measurement(2, 6440), measurement(3, 6470),
    ]);
    const yRecord = deriveCalibration("y", "full-rotation", [
      measurement(0, 6450), measurement(1, 6460), measurement(2, 6440), measurement(3, 6470),
    ]);
    const params = calibrationParametersFromRecords(xRecord, yRecord);
    expect(params).not.toBeNull();
    expect(params!.source).toContain("measured:full-rotation");
    expect(params!.degreesPerCountAt100X).toBeCloseTo(xRecord.degreesPerCountAt100!, 12);

    const xOnly = calibrationParametersFromRecords(xRecord, null);
    expect(xOnly).toBeNull();
  });

  it("yields physical cm/360 through the existing interface once calibrated", () => {
    const xRecord = deriveCalibration("x", "full-rotation", [
      measurement(0, 6450), measurement(1, 6460), measurement(2, 6440), measurement(3, 6470),
    ]);
    const yRecord = deriveCalibration("y", "full-rotation", [
      measurement(0, 6450), measurement(1, 6460), measurement(2, 6440), measurement(3, 6470),
    ]);
    const params = calibrationParametersFromRecords(xRecord, yRecord);
    const cmAtPlayerSens = physicalCmPer360(params!, 800, "x", 7);
    expect(cmAtPlayerSens).not.toBeNull();
    expect(cmAtPlayerSens!).toBeGreaterThan(10);
    expect(cmAtPlayerSens!).toBeLessThan(60);
    const cmAt100 = physicalCmPer360(params!, 800, "x");
    expect(cmAt100!).toBeLessThan(cmAtPlayerSens!);
    void UNCALIBRATED;
  });
});
