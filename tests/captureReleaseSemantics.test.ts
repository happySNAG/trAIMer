import { describe, expect, it } from "vitest";
import {
  PointerLockCaptureSource,
  type BrowserDocumentLike,
  type DomEventTargetLike,
  type LockRequestableElement,
} from "../src/capture/browserSource.ts";
import {
  CAPTURE_RELEASED_REASON,
  POINTER_LOCK_LOSS_REASON,
  type CaptureEvent,
} from "../src/capture/events.ts";

/**
 * THE rc.6 SESSION-KILLER (Pass 13, root cause of "it went back to the main
 * screen after about ten challenges").
 *
 * A break hands the mouse back on purpose. `PointerLockCaptureSource` marks
 * that release so the resulting `pointerlockchange` is reported as
 * CAPTURE_RELEASED_REASON; consumers turn the OTHER reason —
 * POINTER_LOCK_LOSS_REASON — into a fatal interruption that cancels the
 * session.
 *
 * rc.6 cleared the mark inside `releaseLock()` itself:
 *
 *     this.#releaseRequested = deliberate;
 *     document.exitPointerLock();
 *     if (document.pointerLockElement == null) this.#releaseRequested = false;
 *
 * In Chromium/Electron `exitPointerLock()` clears `pointerLockElement`
 * SYNCHRONOUSLY and dispatches `pointerlockchange` in a later task (measured
 * directly in Electron 44). So that "belt and braces" line un-marked every
 * deliberate release before its event arrived, every break reported a LOSS,
 * and the first break silently ended the whole calibration.
 *
 * `FakeDocument` reproduces exactly that ordering, so these tests fail against
 * the rc.6 implementation and pass against the fix.
 */

class FakeDocument implements BrowserDocumentLike {
  pointerLockElement: unknown = null;
  hidden = false;
  #listeners = new Map<string, ((ev: unknown) => void)[]>();
  /** Change events queued by exitPointerLock(), flushed by `flush()`. */
  #queued: (() => void)[] = [];

  addEventListener(type: string, listener: (ev: unknown) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener);
    this.#listeners.set(type, list);
  }

  removeEventListener(type: string, listener: (ev: unknown) => void): void {
    const list = this.#listeners.get(type) ?? [];
    this.#listeners.set(
      type,
      list.filter((l) => l !== listener),
    );
  }

  /** Chromium semantics: element cleared NOW, event dispatched LATER. */
  exitPointerLock(): void {
    if (this.pointerLockElement == null) return;
    this.pointerLockElement = null;
    this.#queued.push(() => this.#dispatch("pointerlockchange"));
  }

  /** Lock acquisition, same split: set now, notify on the next turn. */
  acquire(element: unknown): void {
    this.pointerLockElement = element;
    this.#queued.push(() => this.#dispatch("pointerlockchange"));
  }

  /** A loss we did NOT ask for (Esc, Alt-Tab, focus theft). */
  loseLock(): void {
    this.pointerLockElement = null;
    this.#queued.push(() => this.#dispatch("pointerlockchange"));
  }

  flush(): void {
    const queued = this.#queued;
    this.#queued = [];
    for (const fn of queued) fn();
  }

  #dispatch(type: string): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener({});
  }
}

class FakeTarget implements DomEventTargetLike {
  addEventListener(): void {}
  removeEventListener(): void {}
}

class FakeElement extends FakeTarget implements LockRequestableElement {
  constructor(private readonly doc: FakeDocument) {
    super();
  }
  requestPointerLock(): unknown {
    this.doc.acquire(this);
    return undefined;
  }
}

function makeSource(): {
  source: PointerLockCaptureSource;
  doc: FakeDocument;
  events: CaptureEvent[];
} {
  const doc = new FakeDocument();
  const element = new FakeElement(doc);
  const events: CaptureEvent[] = [];
  const source = new PointerLockCaptureSource({
    element,
    document: doc,
    window: new FakeTarget(),
    viewportProvider: () => ({ widthPx: 1280, heightPx: 720 }),
    lockTimeoutMs: 50,
  });
  source.start({ onEvent: (event) => events.push(event) });
  return { source, doc, events };
}

