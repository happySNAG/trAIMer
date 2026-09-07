import type { Viewport } from "../domain/geometry.ts";
import {
  CAPTURE_RELEASED_REASON,
  initialReticlePosition,
  POINTER_LOCK_LOSS_REASON,
  TAB_HIDDEN_REASON,
  WINDOW_BLUR_REASON,
  type CaptureEvent,
  type CaptureSink,
  type CaptureSource,
} from "./events.ts";
import {
  DOM_CAPTURE_LEAD_TOLERANCE_MS,
  DomTimestampNormalizer,
  type DomTimestampStats,
} from "./timebase.ts";

export interface DomEventTargetLike {
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  removeEventListener(type: string, listener: (ev: unknown) => void): void;
}

export interface LockRequestableElement extends DomEventTargetLike {
  requestPointerLock(): unknown;
}

export interface BrowserDocumentLike extends DomEventTargetLike {
  exitPointerLock(): void;
  readonly pointerLockElement: unknown;
  readonly hidden: boolean;
}

export interface MouseMoveLike {
  movementX?: number;
  movementY?: number;
  timeStamp?: number;
  getCoalescedEvents?(): unknown[];
}

export interface PointerEventCapabilities {
  pointerEventSupported: boolean;
  coalescingSupported: boolean;
  capturePath: "pointermove-coalesced" | "pointermove" | "mousemove";
}

/**
 * Capability detection for high-fidelity pointer capture. Browsers that
 * support Pointer Events with getCoalescedEvents() deliver every raw OS
 * sample between frames; otherwise we fall back to mousemove (frame-coalesced,
 * silent while still). Raw timestamps come from event.timeStamp when finite.
 */
export function detectPointerEventCapabilities(
  element: DomEventTargetLike & { onpointermove?: unknown },
): PointerEventCapabilities {
  const pointerEventSupported = "onpointermove" in element;
  let coalescingSupported = false;
  if (typeof window !== "undefined" && typeof window.PointerEvent === "function") {
    try {
      const probe = new PointerEvent("pointermove", {
        movementX: 1,
        movementY: 0,
      });
      coalescingSupported =
        typeof probe.getCoalescedEvents === "function" &&
        probe.getCoalescedEvents().length >= 0;
    } catch {
      coalescingSupported = false;
    }
  }
  const capturePath: PointerEventCapabilities["capturePath"] =
    pointerEventSupported && coalescingSupported
      ? "pointermove-coalesced"
      : pointerEventSupported
        ? "pointermove"
        : "mousemove";
  return { pointerEventSupported, coalescingSupported, capturePath };
}

/**
 * Why a pointer-lock request ended the way it did. A failed request must
 * always carry a reason the player (and the diagnostic log) can act on —
 * "it just didn't start" is never an acceptable outcome.
 */
export type LockOutcomeCode =
  | "acquired"
  /** The user agent refused the request (pointerlockerror / rejected promise). */
  | "denied"
  /** Neither a change nor an error arrived within the timeout budget. */
  | "timeout"
  /** The player cancelled (Esc / End session / Pause) while the request was pending. */
  | "cancelled"
  /** requestPointerLock() threw or is missing entirely. */
  | "unsupported"
  /** The capture source was torn down before the request settled. */
  | "source-stopped"
  /** Granted, but the lock was gone again before the session could use it. */
  | "released-before-start";

export interface LockOutcome {
  granted: boolean;
  reasonCode: LockOutcomeCode;
  detail: string;
}

export const LOCK_GRANTED: LockOutcome = Object.freeze({
  granted: true,
  reasonCode: "acquired",
  detail: "pointer lock acquired",
});

/** Human-readable, non-blaming explanation for each failure code. */
export const LOCK_FAILURE_GUIDANCE: Record<
  Exclude<LockOutcomeCode, "acquired">,
  string
> = {
  denied:
    "Windows or the browser engine refused to capture the mouse. This usually means the window lost focus, or the pointer was unlocked with Esc less than a second ago.",
  timeout:
    "The mouse-capture request never completed. The window may not have keyboard focus — click the trAIMer window once, then try again.",
  cancelled: "The mouse-capture request was cancelled before it completed.",
  unsupported:
    "This build cannot capture the mouse: the Pointer Lock API is unavailable in this window.",
  "source-stopped": "The capture source was shut down before the request finished.",
  "released-before-start":
    "The mouse was captured but released again before the first trial could start.",
};

