import { describe, expect, it } from "vitest";
import { summarizeCaptureQuality } from "../src/diagnostics/captureQuality.ts";
import type { TrialRecord } from "../src/domain/trial.ts";

function flickTrial(
  id: string,
  indexInSession: number,
  options: {
    rateHz?: number;
    jitter?: boolean;
    lockLoss?: number;
    resizes?: number;
    gapMs?: number;
    phase?: "measured" | "warmup";
    validity?: "valid" | "invalid" | "suspect";
  } = {},
): TrialRecord {
  const rate = options.rateHz ?? 240;
  const dt = 1000 / rate;
  const samples: TrialRecord["samples"] = [];
  let t = 0;
  let x = 640;
  for (let i = 0; i < 40; i++) {
    let step = dt;
    if (options.jitter && i % 3 === 0) step *= 2.2;
    if (options.gapMs && i === 20) step += options.gapMs;
    t += step;
    const dx = 4 + (i % 5);
    samples.push({ tMs: t, cursor: { x: (x += dx), y: 360 }, dx, dy: 0 });
  }
  return {
    id: id as never,
    sessionId: "session-q" as never,
    experimentId: null,
    candidateId: "cand-a" as never,
    indexInSession,
    phase: options.phase ?? "measured",
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
    endedAtMonotonicMs: t,
    samples,
    targets: [
      {
        targetId: "target-1",
        radiusPx: 26,
        appearedMs: 10,
        removedMs: t - 1,
        removalReason: "hit",
        motion: { kind: "static", position: { x: 900, y: 360 } },
      },
    ],
    shots: [
      {
        tMs: t - 2,
        cursorAtShot: { x: 900, y: 360 },
        aimedTargetId: "target-1",
        hit: true,
        missDistancePx: 0,
      },
    ],
    focusInterruptions:
      options.lockLoss && options.lockLoss > 0
        ? [
            {
              startMs: 50,
              endMs: 60,
              reason: "pointer-lock-loss",
            },
          ]
        : [],
    viewportResizes:
      options.resizes && options.resizes > 0
        ? [{ tMs: 80, widthPx: 1280, heightPx: 400 }]
        : [],
    outcome: "hit",
    validity: { status: options.validity ?? "valid", reasons: [] },
    seedTag: null,
    scenarioRepIndex: indexInSession,
    abortedMs: null,
  };
}

