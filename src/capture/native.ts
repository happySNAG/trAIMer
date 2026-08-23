import type { CaptureEvent, CaptureSource, CaptureSink } from "./events.ts";
import { POINTER_LOCK_LOSS_REASON } from "./events.ts";

/**
 * Native high-rate mouse capture transport (500/1000 Hz helpers).
 *
 * The engine never talks to hardware; a future OS-specific helper streams
 * versioned frames of CaptureEvents with monotonic timestamps and sequence
 * numbers. This module defines the wire format, loss detection, and a
 * deterministic replay source so recorded native streams can be fed through
 * every browser-independent engine test.
 */

export const NATIVE_CAPTURE_PROTOCOL_VERSION = 1;

export interface NativeStreamHeader {
  protocolVersion: number;
  sourceKind: "native";
  deviceId: string;
  deviceDescription: string;
  nominalRateHz: number;
  timeOriginNote: string;
}

export interface NativeFrame {
  sequence: number;
  tMonotonicMs: number;
  events: CaptureEvent[];
}

export interface NativeCaptureFixture {
  schemaVersion: number;
  kind: "native-capture-fixture";
  header: NativeStreamHeader;
  frames: NativeFrame[];
}

export interface NativeSequenceGap {
  afterSequence: number;
  missingCount: number;
}

export function serializeNativeFixture(fixture: NativeCaptureFixture): string {
  return JSON.stringify(
    { ...fixture, schemaVersion: fixture.schemaVersion ?? 1 },
    null,
    2,
  );
}

export function parseNativeFixture(raw: string | object): NativeCaptureFixture {
  const parsed =
    typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  const f = parsed as Partial<NativeCaptureFixture> | null;
  if (
    !f ||
    f.kind !== "native-capture-fixture" ||
    !Array.isArray(f.frames) ||
    !f.header
  ) {
    throw new Error("invalid native-capture-fixture");
  }
  if (
    f.header.protocolVersion !== NATIVE_CAPTURE_PROTOCOL_VERSION ||
    f.header.sourceKind !== "native"
  ) {
    throw new Error("unsupported native stream header");
  }
  let previous: number | null = null;
  for (const frame of f.frames) {
    if (typeof frame.sequence !== "number" || !Array.isArray(frame.events)) {
      throw new Error("malformed native frame");
    }
    if (previous !== null && frame.sequence !== previous + 1) {
      // gaps are allowed in data but surfaced by the replay source
      void frame.sequence;
    }
    previous = frame.sequence;
  }
  return {
    schemaVersion: 1,
    kind: "native-capture-fixture",
    header: f.header,
    frames: f.frames,
  };
}

export function detectSequenceGaps(frames: readonly NativeFrame[]): NativeSequenceGap[] {
  const gaps: NativeSequenceGap[] = [];
  for (let i = 1; i < frames.length; i++) {
    const expected = frames[i - 1]!.sequence + 1;
    const actual = frames[i]!.sequence;
    if (actual > expected) {
      gaps.push({ afterSequence: frames[i - 1]!.sequence, missingCount: actual - expected });
    }
  }
  return gaps;
}

export class ReplayCaptureSource implements CaptureSource {
  readonly descriptor: {
    kind: "native";
    description: string;
    nominalSampleIntervalMs: number | null;
  };
  #sink: CaptureSink | null = null;
  #frameIndex = 0;
  #replayTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly fixture: NativeCaptureFixture,
    private readonly replayMode: "instant" | "realtime" = "instant",
  ) {
    this.descriptor = {
      kind: "native",
      description: `native replay (${fixture.header.deviceId} @ ${fixture.header.nominalRateHz} Hz)`,
      nominalSampleIntervalMs: 1000 / Math.max(fixture.header.nominalRateHz, 1),
    };
  }

  #gaps: ReturnType<typeof detectSequenceGaps> = [];

  start(sink: CaptureSink): void {
    this.#sink = sink;
    // Sequence gaps are reported as transport metadata, never synthesized
    // into the event stream (which would corrupt recorded timestamps).
    this.#gaps = detectSequenceGaps(this.fixture.frames);
    if (this.#gaps.length > 0) {
      this.#sink.onEvent({
        kind: "focus-change",
        focused: false,
        reason: `native-transport-warning:${this.#gaps.length} sequence gap(s)`,
        tMs: this.fixture.frames[0]?.tMonotonicMs ?? 0,
      } as CaptureEvent);
      this.#sink.onEvent({
        kind: "focus-change",
        focused: true,
        reason: "native-transport-warning-clear",
        tMs: this.fixture.frames[0]?.tMonotonicMs ?? 0,
      } as CaptureEvent);
    }
    this.#pumpNext(sink);
  }

  get sequenceGaps(): ReturnType<typeof detectSequenceGaps> {
    return this.#gaps;
  }

  #pumpNext(sink: CaptureSink): void {
    if (this.#frameIndex >= this.fixture.frames.length) return;
    const frame = this.fixture.frames[this.#frameIndex];
    this.#frameIndex++;
    for (const event of frame?.events ?? []) sink.onEvent(event);
    const next = this.fixture.frames[this.#frameIndex];
    if (!next) return;
    if (this.replayMode === "instant") {
      this.#pumpNext(sink);
      return;
    }
    const delay = Math.max(0, next.tMonotonicMs - (frame?.tMonotonicMs ?? 0));
    this.#replayTimer = setTimeout(() => this.#pumpNext(sink), delay);
  }

  stop(): void {
    if (this.#replayTimer !== null) {
      clearTimeout(this.#replayTimer);
      this.#replayTimer = null;
    }
    this.#sink = null;
  }

  /** Test helper: synthesize a lock-loss event into the live feed. */
  emitLockLoss(tMs: number): void {
    this.#sink?.onEvent({
      kind: "lock-change",
      tMs,
      locked: false,
      reason: POINTER_LOCK_LOSS_REASON,
    });
  }
}

export function makeNativeFixture(
  header: Omit<NativeStreamHeader, "protocolVersion" | "sourceKind" | "timeOriginNote">,
  frames: NativeFrame[],
): NativeCaptureFixture {
  return {
    schemaVersion: 1,
    kind: "native-capture-fixture",
    header: {
      ...header,
      protocolVersion: NATIVE_CAPTURE_PROTOCOL_VERSION,
      sourceKind: "native",
      timeOriginNote: "monotonic ms from helper process start",
    },
    frames,
  };
}
