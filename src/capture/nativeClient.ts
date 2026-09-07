import type { CaptureEvent, CaptureSource, CaptureSink } from "./events.ts";
import { NATIVE_CAPTURE_PROTOCOL_VERSION } from "./native.ts";
import type { NativeStreamHeader } from "./native.ts";
import { EXPECTED_HELPER_VERSION } from "../version.ts";
import {
  describeClockSync,
  HelperClockSync,
  MAX_CLOCK_SYNC_UNCERTAINTY_MS,
  MIN_CLOCK_SYNC_SAMPLES,
  NATIVE_CAPTURE_LEAD_TOLERANCE_MS,
  type ClockSyncEstimate,
  type ClockSyncStatus,
} from "./timebase.ts";

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
 *   client → helper : {"type":"time-sync","id":"N"}
 *   helper → client : {"type":"time-sync-reply","id":"N","helperMonotonicMs":T}
 *
 * CLOCK DOMAINS. The helper counts milliseconds from ITS OWN process start
 * (QueryPerformanceCounter); this client's consumers measure against the
 * renderer's `performance.timeOrigin`. Those origins are unrelated, and
 * feeding one into the other shifts every reaction time by an unknown
 * constant — silently, and in a direction nothing downstream could detect.
 *
 * So NO event reaches a sink until the offset between the two clocks has been
 * ESTABLISHED by measurement. On `welcome` the client runs a chain of
 * sequential `time-sync` exchanges, each giving an offset estimate with a
 * proven error bound of half its round trip (Cristian's algorithm — see
 * src/capture/timebase.ts). Frames that arrive meanwhile are held in a bounded
 * buffer. When the tightest bound is within MAX_CLOCK_SYNC_UNCERTAINTY_MS the
 * offset is FROZEN for the stream epoch and the buffer is flushed, translated.
 * Freezing is what preserves monotonic ordering: translation is then a single
 * affine map, so a later, slightly different estimate can never reorder two
 * events. Later probes keep running, but only to measure drift and to fail the
 * stream if the clocks diverge — never to retroactively move a timestamp.
 *
 * If the offset cannot be established, the stream FAILS. It does not fall back
 * to untranslated helper time, and it does not guess an offset.
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
  /** Renderer-monotonic clock. Injectable so sync is testable without timers. */
  nowMs?: (() => number) | undefined;
  /** Sequential time-sync exchanges run before the offset is frozen. */
  syncProbeCount?: number | undefined;
  /** Largest half-round-trip bound accepted before the stream is trusted. */
  maxClockSyncUncertaintyMs?: number | undefined;
  /** Notified whenever the synchronization state changes. */
  onClockSync?: ((status: ClockSyncStatus) => void) | undefined;
}

const DEFAULT_RECONNECT = { maxAttempts: 3, initialDelayMs: 250, maxDelayMs: 4000 };

/** Sequential exchanges before an offset may be frozen. */
const MIN_SYNC_PROBES = MIN_CLOCK_SYNC_SAMPLES;

/**
 * Events held while the offset is still being established. One second of a
 * 1 kHz stream, which is far more than the handful of exchanges take; a
 * stream that overruns it is not synchronizing and fails closed.
 */
const MAX_BUFFERED_EVENTS_AWAITING_SYNC = 2000;

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
  | { type: "ping" }
  | { type: "time-sync-reply"; id: string; helperMonotonicMs: number };

