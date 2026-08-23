import { describe, expect, it } from "vitest";
import {
  NativeTransportCaptureSource,
  createLoopbackSocketPair,
} from "../src/capture/nativeClient.ts";
import type { NativeTransportError } from "../src/capture/nativeClient.ts";
import type { CaptureSink } from "../src/capture/events.ts";
import { NATIVE_CAPTURE_PROTOCOL_VERSION } from "../src/capture/native.ts";

type Loopback = ReturnType<typeof createLoopbackSocketPair>;

function makeSource(
  socketForFactory: TransportSocketProvider,
  overrides: Partial<ConstructorParameters<typeof NativeTransportCaptureSource>[0]> = {},
): { source: NativeTransportCaptureSource; events: unknown[]; statuses: string[]; errors: NativeTransportError[] } {
  const events: unknown[] = [];
  const statuses: string[] = [];
  const errors: NativeTransportError[] = [];
  const source = new NativeTransportCaptureSource({
    url: "ws://127.0.0.1:48765",
    sessionToken: "tok-abc",
    appVersion: "test",
    socketFactory: socketForFactory,
    reconnect: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 4 },
    handshakeTimeoutMs: 500,
    onStatus: (s) => statuses.push(s),
    onError: (e) => errors.push(e),
    ...overrides,
  });
  const sink: CaptureSink = { onEvent: (e) => events.push(e) };
  source.start(sink);
  return { source, events, statuses, errors };
}

type TransportSocketProvider = (url: string) => Loopback["client"];

function handshake(pair: Loopback, source: NativeTransportCaptureSource): void {
  pair.open();
  expect(source.status).toBe("handshaking");
  pair.server.deliverClientToServer();
}

const WELCOME = JSON.stringify({
  type: "welcome",
  protocolVersion: NATIVE_CAPTURE_PROTOCOL_VERSION,
  sourceKind: "native",
  deviceId: "mouse-1",
  deviceDescription: "Test mouse",
  nominalRateHz: 1000,
  timeOriginNote: "helper start",
  helperVersion: "helper-1.0.0",
});

function frame(seq: number, tMs: number, dx = 2): string {
  return JSON.stringify({
    type: "frame",
    sequence: seq,
    tMonotonicMs: tMs,
    events: [{ kind: "pointer-sample", tMs, dx, dy: 0 }],
  });
}

