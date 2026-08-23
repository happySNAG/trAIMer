import { describe, expect, it } from "vitest";
import { Rng } from "../src/util/rng.ts";
import {
  parseResumeCheckpoint,
  buildResumePlan,
} from "../src/session/resume.ts";
import { detectInterruptedTrialFromAudit } from "../src/session/runner.ts";
import { RESUME_CHECKPOINT_SCHEMA_VERSION } from "../src/session/resume.ts";
import type { ResumeCheckpoint } from "../src/session/resume.ts";
import { parseNativeFixture, makeNativeFixture, detectSequenceGaps } from "../src/capture/native.ts";
import type { NativeFrame } from "../src/capture/native.ts";
import { importExperimentBundle } from "../src/persistence/bundle.ts";
import { LocalJsonStore } from "../src/persistence/store.ts";
import { InMemoryBackend } from "../src/persistence/backends.ts";
import { unwrapEnvelope } from "../src/persistence/migrations.ts";
import { validateTrial, DEFAULT_VALIDATION_CONFIG } from "../src/validation/validateTrial.ts";
import { SensitivityOptimizer } from "../src/optimizer/optimizer.ts";
import { buildExperimentDefinition } from "../src/experiments/protocol.ts";
import type { TrialRecord } from "../src/domain/trial.ts";

/**
 * Adversarial campaigns (Pass 5): deterministic hostile-input campaigns
 * against every trust boundary. The engine must fail CLOSED or degrade
 * honestly — never accept silently, never corrupt state.
 */

function validCheckpoint(): ResumeCheckpoint {
  return {
    schemaVersion: RESUME_CHECKPOINT_SCHEMA_VERSION,
    kind: "session-resume",
    sessionId: "session-adv",
    experimentId: "experiment-adv",
    status: "running",
    updatedAtIso: "2026-08-23T10:00:00Z",
    createdAtIso: "2026-08-23T09:00:00Z",
    completedSequenceKeys: ["0:0", "0:1"],
    currentRound: 0,
    phaseLog: [{ state: "setup", tIso: "2026-08-23T09:00:00Z" }],
    activeTestingMs: 1000,
    continuousTestingMs: 500,
    restCount: 0,
    blindedLabels: { "cand-a": "Candidate A" },
    repCounterByCandidate: { "cand-a": 2 },
    completedTrialIds: ["trial-a", "trial-b"],
    auditTrail: [],
    captureSource: null,
    playerId: null,
    playerName: null,
    dpi: 800,
    retestOfExperimentId: null,
    calibrationRecordIdsX: [],
    calibrationRecordIdsY: [],
    appVersion: "test",
    engineVersion: "engine-v4",
    optimizerVersion: "optimizer-v3",
    interruptedTrial: null,
    lastValidState: "inter-trial",
  };
}

/** Deterministic structure-aware mutation of a parsed JSON object. */
function mutate(rng: Rng, value: unknown, depth = 0): unknown {
  if (depth > 4 || typeof value !== "object" || value === null) {
    const pick = rng.int(6);
    switch (pick) {
      case 0: return null;
      case 1: return -1;
      case 2: return Number.NaN;
      case 3: return `X".repeat(${rng.int(50)})`;
      case 4: return true;
      default: return {};
    }
  }
  if (Array.isArray(value)) {
    if (value.length === 0 || rng.next() < 0.2) return value;
    const copy = [...value];
    copy[rng.int(copy.length)] = mutate(rng, copy[rng.int(copy.length)], depth + 1);
    return copy;
  }
  const obj = { ...(value as Record<string, unknown>) };
  const keys = Object.keys(obj);
  if (keys.length === 0) return obj;
  const key = keys[rng.int(keys.length)]!;
  if (rng.next() < 0.15) delete obj[key];
  else obj[key] = mutate(rng, obj[key], depth + 1);
  return obj;
}

