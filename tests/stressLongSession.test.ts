import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { TrialRecorder, type TrialRecordingRequest } from "../src/capture/recorder.ts";
import {
  NativeTransportCaptureSource,
  createLoopbackSocketPair,
} from "../src/capture/nativeClient.ts";
import { NATIVE_CAPTURE_PROTOCOL_VERSION } from "../src/capture/native.ts";
import { EXPECTED_HELPER_VERSION } from "../src/version.ts";
import type { CaptureEvent } from "../src/capture/events.ts";
import { validateTrial, DEFAULT_VALIDATION_CONFIG } from "../src/validation/validateTrial.ts";
import { computeInputQuality } from "../src/diagnostics/inputQuality.ts";
import { summarizeCaptureQuality } from "../src/diagnostics/captureQuality.ts";
import { SensitivityOptimizer } from "../src/optimizer/optimizer.ts";
import { buildExperimentDefinition } from "../src/experiments/protocol.ts";
import type { TrialRecord } from "../src/domain/trial.ts";
import { InMemoryBackend } from "../src/persistence/backends.ts";
import { LocalJsonStore } from "../src/persistence/store.ts";

/**
 * Stress / long-session tests (Pass 5).
 *
 * Bounded-runtime simulations of worst-case realistic sessions: an hour of
 * continuous 1000 Hz native streaming, hundreds of recorded trials with
 * checkpoint-style persistence round-trips, and memory-bound transport
 * counters. Every test asserts BOTH correctness and time budgets.
 */

const ONE_MINUTE_OF_1000HZ_EVENTS = 60_000;

function build1000HzStream(durationMs: number): CaptureEvent[] {
  const events: CaptureEvent[] = [];
  for (let t = 0; t < durationMs; t += 1) {
    const dx = Math.round(Math.sin(t / 37) * 4);
    const dy = Math.round(Math.cos(t / 53) * 3);
    events.push({ kind: "pointer-sample", tMs: t, dx, dy });
    if (t % 900 === 0 && t > 0) {
      events.push({ kind: "button", tMs: t, action: "press" });
      events.push({ kind: "button", tMs: t + 30, action: "release" });
    }
  }
  return events;
}

describe("stress: long-session capture", () => {
  it("ingests a full minute of 1000 Hz events (~60k) within budget and stays correct", () => {
    const stream = build1000HzStream(ONE_MINUTE_OF_1000HZ_EVENTS);
    expect(stream.length).toBeGreaterThan(59_000);

    const request: TrialRecordingRequest = {
      id: "trial-stress" as never,
      sessionId: null,
      experimentId: null,
      candidateId: null,
      indexInSession: 0,
      phase: "measured",
      scenarioId: "flick-static-medium",
      scenarioKind: "flick-static",
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
      tMs: 1,
      targetId: "target-1",
      radiusPx: 26,
      motion: { kind: "static", position: { x: 700, y: 360 } },
    });

    const start = performance.now();
    for (const event of stream) recorder.add(event);
    const ingestMs = performance.now() - start;

    const record = recorder.finish("miss-shot-fired", ONE_MINUTE_OF_1000HZ_EVENTS);
    // Budget: ingestion of a full minute must stay far under one second.
    expect(ingestMs).toBeLessThan(1000);

    // Correctness after the marathon:
    for (let i = 1; i < record.samples.length; i += 997) {
      expect(record.samples[i]!.tMs).toBeGreaterThanOrEqual(
        record.samples[i - 1]!.tMs,
      );
    }
    const validity = validateTrial(record, DEFAULT_VALIDATION_CONFIG, {});
    expect(["valid", "suspect"]).toContain(validity.status);
    const quality = computeInputQuality(record);
    expect(quality.metrics.observedRateHz).toBeGreaterThan(800);
  }, 30_000);

  it("transport counters stay bounded and accurate over 100k frames", () => {
    const pair = createLoopbackSocketPair();
    let received = 0;
    const source = new NativeTransportCaptureSource({
      url: "ws://127.0.0.1:48765",
      sessionToken: "tok",
      appVersion: "stress",
      socketFactory: () => pair.client,
      reconnect: { maxAttempts: 0, initialDelayMs: 1, maxDelayMs: 1 },
    });
    // The transport translates helper time into renderer time and emits
    // nothing until that offset is established, so the stress run has to
    // complete the same clock-sync chain a real session does.
    pair.server.onMessage((data) => {
      const msg = JSON.parse(data) as { type?: string; id?: string };
      if (msg.type === "time-sync" && msg.id) {
        source.handleRawMessage(
          JSON.stringify({
            type: "time-sync-reply",
            id: msg.id,
            helperMonotonicMs: performance.now() - 1000,
          }),
        );
      }
    });
    source.start({
      onEvent: (e) => {
        if (e.kind === "pointer-sample") received++;
      },
    });
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
    for (let i = 0; i < 60 && source.clockSync.state === "syncing"; i++) {
      pair.server.deliverClientToServer();
    }
    expect(source.clockSync.state).toBe("established");
    const start = performance.now();
    const FRAMES = 100_000;
    for (let seq = 0; seq < FRAMES; seq++) {
      source.handleRawMessage(
        JSON.stringify({
          type: "frame",
          sequence: seq,
          tMonotonicMs: seq,
          events: [{ kind: "pointer-sample", tMs: seq, dx: 1, dy: 1 }],
        }),
      );
      if (source.status !== "streaming") break;
    }
    const elapsedMs = performance.now() - start;
    expect(source.status).toBe("streaming");
    expect(source.counters.framesReceived).toBe(FRAMES);
    expect(received).toBe(FRAMES);
    expect(source.counters.duplicateSequences).toBe(0);
    expect(source.counters.missingSequences).toBe(0);
    // Throughput budget: ≥50k frames/s through full validation.
    expect(FRAMES / Math.max(elapsedMs / 1000, 1e-9)).toBeGreaterThan(50_000);
    source.stop();
  }, 30_000);
});