export class NativeTransportCaptureSource implements CaptureSource {
  readonly descriptor: {
    kind: "native";
    description: string;
    nominalSampleIntervalMs: number | null;
    /**
     * Events reach sinks in the RENDERER clock: the raw helper timestamps are
     * translated by the established offset before anything is emitted.
     */
    timestampDomain: "renderer-monotonic";
    leadToleranceMs: number;
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
  // ---- clock synchronization state (per stream epoch) ----
  #clockSync = new HelperClockSync();
  /** Frozen once established; never replaced within an epoch. */
  #frozenEstimate: ClockSyncEstimate | null = null;
  #syncState: ClockSyncStatus["state"] = "not-attempted";
  #syncDetail = "no connection yet";
  #pendingProbes = new Map<string, number>();
  #nextProbeId = 0;
  #probesSent = 0;
  /** Frames received before the offset was established, awaiting translation. */
  #pendingFrames: Extract<ServerMessage, { type: "frame" }>[] = [];
  #bufferedEventCount = 0;
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
      timestampDomain: "renderer-monotonic",
      leadToleranceMs: NATIVE_CAPTURE_LEAD_TOLERANCE_MS,
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

  /** Where helper↔renderer clock synchronization currently stands. */
  get clockSync(): ClockSyncStatus {
    return describeClockSync(
      this.#clockSync,
      this.#syncState,
      this.#syncDetail,
      this.#maxSyncUncertaintyMs,
    );
  }

  /** The frozen offset used to translate this epoch, or null before it exists. */
  get frozenClockOffsetMs(): number | null {
    return this.#frozenEstimate?.offsetMs ?? null;
  }

  get #maxSyncUncertaintyMs(): number {
    return this.#options.maxClockSyncUncertaintyMs ?? MAX_CLOCK_SYNC_UNCERTAINTY_MS;
  }

  get #syncProbeCount(): number {
    return Math.max(MIN_SYNC_PROBES, this.#options.syncProbeCount ?? 8);
  }

