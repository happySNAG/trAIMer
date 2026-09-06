import type { Viewport } from "../domain/geometry.ts";
import {
  initialReticlePosition,
  POINTER_LOCK_LOSS_REASON,
  TAB_HIDDEN_REASON,
  WINDOW_BLUR_REASON,
  type CaptureEvent,
  type CaptureSink,
  type CaptureSource,
} from "./events.ts";

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
    "The mouse-capture request never completed. The window may not have keyboard focus — click the Aldo Aim Lab window once, then try again.",
  cancelled: "The mouse-capture request was cancelled before it completed.",
  unsupported:
    "This build cannot capture the mouse: the Pointer Lock API is unavailable in this window.",
  "source-stopped": "The capture source was shut down before the request finished.",
  "released-before-start":
    "The mouse was captured but released again before the first trial could start.",
};

export interface MouseButtonLike {
  button: number;
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

  get capabilities(): PointerEventCapabilities | null {
    return this.#capabilities;
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
      if (coalesced.length > 0) {
        for (const sub of coalesced) {
          const ts =
            typeof sub.timeStamp === "number" && Number.isFinite(sub.timeStamp)
              ? sub.timeStamp
              : nowMs();
          emitSample(sub.movementX ?? 0, sub.movementY ?? 0, ts);
        }
        return;
      }
      const ts =
        typeof ev.timeStamp === "number" && Number.isFinite(ev.timeStamp)
          ? ev.timeStamp
          : nowMs();
      emitSample(ev.movementX ?? 0, ev.movementY ?? 0, ts);
    };

    const capabilities = detectPointerEventCapabilities(element as never);
    this.#capabilities = capabilities;
    const moveType =
      capabilities.capturePath === "mousemove" ? "mousemove" : "pointermove";
    this.#listen(element, moveType, handleMove);

    this.#listen(element, "mousedown", (raw) => {
      const ev = raw as MouseButtonLike;
      if (!this.#locked || ev.button !== 0) return;
      sink.onEvent({ kind: "button", tMs: nowMs(), action: "press" });
    });
    this.#listen(element, "mouseup", (raw) => {
      const ev = raw as MouseButtonLike;
      if (!this.#locked || ev.button !== 0) return;
      sink.onEvent({ kind: "button", tMs: nowMs(), action: "release" });
    });
    this.#listen(element, "contextmenu", () => {
      if (this.#locked) sink.onEvent({ kind: "button", tMs: nowMs(), action: "release" });
    });

    // Pointer Lock dispatches `pointerlockchange` / `pointerlockerror` at the
    // DOCUMENT, never at the locked element (Pointer Lock spec §"pointer lock
    // events"). Registering them on the canvas — as this source did until the
    // rc.3 hardware run — means they never fire: every requestLock() then sat
    // until its timeout and reported a denial that had not happened.
    this.#listen(document, "pointerlockchange", () => {
      const isLocked = this.#options.document.pointerLockElement != null;
      const wasLocked = this.#locked;
      this.#locked = isLocked;
      if (!isLocked && wasLocked) {
        sink.onEvent({
          kind: "lock-change",
          tMs: nowMs(),
          locked: false,
          reason: POINTER_LOCK_LOSS_REASON,
        });
        this.#settleLock({
          granted: false,
          reasonCode: "released-before-start",
          detail: "pointer lock was released before the request settled",
        });
      } else if (isLocked && !wasLocked) {
        sink.onEvent({ kind: "lock-change", tMs: nowMs(), locked: true, reason: "acquired" });
        this.#settleLock(LOCK_GRANTED);
      }
    });

    this.#listen(document, "pointerlockerror", () => {
      this.#locked = false;
      sink.onEvent({
        kind: "lock-change",
        tMs: nowMs(),
        locked: false,
        reason: "denied",
      });
      this.#settleLock({
        granted: false,
        reasonCode: "denied",
        detail: "the user agent raised pointerlockerror",
      });
    });

    this.#listen(window, "blur", () => {
      if (!this.#locked) return;
      sink.onEvent({
        kind: "focus-change",
        tMs: nowMs(),
        focused: false,
        reason: WINDOW_BLUR_REASON,
      });
    });
    this.#listen(window, "focus", () => {
      sink.onEvent({ kind: "focus-change", tMs: nowMs(), focused: true, reason: WINDOW_BLUR_REASON });
    });

    this.#listen(document, "visibilitychange", () => {
      if (this.#options.document.hidden) {
        sink.onEvent({
          kind: "focus-change",
          tMs: nowMs(),
          focused: false,
          reason: TAB_HIDDEN_REASON,
        });
      } else {
        sink.onEvent({
          kind: "focus-change",
          tMs: nowMs(),
          focused: true,
          reason: TAB_HIDDEN_REASON,
        });
      }
    });

    this.#listen(window, "resize", () => {
      const viewport = this.#options.viewportProvider();
      sink.onEvent({
        kind: "resize",
        tMs: nowMs(),
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

  releaseLock(): void {
    if (this.#options.document.pointerLockElement != null) {
      this.#options.document.exitPointerLock();
    }
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

  emitForTesting(event: CaptureEvent): void {
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
