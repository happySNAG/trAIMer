import {
  createLoopbackSocketPair,
  NativeTransportCaptureSource,
  type NativeTransportError,
  type TransportSocket,
} from "../../src/capture/nativeClient.ts";
import type { CaptureSink } from "../../src/capture/events.ts";
import { NATIVE_CAPTURE_PROTOCOL_VERSION } from "../../src/capture/native.ts";
import { EXPECTED_HELPER_VERSION } from "../../src/version.ts";

/**
 * A scripted stand-in for the Windows capture helper.
 *
 * It exists so the clock-synchronization handshake can be exercised with a
 * KNOWN, exact offset between the two clocks: the harness owns both the
 * renderer clock the source reads and the helper clock it answers with, so a
 * test can assert that translated event timestamps land on the millisecond
 * the renderer would have observed.
 */
export interface FakeHelperOptions {
  /** True offset: helperMs + offsetMs === rendererMs. */
  offsetMs?: number;
  /** Renderer-clock cost of one round trip, split evenly by default. */
  roundTripMs?: number;
  /** Fraction of the round trip spent on the outbound leg (asymmetry). */
  outboundFraction?: number;
  helperVersion?: string;
  nominalRateHz?: number;
  /** Refuse to answer time-sync at all (an old helper). */
  supportsTimeSync?: boolean;
}

export interface FakeHelper {
  source: NativeTransportCaptureSource;
  events: { kind: string; tMs: number }[];
  statuses: string[];
  errors: NativeTransportError[];
  clockSyncEvents: unknown[];
  /** Advance the renderer clock. */
  advance(ms: number): void;
  now(): number;
  /** Connect, exchange hello/welcome, and run the sync chain to completion. */
  connectAndSync(): void;
  /** Deliver one frame from the helper, timestamped in HELPER time. */
  sendFrame(sequence: number, helperMs: number, dx?: number): void;
  /** Deliver a raw JSON message from the helper. */
  sendRaw(json: string): void;
  /** Pump one client→helper → helper→client cycle. */
  pump(): void;
}

export function createFakeHelper(options: FakeHelperOptions = {}): FakeHelper {
  const offsetMs = options.offsetMs ?? 123_456.789;
  const roundTripMs = options.roundTripMs ?? 0.4;
  const outboundFraction = options.outboundFraction ?? 0.5;
  const helperVersion = options.helperVersion ?? EXPECTED_HELPER_VERSION;
  const supportsTimeSync = options.supportsTimeSync ?? true;

  let rendererNow = 5_000;
  const pair = createLoopbackSocketPair();
  const events: { kind: string; tMs: number }[] = [];
  const statuses: string[] = [];
  const errors: NativeTransportError[] = [];
  const clockSyncEvents: unknown[] = [];

  const source = new NativeTransportCaptureSource({
    url: "ws://127.0.0.1:48765",
    sessionToken: "tok-abc",
    appVersion: "test",
    socketFactory: () => pair.client as TransportSocket,
    reconnect: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 2 },
    handshakeTimeoutMs: 5000,
    nowMs: () => rendererNow,
    syncProbeCount: 6,
    onStatus: (s) => statuses.push(s),
    onError: (e) => errors.push(e),
    onClockSync: (s) => clockSyncEvents.push(s),
  });
  const sink: CaptureSink = {
    onEvent: (e) => events.push({ kind: e.kind, tMs: e.tMs }),
  };
  source.start(sink);

  // The scripted helper: answers hello with welcome and time-sync with a
  // reading of ITS clock taken partway through the round trip.
  pair.server.onMessage((raw) => {
    const msg = JSON.parse(raw) as { type: string; id?: string };
    if (msg.type === "hello") {
      pair.server.send(
        JSON.stringify({
          type: "welcome",
          protocolVersion: NATIVE_CAPTURE_PROTOCOL_VERSION,
          sourceKind: "native",
          deviceId: "mouse-1",
          deviceDescription: "Test mouse",
          nominalRateHz: options.nominalRateHz ?? 1000,
          timeOriginNote: "monotonic ms from helper process start",
          supportsTimeSync,
          helperVersion,
        }),
      );
      return;
    }
    if (msg.type === "time-sync") {
      if (!supportsTimeSync) return;
      // The helper reads its clock `outboundFraction` of the way through the
      // round trip; the renderer clock advances by the full round trip before
      // the reply is handed back.
      const helperMs = rendererNow + roundTripMs * outboundFraction - offsetMs;
      rendererNow += roundTripMs;
      pair.server.send(
        JSON.stringify({ type: "time-sync-reply", id: msg.id, helperMonotonicMs: helperMs }),
      );
      return;
    }
  });

  const pump = (): void => {
    for (let i = 0; i < 64; i++) {
      pair.server.deliverClientToServer();
      pair.server.deliverServerToClient();
    }
  };

  return {
    source,
    events,
    statuses,
    errors,
    clockSyncEvents,
    advance(ms) {
      rendererNow += ms;
    },
    now: () => rendererNow,
    connectAndSync() {
      pair.open();
      pump();
    },
    sendFrame(sequence, helperMs, dx = 2) {
      pair.server.send(
        JSON.stringify({
          type: "frame",
          sequence,
          tMonotonicMs: helperMs,
          events: [{ kind: "pointer-sample", tMs: helperMs, dx, dy: 0 }],
        }),
      );
      pump();
    },
    sendRaw(json) {
      pair.server.send(json);
      pump();
    },
    pump,
  };
}

/** The true offset the fake helper was built with, for assertions. */
export const DEFAULT_FAKE_HELPER_OFFSET_MS = 123_456.789;