describe("session-level capture quality", () => {
  it("clean high-rate native session scores high with no retest required", () => {
    const trials = Array.from({ length: 12 }, (_, i) =>
      flickTrial(`t${i}`, i, { rateHz: 1000 }),
    );
    const q = summarizeCaptureQuality({ trials });
    expect(q.grade).toBe("high");
    expect(q.typicalEventRateHz).toBeGreaterThan(500);
    expect(q.retestingNecessary).toBe(false);
    expect(q.reasonCodes).toHaveLength(0);
    expect(q.score).toBeGreaterThan(0.85);
  });

  it("a single invalidated trial does NOT destroy an otherwise high-quality session", () => {
    const trials = Array.from({ length: 12 }, (_, i) =>
      flickTrial(`t${i}`, i, { rateHz: 1000 }),
    );
    trials[5] = flickTrial("t5-bad", 5, {
      rateHz: 20,
      validity: "invalid",
    });
    const q = summarizeCaptureQuality({ trials });
    // Robust median keeps the grade high; the bad trial shows in the fraction.
    expect(q.grade).toBe("high");
    expect(q.fractionHighQualityTrials).toBeGreaterThanOrEqual(0.75);
    expect(q.fractionHighQualityTrials).toBeLessThan(1);
    expect(q.retestingNecessary).toBe(false);
  });

  it("pervasive low event rates force retest", () => {
    const trials = Array.from({ length: 10 }, (_, i) =>
      flickTrial(`t${i}`, i, { rateHz: 30 }),
    );
    const q = summarizeCaptureQuality({ trials });
    expect(q.reasonCodes).toContain("LOW_EVENT_RATE");
    expect(q.recommendationSuitability).toBe("not-suitable-retest-required");
    expect(q.retestingNecessary).toBe(true);
  });

  it("lock interruptions are penalized proportionally, not catastrophically", () => {
    const clean = Array.from({ length: 12 }, (_, i) =>
      flickTrial(`t${i}`, i, { rateHz: 1000 }),
    );
    const oneLoss = clean.map((t, i) =>
      i === 3 ? flickTrial("t3-lock", 3, { rateHz: 1000, lockLoss: 1 }) : t,
    );
    const manyLoss = clean.map((t, i) =>
      i % 2 === 0 ? flickTrial(`tl${i}`, i, { rateHz: 1000, lockLoss: 1 }) : t,
    );
    const qClean = summarizeCaptureQuality({ trials: clean });
    const qOne = summarizeCaptureQuality({ trials: oneLoss });
    const qMany = summarizeCaptureQuality({ trials: manyLoss });
    expect(qOne.score).toBeLessThan(qClean.score);
    expect(qMany.score).toBeLessThan(qOne.score);
    // But ONE loss among twelve must not flip the verdict to retest...
    expect(qOne.retestingNecessary).toBe(false);
    // ...whereas losses in half the trials must.
    expect(qMany.retestingNecessary).toBe(true);
  });

  it("degradation over the session is detected via robust slope", () => {
    const trials = Array.from({ length: 15 }, (_, i) => {
      const rate = i < 3 ? 1000 : i < 7 ? 240 : 10;
      return flickTrial(`t${i}`, i, { rateHz: rate });
    });
    const q = summarizeCaptureQuality({ trials });
    expect(q.degradationSlopePer100Trials).not.toBeNull();
    expect(q.degradationSlopePer100Trials!).toBeLessThan(-3);
    expect(q.reasonCodes).toContain("QUALITY_DEGRADED_OVER_TIME");
  });

  it("capture source transitions are surfaced and flagged", () => {
    const trials = Array.from({ length: 8 }, (_, i) => flickTrial(`t${i}`, i));
    const sourceByTrial = new Map<string, string>();
    for (const t of trials) {
      sourceByTrial.set(t.id, t.indexInSession < 4 ? "native" : "browser-pointer-lock");
    }
    const q = summarizeCaptureQuality({ trials, captureSourceKindsByTrialId: sourceByTrial });
    expect(q.sourceKind).toBe("mixed");
    expect(q.sourceTransitions).toHaveLength(1);
    expect(q.sourceTransitions[0]).toMatchObject({ from: "native-high-rate", to: "browser-coalesced" });
    expect(q.reasonCodes).toContain("MIXED_CAPTURE_SOURCES");
  });

  it("single-source sessions report their kind without transitions", () => {
    const trials = Array.from({ length: 6 }, (_, i) => flickTrial(`t${i}`, i));
    const sourceByTrial = new Map<string, string>(
      trials.map((t) => [t.id, "browser-pointer-lock"]),
    );
    const q = summarizeCaptureQuality({ trials, captureSourceKindsByTrialId: sourceByTrial });
    expect(q.sourceKind).toBe("browser-coalesced");
    expect(q.sourceTransitions).toHaveLength(0);
  });

  it("too few measured trials blocks suitability regardless of per-trial cleanliness", () => {
    const trials = [flickTrial("only", 0)];
    const q = summarizeCaptureQuality({ trials });
    expect(q.reasonCodes).toContain("INSUFFICIENT_MEASURED_TRIALS");
    expect(q.recommendationSuitability).toBe("not-suitable-retest-required");
  });

  it("drop indications raise HIGH_DROP_RATE when widespread", () => {
    const trials = Array.from({ length: 10 }, (_, i) =>
      flickTrial(`t${i}`, i, { rateHz: 1000, gapMs: 150 }),
    );
    const q = summarizeCaptureQuality({ trials });
    expect(q.dropRateFraction).toBeGreaterThan(0.2);
    expect(q.reasonCodes).toContain("HIGH_DROP_RATE");
  });
});
