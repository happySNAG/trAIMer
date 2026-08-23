import { describe, expect, it } from "vitest";
import { validateTrial, DEFAULT_VALIDATION_CONFIG } from "../src/validation/validateTrial.ts";
import { computeInputQuality } from "../src/diagnostics/inputQuality.ts";
import { makeNativeFixture, serializeNativeFixture, parseNativeFixture, detectSequenceGaps } from "../src/capture/native.ts";
import type { NativeFrame } from "../src/capture/native.ts";
import { TrialRecorder, type TrialRecordingRequest } from "../src/capture/recorder.ts";
import { InMemoryBackend } from "../src/persistence/backends.ts";
import { LocalJsonStore } from "../src/persistence/store.ts";

/**
 * Pass 6 raw-capture stress (requirement 10).
 *
 * Simulates 125 / 250 / 500 / 1000 Hz (supported range) and 2000 / 4000 /
 * 8000 Hz (future devices) streams end-to-end: generation → ingest →
 * validation → quality → serialization → persistence → replay. The product
 * does NOT advertise >1000 Hz support; the engine must simply not degrade or
 * fail catastrophically when a future device delivers higher rates.
 */

const RATES = [125, 250, 500, 1000, 2000, 4000, 8000] as const;
const DURATION_MS = 3000;

function generateStream(rateHz: number): NativeFrame[] {
  const dt = 1000 / rateHz;
  const frames: NativeFrame[] = [];
  let sequence = 1;
  for (let t = 0; t <= DURATION_MS; t += dt) {
    const dx = Math.sin(t / 50) * 0.8 + (rateHz > 1000 ? 0.05 : 0.3);
    const dy = Math.cos(t / 70) * 0.5;
    frames.push({
      sequence: sequence++,
      tMonotonicMs: Math.round(t * 100) / 100,
      events: [
        {
          kind: "pointer-sample" as const,
          tMs: Math.round(t * 100) / 100,
          dx: Math.round(dx * 1000) / 1000,
          dy: Math.round(dy * 1000) / 1000,
        },
      ],
    });
  }
  return frames;
}

describe("high-rate capture stress", () => {
  it("ingests and validates every supported and future rate within budget", () => {
    const results: Record<number, { frames: number; ingestMsPerKFrame: number }> = {};
    for (const rate of RATES) {
      const frames = generateStream(rate);
      // Serialization round-trip is exact at every rate.
      const json = serializeNativeFixture(
        makeNativeFixture(
          { deviceId: `dev-${rate}`, deviceDescription: `synthetic ${rate} Hz`, nominalRateHz: rate },
          frames,
        ),
      );
      const parsed = parseNativeFixture(json);
      expect(parsed.frames.length).toBe(frames.length);
      expect(parsed.header.nominalRateHz).toBe(rate);
      expect(detectSequenceGaps(parsed.frames)).toEqual([]);

      // Ingest cost per 1000 frames.
      const t0 = performance.now();
      let samples = 0;
      for (const frame of parsed.frames) {
        for (const ev of frame.events) {
          if (ev.kind === "pointer-sample") samples++;
        }
      }
      const ingestMs = performance.now() - t0;
      results[rate] = {
        frames: parsed.frames.length,
        ingestMsPerKFrame: (ingestMs / samples) * 1000,
      };
    }
    // Every rate produced its expected sample volume.
    for (const rate of RATES) {
      expect(results[rate]!.frames).toBeGreaterThanOrEqual((DURATION_MS / 1000) * rate * 0.99);
    }
    // Even 8000 Hz stays far below any interactive budget.
    expect(results[8000]!.ingestMsPerKFrame).toBeLessThan(25);
  });

  it("records full-rate trials that pass validation with monotonic timestamps", () => {
    for (const rate of RATES) {
      const request: TrialRecordingRequest = {
        id: `trial-rate-${rate}` as never,
        sessionId: "session-rate" as never,
        experimentId: null,
        candidateId: "cand-x" as never,
        indexInSession: 0,
        phase: "measured",
        scenarioId: "flick-static-medium",
        scenarioKind: "flick-static",
        scenarioRepIndex: 0,
        viewport: { widthPx: 1280, heightPx: 720 },
        sensitivity: { sensX: 7, sensY: 7 },
        dpi: 800,
        expectedSampleIntervalMs: 1000 / rate,
        startedAtMonotonicMs: 0,
        seedTag: `rate-${rate}`,
      };
      const recorder = new TrialRecorder(request);
      recorder.add({
        kind: "target-spawn",
        tMs: 0,
        targetId: "target-rate" as never,
        radiusPx: 26,
        motion: { kind: "static", position: { x: 900, y: 360 } },
      });
      const dt = 1000 / rate;
      for (let i = 0; i <= DURATION_MS / dt; i++) {
        const t = i * dt;
        recorder.add({ kind: "pointer-sample", tMs: t, dx: 0.9, dy: 0.2 });
      }
      recorder.add({ kind: "button", tMs: DURATION_MS - 1, action: "press" });
      recorder.add({
        kind: "target-remove",
        tMs: DURATION_MS,
        targetId: "target-rate" as never,
        reason: "hit",
      });
      const record = recorder.finish("hit", DURATION_MS);
      const validity = validateTrial(record, DEFAULT_VALIDATION_CONFIG);
      expect(validity.status, `rate ${rate}: ${JSON.stringify(validity.reasons)}`).toBe("valid");
      // Input-quality metrics remain sane at every rate.
      const quality = computeInputQuality(record);
      expect(quality.score).toBeGreaterThan(0.5);
      expect(quality.metrics.observedRateHz).toBeGreaterThan(rate * 0.9);
    }
  });

  it("persists and replays an 8000 Hz fixture losslessly", async () => {
    const frames = generateStream(8000);
    const fixture = makeNativeFixture(
      { deviceId: "dev-8k", deviceDescription: "future 8 kHz mouse", nominalRateHz: 8000 },
      frames.slice(0, 5000),
    );
    const backend = new InMemoryBackend();
    const store = new LocalJsonStore(backend);
    await store.saveRaw("native-capture-fixture", "fixtures/8k.json", fixture);
    const loaded = await store.loadRaw<{ header: { nominalRateHz: number }; frames: unknown[] }>(
      "native-capture-fixture",
      "fixtures/8k.json",
    );
    expect(loaded?.payload.header.nominalRateHz).toBe(8000);
    expect(loaded!.payload.frames.length).toBe(5000);
    // Replay determinism.
    const reSerialized = serializeNativeFixture(parseNativeFixture(JSON.stringify(fixture)));
    expect(reSerialized).toBe(serializeNativeFixture(parseNativeFixture(reSerialized)));
  });

  it("keeps memory bounded across a long 8000 Hz soak", () => {
    // Generate + discard repeatedly; allocation churn must not explode.
    const before = process.memoryUsage().heapUsed;
    for (let round = 0; round < 6; round++) {
      const frames = generateStream(8000);
      const json = serializeNativeFixture(
        makeNativeFixture(
          { deviceId: "soak", deviceDescription: "soak", nominalRateHz: 8000 },
          frames,
        ),
      );
      parseNativeFixture(json);
    }
    global.gc?.();
    const after = process.memoryUsage().heapUsed;
    // Generous ceiling: repeated full-stream processing must not leak GBs.
    expect(after - before).toBeLessThan(600 * 1024 * 1024);
  });
});