function lockChanges(events: CaptureEvent[]) {
  return events.filter((e) => e.kind === "lock-change");
}

describe("a release WE asked for is never reported as a loss", () => {
  it("marks a deliberate release as CAPTURE_RELEASED_REASON even though pointerLockElement clears synchronously", () => {
    const { source, doc, events } = makeSource();
    void source.requestLock();
    doc.flush();
    expect(source.isLocked).toBe(true);

    source.releaseLock();
    // Chromium has already cleared the element by this point — the exact
    // condition rc.6 used to un-mark the release.
    expect(doc.pointerLockElement).toBeNull();
    expect(source.deliberateReleasePending).toBe(true);

    doc.flush();
    const released = lockChanges(events).at(-1);
    expect(released).toBeDefined();
    expect(released!.kind).toBe("lock-change");
    if (released!.kind === "lock-change") {
      expect(released!.locked).toBe(false);
      expect(released!.reason).toBe(CAPTURE_RELEASED_REASON);
      expect(released!.reason).not.toBe(POINTER_LOCK_LOSS_REASON);
    }
  });

  it("still reports a genuine, unasked-for loss as POINTER_LOCK_LOSS_REASON", () => {
    const { source, doc, events } = makeSource();
    void source.requestLock();
    doc.flush();
    doc.loseLock();
    doc.flush();
    const lost = lockChanges(events).at(-1);
    if (lost!.kind === "lock-change") {
      expect(lost!.locked).toBe(false);
      expect(lost!.reason).toBe(POINTER_LOCK_LOSS_REASON);
    }
  });

  it("does not leak a deliberate mark into a later real loss", () => {
    const { source, doc, events } = makeSource();
    void source.requestLock();
    doc.flush();

    // Break: deliberate release, consumed by its own change event.
    source.releaseLock();
    doc.flush();
    expect(source.deliberateReleasePending).toBe(false);

    // Back into the arena, then Esc.
    void source.requestLock();
    doc.flush();
    doc.loseLock();
    doc.flush();

    const changes = lockChanges(events);
    const reasons = changes.map((e) => (e.kind === "lock-change" ? e.reason : ""));
    expect(reasons).toEqual([
      "acquired",
      CAPTURE_RELEASED_REASON,
      "acquired",
      POINTER_LOCK_LOSS_REASON,
    ]);
  });

  it("survives several breaks in a row without ever reporting a loss", () => {
    const { source, doc, events } = makeSource();
    for (let block = 0; block < 5; block++) {
      void source.requestLock();
      doc.flush();
      source.releaseLock();
      doc.flush();
    }
    const losses = lockChanges(events).filter(
      (e) => e.kind === "lock-change" && e.reason === POINTER_LOCK_LOSS_REASON,
    );
    expect(losses).toHaveLength(0);
  });

  it("WITNESS: the rc.6 implementation reports the same release as a loss", () => {
    // A faithful re-implementation of rc.6's releaseLock() against the same
    // fake document, so the regression this suite guards is demonstrated
    // rather than merely asserted.
    const doc = new FakeDocument();
    const element = new FakeElement(doc);
    let releaseRequested = false;
    let locked = false;
    const reasons: string[] = [];
    doc.addEventListener("pointerlockchange", () => {
      const isLocked = doc.pointerLockElement != null;
      const wasLocked = locked;
      locked = isLocked;
      if (!isLocked && wasLocked) {
        const deliberate = releaseRequested;
        releaseRequested = false;
        reasons.push(deliberate ? CAPTURE_RELEASED_REASON : POINTER_LOCK_LOSS_REASON);
      }
    });

    element.requestPointerLock();
    doc.flush();

    // rc.6 releaseLock(), verbatim in shape.
    if (doc.pointerLockElement != null) {
      releaseRequested = true;
      doc.exitPointerLock();
      if (doc.pointerLockElement == null) releaseRequested = false; // the bug
    }
    doc.flush();

    expect(reasons).toEqual([POINTER_LOCK_LOSS_REASON]);
  });
});
