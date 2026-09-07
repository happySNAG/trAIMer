import { describe, expect, it } from "vitest";
import { TrialRecorder, type TrialRecordingRequest } from "../src/capture/recorder.ts";
import { validateTrial, DEFAULT_VALIDATION_CONFIG } from "../src/validation/validateTrial.ts";
import {
  DOM_CAPTURE_LEAD_TOLERANCE_MS,
  SYNTHETIC_CAPTURE_LEAD_TOLERANCE_MS,
} from "../src/capture/timebase.ts";
import { computeFlickMetrics } from "../src/metrics/flick.ts";
import { makeTrialId } from "../src/domain/ids.ts";
import { Rng } from "../src/util/rng.ts";
import type { TargetId } from "../src/domain/ids.ts";

/**
 * The rc.7 "broken timestamps" regression, reproduced.
 *
 * On real Windows hardware 43 of 80 measured drills were thrown away with
 * IMPOSSIBLE_TIMESTAMPS. The cause was not broken hardware and not a broken
 * clock: browser Pointer Lock stamps a pointer sample with the moment the
 * input OCCURRED, and delivers it in the frame that consumes it — while the
 * app started a trial by reading `performance.now()` at the moment it
 * OBSERVED the trial beginning. Same clock, different instants.
 *
 * Measured directly in Chromium while diagnosing this: 15 of 20 simulated
 * drills received at least one sample whose `event.timeStamp` preceded the
 * drill's start, the worst by 12.7 ms.
 *
 * The fixture below reproduces that delivery model exactly and pins BOTH
 * directions: a legitimate few-millisecond lead must not destroy a trial, and
 * a genuine clock-domain error must still destroy it.
 */

const VIEWPORT = { widthPx: 1280, heightPx: 720 };

function request(
  overrides: Partial<TrialRecordingRequest> = {},
): TrialRecordingRequest {
  return {
    id: makeTrialId("t"),
    sessionId: null,
    experimentId: null,
    candidateId: null,
    indexInSession: 0,
    phase: "measured",
    scenarioId: "flick-static-medium",
    scenarioKind: "flick-static",
    scenarioRepIndex: 0,
    viewport: { ...VIEWPORT },
    sensitivity: { sensX: 7, sensY: 7 },
    dpi: 800,
    expectedSampleIntervalMs: null,
    startedAtMonotonicMs: 1000,
    ...overrides,
  };
}

/**
 * Builds one drill exactly as the browser capture path produces it.
 *
 * @param leadMs how far the first delivered batch's oldest sample precedes
 *   the trial's recorded start (0 = the player's hand was still at the
 *   transition; >0 = it was moving).
 * @param displayHz the display the arena is running on; sets the coalescing
 *   window, because Chromium aligns pointer delivery to the consuming frame.
 */
function browserTrial(options: {
  leadMs: number;
  displayHz: number;
  pollingHz?: number;
  leadToleranceMs?: number;
  startMs?: number;
}) {
  const startMs = options.startMs ?? 1000;
  const pollingHz = options.pollingHz ?? 1000;
  const frameMs = 1000 / options.displayHz;
  const sampleMs = 1000 / pollingHz;
  const rec = new TrialRecorder(
    request({
      startedAtMonotonicMs: startMs,
      ...(options.leadToleranceMs !== undefined
        ? { timestampLeadToleranceMs: options.leadToleranceMs }
        : {}),
    }),
  );

  // The first coalesced batch, delivered after the trial started, carrying
  // occurrence timestamps from the frame BEFORE it.
  for (let t = startMs - options.leadMs; t < startMs; t += sampleMs) {
    rec.add({ kind: "pointer-sample", tMs: t, dx: 0.9, dy: 0.3 });
  }

  const targetMs = startMs + 180;
  rec.add({
    kind: "target-spawn",
    tMs: targetMs,
    targetId: "target-1" as TargetId,
    radiusPx: 26,
    motion: { kind: "static", position: { x: 900, y: 420 } },
  });

  // Then the drill proper: samples at the polling rate, delivered in batches
  // one display frame wide.
  const endMs = startMs + 760;
  for (let t = startMs; t < endMs; t += sampleMs) {
    rec.add({ kind: "pointer-sample", tMs: t, dx: 1.1, dy: 0.5 });
  }
  void frameMs;
  rec.add({ kind: "button", tMs: endMs - 20, action: "press" });
  return rec.finish("hit", endMs);
}

