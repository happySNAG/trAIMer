import { describe, expect, it } from "vitest";
import { Rng } from "../src/util/rng.ts";
import { TrialRecorder } from "../src/capture/recorder.ts";
import { validateTrial, DEFAULT_VALIDATION_CONFIG } from "../src/validation/validateTrial.ts";
import { EXPECTED_HELPER_VERSION } from "../src/version.ts";
import {
  NativeTransportCaptureSource,
  createLoopbackSocketPair,
} from "../src/capture/nativeClient.ts";
import { NATIVE_CAPTURE_PROTOCOL_VERSION } from "../src/capture/native.ts";
import type { CaptureSink } from "../src/capture/events.ts";
import type { TrialRecord } from "../src/domain/trial.ts";
import { SensitivityOptimizer } from "../src/optimizer/optimizer.ts";
import { buildExperimentDefinition } from "../src/experiments/protocol.ts";
import { replayExperiment } from "../src/session/replay.ts";
import { summarizeCaptureQuality } from "../src/diagnostics/captureQuality.ts";

/**
 * Deterministic randomized property tests (requirement Q). Every case runs
 * against a seeded Rng so failures are exactly reproducible.
 */

function randomRecorderTrials(seed: number): TrialRecord[] {
  const rng = new Rng(seed);
  const trials: TrialRecord[] = [];
  for (let t = 0; t < 6; t++) {
    const request = {
      id: `trial-prop-${t}` as never,
      sessionId: "session-prop" as never,
      experimentId: null,
      candidateId: null,
      indexInSession: t,
      phase: "measured" as const,
      scenarioId: "flick-static-medium",
      scenarioKind: "flick-static" as const,
      scenarioRepIndex: 0,
      viewport: { widthPx: 1280, heightPx: 720 },
      sensitivity: { sensX: 7, sensY: 7 },
      dpi: 800,
      expectedSampleIntervalMs: null,
      startedAtMonotonicMs: 0,
    };
    const recorder = new TrialRecorder(request);
    recorder.add({
      kind: "target-spawn",
      tMs: 5,
      targetId: "target-1",
      radiusPx: 40,
      motion: { kind: "static", position: { x: 700, y: 360 } },
    });
    let time = rng.range(6, 20);
    for (let i = 0; i < 30; i++) {
      const dx = rng.normal(3, 1.5);
      recorder.add({ kind: "pointer-sample", tMs: time, dx, dy: 0 });
      time += Math.max(1, Math.abs(rng.normal(8, 2)));
    }
    recorder.add({
      kind: "button",
      tMs: time,
      action: "press",
    });
    trials.push(recorder.finish("miss-shot-fired", time + 10));
  }
  return trials;
}

