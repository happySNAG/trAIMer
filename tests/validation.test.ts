import { describe, expect, it } from "vitest";
import {
  DEFAULT_VALIDATION_CONFIG,
  validateTrial,
} from "../src/validation/validateTrial.ts";
import { makeTrial } from "./helpers.ts";
import type { InvalidReasonCode } from "../src/domain/validity.ts";

function codesOf(record: ReturnType<typeof makeTrial>): InvalidReasonCode[] {
  return validateTrial(record).reasons.map((r) => r.code);
}

describe("trial validation", () => {
  it("accepts a well-formed trial", () => {
    const record = makeTrial({
      samples: Array.from({ length: 30 }, (_, i) => ({
        tMs: i * 8,
        cursor: { x: 640 + i, y: 360 },
      })),
      targets: [
        {
          targetId: "target-v",
          radiusPx: 26,
          appearedMs: 10,
          removedMs: null,
          removalReason: null,
          motion: { kind: "static", position: { x: 800, y: 360 } },
        },
      ],
    });
    const validity = validateTrial(record);
    expect(validity.status).toBe("valid");
    expect(validity.reasons).toHaveLength(0);
  });

  it("flags insufficient samples", () => {
    const record = makeTrial({
      samples: [{ tMs: 0, cursor: { x: 640, y: 360 } }],
      targets: [
        {
          targetId: "target-v2",
          radiusPx: 26,
          appearedMs: 10,
          removedMs: null,
          removalReason: null,
          motion: { kind: "static", position: { x: 800, y: 360 } },
        },
      ],
    });
    expect(codesOf(record)).toContain("INSUFFICIENT_SAMPLES");
    const validity = validateTrial(record);
    expect(validity.status).toBe("invalid");
  });

  it("flags missing target appearance", () => {
    const record = makeTrial({
      samples: Array.from({ length: 20 }, (_, i) => ({
        tMs: i * 8,
        cursor: { x: 640, y: 360 },
      })),
    });
    expect(codesOf(record)).toContain("MISSING_TARGET_APPEARANCE");
  });

  it("flags non-monotonic timestamps", () => {
    const record = makeTrial({
      samples: [
        { tMs: 100, cursor: { x: 640, y: 360 } },
        { tMs: 90, cursor: { x: 650, y: 360 } },
        ...Array.from({ length: 25 }, (_, i) => ({
          tMs: 200 + i * 4,
          cursor: { x: 650, y: 360 },
        })),
      ],
      targets: [
        {
          targetId: "target-v3",
          radiusPx: 26,
          appearedMs: 50,
          removedMs: null,
          removalReason: null,
          motion: { kind: "static", position: { x: 800, y: 360 } },
        },
      ],
    });
    expect(codesOf(record)).toContain("IMPOSSIBLE_TIMESTAMPS");
  });

  it("flags samples before trial start", () => {
    const record = makeTrial({
      startedAtMonotonicMs: 500,
      samples: [
        { tMs: 100, cursor: { x: 640, y: 360 } },
        ...Array.from({ length: 25 }, (_, i) => ({
          tMs: 600 + i * 4,
          cursor: { x: 640, y: 360 },
        })),
      ],
      targets: [
        {
          targetId: "target-v4",
          radiusPx: 26,
          appearedMs: 600,
          removedMs: null,
          removalReason: null,
          motion: { kind: "static", position: { x: 800, y: 360 } },
        },
      ],
    });
    expect(codesOf(record)).toContain("IMPOSSIBLE_TIMESTAMPS");
  });

  it("flags click before target appearance as suspect", () => {
    const record = makeTrial({
      samples: [
        { tMs: 10, cursor: { x: 900, y: 360 } },
        ...Array.from({ length: 25 }, (_, i) => ({
          tMs: 20 + i * 4,
          cursor: { x: 900, y: 360 },
        })),
      ],
      shots: [
        {
          tMs: 12,
          cursorAtShot: { x: 900, y: 360 },
          aimedTargetId: null,
          hit: false,
          missDistancePx: 100,
        },
      ],
      targets: [
        {
          targetId: "target-v5",
          radiusPx: 26,
          appearedMs: 100,
          removedMs: null,
          removalReason: null,
          motion: { kind: "static", position: { x: 900, y: 360 } },
        },
      ],
    });
    const validity = validateTrial(record);
    expect(validity.status).toBe("suspect");
    expect(validity.reasons.map((r) => r.code)).toContain(
      "CLICK_BEFORE_TARGET_APPEARANCE",
    );
  });

  it("flags focus loss as suspect", () => {
    const record = makeTrial({
      samples: Array.from({ length: 20 }, (_, i) => ({
        tMs: i * 8,
        cursor: { x: 640, y: 360 },
      })),
      targets: [
        {
          targetId: "target-v6",
          radiusPx: 26,
          appearedMs: 5,
          removedMs: null,
          removalReason: null,
          motion: { kind: "static", position: { x: 800, y: 360 } },
        },
      ],
      focusInterruptions: [{ startMs: 40, endMs: 60, reason: "alt-tab" }],
    });
    const validity = validateTrial(record);
    expect(validity.status).toBe("suspect");
    expect(validity.reasons[0]!.code).toBe("FOCUS_LOSS");
  });

  it("flags large sample gaps", () => {
    const record = makeTrial({
      samples: [
        { tMs: 10, cursor: { x: 640, y: 360 } },
        { tMs: 400, cursor: { x: 660, y: 360 } },
        ...Array.from({ length: 25 }, (_, i) => ({
          tMs: 420 + i * 4,
          cursor: { x: 660, y: 360 },
        })),
      ],
      targets: [
        {
          targetId: "target-v7",
          radiusPx: 26,
          appearedMs: 15,
          removedMs: null,
          removalReason: null,
          motion: { kind: "static", position: { x: 800, y: 360 } },
        },
      ],
    });
    expect(codesOf(record)).toContain("LARGE_SAMPLE_GAP");
  });

  it("flags impossible movement speed", () => {
    const record = makeTrial({
      samples: [
        { tMs: 0, cursor: { x: 100, y: 360 } },
        { tMs: 4, cursor: { x: 1100, y: 360 } },
        ...Array.from({ length: 25 }, (_, i) => ({
          tMs: 8 + i * 4,
          cursor: { x: 1100, y: 360 },
        })),
      ],
      targets: [
        {
          targetId: "target-v8",
          radiusPx: 26,
          appearedMs: 1,
          removedMs: null,
          removalReason: null,
          motion: { kind: "static", position: { x: 300, y: 360 } },
        },
      ],
    });
    expect(codesOf(record)).toContain("IMPOSSIBLE_MOVEMENT");
  });

  it("flags configuration mismatch", () => {
    const record = makeTrial({
      sensitivity: { sensX: 9, sensY: 9 },
      samples: Array.from({ length: 20 }, (_, i) => ({
        tMs: i * 8,
        cursor: { x: 640, y: 360 },
      })),
      targets: [
        {
          targetId: "target-v9",
          radiusPx: 26,
          appearedMs: 5,
          removedMs: null,
          removalReason: null,
          motion: { kind: "static", position: { x: 800, y: 360 } },
        },
      ],
    });
    const validity = validateTrial(record, DEFAULT_VALIDATION_CONFIG, {
      sensitivity: { sensX: 7, sensY: 7 },
      dpi: 800,
    });
    expect(validity.reasons.map((r) => r.code)).toContain("CONFIG_MISMATCH");

    const dpiMismatch = validateTrial(record, DEFAULT_VALIDATION_CONFIG, {
      dpi: 1600,
    });
    expect(dpiMismatch.reasons.map((r) => r.code)).toContain("CONFIG_MISMATCH");
  });
});
