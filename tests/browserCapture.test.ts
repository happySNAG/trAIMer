import { describe, expect, it } from "vitest";
import {
  PointerLockCaptureSource,
  VirtualReticle,
  type BrowserDocumentLike,
  type DomEventTargetLike,
  type LockRequestableElement,
} from "../src/capture/browserSource.ts";
import type { CaptureEvent } from "../src/capture/events.ts";

class FakeTarget {
  readonly listeners = new Map<string, ((ev: unknown) => void)[]>();
  lockRequested = false;
  pointerLockElementValue: unknown = null;

  addEventListener(type: string, listener: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, listener: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  }
  requestPointerLock(): void {
    this.lockRequested = true;
  }
  emit(type: string, ev: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(ev);
  }
}

function makeHarness() {
  const element = new FakeTarget();
  const docLike = new FakeTarget();
  const win = new FakeTarget();
  const documentLike = docLike as unknown as BrowserDocumentLike & FakeTarget;
  Object.defineProperty(documentLike, "pointerLockElement", {
    get: () => element.pointerLockElementValue,
  });
  documentLike.exitPointerLock = () => {
    element.pointerLockElementValue = null;
    // Pointer Lock dispatches lock events at the DOCUMENT, never at the
    // element. The harness models that faithfully: a fake that emitted them
    // on the element is exactly what let the rc.3 bug ship.
    docLike.emit("pointerlockchange", {});
  };
  let hiddenFlag = false;
  Object.defineProperty(documentLike, "hidden", {
    get: () => hiddenFlag,
    configurable: true,
  });

  const source = new PointerLockCaptureSource({
    element: element as unknown as LockRequestableElement,
    document: documentLike as unknown as BrowserDocumentLike,
    window: win as unknown as DomEventTargetLike,
    viewportProvider: () => ({ widthPx: 1280, heightPx: 720 }),
  });

  const events: CaptureEvent[] = [];
  source.start({ onEvent: (event) => events.push(event) });
  return {
    source,
    element,
    docLike,
    win,
    events,
    documentLike,
    setHidden(value: boolean): void {
      hiddenFlag = value;
    },
  };
}

describe("virtual reticle", () => {
  it("starts at the viewport center", () => {
    const reticle = new VirtualReticle({ widthPx: 1280, heightPx: 720 });
    expect(reticle.position).toEqual({ x: 640, y: 360 });
  });

  it("clamps to viewport bounds and reports only applied deltas", () => {
    const reticle = new VirtualReticle({ widthPx: 100, heightPx: 100 });
    const first = reticle.applyRawDelta(-5000, -5000);
    expect(first).toEqual({ dx: -50, dy: -50 });
    expect(reticle.position).toEqual({ x: 0, y: 0 });
    const overflow = reticle.applyRawDelta(-30, 10);
    expect(overflow).toEqual({ dx: 0, dy: 10 });
  });
});

describe("pointer lock capture source", () => {
  it("emits clamped pointer samples and button presses while locked", () => {
    const harness = makeHarness();
    harness.element.pointerLockElementValue = {};
    harness.docLike.emit("pointerlockchange", {});

    harness.element.emit("mousemove", { movementX: 12, movementY: -5 });
    harness.element.emit("mousedown", { button: 0 });
    harness.element.emit("mouseup", { button: 0 });

    const samples = harness.events.filter((e) => e.kind === "pointer-sample");
    expect(samples.length).toBe(1);
    expect(samples[0]).toMatchObject({ dx: 12, dy: -5 });

    const presses = harness.events.filter((e) => e.kind === "button" && e.action === "press");
    expect(presses.length).toBe(1);
  });

  it("ignores mouse input while unlocked", () => {
    const harness = makeHarness();
    harness.element.emit("mousemove", { movementX: 40, movementY: 40 });
    harness.element.emit("mousedown", { button: 0 });
    expect(harness.events.filter((e) => e.kind === "pointer-sample")).toHaveLength(0);
    expect(harness.events.filter((e) => e.kind === "button")).toHaveLength(0);
  });

  it("emits a fatal lock-change event on unexpected lock loss", async () => {
    const harness = makeHarness();
    harness.element.pointerLockElementValue = {};
    harness.docLike.emit("pointerlockchange", {});
    harness.events.length = 0;

    harness.element.pointerLockElementValue = null;
    harness.docLike.emit("pointerlockchange", {});

    const lockEvents = harness.events.filter((e) => e.kind === "lock-change");
    expect(lockEvents.length).toBe(1);
    expect(lockEvents[0]).toMatchObject({ locked: false, reason: "pointer-lock-loss" });
    void harness;
  });

  it("reports a denial with reasonCode on pointerlockerror", async () => {
    const harness = makeHarness();
    const promise = harness.source.requestLock();
    harness.docLike.emit("pointerlockerror", {});
    await expect(promise).resolves.toMatchObject({
      granted: false,
      reasonCode: "denied",
    });
  });

  it("reports a grant on successful acquisition", async () => {
    const harness = makeHarness();
    const promise = harness.source.requestLock();
    harness.element.pointerLockElementValue = {};
    harness.docLike.emit("pointerlockchange", {});
    await expect(promise).resolves.toMatchObject({
      granted: true,
      reasonCode: "acquired",
    });
  });

  it("reports source-stopped when the source is torn down before a grant", async () => {
    const harness = makeHarness();
    const promise = harness.source.requestLock();
    harness.source.stop();
    await expect(promise).resolves.toMatchObject({
      granted: false,
      reasonCode: "source-stopped",
    });
  });

  it("records tab-hidden and window-blur focus interruptions", () => {
    const harness = makeHarness();
    harness.element.pointerLockElementValue = {};
    harness.docLike.emit("pointerlockchange", {});

    harness.setHidden(true);
    harness.docLike.emit("visibilitychange", {});
    harness.setHidden(false);
    const tabEvent = harness.events.find(
      (e) => e.kind === "focus-change" && !e.focused,
    );
    expect(tabEvent).toBeDefined();

    harness.win.emit("blur", {});
    const blurEvent = harness.events.filter((e) => e.kind === "focus-change" && !e.focused);
    expect(blurEvent.length).toBeGreaterThanOrEqual(2);
  });

  it("emits resize with current viewport dimensions", () => {
    const harness = makeHarness();
    harness.win.emit("resize", {});
    const resize = harness.events.find((e) => e.kind === "resize");
    expect(resize).toMatchObject({ widthPx: 1280, heightPx: 720 });
  });

  it("detaches all listeners on stop()", () => {
    const harness = makeHarness();
    const before = [...harness.element.listeners.entries()].map(([k, v]) => `${k}:${v.length}`);
    harness.source.stop();
    const after = [...harness.element.listeners.entries()].map(([k, v]) => `${k}:${v.length}`);
    expect(after.join()).not.toBe(before.join());
  });
});