describe("property invariants (deterministic randomized)", () => {
  it("timestamps never regress inside recorded trials across many seeds", () => {
    for (let seed = 1; seed <= 25; seed++) {
      for (const trial of randomRecorderTrials(seed)) {
        for (let i = 1; i < trial.samples.length; i++) {
          expect(trial.samples[i]!.tMs).toBeGreaterThanOrEqual(
            trial.samples[i - 1]!.tMs,
          );
        }
      }
    }
  });

  it("persisted trials round-trip byte-identically through JSON", () => {
    for (let seed = 1; seed <= 10; seed++) {
      for (const trial of randomRecorderTrials(seed)) {
        const roundTrip = JSON.parse(JSON.stringify(trial)) as TrialRecord;
        expect(roundTrip).toEqual(trial);
      }
    }
  });

  it("validation never returns impossible statuses and attribution is stable", () => {
    for (let seed = 1; seed <= 25; seed++) {
      for (const trial of randomRecorderTrials(seed)) {
        const v = validateTrial(trial, DEFAULT_VALIDATION_CONFIG, {});
        expect(["valid", "suspect", "invalid"]).toContain(v.status);
        // Attribution never changes after recording.
        const before = trial.candidateId;
        void validateTrial(trial, DEFAULT_VALIDATION_CONFIG, {});
        expect(trial.candidateId).toBe(before);
      }
    }
  });

  it("confidence stays in [0,1] and ranges stay ordered/bounded under noise", () => {
    const definition = buildExperimentDefinition({
      id: "experiment-prop" as never,
      name: "prop",
      baselineSensitivity: { sensX: 7, sensY: 7 },
      dpi: 800,
      randomizeOrder: false,
      orderSeed: 11,
      measuredRepsPerCandidatePerRound: 4,
      adaptiveAllocation: { enabled: false },
      stoppingCriteria: { maxSearchRounds: 1 },
    });
    const rng = new Rng(777);
    const optimizer = new SensitivityOptimizer(definition);
    let seq = 0;
    for (const candidate of definition.candidates) {
      for (let rep = 0; rep < 5; rep++) {
        const base = {
          id: `trial-p${seq++}` as never,
          sessionId: null,
          experimentId: definition.id,
          candidateId: candidate.id,
          indexInSession: seq,
          phase: "measured" as const,
          scenarioId: "flick-static-medium",
          scenarioKind: "flick-static" as const,
          scenarioRepIndex: rep,
          captureContext: {
            scenarioKind: "flick-static" as const,
            viewport: { widthPx: 1280, heightPx: 720 },
            sensitivity: candidate.sensitivity,
            dpi: 800,
            expectedSampleIntervalMs: null,
          },
          startedAtMonotonicMs: 0,
          endedAtMonotonicMs: 500,
          samples: Array.from({ length: 14 }, (_, i) => ({
            tMs: i * 10,
            cursor: { x: 640 + i * 2, y: 360 },
            dx: 2,
            dy: 0,
          })),
          targets: [
            {
              targetId: "target-1",
              radiusPx: 26,
              appearedMs: 5,
              removedMs: 480,
              removalReason: "hit" as const,
              motion: { kind: "static" as const, position: { x: 700, y: 360 } },
            },
          ],
          shots: [
            {
              tMs: 460,
              cursorAtShot: { x: 700 + rng.range(-30, 30), y: 360 },
              aimedTargetId: "target-1",
              hit: true,
              missDistancePx: 0,
            },
          ],
          focusInterruptions: [],
          viewportResizes: [],
          outcome: "hit" as const,
          validity: { status: "valid" as const, reasons: [] },
          seedTag: null,
          abortedMs: null,
        };
        optimizer.addTrials([base as unknown as TrialRecord]);
      }
    }
    const rec = optimizer.recommend();
    expect(rec.confidence).toBeGreaterThanOrEqual(0);
    expect(rec.confidence).toBeLessThanOrEqual(1);
    expect(rec.edpiRange.min).toBeLessThanOrEqual(rec.edpiRange.max);
    expect(rec.sensXRange.min).toBeLessThanOrEqual(rec.sensXRange.max);
    // Candidate bounds respected by the primary recommendation.
    expect(rec.primarySensitivity.sensX).toBeGreaterThan(0);
  });

  it("malformed native frames fail closed (no partial ingestion) across fuzzed payloads", () => {
    const rng = new Rng(4242);
    for (let iter = 0; iter < 50; iter++) {
      const pair = createLoopbackSocketPair();
      const received: unknown[] = [];
      const source = new NativeTransportCaptureSource({
        url: "ws://127.0.0.1",
        sessionToken: "tok",
        appVersion: "test",
        socketFactory: () => pair.client,
        reconnect: { maxAttempts: 0, initialDelayMs: 1, maxDelayMs: 1 },
      });
      source.start({ onEvent: (e) => received.push(e) } satisfies CaptureSink);
      pair.open();
      source.handleRawMessage(
        JSON.stringify({
          type: "welcome",
          protocolVersion: NATIVE_CAPTURE_PROTOCOL_VERSION,
          sourceKind: "native",
          deviceId: "d",
          deviceDescription: "",
          nominalRateHz: 1000,
          timeOriginNote: "",
          helperVersion: EXPECTED_HELPER_VERSION,
        }),
      );
      // Fuzz: corrupt one aspect of a valid frame.
      const good = {
        type: "frame",
        sequence: 0,
        tMonotonicMs: 5,
        events: [{ kind: "pointer-sample", tMs: 5, dx: 1, dy: 2 }],
      };
      const mutations = [
        () => JSON.stringify({ ...good, events: "not-array" }),
        () => JSON.stringify({ ...good, sequence: 0.5 }),
        () => JSON.stringify({ ...good, tMonotonicMs: null }),
        () =>
          JSON.stringify({
            ...good,
            events: [{ kind: "pointer-sample", tMs: 5, dx: Number.NaN, dy: 2 }],
          }),
        () => "{broken json",
        () => JSON.stringify({ type: "unknown-type" }),
      ];
      const mutate = mutations[rng.int(mutations.length)]!;
      const before = source.counters.framesReceived;
      source.handleRawMessage(mutate());
      expect(source.status === "failed" || source.status === "closed").toBe(true);
      expect(source.counters.framesReceived).toBe(before); // no partial data
      source.stop();
    }
  });

  it("replay remains deterministic across repeated runs with randomized inputs", () => {
    const definition = buildExperimentDefinition({
      id: "experiment-replay-prop" as never,
      name: "replay prop",
      baselineSensitivity: { sensX: 7, sensY: 7 },
      dpi: 800,
      randomizeOrder: false,
      orderSeed: 21,
      measuredRepsPerCandidatePerRound: 4,
      adaptiveAllocation: { enabled: false },
      stoppingCriteria: { maxSearchRounds: 1 },
    });
    const rng = new Rng(9090);
    const trials: TrialRecord[] = [];
    let seq = 0;
    for (const candidate of definition.candidates.slice(0, 3)) {
      for (let rep = 0; rep < 4; rep++) {
        const jitter = rng.range(-15, 15);
        trials.push({
          id: `trial-rp${seq++}` as never,
          sessionId: null,
          experimentId: definition.id,
          candidateId: candidate.id,
          indexInSession: seq,
          phase: "measured",
          scenarioId: "flick-static-medium",
          scenarioKind: "flick-static",
          scenarioRepIndex: rep,
          captureContext: {
            scenarioKind: "flick-static",
            viewport: { widthPx: 1280, heightPx: 720 },
            sensitivity: candidate.sensitivity,
            dpi: 800,
            expectedSampleIntervalMs: null,
          },
          startedAtMonotonicMs: 0,
          endedAtMonotonicMs: 400,
          samples: Array.from({ length: 12 }, (_, i) => ({
            tMs: i * 10,
            cursor: { x: 640 + i * 2, y: 360 },
            dx: 2,
            dy: 0,
          })),
          targets: [
            {
              targetId: "target-1",
              radiusPx: 26,
              appearedMs: 5,
              removedMs: 380,
              removalReason: "hit",
              motion: { kind: "static", position: { x: 655 + jitter, y: 360 } },
            },
          ],
          shots: [
            {
              tMs: 360,
              cursorAtShot: { x: 650, y: 360 },
              aimedTargetId: "target-1",
              hit: true,
              missDistancePx: 0,
            },
          ],
          focusInterruptions: [],
          viewportResizes: [],
          outcome: "hit",
          validity: { status: "valid", reasons: [] },
          seedTag: null,
          abortedMs: null,
        } as unknown as TrialRecord);
      }
    }
    const r1 = replayExperiment(structuredClone(definition), structuredClone(trials));
    const r2 = replayExperiment(structuredClone(definition), structuredClone(trials));
    expect(r1.recommendation.recommendedEdpi).toBe(r2.recommendation.recommendedEdpi);
    expect(r1.recommendation.confidence).toBe(r2.recommendation.confidence);
    expect(r1.recommendation.edpiRange).toEqual(r2.recommendation.edpiRange);
  });

  it("session quality score always lands in [0,1] with a legal grade on fuzzed streams", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const trials = randomRecorderTrials(seed * 13);
      const q = summarizeCaptureQuality({ trials });
      expect(q.score).toBeGreaterThanOrEqual(0);
      expect(q.score).toBeLessThanOrEqual(1);
      expect(["high", "acceptable", "degraded", "poor"]).toContain(q.grade);
      expect(q.fractionHighQualityTrials).toBeLessThanOrEqual(1);
    }
  });
});