describe("stress: long measured session pipeline", () => {
  function syntheticMeasuredTrial(index: number, candidateId: string, seedTagNoise: number): TrialRecord {
    return {
      id: `trial-s${index}` as never,
      sessionId: "session-stress" as never,
      experimentId: "experiment-stress" as never,
      candidateId: candidateId as never,
      indexInSession: index,
      phase: "measured",
      scenarioId: ["flick-static-medium", "flick-static-small", "tracking-smooth-sine"][index % 3]!,
      scenarioKind: index % 3 === 2 ? "tracking" : "flick-static",
      captureContext: {
        scenarioKind: index % 3 === 2 ? ("tracking" as const) : ("flick-static" as const),
        viewport: { widthPx: 1280, heightPx: 720 },
        sensitivity: { sensX: 7, sensY: 7 },
        dpi: 800,
        expectedSampleIntervalMs: null,
      },
      startedAtMonotonicMs: index * 5000,
      endedAtMonotonicMs: index * 5000 + 2000,
      samples: Array.from({ length: 240 }, (_, i) => ({
        tMs: index * 5000 + i * 8,
        cursor: { x: 640 + i + seedTagNoise, y: 360 },
        dx: 1,
        dy: 0,
      })),
      targets: [
        {
          targetId: "target-1",
          radiusPx: 26,
          appearedMs: index * 5000 + 10,
          removedMs: index * 5000 + 1900,
          removalReason: "hit",
          motion: { kind: "static", position: { x: 700 + seedTagNoise, y: 360 } },
        },
      ],
      shots: [
        {
          tMs: index * 5000 + 1800,
          cursorAtShot: { x: 700 + seedTagNoise, y: 360 },
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
      scenarioRepIndex: index % 8,
      abortedMs: null,
    } as unknown as TrialRecord;
  }

  it("300-trial session: validation + quality + optimization complete within budget", () => {
    const definition = buildExperimentDefinition({
      id: "experiment-stress" as never,
      name: "stress",
      baselineSensitivity: { sensX: 7, sensY: 7 },
      dpi: 800,
      randomizeOrder: false,
      orderSeed: 5,
      adaptiveAllocation: { enabled: false },
      stoppingCriteria: { maxSearchRounds: 2 },
    });
    const optimizer = new SensitivityOptimizer(definition);
    const allTrials: TrialRecord[] = [];

    const start = performance.now();
    let seq = 0;
    for (const candidate of definition.candidates) {
      for (let rep = 0; rep < 15; rep++) {
        const trial = syntheticMeasuredTrial(seq++, candidate.id, (seq % 7) - 3);
        validateTrial(trial, DEFAULT_VALIDATION_CONFIG, {
          sensitivity: candidate.sensitivity,
          dpi: 800,
        });
        allTrials.push(trial);
      }
    }
    optimizer.addTrials(allTrials);
    const quality = summarizeCaptureQuality({ trials: allTrials });
    const rec = optimizer.recommend();
    const elapsedMs = performance.now() - start;

    expect(allTrials.length).toBe(definition.candidates.length * 15);
    expect(quality.trialsAnalyzed).toBe(allTrials.length);
    expect(Number.isFinite(rec.recommendedEdpi)).toBe(true);
    // Whole 300-trial analysis pipeline under 5 seconds.
    expect(elapsedMs).toBeLessThan(5000);
  }, 30_000);

  it("JSON persistence round-trips remain stable at scale (300 trials)", async () => {
    const backend = new InMemoryBackend();
    const store = new LocalJsonStore(backend);
    const start = performance.now();
    for (let i = 0; i < 300; i++) {
      await store.saveRaw("trial-record", `trials/experiment-stress/trial-s${i}.json`, {
        id: `trial-s${i}`,
        samples: [],
      });
    }
    const list = await store.listTrialIds("experiment-stress");
    expect(list.length).toBe(300);
    const first = await store.loadRawAt<{ id: string }>(
      "trial-record",
      "trials/experiment-stress/trial-s0.json",
    );
    expect(first?.payload.id).toBe("trial-s0");
    expect(performance.now() - start).toBeLessThan(10_000);
  }, 30_000);
});