  #now(): number {
    const clock = this.#options.nowMs;
    if (clock) return clock();
    return typeof performance !== "undefined" ? performance.now() : Date.now();
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
        // Helper implementation pinning: a helper with the right protocol
        // version but wrong/unknown build must NOT stream data into records
        // that tier-1 trust decisions rely on (fail-closed handshake).
        if (String(msg.helperVersion) !== EXPECTED_HELPER_VERSION) {
          this.#fail(
            new NativeTransportError(
              `helper version mismatch: helper reports "${String(msg.helperVersion)}", client expects "${EXPECTED_HELPER_VERSION}"`,
            ),
          );
          return;
        }
        if (typeof msg.nominalRateHz !== "number" || !Number.isFinite(msg.nominalRateHz) || msg.nominalRateHz <= 0) {
          this.#fail(
            new NativeTransportError(
              `malformed welcome: nominalRateHz ${String(msg.nominalRateHz)}`,
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
        // A new epoch means a new helper clock reading base as far as this
        // client is concerned: discard the previous offset rather than
        // carrying it across a reconnect it was never measured for.
        this.#resetClockSync();
        this.#setStatus("streaming", `accepted by ${this.#header.deviceId}`);
        this.#socket?.send(JSON.stringify({ type: "resume-from", lastSequence: null }));
        this.#beginClockSync();
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
      case "time-sync-reply":
        this.#handleTimeSyncReply(msg);
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

    // Helper time is NOT renderer time. Nothing is emitted until the offset
    // between them has been measured; frames that arrive first wait here.
    if (this.#frozenEstimate === null) {
      this.#pendingFrames.push({ ...msg, events });
      this.#bufferedEventCount += events.length;
      if (this.#bufferedEventCount > MAX_BUFFERED_EVENTS_AWAITING_SYNC) {
        this.#failSync(
          `clock synchronization did not complete within ${MAX_BUFFERED_EVENTS_AWAITING_SYNC} buffered events`,
        );
      }
      return;
    }
    for (const ev of events) this.#sink?.onEvent(this.#translate(ev));
  }

  // -------------------------------------------------------------------------
  // Clock synchronization
  // -------------------------------------------------------------------------

  #resetClockSync(): void {
    this.#clockSync = new HelperClockSync();
    this.#frozenEstimate = null;
    this.#pendingProbes.clear();
    this.#probesSent = 0;
    this.#pendingFrames = [];
    this.#bufferedEventCount = 0;
    this.#setSyncState("not-attempted", "new stream epoch");
  }

  #setSyncState(state: ClockSyncStatus["state"], detail: string): void {
    this.#syncState = state;
    this.#syncDetail = detail;
    this.#options.onClockSync?.(this.clockSync);
  }

  #beginClockSync(): void {
    this.#setSyncState("syncing", "measuring helper↔renderer clock offset");
    this.#sendSyncProbe();
  }

  #sendSyncProbe(): void {
    const socket = this.#socket;
    if (!socket || this.#stoppedByCaller) return;
    const id = `s${this.#nextProbeId++}`;
    this.#pendingProbes.set(id, this.#now());
    this.#probesSent++;
    socket.send(JSON.stringify({ type: "time-sync", id }));
  }

  #handleTimeSyncReply(
    msg: Extract<ServerMessage, { type: "time-sync-reply" }>,
  ): void {
    const id = String(msg.id);
    const t0 = this.#pendingProbes.get(id);
    if (t0 === undefined) return; // stale or unsolicited; ignore quietly
    this.#pendingProbes.delete(id);
    if (
      typeof msg.helperMonotonicMs !== "number" ||
      !Number.isFinite(msg.helperMonotonicMs)
    ) {
      this.#failSync(`malformed time-sync reply: ${String(msg.helperMonotonicMs)}`);
      return;
    }
    this.#clockSync.addSample({ t0, helperMs: msg.helperMonotonicMs, t2: this.#now() });

    if (this.#frozenEstimate !== null) {
      // Post-freeze probes exist only to watch the clocks stay together.
      this.#checkDivergence();
      return;
    }
    if (this.#probesSent < this.#syncProbeCount) {
      // Sequential, never a burst: each exchange then measures a quiet round
      // trip, which is what makes the proven bound tight.
      this.#sendSyncProbe();
      return;
    }
    this.#freezeOffsetOrFail();
  }

  #freezeOffsetOrFail(): void {
    const estimate = this.#clockSync.estimate();
    if (estimate === null) {
      this.#failSync(
        `only ${this.#clockSync.sampleCount} usable time-sync exchange(s); need ${MIN_SYNC_PROBES}`,
      );
      return;
    }
    if (estimate.uncertaintyHalfWidthMs > this.#maxSyncUncertaintyMs) {
      this.#setSyncState(
        "untrusted",
        `best clock-offset bound is ±${estimate.uncertaintyHalfWidthMs.toFixed(3)} ms, above the ±${this.#maxSyncUncertaintyMs} ms this build will measure with`,
      );
      this.#fail(
        new NativeTransportError(
          `helper clock offset could only be bounded to ±${estimate.uncertaintyHalfWidthMs.toFixed(3)} ms (limit ±${this.#maxSyncUncertaintyMs} ms)`,
        ),
      );
      return;
    }
    this.#frozenEstimate = estimate;
    this.#setSyncState(
      "established",
      `offset ${estimate.offsetMs.toFixed(3)} ms ±${estimate.uncertaintyHalfWidthMs.toFixed(3)} ms from ${estimate.samples} exchanges`,
    );
    const buffered = this.#pendingFrames;
    this.#pendingFrames = [];
    this.#bufferedEventCount = 0;
    for (const frame of buffered) {
      for (const ev of frame.events as CaptureEvent[]) {
        this.#sink?.onEvent(this.#translate(ev));
      }
    }
  }

  /**
   * A frozen offset is only honest while the two clocks stay together. If a
   * later exchange proves an offset that differs from the frozen one by more
   * than the two bounds allow, the streams have diverged and the epoch is no
   * longer measurable — fail closed rather than keep translating with a
   * number the evidence has contradicted.
   */
  #checkDivergence(): void {
    const frozen = this.#frozenEstimate;
    const current = this.#clockSync.estimate();
    if (frozen === null || current === null) return;
    const drift = Math.abs(current.offsetMs - frozen.offsetMs);
    const allowed =
      frozen.uncertaintyHalfWidthMs +
      current.uncertaintyHalfWidthMs +
      this.#maxSyncUncertaintyMs;
    if (drift > allowed) {
      this.#failSync(
        `helper and renderer clocks diverged by ${drift.toFixed(3)} ms (allowed ${allowed.toFixed(3)} ms)`,
      );
    }
  }

  #failSync(detail: string): void {
    this.#setSyncState("failed", detail);
    this.#pendingFrames = [];
    this.#bufferedEventCount = 0;
    this.#fail(new NativeTransportError(`native capture clock sync failed: ${detail}`));
  }

  /** Rewrites one event's timestamp from helper time into renderer time. */
  #translate(event: CaptureEvent): CaptureEvent {
    const estimate = this.#frozenEstimate;
    if (estimate === null) throw new Error("translate before sync established");
    return { ...event, tMs: event.tMs + estimate.offsetMs };
  }

  /** Runs one extra exchange; used by Diagnostics and by drift monitoring. */
  probeClockSync(): void {
    if (this.#status !== "streaming") return;
    this.#sendSyncProbe();
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
