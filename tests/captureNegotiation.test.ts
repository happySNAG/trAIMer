import { describe, expect, it } from "vitest";
import {
  CaptureSourceNegotiator,
  NATIVE_DISCONNECT_REASON,
  type NegotiationCandidate,
} from "../src/capture/negotiation.ts";
import type { CaptureEvent, CaptureSource } from "../src/capture/events.ts";

function fakeSource(kind: "native" | "browser-pointer-lock" | "synthetic"): CaptureSource {
  return {
    descriptor: {
      kind,
      description: kind,
      nominalSampleIntervalMs: null,
    },
    start(): void {},
    stop(): void {},
  };
}

function candidate(
  tier: 1 | 2 | 3,
  kind: "native" | "browser-pointer-lock" | "synthetic",
  opts: { available?: boolean; validated?: boolean } = {},
): NegotiationCandidate {
  return {
    tier,
    metadata: {
      kind,
      description: `${kind} tier ${tier}`,
      validatedNative: opts.validated ?? kind !== "native",
      nominalRateHz: kind === "native" ? 1000 : null,
    },
    create: () => fakeSource(kind),
    isAvailable: async () => opts.available ?? true,
  };
}

describe("capture-source negotiation", () => {
  it("prefers validated native over coalesced browser over basic mouse", async () => {
    const negotiator = new CaptureSourceNegotiator(() => "2026-01-01T00:00:00Z");
    const outcome = await negotiator.negotiate([
      candidate(2, "browser-pointer-lock"),
      candidate(1, "native", { validated: true }),
      candidate(3, "synthetic"),
    ]);
    expect(outcome.active.metadata.kind).toBe("native");
    expect(outcome.active.tier).toBe(1);
    expect(outcome.active.metadata.validatedNative).toBe(true);
    // Lower tiers were never needed, so nothing was rejected.
    expect(outcome.rejected).toEqual([]);
  });

  it("NEVER silently downgrades: unvalidated native is rejected with a reason", async () => {
    const negotiator = new CaptureSourceNegotiator(() => "2026-01-01T00:00:00Z");
    const outcome = await negotiator.negotiate([
      candidate(1, "native", { validated: false }),
      candidate(2, "browser-pointer-lock"),
    ]);
    expect(outcome.active.tier).toBe(2);
    expect(outcome.active.metadata.kind).toBe("browser-pointer-lock");
    const nativeRejection = outcome.rejected.find((r) => r.tier === 1)!;
    expect(nativeRejection.reason).toMatch(/not validated/);
  });

  it("falls through unavailable tiers in order", async () => {
    const negotiator = new CaptureSourceNegotiator(() => "2026-01-01T00:00:00Z");
    const outcome = await negotiator.negotiate([
      candidate(1, "native", { available: false }),
      candidate(2, "browser-pointer-lock", { available: false }),
      candidate(3, "synthetic"),
    ]);
    expect(outcome.active.tier).toBe(3);
  });

  it("throws when nothing is available instead of inventing a source", async () => {
    const negotiator = new CaptureSourceNegotiator(() => "2026-01-01T00:00:00Z");
    await expect(
      negotiator.negotiate([
        candidate(1, "native", { available: false }),
        candidate(2, "browser-pointer-lock", { available: false }),
        candidate(3, "synthetic", { available: false }),
      ]),
    ).rejects.toThrow(/no capture source could be negotiated/);
  });

  it("records transitions when activated and on explicit fallback", () => {
    const negotiator = new CaptureSourceNegotiator(
      () => "2026-02-02T10:00:00Z",
    );
    negotiator.activate(
      { source: fakeSource("native"), metadata: candidate(1, "native").metadata as never, tier: 1 },
      "initial selection",
    );
    negotiator.fallbackTo(
      {
        source: fakeSource("browser-pointer-lock"),
        metadata: candidate(2, "browser-pointer-lock").metadata as never,
        tier: 2,
      },
      "helper crashed",
    );
    const t = negotiator.transitions;
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ reason: "initial selection", from: null });
    expect(t[1]).toMatchObject({
      reason: "explicit fallback between trials: helper crashed",
      invalidatedTrialIds: [],
    });
    expect(negotiator.currentMetadata()?.kind).toBe("browser-pointer-lock");
  });

  it("mid-trial disconnect invalidates the affected trial explicitly", () => {
    const negotiator = new CaptureSourceNegotiator(
      () => "2026-03-03T00:00:00Z",
    );
    negotiator.activate(
      { source: fakeSource("native"), metadata: candidate(1, "native").metadata as never, tier: 1 },
      "start",
    );
    const events: CaptureEvent[] =
      negotiator.handleNativeDisconnectDuringTrial("trial-9", 4321);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "focus-change",
      focused: false,
      reason: NATIVE_DISCONNECT_REASON,
      tMs: 4321,
    });
    // The transition records WHICH trial was invalidated.
    const last = negotiator.transitions.at(-1)!;
    expect(last.invalidatedTrialIds).toEqual(["trial-9"]);
    expect(last.reason).toBe(NATIVE_DISCONNECT_REASON);
  });

  it("refuses mid-trial source mixing without invalidation", () => {
    const negotiator = new CaptureSourceNegotiator(() => "2026-04-04T00:00:00Z");
    const nativeMeta = {
      ...candidate(1, "native").metadata,
      sourceId: "src-native-A",
    } as never;
    const synthMeta = {
      ...candidate(3, "synthetic").metadata,
      sourceId: "src-synth-B",
    } as never;
    negotiator.activate(
      { source: fakeSource("native"), metadata: nativeMeta, tier: 1 },
      "start",
    );
    const startedUnder = negotiator.currentMetadata();
    negotiator.fallbackTo(
      { source: fakeSource("synthetic"), metadata: synthMeta, tier: 3 },
      "test",
    );
    expect(() => negotiator.assertNoMidTrialMixing(startedUnder)).toThrow(
      /without explicit invalidation/,
    );
  });
});
