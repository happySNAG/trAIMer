import { describe, expect, it } from "vitest";
import {
  DEFAULT_CALIBRATION_OPTIONS,
  deriveCalibration,
  degreesPerCountForRep,
  type CalibrationMeasurement,
} from "../src/calibration/core.ts";
import {
  buildConsistencyView,
  checkCalibrationStaleness,
} from "../src/calibration/staleness.ts";

type RawMeasurement = Omit<CalibrationMeasurement, "rejected" | "rejectReason">;

function measurement(
  repIndex: number,
  countsX: number,
  overrides: Partial<RawMeasurement> = {},
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
    ...overrides,
  };
}

describe("calibration hardening", () => {
  it("multi-turn measurements divide total rotation correctly", () => {
    // One 360° turn ≈ 6428 counts ⇒ 5 turns should be ≈ 5×6428 for the same
    // deg/count; using the turns field keeps endpoint error down.
    const single = measurement(0, 6428);
    const multi = measurement(1, 6428 * 3, { turns: 3 });
    expect(degreesPerCountForRep(single)).toBeCloseTo(
      degreesPerCountForRep(multi),
      9,
    );
  });

  it("median/MAD estimator resists a bad endpoint better than a mean", () => {
    const reps = [6450, 6460, 6440, 6470, 6465, 9000];
    const record = deriveCalibration("x", "full-rotation", reps.map((c, i) => measurement(i, c)));
    expect(record.estimator ?? DEFAULT_CALIBRATION_OPTIONS.estimator).toBe("median-mad");
    expect(record.adequate).toBe(true);
    // The outlier was rejected and flagged, never deleted.
    const rejected = record.measurements.filter((m) => m.rejected);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.countsX).toBe(9000);
    // Robust estimate sits at the median of retained values.
    expect(record.degreesPerCountAt100!).toBeCloseTo(360 / (6460 * 0.07), 6);
    expect(record.consistency!.madDegPerCount).toBeGreaterThanOrEqual(0);
    expect(record.qualityScore!).toBeGreaterThan(0.8);
  });

  it("quality score degrades with inconsistency and poor retention", () => {
    const consistent = deriveCalibration(
      "x",
      "full-rotation",
      [6450, 6460, 6440, 6470].map((c, i) => measurement(i, c)),
    );
    const sloppy = deriveCalibration(
      "x",
      "full-rotation",
      [6000, 6600, 6300, 6700, 6400].map((c, i) => measurement(i, c)),
      { ...DEFAULT_CALIBRATION_OPTIONS },
    );
    expect(sloppy.qualityScore!).toBeLessThan(consistent.qualityScore!);
  });

  it("CI is reported around the robust estimate", () => {
    const record = deriveCalibration(
      "x",
      "full-rotation",
      [6400, 6500, 6450, 6480, 6470].map((c, i) => measurement(i, c)),
    );
    const v = record.degreesPerCountAt100!;
    expect(record.ci95DegreesPerCountAt100!.min).toBeLessThan(v);
    expect(record.ci95DegreesPerCountAt100!.max).toBeGreaterThan(v);
    expect(record.standardErrorDegreesPerCountAt100!).toBeGreaterThan(0);
  });

  it("staleness: DPI change flags stale", () => {
    const r = checkCalibrationStaleness(
      { dpi: 800, deviceId: null, captureSourceKind: null, relevantSettingsHash: null },
      { dpi: 1600, deviceId: null, captureSourceKind: null, relevantSettingsHash: null },
    );
    expect(r.stale).toBe(true);
    expect(r.reasons).toEqual(["DPI_CHANGED"]);
  });

  it("staleness: device identity change flags stale", () => {
    const r = checkCalibrationStaleness(
      { dpi: 800, deviceId: "mouse-aaaa", captureSourceKind: null, relevantSettingsHash: null },
      { dpi: 800, deviceId: "mouse-bbbb", captureSourceKind: null, relevantSettingsHash: null },
    );
    expect(r.reasons).toContain("DEVICE_CHANGED");
  });

  it("staleness: native↔browser source switch is material; browser variant tweaks are not", () => {
    const material = checkCalibrationStaleness(
      { dpi: 800, deviceId: null, captureSourceKind: "native", relevantSettingsHash: null },
      { dpi: 800, deviceId: null, captureSourceKind: "browser-pointer-lock", relevantSettingsHash: null },
    );
    expect(material.reasons).toContain("CAPTURE_SOURCE_CHANGED");

    const benign = checkCalibrationStaleness(
      { dpi: 800, deviceId: null, captureSourceKind: "browser-pointer-lock", relevantSettingsHash: null },
      { dpi: 800, deviceId: null, captureSourceKind: "browser-pointer-lock", relevantSettingsHash: null },
    );
    expect(benign.stale).toBe(false);
  });

  it("staleness: user setting changes flag stale; missing fingerprints stay quiet", () => {
    const settingsChanged = checkCalibrationStaleness(
      { dpi: 800, deviceId: null, captureSourceKind: null, relevantSettingsHash: "abc" },
      { dpi: 800, deviceId: null, captureSourceKind: null, relevantSettingsHash: "zzz" },
    );
    expect(settingsChanged.reasons).toContain("SETTINGS_CHANGED");

    const noFingerprint = checkCalibrationStaleness(null, {
      dpi: 9999,
      deviceId: null,
      captureSourceKind: null,
      relevantSettingsHash: null,
    });
    expect(noFingerprint.stale).toBe(false);
  });

  it("consistency view provides per-rep dots plus a robust spread band", () => {
    const record = deriveCalibration(
      "x",
      "full-rotation",
      [6450, 6460, 6440, 6470, 9000].map((c, i) => measurement(i, c)),
    );
    const view = buildConsistencyView(record.measurements, record.measurements.map((m) => {
      const counts = m.countsX;
      return m.thetaDeg / (counts * (m.sensPercent / 100));
    }));
    expect(view.perRepDegPerCount).toHaveLength(5);
    expect(view.perRepDegPerCount.filter((r) => r.rejected)).toHaveLength(1);
    expect(view.spreadBand.low).toBeLessThan(view.medianDegPerCount);
    expect(view.spreadBand.high).toBeGreaterThan(view.medianDegPerCount);
    expect(view.robustCvFraction).toBeGreaterThan(0);
  });
});
