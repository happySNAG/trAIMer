import { describe, expect, it } from "vitest";
import { InMemoryBackend } from "../src/persistence/backends.ts";
import { LocalJsonStore } from "../src/persistence/store.ts";
import { exportExperimentBundle, importExperimentBundle } from "../src/persistence/bundle.ts";
import {
  AimLabError,
  toAimLabError,
  guardedWrite,
} from "../src/errors/types.ts";
import { parseResumeCheckpoint } from "../src/session/resume.ts";
import { analyzeNativeStream } from "../src/diagnostics/nativeDiagnostics.ts";
import type { NativeFrame } from "../src/capture/native.ts";
import type { TrialRecord } from "../src/domain/trial.ts";
import { buildExperimentDefinition } from "../src/experiments/protocol.ts";
import { SensitivityOptimizer } from "../src/optimizer/optimizer.ts";
import { deriveCalibration } from "../src/calibration/core.ts";

/** Backend whose writes fail after N successes (deterministic fault). */
class FlakyBackend extends InMemoryBackend {
  #writes = 0;
  constructor(private readonly failAfterWrites: number) {
    super();
  }
  override async writeFile(relPath: string, contents: string): Promise<void> {
    this.#writes++;
    if (this.#writes > this.failAfterWrites) {
      throw new Error("SIMULATED_IDB_FAILURE");
    }
    await super.writeFile(relPath, contents);
  }
}

function minimalTrial(id: string, candidateId: string): TrialRecord {
  return {
    id: id as never,
    sessionId: "session-f" as never,
    experimentId: "experiment-f" as never,
    candidateId: candidateId as never,
    indexInSession: 0,
    phase: "measured",
    scenarioId: "flick-static-medium",
    scenarioKind: "flick-static",
    captureContext: {
      scenarioKind: "flick-static",
      viewport: { widthPx: 1280, heightPx: 720 },
      sensitivity: { sensX: 7, sensY: 7 },
      dpi: 800,
      expectedSampleIntervalMs: null,
    },
    startedAtMonotonicMs: 0,
    endedAtMonotonicMs: 100,
    samples: [],
    targets: [],
    shots: [],
    focusInterruptions: [],
    viewportResizes: [],
    outcome: "hit",
    validity: { status: "valid", reasons: [] },
    seedTag: null,
    scenarioRepIndex: 0,
    abortedMs: null,
  };
}

