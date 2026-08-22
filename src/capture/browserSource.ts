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
}

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
  #pendingLock: ((granted: boolean) => void) | null = null;
  #lockTimer: ReturnType<typeof setTimeout> | null = null;

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

    this.#listen(element, "mousemove", (raw) => {
      const ev = raw as MouseMoveLike;
      if (!this.#locked) return;
      const applied = this.#reticle.applyRawDelta(ev.movementX ?? 0, ev.movementY ?? 0);
      sink.onEvent({
        kind: "pointer-sample",
        tMs: nowMs(),
        dx: applied.dx,
        dy: applied.dy,
      });
    });

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

    this.#listen(element, "pointerlockchange", () => {
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
        this.#resolvePendingLock(false);
      } else if (isLocked && !wasLocked) {
        sink.onEvent({ kind: "lock-change", tMs: nowMs(), locked: true, reason: "acquired" });
        this.#resolvePendingLock(true);
      }
    });

    this.#listen(element, "pointerlockerror", () => {
      this.#locked = false;
      sink.onEvent({
        kind: "lock-change",
        tMs: nowMs(),
        locked: false,
        reason: "denied",
      });
      this.#resolvePendingLock(false);
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

  async requestLock(): Promise<boolean> {
    const grantedViaListener = new Promise<boolean>((resolve) => {
      this.#pendingLock = resolve;
      this.#lockTimer = setTimeout(() => this.#resolvePendingLock(false), this.#options.lockTimeoutMs ?? 5000);
    });
    try {
      this.#options.element.requestPointerLock();
    } catch {
      this.#resolvePendingLock(false);
    }
    return grantedViaListener;
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
    this.#resolvePendingLock(false);
  }

  emitForTesting(event: CaptureEvent): void {
    this.#sink?.onEvent(event);
  }

  #resolvePendingLock(granted: boolean): void {
    if (this.#lockTimer !== null) {
      clearTimeout(this.#lockTimer);
      this.#lockTimer = null;
    }
    if (this.#pendingLock) {
      const resolve = this.#pendingLock;
      this.#pendingLock = null;
      resolve(granted);
    }
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
