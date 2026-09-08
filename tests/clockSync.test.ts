import { describe, expect, it } from "vitest";
import { createFakeHelper } from "./support/helperSocket.ts";
import {
  DOM_CAPTURE_LEAD_TOLERANCE_MS,
  DomTimestampNormalizer,
  HelperClockSync,
  MAX_CLOCK_SYNC_UNCERTAINTY_MS,
  MIN_CLOCK_SYNC_SAMPLES,
} from "../src/capture/timebase.ts";

describe("helper↔renderer clock synchronization", () => {
  it("recovers a known offset and bounds its own error by half the round trip", () => {
    const sync = new HelperClockSync();
    const trueOffset = 987_654.321;
    // Round trips of 6, 4, 2, 1, 0.5, 3 ms; the helper reads its clock at the
    // midpoint of each, so the recovered offset should be exact and the bound
    // should come from the SHORTEST round trip.
    let t = 1000;
    for (const rtt of [6, 4, 2, 1, 0.5, 3]) {
      const t0 = t;
      const helperMs = t0 + rtt / 2 - trueOffset;
      const t2 = t0 + rtt;
      sync.addSample({ t0, helperMs, t2 });
      t = t2 + 100;
    }
    const est = sync.estimate();
    expect(est).not.toBeNull();
    expect(est!.offsetMs).toBeCloseTo(trueOffset, 6);
    expect(est!.minRoundTripMs).toBeCloseTo(0.5, 6);
    expect(est!.uncertaintyHalfWidthMs).toBeCloseTo(0.25, 6);
    expect(sync.isTrustworthy()).toBe(true);
  });

  it("keeps the estimate inside the proven bound even when the legs are asymmetric", () => {
    const sync = new HelperClockSync();
    const trueOffset = 5000;
    let t = 0;
    for (let i = 0; i < 8; i++) {
      const rtt = 2;
      const t0 = t;
      // Worst case: the whole round trip is spent on the outbound leg, so the
      // helper reads its clock the instant the request arrives.
      const helperMs = t0 + rtt - trueOffset;
      sync.addSample({ t0, helperMs, t2: t0 + rtt });
      t += 50;
    }
    const est = sync.estimate()!;
    expect(Math.abs(est.offsetMs - trueOffset)).toBeLessThanOrEqual(
      est.uncertaintyHalfWidthMs + 1e-9,
    );
  });

  it("offers no estimate until enough exchanges have completed", () => {
    const sync = new HelperClockSync();
    for (let i = 0; i < MIN_CLOCK_SYNC_SAMPLES - 1; i++) {
      sync.addSample({ t0: i * 10, helperMs: i * 10 - 42, t2: i * 10 + 1 });
    }
    expect(sync.estimate()).toBeNull();
    expect(() => sync.toRendererMs(0)).toThrow(/not established/);
    sync.addSample({ t0: 500, helperMs: 458, t2: 501 });
    expect(sync.estimate()).not.toBeNull();
  });

  it("rejects impossible exchanges rather than folding them into the estimate", () => {
    const sync = new HelperClockSync();
    expect(sync.addSample({ t0: 100, helperMs: 5, t2: 90 })).toBe(false);
    expect(sync.addSample({ t0: NaN, helperMs: 5, t2: 100 })).toBe(false);
    expect(sync.sampleCount).toBe(0);
  });

  it("reports drift without silently correcting for it", () => {
    const sync = new HelperClockSync();
    // Helper clock running 100 ppm fast: its reading falls behind renderer
    // time by 100 microseconds every second.
    for (let i = 0; i < 10; i++) {
      const t0 = i * 1000;
      const helperMs = t0 - 1000 - t0 * 100e-6;
      sync.addSample({ t0, helperMs: helperMs + 0.5, t2: t0 + 1 });
    }
    const est = sync.estimate()!;
    expect(est.driftPpm).not.toBeNull();
    expect(est.driftPpm!).toBeGreaterThan(50);
    expect(est.driftPpm!).toBeLessThan(150);
    // The offset is still the plain min-RTT estimate; drift is a diagnostic.
    expect(est.offsetMs).toBeCloseTo(1000 - 0.5 + 0.5, 1);
  });
});

