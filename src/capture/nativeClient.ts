import type { CaptureEvent, CaptureSource, CaptureSink } from "./events.ts";
import { NATIVE_CAPTURE_PROTOCOL_VERSION } from "./native.ts";
import type { NativeStreamHeader } from "./native.ts";

/**
 * Local native-capture transport client (Pass 4, requirements A/B).
 *
 * Connects to the platform capture helper over loopback only. The wire
 * contract:
 *
 *   client → helper : {"type":"hello","protocolVersion":N,"sessionToken":T,
 *                      "appVersion":V}
 *   helper → client : {"type":"welcome", header fields..., "helperVersion":S}
 *                   | {"type":"reject","reason":R}
 *   helper → client : {"type":"frame","sequence":Q,"tMonotonicMs":t,
 *                      "events":[CaptureEvent...]}
 *                   | {"type":"lifecycle","phase":"started"|"stopping"|"reconnecting"}
 *                   | {"type":"ping"}   (client replies "pong")
 *
 * Fail-closed rules: malformed frames, protocol mismatch, duplicate or
 * non-monotonic sequences abort the stream loudly — data is never silently
 * repaired or interpolated. The sessionToken prevents accidental cross-talk
 * between two Aim Lab instances sharing one helper: the helper serves exactly
 * one accepted token at a time.
 */

export interface TransportSocket {
  send(data: string): void;
  close(): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
  onError(cb: (message: string) => void): void;
}

export type TransportSocketFactory = (url: string) => TransportSocket;

export type NativeTransportStatus =
  | "idle"
  | "connecting"
  | "handshaking"
  | "streaming"
  | "reconnecting"
  | "failed"
  | "closed";

export class NativeTransportError extends Error {
  constructor(message: string, readonly fatal: boolean = true) {
    super(message);
    this.name = "NativeTransportError";
  }
}

export interface NativeTransportCounters {
  framesReceived: number;
  eventsReceived: number;
  duplicateSequences: number;
  missingSequences: number;
  nonMonotonicTimestamps: number;
  reconnects: number;
  longestGapMs: number | null;
  lastSequenceSeen: number | null;
}

export interface NativeTransportOptions {
  url: string;
  /** Unique per Aim Lab instance; prevents cross-talk between instances. */
  sessionToken: string;
  appVersion: string;
  socketFactory: TransportSocketFactory;
  reconnect?: {
    maxAttempts: number;
    initialDelayMs: number;
    maxDelayMs: number;
  };
  handshakeTimeoutMs?: number;
  onStatus?: ((status: NativeTransportStatus, detail: string) => void) | undefined;
  onError?: ((error: NativeTransportError) => void) | undefined;
}

const DEFAULT_RECONNECT = { maxAttempts: 3, initialDelayMs: 250, maxDelayMs: 4000 };

/** Security limits (Pass 5): a hostile/buggy helper cannot exhaust memory. */
export const NATIVE_TRANSPORT_LIMITS = {
  /** Maximum inbound message size in characters (~1 MiB). Legit frames are <10 KB. */
  maxMessageChars: 1_000_000,
  /** Maximum events per frame accepted. */
  maxEventsPerFrame: 4096,
} as const;

/**
 * Validates that a transport URL targets loopback only. The native capture
 * transport must NEVER leave the machine; this fails closed on anything else.
 */
export function assertLoopbackUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NativeTransportError(`invalid transport url: ${url}`);
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new NativeTransportError(`transport must use ws:// or wss:// (got ${parsed.protocol})`);
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host !== "127.0.0.1" &&
    host !== "localhost" &&
    host !== "::1" &&
    host !== "[::1]"
  ) {
    throw new NativeTransportError(
      `native capture is loopback-only; refusing non-local host "${parsed.hostname}"`,
    );
  }
}

interface WelcomeMessage extends NativeStreamHeader {
  helperVersion: string;
}

type ServerMessage =
  | ({ type: "welcome" } & WelcomeMessage)
  | { type: "reject"; reason: string }
  | { type: "frame"; sequence: number; tMonotonicMs: number; events: unknown[] }
  | { type: "lifecycle"; phase: "started" | "stopping" | "reconnecting"; detail?: string }
  | { type: "ping" };

export class NativeTransportCaptureSource implements CaptureSource {
  readonly descriptor: {
    kind: "native";
    description: string;
    nominalSampleIntervalMs: number | null;
  };

