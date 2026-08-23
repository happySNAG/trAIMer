/**
 * Performance benchmark: 1000 Hz raw event ingestion, trial recording,
 * validation, replay and optimizer runtime (Pass 4, requirement W).
 *
 * Usage: npm run bench
 */
import { performance } from "node:perf_hooks";
import { TrialRecorder } from "../src/capture/recorder.ts";
import { validateTrial, DEFAULT_VALIDATION_CONFIG } from "../src/validation/validateTrial.ts";
import { computeInputQuality } from "../src/diagnostics/inputQuality.ts";
import { summarizeCaptureQuality } from "../src/diagnostics/captureQuality.ts";
import { SensitivityOptimizer } from "../src/optimizer/optimizer.ts";
import { buildExperimentDefinition } from "../src/experiments/protocol.ts";
import type { CaptureEvent, TrialRecord } from "../src/index.ts";

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

function ingest1000Hz(durationMs = 5000): {
  events: number;
  recorderMs: number;
  record: TrialRecord;
} {
  const request = {
    id: "trial-bench" as const,
    sessionId: null,
    experimentId: null,
    candidateId: null,
    indexInSession: 0,
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
    radiusPx: 26,
    motion: { kind: "static", position: { x: 700, y: 360 } },
  });
  // Pre-build the event stream the way a native helper would deliver it.
  const stream: CaptureEvent[] = [];
  for (let t = 10; t < durationMs; t += 1) {
    const dx = Math.sin(t / 40) * 3 + (t % 17 === 0 ? 6 : 0);
    stream.push({ kind: "pointer-sample", tMs: t, dx, dy: 0 });
    if (t % 400 === 0) {
      stream.push({ kind: "button", tMs: t, action: "press" });
    }
  }
  const start = performance.now();
  for (const ev of stream) recorder.add(ev);
  const recorderMs = performance.now() - start;
  return {
    events: stream.length,
    recorderMs,
    record: recorder.finish("hit", durationMs),
  };
}

function main(): void {
  console.log("== Aldo Aim Lab performance benchmark ==\n");

  // 1. Raw ingestion at 1000 Hz.
  const ing = ingest1000Hz(5000);
  console.log(
    `[ingest]   ${fmt(ing.events)} events @1000Hz in ${ing.recorderMs.toFixed(2)} ms → ${fmt(ing.events / Math.max(ing.recorderMs / 1000, 1e-9) / 1000)}M events/s headroom`,
  );

  // 2. Validation.
  const vStart = performance.now();
  const validity = validateTrial(ing.record, DEFAULT_VALIDATION_CONFIG, {});
  const vMs = performance.now() - vStart;
  console.log(
    `[validate] ${fmt(ing.events)} samples validated in ${vMs.toFixed(2)} ms (status=${validity.status})`,
  );

  // 3. Input quality per trial.
  const qStart = performance.now();
  computeInputQuality(ing.record);
  const qMs = performance.now() - qStart;
  console.log(`[quality]  input-quality computed in ${qMs.toFixed(2)} ms`);

  // 4. Session quality over 120 trials.
  const trials: TrialRecord[] = Array.from({ length: 120 }, (_, i) => ({
    ...ing.record,
    id: `trial-${i}` as never,
    indexInSession: i,
  }));
  const sqStart = performance.now();
  const sessionQ = summarizeCaptureQuality({ trials });
  const sqMs = performance.now() - sqStart;
  void sessionQ;
  console.log(`[session]  capture-quality over 120 trials in ${sqMs.toFixed(1)} ms`);

  // 5. Optimizer on a realistic candidate set.
  const definition = buildExperimentDefinition({
    id: "experiment-bench" as never,
    name: "bench",
    baselineSensitivity: { sensX: 7, sensY: 7 },
    dpi: 800,
    randomizeOrder: false,
    orderSeed: 1,
    measuredRepsPerCandidatePerRound: 8,
    adaptiveAllocation: { enabled: false },
    stoppingCriteria: { maxSearchRounds: 2 },
  });
  const optimizer = new SensitivityOptimizer(definition);
  let seq = 0;
  for (const candidate of definition.candidates) {
    for (let rep = 0; rep < 16; rep++) {
      optimizer.addTrials([
        {
          ...ing.record,
          id: `trial-b${seq++}` as never,
          candidateId: candidate.id,
          scenarioRepIndex: rep % 5,
        } as TrialRecord,
      ]);
    }
  }
  const oStart = performance.now();
  const rec = optimizer.recommend();
  const oMs = performance.now() - oStart;
  console.log(
    `[optimize] ${definition.candidates.length} candidates × 16 trials analyzed+recommended in ${oMs.toFixed(1)} ms (edpi ${rec.recommendedEdpi.toFixed(0)})`,
  );
  console.log("\nAll hot-path timings above are wall-clock single runs;");
  console.log("they should stay far below interactive thresholds (frames at 16.7 ms).");
}

main();