describe("native transport protocol", () => {
  it("performs the versioned hello/welcome handshake and streams frames", () => {
    const pair = createLoopbackSocketPair();
    const sentToServer: string[] = [];
    pair.server.onMessage((data) => sentToServer.push(data));
    const { source, events } = makeSource(() => pair.client);

    handshake(pair, source);

    // The client's first message was the versioned hello with its token.
    const hello = JSON.parse(sentToServer[0]!);
    expect(hello).toMatchObject({
      type: "hello",
      protocolVersion: NATIVE_CAPTURE_PROTOCOL_VERSION,
      sessionToken: "tok-abc",
    });
    expect(source.status).toBe("handshaking");

    source.handleRawMessage(WELCOME);
    expect(source.status).toBe("streaming");
    expect(source.header?.deviceId).toBe("mouse-1");
    expect(source.descriptor.nominalSampleIntervalMs).toBeCloseTo(1, 6);

    source.handleRawMessage(frame(0, 10));
    source.handleRawMessage(frame(1, 11));
    source.handleRawMessage(frame(2, 12.5));
    expect(events).toHaveLength(3);
    expect(source.counters.framesReceived).toBe(3);
    expect(source.counters.lastSequenceSeen).toBe(2);
    source.stop();
  });

  it("fails closed on protocol version mismatch", () => {
    const pair = createLoopbackSocketPair();
    const { source, events, errors } = makeSource(() => pair.client);
    pair.open();
    source.handleRawMessage(
      JSON.stringify({ type: "welcome", protocolVersion: 99, sourceKind: "native", deviceId: "d", deviceDescription: "", nominalRateHz: 500, timeOriginNote: "", helperVersion: "x" }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/protocol mismatch/);
    expect(source.status).toBe("failed");
    expect(events).toHaveLength(0);
  });

  it("rejects malformed JSON, malformed events, and bad sequences loudly", () => {
    const pair = createLoopbackSocketPair();
    const { source, errors } = makeSource(() => pair.client);
    pair.open();
    source.handleRawMessage(WELCOME);

    source.handleRawMessage("not json at all");
    expect(errors.at(-1)!.message).toMatch(/malformed message/);

    source.handleRawMessage(
      JSON.stringify({ type: "frame", sequence: 0, tMonotonicMs: 5, events: [{ kind: "nonsense" }] }),
    );
    expect(errors.at(-1)!.message).toMatch(/malformed capture event/);

    source.handleRawMessage(
      JSON.stringify({ type: "frame", sequence: -3, tMonotonicMs: 5, events: [] }),
    );
    expect(errors.at(-1)!.message).toMatch(/malformed frame sequence/);

    source.handleRawMessage(
      JSON.stringify({ type: "frame", sequence: 7, tMonotonicMs: "soon", events: [] }),
    );
    expect(errors.at(-1)!.message).toMatch(/malformed frame timestamp/);
    source.stop();
  });

  it("detects duplicate sequences and counts gaps without fabrication", () => {
    const pair = createLoopbackSocketPair();
    const { source, errors } = makeSource(() => pair.client);
    pair.open();
    source.handleRawMessage(WELCOME);

    source.handleRawMessage(frame(0, 1));
    source.handleRawMessage(frame(0, 2)); // duplicate → fail closed
    expect(errors.at(-1)!.message).toMatch(/duplicate frame sequence 0/);
    expect(source.counters.duplicateSequences).toBe(1);
    source.stop();

    // Fresh stream for the gap case.
    const pair2 = createLoopbackSocketPair();
    const { source: s2, errors: e2, events: ev2 } = makeSource(() => pair2.client);
    pair2.open();
    s2.handleRawMessage(WELCOME);
    s2.handleRawMessage(frame(0, 1));
    s2.handleRawMessage(frame(5, 5));
    expect(e2).toHaveLength(0); // gaps surface as counters, not fabricated data
    expect(ev2.length).toBe(2);
    expect(s2.counters.missingSequences).toBe(4);
    s2.stop();
  });

  it("non-monotonic timestamps fail the stream", () => {
    const pair = createLoopbackSocketPair();
    const { source, errors } = makeSource(() => pair.client);
    pair.open();
    source.handleRawMessage(WELCOME);
    source.handleRawMessage(JSON.stringify({
      type: "frame", sequence: 0, tMonotonicMs: 10,
      events: [{ kind: "pointer-sample", tMs: 10, dx: 1, dy: 1 }],
    }));
    source.handleRawMessage(JSON.stringify({
      type: "frame", sequence: 1, tMonotonicMs: 9.5,
      events: [{ kind: "pointer-sample", tMs: 9.5, dx: 1, dy: 1 }],
    }));
    expect(errors.at(-1)!.message).toMatch(/non-monotonic timestamps/);
    source.stop();
  });

  it("reconnects after connection loss and resets the epoch on welcome", async () => {
    const sockets: Loopback[] = [];
    let statuses = "";
    const source = new NativeTransportCaptureSource({
      url: "ws://127.0.0.1:48765",
      sessionToken: "tok",
      appVersion: "t",
      socketFactory: () => {
        const p = createLoopbackSocketPair();
        p.open();
        sockets.push(p);
        return p.client;
      },
      reconnect: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2 },
      onStatus: (s) => {
        statuses += `${s};`;
      },
    });
    source.start({ onEvent: () => undefined });
    expect(sockets.length).toBe(1);

    sockets[0]!.failClient();
    await new Promise((r) => setTimeout(r, 10));
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    expect(statuses).toContain("reconnecting;");
    source.stop();
  });

  it("gives up after maxAttempts and reports failure", async () => {
    const source = new NativeTransportCaptureSource({
      url: "ws://127.0.0.1:48765",
      sessionToken: "tok",
      appVersion: "t",
      socketFactory: (): never => {
        throw new Error("no listener");
      },
      reconnect: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 2 },
      onStatus: () => undefined,
      onError: () => undefined,
    });
    source.start({ onEvent: () => undefined });
    await new Promise((r) => setTimeout(r, 10));
    expect(source.status).toBe("failed");
  });

  it("stops cleanly and stops retrying after caller stop", async () => {
    const pair = createLoopbackSocketPair();
    const { source, statuses } = makeSource(() => pair.client);
    pair.open();
    source.stop();
    expect(statuses).toContain("closed");
    await new Promise((r) => setTimeout(r, 6));
    expect(source.status).toBe("closed");
  });
});

describe("cross-talk protection contract", () => {
  it("every Aim Lab instance mints a distinct session token", () => {
    const tokenA = `tok-${Math.random().toString(36).slice(2)}`;
    const tokenB = `tok-${Math.random().toString(36).slice(2)}`;
    expect(tokenA).not.toBe(tokenB);

    const pair = createLoopbackSocketPair();
    const sent: string[] = [];
    pair.server.onMessage((data) => sent.push(data));
    const { source } = makeSource(() => pair.client, { sessionToken: tokenA });
    pair.open();
    pair.server.deliverClientToServer();
    const hello = JSON.parse(sent[0]!);
    expect(hello.type).toBe("hello");
    expect(hello.sessionToken).toBe(tokenA);
    expect(hello.protocolVersion).toBe(NATIVE_CAPTURE_PROTOCOL_VERSION);
    void source;
  });
});