  readonly #options: Required<Pick<NativeTransportOptions, "url" | "sessionToken" | "appVersion" | "socketFactory">> &
    NativeTransportOptions;
  #sink: CaptureSink | null = null;
  #socket: TransportSocket | null = null;
  #status: NativeTransportStatus = "idle";
  #stoppedByCaller = false;
  #handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectAttempt = 0;
  #header: WelcomeMessage | null = null;
  readonly #counters: NativeTransportCounters = {
    framesReceived: 0,
    eventsReceived: 0,
    duplicateSequences: 0,
    missingSequences: 0,
    nonMonotonicTimestamps: 0,
    reconnects: 0,
    longestGapMs: null,
    lastSequenceSeen: null,
  };
  #lastFrameMonotonicMs: number | null = null;
  /*
   * Sequence continuity is enforced via `lastSequenceSeen` alone. Sequences
   * are strictly increasing within an epoch, so a Set of seen sequences is
   * redundant AND unbounded (a leak at 1000 Hz over a long session); the
   * non-monotonic check already rejects duplicates and regressions.
   */

  constructor(options: NativeTransportOptions) {
    assertLoopbackUrl(options.url);
    this.#options = options;
    this.descriptor = {
      kind: "native",
      description: `native capture helper (${options.url})`,
      nominalSampleIntervalMs: null,
    };
  }

  get status(): NativeTransportStatus {
    return this.#status;
  }

  get header(): WelcomeMessage | null {
    return this.#header;
  }

  get counters(): Readonly<NativeTransportCounters> {
    return { ...this.#counters };
  }

  start(sink: CaptureSink): void {
    if (this.#sink) throw new Error("transport already started");
    this.#sink = sink;
    this.#stoppedByCaller = false;
    this.#connect();
  }

  stop(): void {
    this.#stoppedByCaller = true;
    this.#clearTimers();
    this.#socket?.close();
    this.#socket = null;
    this.#setStatus("closed", "stopped by caller");
  }

  /** Explicitly validates a raw server message (also used by tests). */
  handleRawMessage(raw: string): void {
    this.#handleMessage(raw);
  }

  #setStatus(status: NativeTransportStatus, detail: string): void {
    this.#status = status;
    this.#options.onStatus?.(status, detail);
  }

  #fail(error: NativeTransportError): void {
    this.#options.onError?.(error);
    // Fail closed: no silent continuation of a broken stream.
    this.#clearTimers();
    this.#socket?.close();
    this.#socket = null;
    this.#setStatus("failed", error.message);
  }

  #clearTimers(): void {
    if (this.#handshakeTimer !== null) {
      clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = null;
    }
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }

  #connect(): void {
    if (this.#stoppedByCaller) return;
    this.#setStatus(
      this.#reconnectAttempt === 0 ? "connecting" : "reconnecting",
      `${this.#options.url} (attempt ${this.#reconnectAttempt + 1})`,
    );
    let socket: TransportSocket;
    try {
      socket = this.#options.socketFactory(this.#options.url);
    } catch (err) {
      this.#scheduleReconnect(`socket factory failed: ${String(err)}`);
      return;
    }
    this.#socket = socket;

    socket.onOpen(() => {
      this.#setStatus("handshaking", "sending hello");
      socket.send(
        JSON.stringify({
          type: "hello",
          protocolVersion: NATIVE_CAPTURE_PROTOCOL_VERSION,
          sessionToken: this.#options.sessionToken,
          appVersion: this.#options.appVersion,
        }),
      );
      const timeoutMs = this.#options.handshakeTimeoutMs ?? 3000;
      this.#handshakeTimer = setTimeout(() => {
        this.#fail(new NativeTransportError("handshake timed out"));
      }, timeoutMs);
    });

    socket.onMessage((data) => this.#handleMessage(data));

    socket.onClose((_code, reason) => {
      if (this.#stoppedByCaller) return;
      this.#scheduleReconnect(reason || "connection closed");
    });

    socket.onError((message) => {
      if (this.#stoppedByCaller) return;
      this.#scheduleReconnect(message);
    });
  }

  #scheduleReconnect(detail: string): void {
    if (this.#stoppedByCaller) return;
    const cfg = this.#options.reconnect ?? DEFAULT_RECONNECT;
    if (this.#reconnectAttempt >= cfg.maxAttempts) {
      this.#fail(new NativeTransportError(`native helper unavailable: ${detail}`));
      return;
    }
    const delay = Math.min(
      cfg.maxDelayMs,
      cfg.initialDelayMs * Math.pow(2, this.#reconnectAttempt),
    );
    this.#reconnectAttempt++;
    if (this.#reconnectAttempt > 1) this.#counters.reconnects++;
    this.#setStatus("reconnecting", `${detail}; retrying in ${delay} ms`);
    this.#reconnectTimer = setTimeout(() => this.#connect(), delay);
  }

  #handleMessage(raw: string): void {
    if (raw.length > NATIVE_TRANSPORT_LIMITS.maxMessageChars) {
      this.#fail(
        new NativeTransportError(
          `oversized message rejected (${raw.length} chars > ${NATIVE_TRANSPORT_LIMITS.maxMessageChars})`,
        ),
      );
      return;
    }
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      this.#fail(new NativeTransportError("malformed message: not JSON"));
      return;
    }
    switch (msg.type) {
      case "welcome": {
        if (this.#handshakeTimer !== null) {
          clearTimeout(this.#handshakeTimer);
          this.#handshakeTimer = null;
        }
        if (msg.protocolVersion !== NATIVE_CAPTURE_PROTOCOL_VERSION) {
          this.#fail(
            new NativeTransportError(
              `protocol mismatch: helper speaks v${msg.protocolVersion}, client expects v${NATIVE_CAPTURE_PROTOCOL_VERSION}`,
            ),
          );
          return;
        }
        this.#header = {
          protocolVersion: msg.protocolVersion,
          sourceKind: "native",
          deviceId: String(msg.deviceId),
          deviceDescription: String(msg.deviceDescription),
          nominalRateHz: Number(msg.nominalRateHz),
          timeOriginNote: String(msg.timeOriginNote),
          helperVersion: String(msg.helperVersion),
        };
        this.descriptor.description = `native ${this.#header.deviceId} (${this.#header.deviceDescription} @ ${this.#header.nominalRateHz} Hz)`;
        this.descriptor.nominalSampleIntervalMs =
          1000 / Math.max(this.#header.nominalRateHz, 1);
        this.#reconnectAttempt = 0;
        // A new connection starts a NEW stream epoch: sequence numbering and
        // timestamps restart under the helper. Cumulative counters survive;
        // continuity state resets so reconnects are not miscounted as drops.
        this.#counters.lastSequenceSeen = null;
        this.#lastFrameMonotonicMs = null;
        this.#setStatus("streaming", `accepted by ${this.#header.deviceId}`);
        this.#socket?.send(JSON.stringify({ type: "resume-from", lastSequence: null }));
        return;
      }
      case "reject":
        this.#fail(new NativeTransportError(`helper rejected connection: ${msg.reason}`));
        return;
      case "lifecycle":
        if (msg.phase === "reconnecting") this.#setStatus("reconnecting", msg.detail ?? "helper reconnecting to device");
        return;
      case "ping":
        this.#socket?.send(JSON.stringify({ type: "pong" }));
        return;
      case "frame":
        this.#handleFrame(msg);
        return;
      default:
        this.#fail(new NativeTransportError(`unknown message type ${(msg as { type?: string }).type}`));
    }
  }

  #handleFrame(msg: Extract<ServerMessage, { type: "frame" }>): void {
    const seq = msg.sequence;
    if (!Number.isInteger(seq) || seq < 0) {
      this.#fail(new NativeTransportError(`malformed frame sequence ${String(seq)}`));
      return;
    }
    if (!Array.isArray(msg.events)) {
      this.#fail(new NativeTransportError("malformed frame: events is not an array"));
      return;
    }
    if (typeof msg.tMonotonicMs !== "number" || !Number.isFinite(msg.tMonotonicMs)) {
      this.#fail(new NativeTransportError("malformed frame timestamp"));
      return;
    }
    const lastSeq = this.#counters.lastSequenceSeen;
    // Strictly increasing within an epoch: duplicates and regressions both
    // fail closed here (bounded memory — no seen-set retained).
    if (lastSeq !== null && seq <= lastSeq) {
      if (seq === lastSeq) this.#counters.duplicateSequences++;
      this.#fail(
        new NativeTransportError(
          seq === lastSeq
            ? `duplicate frame sequence ${seq}`
            : `non-monotonic sequence ${seq} after ${lastSeq}`,
        ),
      );
      return;
    }
    if (lastSeq !== null && seq > lastSeq + 1) {
      this.#counters.missingSequences += seq - lastSeq - 1;
    }
    if (this.#lastFrameMonotonicMs !== null) {
      const gap = msg.tMonotonicMs - this.#lastFrameMonotonicMs;
      if (gap < 0) {
        this.#counters.nonMonotonicTimestamps++;
        this.#fail(new NativeTransportError(`non-monotonic timestamps: gap ${gap.toFixed(3)}ms`));
        return;
      }
      if (
        this.#counters.longestGapMs === null ||
        gap > this.#counters.longestGapMs
      ) {
        this.#counters.longestGapMs = gap;
      }
    }
    if (msg.events.length > NATIVE_TRANSPORT_LIMITS.maxEventsPerFrame) {
      this.#fail(
        new NativeTransportError(
          `oversized frame: ${msg.events.length} events > ${NATIVE_TRANSPORT_LIMITS.maxEventsPerFrame}`,
        ),
      );
      return;
    }
    const events: CaptureEvent[] = [];
    for (const rawEvent of msg.events) {
      const ev = validateCaptureEvent(rawEvent);
      if (!ev) {
        this.#fail(new NativeTransportError(`malformed capture event in frame ${seq}`));
        return;
      }
      events.push(ev);
    }
    // Recorded ONLY after every event validated — a failed frame leaves zero
    // trace in counters, sequence tracking, or sinks.
    this.#counters.framesReceived++;
    this.#counters.lastSequenceSeen = seq;
    this.#lastFrameMonotonicMs = msg.tMonotonicMs;
    this.#counters.eventsReceived += events.length;
    for (const ev of events) this.#sink?.onEvent(ev);
  }
}

