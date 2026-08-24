import { describe, expect, it } from "vitest";
import { InMemoryBackend } from "../src/persistence/backends.ts";
import { LocalJsonStore } from "../src/persistence/store.ts";
import {
  buildHardwareValidationBundle,
  type RuntimeFacts,
} from "../src/diagnostics/hardwareValidation.ts";
import { APP_VERSION } from "../src/version.ts";

/**
 * Hardware-validation bundle (Pass 7, requirement V): assembles compact,
 * inspectable evidence from persisted local records for Aldo's PC smoke.
 */

const RUNTIME: RuntimeFacts = {
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0",
  platform: "Win32",
  screenPx: { width: 2560, height: 1440 },
  devicePixelRatio: 1.25,
  hardwareConcurrency: 16,
  estimatedRefreshHz: 200,
};

async function seedStore(withSelfTest: boolean, withSessions = true) {
  const store = new LocalJsonStore(new InMemoryBackend());
  if (withSelfTest) {
    await store.saveRaw("capture-self-test", "self-tests/st-1.json", {
      kind: "capture-self-test",
      schemaVersion: 1,
      startedAtIso: "2026-08-24T10:00:00.000Z",
      endedAtIso: "2026-08-24T10:00:05.000Z",
      durationMs: 5000,
      sourceKind: "native-loopback",
      deviceId: "dev-123",
      deviceDescription: "Logitech G Pro X Superlight",
      nominalRateHz: 1000,
      observedRateHz: 986.4,
      verdict: "pass",
      checks: [
        { id: "rate", pass: true },
        { id: "jitter", pass: true },
        { id: "drops", pass: false },
      ],
      transportCounters: {
        framesReceived: 4930,
        duplicateSequences: 0,
        missingSequences: 2,
        nonMonotonicTimestamps: 0,
        reconnects: 0,
      },
    });
  }
  if (withSessions) {
    await store.saveRaw("human-session", "human-sessions/s1.json", {
      sessionId: "s1",
      startedAtIso: "2026-08-24T11:00:00.000Z",
      status: "complete",
      optimizerVersion: "optimizer-v3",
    });
    await store.saveRaw("human-session", "human-sessions/s2.json", {
      sessionId: "s2",
      startedAtIso: "2026-08-24T12:00:00.000Z",
      status: "aborted",
      optimizerVersion: "optimizer-v3",
    });
  }
  await store.saveRaw("session-checkpoint", "sessions/checkpoints/c1.json", {
    status: "running",
    updatedAtIso: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
  });
  await store.saveRaw("calibration-record", "calibrations/x-1.json", {
    axis: "x",
    adequate: true,
    createdAtIso: "2026-08-23T09:00:00.000Z",
  });
  await store.saveRaw("calibration-record", "calibrations/y-1.json", {
    axis: "y",
    adequate: false,
    createdAtIso: "2026-08-23T09:30:00.000Z",
  });
  return store;
}

function makeStore() {
  return new LocalJsonStore(new InMemoryBackend());
}

describe("hardware validation bundle", () => {
  it("assembles versions, capture diagnostics, session/resume/calibration status", async () => {
    const store = await seedStore(true);
    const bundle = await buildHardwareValidationBundle(store, { runtime: RUNTIME });

    expect(bundle.kind).toBe("aldo-hardware-validation-bundle");
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.release.appVersion).toBe(APP_VERSION);
    expect(bundle.release.engineVersion).toBe("engine-v4");
    expect(bundle.release.expectedHelperVersion).toBe("helper-1.0.0");
    expect(bundle.runtime.devicePixelRatio).toBe(1.25);
    expect(bundle.runtime.estimatedRefreshHz).toBe(200);

    expect(bundle.capture.latestSelfTest).toMatchObject({
      sourceKind: "native-loopback",
      nominalRateHz: 1000,
      observedRateHz: 986.4,
      verdict: "pass",
      checksFailed: ["drops"],
    });
    expect(bundle.capture.latestSelfTest?.transportCounters?.missingSequences).toBe(2);

    expect(bundle.sessions.total).toBe(2);
    expect(bundle.sessions.completed).toBe(1);
    expect(bundle.sessions.aborted).toBe(1);
    expect(bundle.sessions.lastSessionAtIso).toBe("2026-08-24T12:00:00.000Z");

    expect(bundle.resume.unfinishedCheckpoints).toBe(1);
    expect(bundle.resume.staleCheckpoints).toBe(1);

    expect(bundle.calibration.hasRecord).toBe(true);
    expect(bundle.calibration.adequateX).toBe(true);
    expect(bundle.calibration.adequateY).toBe(false);
    expect(bundle.warnings.some((w) => w.includes("inadequate"))).toBe(true);

    // Compact and privacy-safe: no raw input samples anywhere.
    const serialized = JSON.stringify(bundle);
    expect(serialized.length).toBeLessThan(20_000);
    expect(serialized).not.toContain('"samples"');
    expect(serialized).not.toContain("movementX");
  });

  it("flags missing evidence honestly on a fresh install", async () => {
    const store = makeStore();
    const bundle = await buildHardwareValidationBundle(store, {
      runtime: { ...RUNTIME, estimatedRefreshHz: null },
    });
    expect(bundle.capture.latestSelfTest).toBeNull();
    expect(bundle.sessions.total).toBe(0);
    expect(bundle.calibration.hasRecord).toBe(false);
    // The warnings list tells the operator exactly what is missing.
    expect(bundle.warnings.some((w) => w.includes("self-test"))).toBe(true);
    expect(bundle.warnings.some((w) => w.includes("no human sessions"))).toBe(true);
    expect(bundle.warnings.some((w) => w.includes("calibration"))).toBe(true);
  });
});