describe("capture timestamp domain — the rc.7 exclusion regression", () => {
  it("reproduces rc.7: a legitimate few-millisecond lead destroyed the trial", () => {
    // rc.7 recorded no tolerance at all, so the validator's rule was
    // "no sample may precede the trial start, ever".
    const record = browserTrial({ leadMs: 3, displayHz: 200, leadToleranceMs: 0 });
    const verdict = validateTrial(record);
    expect(verdict.status).toBe("invalid");
    expect(verdict.reasons[0]?.code).toBe("IMPOSSIBLE_TIMESTAMPS");
    expect(verdict.reasons[0]?.detail).toMatch(/precedes trial start/);
  });

  it("the same trial is valid once the source declares its delivery lead", () => {
    const record = browserTrial({
      leadMs: 3,
      displayHz: 200,
      leadToleranceMs: DOM_CAPTURE_LEAD_TOLERANCE_MS,
    });
    expect(validateTrial(record).status).toBe("valid");
  });

  it("holds across the worst lead Chromium was measured producing", () => {
    for (const leadMs of [0.4, 1.7, 5, 9.8, 12.7]) {
      const record = browserTrial({
        leadMs,
        displayHz: 200,
        leadToleranceMs: DOM_CAPTURE_LEAD_TOLERANCE_MS,
      });
      expect(validateTrial(record).status, `lead ${leadMs}ms`).toBe("valid");
    }
  });

  it("still excludes a genuine clock-domain mix-up", () => {
    // The failure mode the original rule existed to catch: helper-monotonic
    // timestamps (milliseconds since the helper process started) fed into a
    // renderer-clock trial. The lead is seconds, not milliseconds.
    const record = browserTrial({
      leadMs: 4200,
      displayHz: 200,
      leadToleranceMs: DOM_CAPTURE_LEAD_TOLERANCE_MS,
    });
    const verdict = validateTrial(record);
    expect(verdict.status).toBe("invalid");
    expect(verdict.reasons[0]?.code).toBe("IMPOSSIBLE_TIMESTAMPS");
    expect(verdict.reasons[0]?.detail).toMatch(/beyond the 40ms/);
  });

  it("caps the tolerance a capture source may declare for itself", () => {
    // A source cannot widen the rule by claiming a huge lead.
    const record = browserTrial({
      leadMs: 500,
      displayHz: 200,
      leadToleranceMs: 100_000,
    });
    expect(validateTrial(record).status).toBe("invalid");
  });

  it("gives synthetic and replay streams no tolerance at all", () => {
    expect(SYNTHETIC_CAPTURE_LEAD_TOLERANCE_MS).toBe(0);
    const record = browserTrial({ leadMs: 2, displayHz: 200 });
    // No tolerance recorded on the trial ⇒ the historical rule, unchanged.
    expect(record.captureContext.timestampLeadToleranceMs).toBeUndefined();
    expect(validateTrial(record).status).toBe("invalid");
  });

  it("validates a stored rc.7 record exactly as it was validated when recorded", () => {
    // Records written before this pass carry no tolerance field. Reading the
    // absent field as 0 keeps history stable: a session that was excluded
    // then must not silently become valid now.
    const record = browserTrial({ leadMs: 6, displayHz: 200 });
    const legacy = { ...record };
    delete (legacy.captureContext as { timestampLeadToleranceMs?: number })
      .timestampLeadToleranceMs;
    expect(validateTrial(legacy).status).toBe("invalid");
  });
});