describe("failure injection: persistence", () => {
  it("IndexedDB write failure surfaces as a typed retryable error", async () => {
    const backend = new FlakyBackend(1);
    const store = new LocalJsonStore(backend);
    await store.saveRaw("aim-session", "sessions/s1.json", { ok: true });
    const outcome = await guardedWrite(
      () => store.saveTrial("experiment-f", minimalTrial("trial-1", "cand-a")),
      { kind: "trial-record", path: "trials/experiment-f/trial-1.json" },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeInstanceOf(AimLabError);
    expect(outcome.error!.category).toBe("persistence");
    expect(outcome.error!.retryable).toBe(true);
  });

  it("corrupted checkpoint payloads fail closed instead of half-resuming", () => {
    expect(() => parseResumeCheckpoint(undefined)).toThrow();
    expect(() => parseResumeCheckpoint("garbage")).toThrow();
    expect(() =>
      parseResumeCheckpoint({
        schemaVersion: 2,
        kind: "session-resume",
        sessionId: 42, // wrong type
        experimentId: "experiment-x",
        completedSequenceKeys: [],
        phaseLog: [],
      }),
    ).toThrow(/missing required fields|corrupted/);
  });

  it("malformed import bundles are rejected with clear reasons and no partial state", async () => {
    const backend = new InMemoryBackend();
    const store = new LocalJsonStore(backend);

    await expect(importExperimentBundle(store, null)).rejects.toThrow(/invalid session bundle envelope/);
    await expect(importExperimentBundle(store, { kind: "nope" })).rejects.toThrow(/invalid session bundle envelope/);
    await expect(
      importExperimentBundle(store, {
        kind: "session-bundle",
        schemaVersion: 999,
        payload: {},
      }),
    ).rejects.toThrow(/newer than supported/);
    await expect(
      importExperimentBundle(store, {
        kind: "session-bundle",
        schemaVersion: 1,
        payload: { trials: [] },
      }),
    ).rejects.toThrow(/missing experiment definition/);
    // Nothing was persisted by any failed import.
    expect(await store.listSessionIds()).toEqual([]);

    // A valid bundle still round-trips.
    const source = new LocalJsonStore(new InMemoryBackend());
    await source.saveExperiment(
      buildExperimentDefinition({
        id: "experiment-bundle-ok" as never,
        name: "b",
        baselineSensitivity: { sensX: 7, sensY: 7 },
        dpi: 800,
        randomizeOrder: false,
      }),
    );
    await source.saveTrial("experiment-bundle-ok", minimalTrial("trial-z", "cand-a"));
    const bundle = await exportExperimentBundle(source, "experiment-bundle-ok");
    const result = await importExperimentBundle(store, JSON.parse(JSON.stringify(bundle)));
    expect(result.trialsImported).toBe(1);
  });
});

describe("failure injection: capture stream", () => {
  it("native diagnostics treat empty/garbage streams as failures, never healthy", () => {
    expect(analyzeNativeStream([], {}).verdict).toBe("fail");
    const garbage: NativeFrame[] = [
      { sequence: 5, tMonotonicMs: 10, events: [] },
      { sequence: 4, tMonotonicMs: 11, events: [] }, // out of order
      { sequence: 9, tMonotonicMs: 3, events: [] }, // time regression
    ];
    const d = analyzeNativeStream(garbage, {});
    expect(d.nonMonotonicTimestamps).toBeGreaterThan(0);
    expect(d.verdict).toBe("fail");
  });

  it("duplicate frames in fixture data are detected as duplicates", () => {
    const frames: NativeFrame[] = [
      { sequence: 0, tMonotonicMs: 0, events: [] },
      { sequence: 1, tMonotonicMs: 1, events: [] },
      { sequence: 1, tMonotonicMs: 2, events: [] },
    ];
    const d = analyzeNativeStream(frames, {});
    expect(d.duplicateSequences).toBe(1);
  });
});

describe("failure injection: optimizer / clock / calibration", () => {
  it("optimizer refuses gracefully on starved input (no exception escapes)", () => {
    const definition = buildExperimentDefinition({
      id: "experiment-starved" as never,
      name: "starved",
      baselineSensitivity: { sensX: 7, sensY: 7 },
      dpi: 800,
      randomizeOrder: false,
      orderSeed: 5,
    });
    // A trial with missing samples must be excluded by validation, not crash.
    const broken = minimalTrial("trial-empty", definition.candidates[0]!.id);
    broken.samples = [];
    const optimizer = new SensitivityOptimizer(definition);
    optimizer.addTrials([broken]);
    const rec = optimizer.recommend();
    expect(rec.refusedHighConfidence).toBe(true);
    expect(rec.confidenceLabel).toBe("low");
  });

  it("clock anomaly (non-monotonic timestamps) invalidates the trial via validation", () => {
    const definition = buildExperimentDefinition({
      id: "experiment-clock" as never,
      name: "clock",
      baselineSensitivity: { sensX: 7, sensY: 7 },
      dpi: 800,
      randomizeOrder: false,
      orderSeed: 6,
    });
    const trial = minimalTrial("trial-clock", definition.candidates[0]!.id);
    trial.samples = Array.from({ length: 12 }, (_, i) => ({
      tMs: i < 6 ? i * 10 : (11 - i) * 10 - 100, // regressing timestamps
      cursor: { x: 640 + i * 2, y: 360 },
      dx: 2,
      dy: 0,
    }));
    const optimizer = new SensitivityOptimizer(definition);
    optimizer.addTrials([trial]);
    const rec = optimizer.recommend();
    expect(rec.evidence.trialsAnalyzed).toBe(0);
    expect(rec.warnings.join(" ")).toMatch(/too few valid trials/i);
  });

  it("invalid calibration artifacts are flagged inadequate, never applied", () => {
    const bad = deriveCalibration("x", "full-rotation", []);
    expect(bad.adequate).toBe(false);
    expect(bad.inadequacyReasons.length).toBeGreaterThan(0);
    expect(bad.degreesPerCountAt100).toBeNull();

    const nanCounts = deriveCalibration("x", "full-rotation", [
      { repIndex: 0, countsX: Number.NaN, countsY: 0, thetaDeg: 360, dpi: 800, sensPercent: 7, capturedAtIso: "", method: "full-rotation" },
    ]);
    expect(nanCounts.adequate).toBe(false);
  });
});

describe("failure injection: error normalization boundary", () => {
  it("every engine error crossing to the UI is an AimLabError with safe text", () => {
    const weird = toAimLabError({ random: "object" });
    expect(weird.category).toBe("user-correctable");
    expect(typeof weird.userMessage).toBe("string");

    const stackful = toAimLabError(new Error("stack revealing internals\n    at foo()"));
    expect(stackful.userMessage).not.toMatch(/at foo\(\)/);
    expect(stackful.details.internalType).toBe("Error");
  });
});