/** Structural validation — the engine never ingests fabricated shapes. */
function validateCaptureEvent(raw: unknown): CaptureEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const ev = raw as Record<string, unknown>;
  const tMs = ev.tMs;
  if (typeof tMs !== "number" || !Number.isFinite(tMs)) return null;
  const num = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v);
  switch (ev.kind) {
    case "pointer-sample":
      return num(ev.dx) && num(ev.dy)
        ? { kind: "pointer-sample", tMs, dx: ev.dx, dy: ev.dy }
        : null;
    case "button":
      return ev.action === "press" || ev.action === "release"
        ? { kind: "button", tMs, action: ev.action }
        : null;
    case "focus-change":
      return typeof ev.focused === "boolean" && typeof ev.reason === "string"
        ? { kind: "focus-change", tMs, focused: ev.focused, reason: ev.reason }
        : null;
    case "lock-change":
      return typeof ev.locked === "boolean" && typeof ev.reason === "string"
        ? { kind: "lock-change", tMs, locked: ev.locked, reason: ev.reason }
        : null;
    case "resize":
      return num(ev.widthPx) && num(ev.heightPx)
        ? { kind: "resize", tMs, widthPx: ev.widthPx, heightPx: ev.heightPx }
        : null;
    // target-spawn/target-remove are produced inside the app, never by hardware.
    default:
      return null;
  }
}