describe("native transport clock domain", () => {
  it("emits nothing until the offset is established, then flushes translated", () => {
    const offsetMs = 777_000.5;
    const helper = createFakeHelper({ offsetMs, roundTripMs: 0.4 });
    helper.connectAndSync();
    expect(helper.source.clockSync.state).toBe("established");
    expect(helper.source.frozenClockOffsetMs).not.toBeNull();
    // Recovered offset is within the bound it proved.
    const est = helper.source.clockSync.estimate!;
    expect(Math.abs(est.offsetMs - offsetMs)).toBeLessThanOrEqual(
      est.uncertaintyHalfWidthMs + 1e-6,
    );

    const helperEventMs = 4242;
    helper.sendFrame(0, helperEventMs);
    expect(helper.events).toHaveLength(1);
    // The emitted timestamp is HELPER time mapped into RENDERER time. Under
    // rc.7 it would have been the raw helper number.
    expect(helper.events[0]!.tMs).toBeCloseTo(helperEventMs + est.offsetMs, 6);
    expect(helper.events[0]!.tMs).not.toBeCloseTo(helperEventMs, 0);
  });

  it("holds frames that arrive before sync completes and never drops them", () => {
    // A helper that only answers after some frames have already streamed.
    const helper = createFakeHelper({ offsetMs: 1000, roundTripMs: 0.2 });
    helper.connectAndSync();
    const est = helper.source.clockSync.estimate!;
    expect(helper.events.length).toBe(0);
    helper.sendFrame(0, 10);
    helper.sendFrame(1, 11);
    expect(helper.events.map((e) => e.tMs)).toEqual([
      10 + est.offsetMs,
      11 + est.offsetMs,
    ]);
  });

  it("fails closed against a helper that cannot answer time-sync", () => {
    const helper = createFakeHelper({ supportsTimeSync: false });
    helper.connectAndSync();
    helper.sendFrame(0, 10);
    // No translation exists, so no event may be emitted.
    expect(helper.events).toHaveLength(0);
    expect(helper.source.clockSync.state).not.toBe("established");
  });

  it("refuses an offset it can only bound loosely", () => {
    // A round trip far wider than the accepted uncertainty.
    const helper = createFakeHelper({
      offsetMs: 500,
      roundTripMs: MAX_CLOCK_SYNC_UNCERTAINTY_MS * 20,
    });
    helper.connectAndSync();
    expect(helper.source.clockSync.state).toBe("untrusted");
    expect(helper.source.status).toBe("failed");
    helper.sendFrame(0, 10);
    expect(helper.events).toHaveLength(0);
  });

  it("preserves monotonic ordering across the whole epoch", () => {
    const helper = createFakeHelper({ offsetMs: -250.25, roundTripMs: 0.3 });
    helper.connectAndSync();
    for (let i = 0; i < 50; i++) helper.sendFrame(i, 100 + i * 1.7);
    const times = helper.events.map((e) => e.tMs);
    expect(times).toHaveLength(50);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]!).toBeGreaterThan(times[i - 1]!);
    }
  });

  it("never lets a re-measured offset move an already-emitted timeline", () => {
    const helper = createFakeHelper({ offsetMs: 42, roundTripMs: 0.3 });
    helper.connectAndSync();
    const frozen = helper.source.frozenClockOffsetMs;
    helper.sendFrame(0, 10);
    // A later, much better exchange must not change the translation.
    helper.source.probeClockSync();
    helper.pump();
    expect(helper.source.frozenClockOffsetMs).toBe(frozen);
    helper.sendFrame(1, 20);
    expect(helper.events[1]!.tMs - helper.events[0]!.tMs).toBeCloseTo(10, 9);
  });

  it("declares the renderer clock domain and a bounded lead once translated", () => {
    const helper = createFakeHelper();
    expect(helper.source.descriptor.timestampDomain).toBe("renderer-monotonic");
    expect(helper.source.descriptor.leadToleranceMs).toBe(
      DOM_CAPTURE_LEAD_TOLERANCE_MS,
    );
  });
});

describe("DOM timestamp normalization", () => {
  it("keeps an occurrence timestamp that merely lags the handler", () => {
    const n = new DomTimestampNormalizer();
    expect(n.normalize(990, 1000)).toBe(990);
    expect(n.stats.behind).toBe(1);
    expect(n.stats.maxLeadMs).toBe(10);
    expect(n.stats.foreignDomain).toBe(0);
  });

  it("falls back to the observation clock for a foreign time domain", () => {
    const n = new DomTimestampNormalizer();
    // A user agent reporting epoch milliseconds instead of time-origin ms.
    expect(n.normalize(1_800_000_000_000, 1000)).toBe(1000);
    expect(n.stats.foreignDomain).toBe(1);
  });

  it("never accepts a timestamp from the future", () => {
    const n = new DomTimestampNormalizer();
    expect(n.normalize(1050, 1000)).toBe(1000);
    expect(n.stats.aheadOfNow).toBe(1);
    // Clock granularity is tolerated rather than counted as an error.
    expect(n.normalize(1000.4, 1000)).toBe(1000.4);
    expect(n.stats.aheadOfNow).toBe(1);
  });

  it("falls back when there is no timestamp at all", () => {
    const n = new DomTimestampNormalizer();
    expect(n.normalize(undefined, 77)).toBe(77);
    expect(n.normalize(Number.NaN, 77)).toBe(77);
    expect(n.stats.missing).toBe(2);
  });
});