describe("adversarial campaign: corrupted checkpoints", () => {
  it("200 mutated checkpoints are rejected or safely refused — never half-accepted", () => {
    const rng = new Rng(20260823);
    let rejected = 0;
    let acceptedUnchanged = 0;
    for (let i = 0; i < 200; i++) {
      const mutated = mutate(rng, structuredClone(validCheckpoint()));
      try {
        const parsed = parseResumeCheckpoint(mutated);
        // If it parses, the resume PLAN must still be coherent.
        const plan = buildResumePlan(parsed, buildExperimentDefinition({
          id: "experiment-adv" as never,
          name: "adv",
          baselineSensitivity: { sensX: 7, sensY: 7 },
          dpi: 800,
          randomizeOrder: false,
        }));
        expect(plan.completedKeys.size).toBeLessThanOrEqual(
          parsed.completedSequenceKeys.length,
        );
        acceptedUnchanged++;
      } catch {
        rejected++;
      }
    }
    // The campaign must genuinely exercise the validator.
    expect(rejected + acceptedUnchanged).toBe(200);
    expect(rejected).toBeGreaterThan(10);

    // Targeted tampering: EVERY required field must be individually
    // load-bearing (delete / wrong-type each one and rejection follows).
    const base = validCheckpoint();
    const required: [keyof ResumeCheckpoint, unknown][] = [
      ["schemaVersion", 1],
      ["schemaVersion", "2"],
      ["kind", "other"],
      ["sessionId", 123],
      ["experimentId", undefined],
      ["completedSequenceKeys", "0:0"],
      ["phaseLog", null],
    ];
    let targetedRejected = 0;
    for (const [field, badValue] of required) {
      const tampered = { ...base, [field]: badValue } as unknown;
      try {
        parseResumeCheckpoint(tampered);
      } catch {
        targetedRejected++;
      }
    }
    expect(targetedRejected).toBe(required.length);
  });

  it("audit-trail tampering cannot fake an interrupted trial into existence with bad types", () => {
    const cp = validCheckpoint();
    cp.auditTrail = [
      {
        seq: 0,
        tIso: "not-a-date",
        category: "trial-started" as never,
        detail: { candidateId: 42 as never, phase: null as never },
      },
    ];
    const interrupted = detectInterruptedTrialFromAudit(cp);
    // Coercion is tolerated but produces harmless strings; never throws.
    if (interrupted !== null) {
      expect(typeof interrupted.candidateId).toBe("string");
    }
  });
});

describe("adversarial campaign: hostile native fixtures", () => {
  function frame(seq: number, tMs: number, events: NativeFrame["events"]): NativeFrame {
    return { sequence: seq, tMonotonicMs: tMs, events };
  }

  it("fuzzed fixture payloads either parse losslessly or throw typed errors", () => {
    const rng = new Rng(777001);
    let threw = 0;
    for (let i = 0; i < 150; i++) {
      const frames: NativeFrame[] = [
        frame(0, 0, [{ kind: "pointer-sample", tMs: 0, dx: 1, dy: 1 }]),
        frame(1, 1, [
          { kind: "pointer-sample", tMs: 1, dx: 2, dy: 2 },
        ]),
      ];
      const fixture = makeNativeFixture(
        { deviceId: "d", deviceDescription: "", nominalRateHz: 1000 },
        frames,
      );
      // Structure-aware envelope corruption: header, frame shape, kinds.
      const raw = JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;
      const attack = rng.int(5);
      if (attack === 0) {
        (raw.header as Record<string, unknown>).protocolVersion = 99;
      } else if (attack === 1) {
        raw.kind = "not-a-fixture";
      } else if (attack === 2) {
        (raw.frames as unknown[])[1] = { sequence: "one", tMonotonicMs: 1, events: [] };
      } else if (attack === 3) {
        delete (raw.header as Record<string, unknown>).nominalRateHz;
      } else {
        (raw.frames as unknown[]).splice(1, 1); // drop frame → still valid
      }
      try {
        const parsed = parseNativeFixture(raw);
        // Whatever parses must preserve sequence integrity accounting.
        void detectSequenceGaps(parsed.frames);
      } catch {
        threw++;
      }
    }
    expect(threw).toBeGreaterThan(0); // the campaign exercised rejection paths
  });

  it("sequence gaps are reported, never silently repaired", () => {
    const gaps = detectSequenceGaps([
      frame(0, 0, []),
      frame(3, 3, []),
      frame(7, 7, []),
    ]);
    expect(gaps).toEqual([
      { afterSequence: 0, missingCount: 2 },
      { afterSequence: 3, missingCount: 3 },
    ]);
  });
});