/**
 * Deterministic loopback socket pair for tests: messages sent by one side are
 * buffered until delivered explicitly; connection lifecycle is driven by the
 * test via open()/failClient() so ordering is fully controlled.
 */
export function createLoopbackSocketPair(): {
  client: TransportSocket;
  server: TransportSocket & {
    deliverClientToServer(): void;
    deliverServerToClient(): void;
  };
  /** Fires onOpen on both sides (loopback connect). */
  open(): void;
  /** Simulates an abnormal transport failure on the client side. */
  failClient(reason?: string): void;
} {
  let clientToServer: string[] = [];
  let serverToClient: string[] = [];
  const clientHandlers = {
    open: (): void => {},
    message: (_data: string): void => {},
    close: (_code: number, _reason: string): void => {},
    error: (_message: string): void => {},
  };
  const serverHandlers = {
    open: (): void => {},
    message: (_data: string): void => {},
    close: (_code: number, _reason: string): void => {},
    error: (_message: string): void => {},
  };

  const client: TransportSocket = {
    send(data: string): void {
      clientToServer.push(data);
    },
    close(): void {
      serverHandlers.close(1000, "client closed");
    },
    onOpen(cb: () => void): void {
      const prev = clientHandlers.open;
      clientHandlers.open = (): void => {
        prev();
        cb();
      };
    },
    onMessage(cb: (data: string) => void): void {
      clientHandlers.message = cb;
    },
    onClose(cb: (code: number, reason: string) => void): void {
      clientHandlers.close = cb;
    },
    onError(cb: (message: string) => void): void {
      clientHandlers.error = cb;
    },
  };

  const server: TransportSocket & {
    deliverClientToServer(): void;
    deliverServerToClient(): void;
  } = {
    send(data: string): void {
      serverToClient.push(data);
    },
    close(): void {
      clientHandlers.close(1000, "server closed");
    },
    onOpen(cb: () => void): void {
      const prev = serverHandlers.open;
      serverHandlers.open = (): void => {
        prev();
        cb();
      };
    },
    onMessage(cb: (data: string) => void): void {
      serverHandlers.message = cb;
    },
    onClose(cb: (code: number, reason: string) => void): void {
      serverHandlers.close = cb;
    },
    onError(cb: (message: string) => void): void {
      serverHandlers.error = cb;
    },
    deliverClientToServer(): void {
      const batch = clientToServer;
      clientToServer = [];
      for (const data of batch) serverHandlers.message(data);
    },
    deliverServerToClient(): void {
      const batch = serverToClient;
      serverToClient = [];
      for (const data of batch) clientHandlers.message(data);
    },
  };

  return {
    client,
    server,
    open(): void {
      clientHandlers.open();
      serverHandlers.open();
    },
    failClient(reason = "abnormal closure"): void {
      clientHandlers.close(1006, reason);
    },
  };
}