export interface MouseButtonLike {
  button: number;
  timeStamp?: number;
}

/** Any DOM event this source reads an occurrence timestamp from. */
export interface TimestampedDomEvent {
  timeStamp?: number;
}

export interface BrowserCaptureOptions {
  element: LockRequestableElement;
  document: BrowserDocumentLike;
  window: DomEventTargetLike;
  viewportProvider(): Viewport;
  lockTimeoutMs?: number;
}

export class VirtualReticle {
  readonly #viewport: Viewport;
  #position: { x: number; y: number };

  constructor(viewport: Viewport) {
    this.#viewport = viewport;
    this.#position = initialReticlePosition(viewport);
  }

  get position(): { x: number; y: number } {
    return { ...this.#position };
  }

  reset(): void {
    this.#position = initialReticlePosition(this.#viewport);
  }

  applyRawDelta(dx: number, dy: number): { dx: number; dy: number } {
    const nextX = Math.min(
      this.#viewport.widthPx,
      Math.max(0, this.#position.x + dx),
    );
    const nextY = Math.min(
      this.#viewport.heightPx,
      Math.max(0, this.#position.y + dy),
    );
    const appliedX = nextX - this.#position.x;
    const appliedY = nextY - this.#position.y;
    this.#position = { x: nextX, y: nextY };
    return { dx: appliedX, dy: appliedY };
  }
}

interface ListenerEntry {
  target: DomEventTargetLike;
  type: string;
  listener: (ev: unknown) => void;
}

export class PointerLockCaptureSource implements CaptureSource {
  readonly descriptor = {
    kind: "browser-pointer-lock" as const,
    description: "Browser Pointer Lock capture (movement deltas at event rate)",
    nominalSampleIntervalMs: null,
    /**
     * Every event this source emits is stamped with the OCCURRENCE time the
     * user agent reported (`event.timeStamp`), which lives in the renderer's
     * `performance.now()` domain but is always a little earlier than the
     * moment the handler runs. See src/capture/timebase.ts.
     */
    timestampDomain: "renderer-monotonic" as const,
    leadToleranceMs: DOM_CAPTURE_LEAD_TOLERANCE_MS,
  };

  readonly #options: BrowserCaptureOptions;
  readonly #reticle: VirtualReticle;
  readonly #listeners: ListenerEntry[] = [];
  #sink: CaptureSink | null = null;
  #locked = false;
  #pendingLock: {
    promise: Promise<LockOutcome>;
    settle: (outcome: LockOutcome) => void;
  } | null = null;
  #lockTimer: ReturnType<typeof setTimeout> | null = null;
  #capabilities: PointerEventCapabilities | null = null;
  #lastOutcome: LockOutcome | null = null;
  /**
   * Turns every incoming DOM `timeStamp` into a renderer-monotonic timestamp
   * and records how far behind the observation clock it was. The recorded
   * distribution is what proves the lead tolerance in
   * src/capture/timebase.ts is the right size on THIS machine, rather than
   * an assumption; it is surfaced in Diagnostics and in Advanced Results.
   */
  readonly #timestamps = new DomTimestampNormalizer();
  /**
   * How many exitPointerLock() calls WE made are still waiting for their
   * pointerlockchange, so each one is reported as CAPTURE_RELEASED_REASON
   * rather than a loss. Consumers turn a loss into a fatal interruption.
   *
   * A COUNTER, not a boolean, and cleared only by the change handler.
   *
   * rc.6 shipped this as a boolean that `releaseLock()` re-cleared the moment
   * `document.pointerLockElement` read back null. In Chromium/Electron
   * `exitPointerLock()` clears `pointerLockElement` SYNCHRONOUSLY and fires
   * `pointerlockchange` in a later task, so that "belt and braces" line
   * un-marked every single deliberate release before its event arrived. Every
   * break therefore surfaced as POINTER_LOCK_LOSS_REASON, which the run
   * controller treats as a fatal interruption — the first break silently
   * ended the whole calibration. Measured in Electron 44:
   * `exitPointerLock()` → `pointerLockElement` null on the next line,
   * `pointerlockchange` one task later.
   */
  #pendingDeliberateReleases = 0;

  get capabilities(): PointerEventCapabilities | null {
    return this.#capabilities;
  }

  /** Observed occurrence→observation lead distribution for this source. */
  get timestampStats(): Readonly<DomTimestampStats> {
    return this.#timestamps.stats;
  }

  /** True while the document reports this source's element as locked. */
  get isLocked(): boolean {
    return this.#locked;
  }

  /** True while a lock request is in flight and has not settled. */
  get lockPending(): boolean {
    return this.#pendingLock !== null;
  }

  /** The last settled lock outcome — the diagnostic the UI surfaces. */
  get lastLockOutcome(): LockOutcome | null {
    return this.#lastOutcome;
  }

  constructor(options: BrowserCaptureOptions) {
    this.#options = options;
    this.#reticle = new VirtualReticle(options.viewportProvider());
  }

  get reticle(): VirtualReticle {
    return this.#reticle;
  }

  start(sink: CaptureSink): void {
    this.#sink = sink;
    const { element, document, window } = this.#options;

    const emitSample = (dx: number, dy: number, tMs: number): void => {
      const applied = this.#reticle.applyRawDelta(dx, dy);
      sink.onEvent({
        kind: "pointer-sample",
        tMs,
        dx: applied.dx,
        dy: applied.dy,
      });
    };

    const handleMove = (raw: unknown): void => {
      const ev = raw as MouseMoveLike;
      if (!this.#locked) return;
      const coalesced =
        typeof ev.getCoalescedEvents === "function"
          ? (ev.getCoalescedEvents() as MouseMoveLike[])
          : [];
      // ONE observation-clock reading for the whole batch: every sample in a
      // coalesced burst was observed at the same instant, so measuring each
      // one against a separately-advancing `performance.now()` would report
      // leads that grew with the loop index rather than with the transport.
      const observedAt = nowMs();
      if (coalesced.length > 0) {
        for (const sub of coalesced) {
          emitSample(
            sub.movementX ?? 0,
            sub.movementY ?? 0,
            this.#timestamps.normalize(sub.timeStamp, observedAt),
          );
        }
        return;
      }
      emitSample(
        ev.movementX ?? 0,
        ev.movementY ?? 0,
        this.#timestamps.normalize(ev.timeStamp, observedAt),
      );
    };

    const capabilities = detectPointerEventCapabilities(element as never);
    this.#capabilities = capabilities;
    const moveType =
      capabilities.capturePath === "mousemove" ? "mousemove" : "pointermove";
    this.#listen(element, moveType, handleMove);

    // Buttons are stamped with their OCCURRENCE time, exactly like pointer
    // samples. rc.7 stamped them with `performance.now()` read inside the
    // handler — the observation clock — which put every shot one input-
    // delivery lag (measured at up to 12.7 ms in Chromium) later than the
    // motion stream it is compared against, inflating every acquisition time
    // and shifting hit detection on moving targets to where the target was
    // AFTER the click. Mixing two sampling instants of one clock is the same
    // class of error as mixing two clocks.
    this.#listen(element, "mousedown", (raw) => {
      const ev = raw as MouseButtonLike;
      if (!this.#locked || ev.button !== 0) return;
      sink.onEvent({ kind: "button", tMs: this.#eventTime(raw), action: "press" });
    });
    this.#listen(element, "mouseup", (raw) => {
      const ev = raw as MouseButtonLike;
      if (!this.#locked || ev.button !== 0) return;
      sink.onEvent({ kind: "button", tMs: this.#eventTime(raw), action: "release" });
    });
    this.#listen(element, "contextmenu", (raw) => {
      if (this.#locked) {
        sink.onEvent({ kind: "button", tMs: this.#eventTime(raw), action: "release" });
      }
    });

    // Pointer Lock dispatches `pointerlockchange` / `pointerlockerror` at the
    // DOCUMENT, never at the locked element (Pointer Lock spec §"pointer lock
    // events"). Registering them on the canvas — as this source did until the
    // rc.3 hardware run — means they never fire: every requestLock() then sat
    // until its timeout and reported a denial that had not happened.
    this.#listen(document, "pointerlockchange", (raw) => {
      const tMs = this.#eventTime(raw);
      const isLocked = this.#options.document.pointerLockElement != null;
      const wasLocked = this.#locked;
      this.#locked = isLocked;
      if (!isLocked && wasLocked) {
        const deliberate = this.#pendingDeliberateReleases > 0;
        if (deliberate) this.#pendingDeliberateReleases--;
        sink.onEvent({
          kind: "lock-change",
          tMs,
          locked: false,
          reason: deliberate ? CAPTURE_RELEASED_REASON : POINTER_LOCK_LOSS_REASON,
        });
        this.#settleLock({
          granted: false,
          reasonCode: "released-before-start",
          detail: "pointer lock was released before the request settled",
        });
      } else if (isLocked && !wasLocked) {
        // A fresh lock supersedes any release we are still waiting on.
        this.#pendingDeliberateReleases = 0;
        sink.onEvent({ kind: "lock-change", tMs, locked: true, reason: "acquired" });
        this.#settleLock(LOCK_GRANTED);
      }
    });

    this.#listen(document, "pointerlockerror", (raw) => {
      this.#locked = false;
      sink.onEvent({
        kind: "lock-change",
        tMs: this.#eventTime(raw),
        locked: false,
        reason: "denied",
      });
      this.#settleLock({
        granted: false,
        reasonCode: "denied",
        detail: "the user agent raised pointerlockerror",
      });
    });

    this.#listen(window, "blur", (raw) => {
      if (!this.#locked) return;
      sink.onEvent({
        kind: "focus-change",
        tMs: this.#eventTime(raw),
        focused: false,
        reason: WINDOW_BLUR_REASON,
      });
    });
    this.#listen(window, "focus", (raw) => {
      sink.onEvent({
        kind: "focus-change",
        tMs: this.#eventTime(raw),
        focused: true,
        reason: WINDOW_BLUR_REASON,
      });
    });

    this.#listen(document, "visibilitychange", (raw) => {
      const tMs = this.#eventTime(raw);
      if (this.#options.document.hidden) {
        sink.onEvent({
          kind: "focus-change",
          tMs,
          focused: false,
          reason: TAB_HIDDEN_REASON,
        });
      } else {
        sink.onEvent({
          kind: "focus-change",
          tMs,
          focused: true,
          reason: TAB_HIDDEN_REASON,
        });
      }
    });

    this.#listen(window, "resize", (raw) => {
      const viewport = this.#options.viewportProvider();
      sink.onEvent({
        kind: "resize",
        tMs: this.#eventTime(raw),
        widthPx: viewport.widthPx,
        heightPx: viewport.heightPx,
      });
    });
  }

  /**
   * Requests Pointer Lock and resolves with a STRUCTURED outcome.
   *
   * Must be called synchronously from a user-gesture handler: Chromium
   * requires user activation for the first lock of a document, and awaiting
   * storage (or anything else) first is what turns a working click into a
   * silent denial.
   *
   * Concurrent callers share one request. That is deliberate: the arena click
   * starts the request inside the gesture, and the session runner's execution
   * gate — which reaches this method milliseconds later, after its own async
   * setup — must join that request rather than issue a second, gesture-less
   * one.
   */
  requestLock(): Promise<LockOutcome> {
    if (this.#locked) return Promise.resolve(LOCK_GRANTED);
    if (this.#pendingLock) return this.#pendingLock.promise;

    let settle!: (outcome: LockOutcome) => void;
    const promise = new Promise<LockOutcome>((resolve) => {
      settle = resolve;
    });
    this.#pendingLock = { promise, settle };

    const timeoutMs = this.#options.lockTimeoutMs ?? 5000;
    this.#lockTimer = setTimeout(
      () =>
        this.#settleLock({
          granted: false,
          reasonCode: "timeout",
          detail: `no pointerlockchange or pointerlockerror within ${timeoutMs} ms`,
        }),
      timeoutMs,
    );

    let requested: unknown;
    try {
      requested = this.#options.element.requestPointerLock();
    } catch (err) {
      this.#settleLock({
        granted: false,
        reasonCode: "unsupported",
        detail: `requestPointerLock() threw: ${describeError(err)}`,
      });
      return promise;
    }

    // Chromium >= 111 returns a Promise from requestPointerLock(). Its
    // rejection carries the real refusal reason, and leaving it unhandled
    // surfaces as an unhandled rejection in the shell.
    if (isPromiseLike(requested)) {
      void Promise.resolve(requested).then(
        () => this.#settleLock(LOCK_GRANTED),
        (err: unknown) =>
          this.#settleLock({
            granted: false,
            reasonCode: "denied",
            detail: describeError(err),
          }),
      );
    }
    return promise;
  }

  /**
   * Cancels an in-flight lock request (Esc, Pause, End session) and releases
   * any lock already held. Settles the pending promise IMMEDIATELY so nothing
   * waits out the timeout: a cancel the player asked for must never look like
   * a hang.
   */
  abortPendingLock(detail = "cancelled before the lock was acquired"): void {
    this.#settleLock({ granted: false, reasonCode: "cancelled", detail });
    this.releaseLock();
  }

  /**
   * Hands the mouse back. `deliberate` (the default) marks the resulting
   * pointerlockchange as CAPTURE_RELEASED_REASON so consumers do not mistake
   * an intentional release — a break, a pause, the end of a session — for the
   * fatal loss of a lock the session still needed.
   */
  releaseLock(deliberate = true): void {
    if (this.#options.document.pointerLockElement == null) return;
    if (deliberate) this.#pendingDeliberateReleases++;
    this.#options.document.exitPointerLock();
    // Deliberately NOT re-checking pointerLockElement here. Chromium clears it
    // synchronously inside exitPointerLock() and dispatches pointerlockchange
    // afterwards; a post-call check therefore always reads "already unlocked"
    // and would cancel the very marker the change handler is about to read.
    // The mark is consumed by that handler (and reset by a fresh lock), so a
    // document that never dispatches cannot leak it into a real loss: a real
    // loss requires being locked again first, which resets the counter.
  }

  /** True while a deliberate release is still waiting for its change event. */
  get deliberateReleasePending(): boolean {
    return this.#pendingDeliberateReleases > 0;
  }

  stop(): void {
    for (const entry of this.#listeners) {
      entry.target.removeEventListener(entry.type, entry.listener);
    }
    this.#listeners.length = 0;
    this.#sink = null;
    this.#settleLock({
      granted: false,
      reasonCode: "source-stopped",
      detail: "capture source stopped before the request settled",
    });
  }

  /**
   * Test adapter seam: pushes a scripted event through the production sink.
   *
   * A pointer sample is applied to the virtual reticle FIRST, exactly as the
   * real pointermove handler does, and re-emitted with the applied (clamped)
   * delta. Without that step the reticle never moved under `?e2e=1`: the
   * recorder's own cursor advanced, but the thing the arena draws — and the
   * thing `arenaSnapshot()` reports — stayed pinned at the centre of the
   * screen for the whole session. The scripted player could therefore never
   * aim at anything, which is why the browser suite had never once exercised
   * a hit.
   */
  emitForTesting(event: CaptureEvent): void {
    if (event.kind === "pointer-sample") {
      const applied = this.#reticle.applyRawDelta(event.dx, event.dy);
      this.#sink?.onEvent({ ...event, dx: applied.dx, dy: applied.dy });
      return;
    }
    this.#sink?.onEvent(event);
  }

  /**
   * Test adapter seam (app/src/testHooks.ts, ?e2e=1 only): resolves a pending
   * lock request as granted and marks the source locked so scripted events
   * flow through the exact production path.
   */
  simulateLockAcquiredForTesting(): void {
    this.#locked = true;
    this.#settleLock(LOCK_GRANTED);
  }

  /** Occurrence time of a DOM event, normalized into the renderer clock. */
  #eventTime(raw: unknown): number {
    const ev = raw as TimestampedDomEvent | null;
    return this.#timestamps.normalize(ev?.timeStamp, nowMs());
  }

  #settleLock(outcome: LockOutcome): void {
    if (this.#lockTimer !== null) {
      clearTimeout(this.#lockTimer);
      this.#lockTimer = null;
    }
    if (!this.#pendingLock) return;
    const { settle } = this.#pendingLock;
    this.#pendingLock = null;
    this.#lastOutcome = outcome;
    settle(outcome);
  }

  #listen(
    target: DomEventTargetLike,
    type: string,
    handler: (ev: unknown) => void,
  ): void {
    const listener = (ev: unknown): void => handler(ev);
    this.#listeners.push({ target, type, listener });
    target.addEventListener(type, listener);
  }
}

function nowMs(): number {
  return performance.now();
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message ? `${err.name}: ${err.message}` : err.name;
  }
  return String(err);
}
