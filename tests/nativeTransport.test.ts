import { describe, expect, it } from "vitest";
import type { TrialRecord } from "../src/domain/trial.ts";
import {
  makeNativeFixture,
  parseNativeFixture,
  serializeNativeFixture,
  detectSequenceGaps,
  ReplayCaptureSource,
} from "../src/capture/native.ts";
import { TrialRecorder, type TrialRecordingRequest } from "../src/capture/recorder.ts";
import { validateTrial } from "../src/validation/validateTrial.ts";
import { computeFlickMetrics } from "../src/metrics/flick.ts";
import { equalXy } from "../src/domain/settings.ts";

function deltaFrame(seq: number, tMs: number, dx: number): {
  sequence: number;
  tMonotonicMs: number;
  events: [
    { kind: "pointer-sample"; tMs: number; dx: number; dy: number },
  ];
} {
  return {
    sequence: seq,
    tMonotonicMs: tMs,
    events: [{ kind: "pointer-sample", tMs: tMs, dx, dy: 0 }],
  };
}

const header = {
  deviceId: "native-helper-01",
  deviceDescription: "synthetic 1000 Hz helper",
  nominalRateHz: 1000,
};

describe("native capture transport", () => {
  const frames = [
    deltaFrame(0, 0, 0),
    deltaFrame(1, 1, 2),
    deltaFrame(2, 2, 3),
    ...Array.from({ length: 200 }, (_, i) => deltaFrame(3 + i, 3 + i, i % 7 === 0 ? 6 : 2)),
    { sequence: 210, tMonotonicMs: 213, events: [{ kind: "button" as const, tMs: 213, action: "press" as const }] },
  ];

  it("serializes and parses fixtures losslessly", () => {
    const fixture = makeNativeFixture(header, frames);
    const roundTrip = parseNativeFixture(serializeNativeFixture(fixture));
    expect(roundTrip).toEqual(fixture);
  });

  it("rejects malformed fixtures and unsupported headers", () => {
    expect(() => parseNativeFixture({ kind: "nope" })).toThrow(/invalid native-capture-fixture/);
    expect(() =>
      parseNativeFixture({
        kind: "native-capture-fixture",
        schemaVersion: 1,
        header: { protocolVersion: 99, sourceKind: "native", deviceId: "x", deviceDescription: "", nominalRateHz: 500 },
        frames: [],
      }),
    ).toThrow(/unsupported native stream header/);
  });

  it("detects sequence gaps (dropped frames)", () => {
    const gapped = [frames[0], frames[2], frames[5]].map((f) => f!);
    const gaps = detectSequenceGaps(gapped);
    expect(gaps).toEqual([
      { afterSequence: 0, missingCount: 1 },
      { afterSequence: 2, missingCount: 2 },
    ]);
  });

  it("replays a fixture through the recorder identically to a live feed", () => {
    const fixture = makeNativeFixture(header, frames);
    const replay = new ReplayCaptureSource(fixture);

    const request: TrialRecordingRequest = {
      id: "trial-native" as never,
      sessionId: null,
      experimentId: null,
      candidateId: null,
      indexInSession: 0,
      phase: "measured",
      scenarioId: "flick-static-medium",
      scenarioKind: "flick-static",
      scenarioRepIndex: 0,
      viewport: { widthPx: 1280, heightPx: 720 },
      sensitivity: equalXy(7),
      dpi: 800,
      expectedSampleIntervalMs: null,
      startedAtMonotonicMs: 0,
    };

    // Both feeds get a target so the trial is structurally complete.
    // A generous radius keeps the single shot a deterministic hit regardless
    // of where the fixture deltas leave the cursor.
    const spawnTarget = (recorder: TrialRecorder): void => {
      recorder.add({
        kind: "target-spawn",
        tMs: 0,
        targetId: "target-native",
        radiusPx: 900,
        motion: { kind: "static", position: { x: 700, y: 360 } },
      });
    };

    // live-style feed
    const liveRecorder = new TrialRecorder(request);
    spawnTarget(liveRecorder);
    for (const frame of fixture.frames) {
      for (const event of frame.events) liveRecorder.add(event);
    }
    liveRecorder.add({
      kind: "target-remove",
      tMs: 214,
      targetId: "target-native",
      reason: "hit",
    });
    const liveRecord = liveRecorder.finish("hit", 260);

    // replayed feed through the CaptureSource boundary
    let record: TrialRecord | null = null;
    let spawned = false;
    const recorder = new TrialRecorder(request);
    spawnTarget(recorder);
    replay.start({
      onEvent(event) {
        if (record) return;
        if (event.kind === "pointer-sample" && event.tMs >= 200 && !spawned) {
          spawned = true;
          recorder.add({
            kind: "target-remove",
            tMs: event.tMs,
            targetId: "target-native",
            reason: "hit",
          });
        }
        recorder.add(event);
        if (event.kind === "button" && event.action === "press") {
          record = recorder.finish(
            recorder.state.hitCount > 0 ? "hit" : "miss-shot-fired",
            event.tMs + 10,
          );
        }
      },
    });
    replay.stop();

    expect(record).not.toBeNull();
    const finalRecord = record ?? liveRecord;
    expect(finalRecord.samples.length).toBe(liveRecord.samples.length);
    const replayDx = finalRecord.samples.map((s) => Math.round(s.dx * 1000) / 1000);
    const liveDx = liveRecord.samples.map((s) => Math.round(s.dx * 1000) / 1000);
    expect(replayDx).toEqual(liveDx);
    const validity = validateTrial(finalRecord);
    expect(validity.status === "valid" || validity.status === "suspect").toBe(true);
    expect(computeFlickMetrics(finalRecord).shotsFired).toBe(1);
  });

  it("surfaces lock-loss events injected by the transport", () => {
    const replay = new ReplayCaptureSource(makeNativeFixture(header, frames));
    const events: string[] = [];
    replay.start({ onEvent: (e) => events.push(e.kind) });
    replay.emitLockLoss(999);
    void events;
    expect(events).toContain("lock-change");
  });
});
