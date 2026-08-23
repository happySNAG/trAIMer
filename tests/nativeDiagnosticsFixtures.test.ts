import { describe, expect, it } from "vitest";
import { analyzeNativeStream } from "../src/diagnostics/nativeDiagnostics.ts";
import type { NativeFrame } from "../src/capture/native.ts";

/** Deterministic fixture builders per polling-rate scenario. */
function regularStream(
  rateHz: number,
  durationMs: number,
  seed = 1,
): NativeFrame[] {
  const dtMs = 1000 / rateHz;
  const frames: NativeFrame[] = [];
  let seq = 0;
  // tiny deterministic wobble so the stream is not perfectly synthetic
  let state = seed >>> 0;
  for (let tMs = 0; tMs <= durationMs; tMs += dtMs) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const wobble = ((state % 200) / 200 - 0.5) * dtMs * 0.02;
    frames.push({
      sequence: seq++,
      tMonotonicMs: tMs + wobble,
      events: [
        { kind: "pointer-sample", tMs: tMs + wobble, dx: 2, dy: 0 },
      ],
    });
  }
  return frames;
}

function jittery1000(): NativeFrame[] {
  const base = regularStream(1000, 60);
  return base.map((f, i) => ({
    ...f,
    tMonotonicMs: f.tMonotonicMs + (i % 4 === 0 ? 3.5 : i % 7 === 0 ? -2.5 : 0),
  }));
}

function dropped1000(dropEveryNth: number): NativeFrame[] {
  const base = regularStream(1000, 80);
  return base
    .filter((f) => f.sequence % dropEveryNth !== 0)
    .map((f) => ({ ...f }));
}

function burstyStream(): NativeFrame[] {
  // Coalesced bursts every ~8 ms carrying 8 samples each.
  const frames: NativeFrame[] = [];
  let seq = 0;
  for (let burstStart = 0; burstStart <= 64; burstStart += 8) {
    const events = Array.from({ length: 8 }, (_, i) => ({
      kind: "pointer-sample" as const,
      tMs: burstStart + i,
      dx: 1,
      dy: 0,
    }));
    frames.push({ sequence: seq++, tMonotonicMs: burstStart + 7, events });
  }
  return frames;
}

describe("native capture diagnostics fixtures", () => {
  it("125 Hz clean stream passes at its requested rate", () => {
    const d = analyzeNativeStream(regularStream(125, 800), {
      requestedRateHz: 125,
    });
    expect(d.observedRateHz).toBeGreaterThan(110);
    expect(d.observedRateHz).toBeLessThan(140);
    expect(d.droppedSequences).toBe(0);
    expect(d.jitterCv!).toBeLessThan(0.05);
    expect(d.verdict).toBe("pass");
    expect(d.checks.find((c) => c.name === "effective-rate")!.status).toBe("pass");
  });

  it("250 Hz clean stream passes", () => {
    const d = analyzeNativeStream(regularStream(250, 400), {
      requestedRateHz: 250,
    });
    expect(Math.round(d.observedRateHz)).toBeGreaterThanOrEqual(235);
    expect(d.verdict).toBe("pass");
  });

  it("500 Hz clean stream passes with tight p10-p90 band", () => {
    const d = analyzeNativeStream(regularStream(500, 300), {
      requestedRateHz: 500,
    });
    expect(d.intervalP50Ms!).toBeCloseTo(2, 1);
    expect(d.intervalP90Ms! - d.intervalP10Ms!).toBeLessThan(0.5);
    expect(d.verdict).toBe("pass");
  });

  it("1000 Hz clean stream passes and reports sub-ms intervals", () => {
    const d = analyzeNativeStream(regularStream(1000, 250), {
      requestedRateHz: 1000,
    });
    expect(d.observedRateHz).toBeGreaterThan(950);
    expect(d.intervalP50Ms!).toBeLessThan(1.05);
    expect(d.durationTestedMs).toBeGreaterThanOrEqual(240);
    expect(d.frameCount).toBeGreaterThan(240);
    expect(d.verdict).toBe("pass");
  });

  it("jittery 1000 Hz warns on timing jitter", () => {
    const d = analyzeNativeStream(jittery1000(), { requestedRateHz: 1000 });
    expect(d.jitterCv!).toBeGreaterThan(0.6);
    expect(d.checks.find((c) => c.name === "timing-jitter")!.status === "warn" ||
      d.checks.find((c) => c.name === "timing-jitter")!.status === "fail").toBe(true);
    expect(["warn", "fail"]).toContain(d.verdict);
  });

  it("dropped-frame 1000 Hz reports missing sequences and fails/warns", () => {
    const d = analyzeNativeStream(dropped1000(25), { requestedRateHz: 1000 });
    expect(d.droppedSequences).toBeGreaterThan(0);
    // Median-based rate is robust to sparse drops (still ~1000 Hz), which is
    // exactly why sequence accounting — not rate alone — must flag the loss.
    expect(d.observedRateHz).toBeGreaterThan(950);
    const integrity = d.checks.find((c) => c.name === "sequence-integrity")!;
    expect(integrity.status).not.toBe("pass");
    expect(d.verdict).not.toBe("pass");

    // Heavy drops do move real throughput even though the median interval
    // stays robust.
    const heavy = analyzeNativeStream(dropped1000(3), { requestedRateHz: 1000 });
    expect(heavy.throughputRateHz).toBeLessThan(800);
    expect(heavy.verdict).toBe("fail");
  });

  it("bursty/coalesced stream is detected and warned", () => {
    const d = analyzeNativeStream(burstyStream(), { requestedRateHz: 1000 });
    expect(d.bursts.count).toBeGreaterThan(5);
    expect(d.bursts.maxCoalescedEventsPerFrame).toBe(8);
    // Observed frame rate looks like 125 Hz even though the device is 1000 Hz.
    expect(d.observedRateHz).toBeLessThan(200);
    expect(d.checks.find((c) => c.name === "burst-behavior")!.status).not.toBe("pass");
  });

  it("click ordering check catches a click with no preceding motion", () => {
    const frames: NativeFrame[] = [
      {
        sequence: 0,
        tMonotonicMs: 0,
        events: [{ kind: "button", tMs: 0, action: "press" }],
      },
      {
        sequence: 1,
        tMonotonicMs: 1,
        events: [{ kind: "pointer-sample", tMs: 1, dx: 3, dy: 0 }],
      },
      {
        sequence: 2,
        tMonotonicMs: 2,
        events: [{ kind: "pointer-sample", tMs: 2, dx: 3, dy: 0 }],
      },
    ];
    const d = analyzeNativeStream(frames);
    expect(d.clickAfterDeltaOrderedCorrectly).toBe(false);
    expect(d.checks.find((c) => c.name === "click-ordering")!.status).toBe("warn");
  });

  it("non-monotonic timestamps and reconnects degrade stream-stability", () => {
    const frames = regularStream(500, 40);
    frames[5]!.tMonotonicMs = frames[4]!.tMonotonicMs - 5;
    const d = analyzeNativeStream(frames, {
      requestedRateHz: 500,
      reconnectEvents: 2,
    });
    expect(d.nonMonotonicTimestamps).toBeGreaterThan(0);
    expect(d.reconnectEvents).toBe(2);
    const stability = d.checks.find((c) => c.name === "stream-stability")!;
    expect(stability.status).toBe("fail");
    expect(d.verdict).toBe("fail");
  });

  it("empty streams fail loudly rather than reporting fake health", () => {
    const d = analyzeNativeStream([], {});
    expect(d.verdict).toBe("fail");
    expect(d.observedRateHz).toBe(0);
  });
});