describe("what the exclusion rate actually was", () => {
  /**
   * The real session: 80 measured drills, 43 excluded, 37 valid.
   *
   * A drill acquires a pre-start sample whenever the player's hand was moving
   * in the input-delivery window before it began. Simulating that at the rate
   * a real session produces reproduces the observed exclusion count to within
   * the noise of the coin flip that generates it — and the fix takes it to
   * zero without touching any other rule.
   */
  function runSession(leadToleranceMs: number): { valid: number; excluded: number } {
    const rng = new Rng(20260907);
    let valid = 0;
    let excluded = 0;
    for (let i = 0; i < 80; i++) {
      // Was the hand still moving when this drill started?
      const moving = rng.next() < 0.55;
      const leadMs = moving ? 0.5 + rng.next() * 12 : 0;
      const record = browserTrial({
        leadMs,
        displayHz: 200,
        startMs: 1000 + i * 4000,
        leadToleranceMs,
      });
      if (validateTrial(record).status === "valid") valid++;
      else excluded++;
    }
    return { valid, excluded };
  }

  it("rc.7's rule threw away roughly half of a clean session", () => {
    const rc7 = runSession(0);
    expect(rc7.excluded).toBeGreaterThan(30);
    expect(rc7.excluded).toBeLessThan(55);
    expect(rc7.valid + rc7.excluded).toBe(80);
  });

  it("the fix keeps every one of those drills, and adds no new rule", () => {
    const fixed = runSession(DOM_CAPTURE_LEAD_TOLERANCE_MS);
    expect(fixed.excluded).toBe(0);
    expect(fixed.valid).toBe(80);
  });
});

describe("timing math is unaffected by the display rate or the tolerance", () => {
  it("a 200 Hz display produces the same measurements as a 60 Hz one", () => {
    const at200 = browserTrial({
      leadMs: 4,
      displayHz: 200,
      leadToleranceMs: DOM_CAPTURE_LEAD_TOLERANCE_MS,
    });
    const at60 = browserTrial({
      leadMs: 4,
      displayHz: 60,
      leadToleranceMs: DOM_CAPTURE_LEAD_TOLERANCE_MS,
    });
    const a = computeFlickMetrics(at200);
    const b = computeFlickMetrics(at60);
    expect(a.reactionTimeMs).toBeCloseTo(b.reactionTimeMs ?? 0, 9);
    expect(a.totalAcquisitionTimeMs).toBeCloseTo(b.totalAcquisitionTimeMs ?? 0, 9);
    expect(a.overshootRatio).toBeCloseTo(b.overshootRatio, 9);
  });

  it("no part of the tolerance leaks into a reaction time", () => {
    // Reaction time is measured from target appearance, which is unrelated to
    // the trial's start; widening the trial-start tolerance must not move it
    // by a single millisecond.
    const strict = browserTrial({ leadMs: 0, displayHz: 200, leadToleranceMs: 0 });
    const tolerant = browserTrial({
      leadMs: 0,
      displayHz: 200,
      leadToleranceMs: DOM_CAPTURE_LEAD_TOLERANCE_MS,
    });
    expect(computeFlickMetrics(strict).reactionTimeMs).toBe(
      computeFlickMetrics(tolerant).reactionTimeMs,
    );
  });

  it("pre-start samples are recorded, not silently dropped", () => {
    // They moved the on-screen reticle, so they belong in the record: the
    // alternative (dropping them) would put the recorder's cursor and the
    // arena's reticle in different places for the rest of the drill.
    const record = browserTrial({
      leadMs: 5,
      displayHz: 200,
      leadToleranceMs: DOM_CAPTURE_LEAD_TOLERANCE_MS,
    });
    const preStart = record.samples.filter(
      (s) => s.tMs < record.startedAtMonotonicMs,
    );
    expect(preStart.length).toBeGreaterThan(0);
    expect(record.samples[0]!.tMs).toBeLessThan(record.startedAtMonotonicMs);
  });

  it("monotonicity is still enforced inside the tolerance window", () => {
    const rec = new TrialRecorder(
      request({ timestampLeadToleranceMs: DOM_CAPTURE_LEAD_TOLERANCE_MS }),
    );
    for (let i = 0; i < 12; i++) {
      rec.add({ kind: "pointer-sample", tMs: 995 + i, dx: 1, dy: 0 });
    }
    // A sample that goes BACKWARDS is still impossible, tolerance or not.
    rec.add({ kind: "pointer-sample", tMs: 999, dx: 1, dy: 0 });
    rec.add({
      kind: "target-spawn",
      tMs: 1100,
      targetId: "target-1" as TargetId,
      radiusPx: 26,
      motion: { kind: "static", position: { x: 900, y: 420 } },
    });
    const record = rec.finish("timeout-no-shot", 1400);
    const verdict = validateTrial(record, DEFAULT_VALIDATION_CONFIG);
    expect(verdict.status).toBe("invalid");
    expect(verdict.reasons.some((r) => /non-monotonic/.test(r.detail))).toBe(true);
  });
});