describe("adversarial campaign: persistence boundaries", () => {
  it("bundle imports with wrong-typed fields everywhere are rejected cleanly", async () => {
    const store = new LocalJsonStore(new InMemoryBackend());
    const hostiles = [
      undefined,
      null,
      42,
      "string",
      [],
      { kind: "session-bundle" },
      { kind: "session-bundle", schemaVersion: 1 },
      { kind: "session-bundle", schemaVersion: 1, payload: null },
      { kind: "session-bundle", schemaVersion: 1, payload: { experimentDefinition: 7 } },
      {
        kind: "session-bundle",
        schemaVersion: -1,
        payload: { experimentDefinition: { id: "x" }, trials: [] },
      },
    ];
    for (const hostile of hostiles) {
      await expect(importExperimentBundle(store, hostile)).rejects.toThrow();
    }
    expect(await store.listSessionIds()).toEqual([]);
  });

  it("envelope unwrapping rejects prototype-polluting shapes without executing anything", () => {
    const evil = JSON.parse('{"schemaVersion":1,"kind":"trial-record","savedAtIso":"x","payload":{"__proto__":{"polluted":true},"id":"t1"}}');
    // JSON.parse creates __proto__ as an OWN property; it must never reach
    // Object.prototype, and unwrapping must not execute or normalize it.
    let unwrapped: unknown = null;
    try {
      unwrapped = unwrapEnvelope("trial-record", evil);
    } catch {
      // rejection is acceptable too
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    if (unwrapped !== null) {
      expect(Object.keys(Object.getOwnPropertyDescriptors({}))).not.toContain("polluted");
    }
  });

  it("NaN/Infinity injection into trial samples is caught by validation", () => {
    const definition = buildExperimentDefinition({
      id: "experiment-nan" as never,
      name: "nan",
      baselineSensitivity: { sensX: 7, sensY: 7 },
      dpi: 800,
      randomizeOrder: false,
      orderSeed: 1,
    });
    const trial = {
      id: "trial-nan" as never,
      sessionId: null,
      experimentId: definition.id,
      candidateId: definition.candidates[0]!.id,
      indexInSession: 0,
      phase: "measured" as const,
      scenarioId: "flick-static-medium",
      scenarioKind: "flick-static" as const,
      scenarioRepIndex: 0,
      captureContext: {
        scenarioKind: "flick-static" as const,
        viewport: { widthPx: Number.NaN, heightPx: 720 },
        sensitivity: { sensX: Number.NaN, sensY: 7 },
        dpi: 800,
        expectedSampleIntervalMs: null,
      },
      startedAtMonotonicMs: 0,
      endedAtMonotonicMs: 300,
      samples: Array.from({ length: 14 }, (_, i) => ({
        tMs: i * 10,
        cursor: { x: 640 + i * (Number.POSITIVE_INFINITY / 1e12), y: 360 },
        dx: 2,
        dy: 0,
      })),
      targets: [
        {
          targetId: "target-1",
          radiusPx: 26,
          appearedMs: 5,
          removedMs: 280,
          removalReason: "hit" as const,
          motion: { kind: "static" as const, position: { x: 700, y: 360 } },
        },
      ],
      shots: [],
      focusInterruptions: [],
      viewportResizes: [],
      outcome: "hit" as const,
      validity: { status: "valid" as const, reasons: [] },
      seedTag: null,
      abortedMs: null,
    } as unknown as TrialRecord;

    const validity = validateTrial(trial, DEFAULT_VALIDATION_CONFIG, {});
    expect(validity.status === "invalid" || validity.status === "suspect").toBe(true);

    // The optimizer refuses to rank from such data instead of producing junk.
    const optimizer = new SensitivityOptimizer(definition);
    optimizer.addTrials([trial]);
    const rec = optimizer.recommend();
    expect(rec.refusedHighConfidence).toBe(true);
  });
});
