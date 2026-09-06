import { describe, expect, it, vi } from "vitest";
import {
  LOCK_FAILURE_GUIDANCE,
  LOCK_GRANTED,
  PointerLockCaptureSource,
  type BrowserDocumentLike,
  type DomEventTargetLike,
  type LockOutcome,
  type LockRequestableElement,
} from "../src/capture/browserSource.ts";
import { SessionRunner } from "../src/session/runner.ts";
import type { TrialExecutionPort } from "../src/session/types.ts";
import { buildExperimentDefinition } from "../src/experiments/protocol.ts";
import { makeExperimentId, makeTrialId } from "../src/domain/ids.ts";
import type { TrialRecord } from "../src/domain/trial.ts";
import { LocalJsonStore } from "../src/persistence/store.ts";
import { InMemoryBackend } from "../src/persistence/backends.ts";
import { scenarioById } from "../src/domain/scenario.ts";
import {
  decideCaptureTier,
  NATIVE_LIVE_BLOCKER,
} from "../app/src/captureTiers.ts";

/**
 * Test-entry regression suite (Pass 10).
 *
 * rc.3 shipped to real Windows hardware with a test that could not be
 * started: the arena overlay swallowed the click, and — had the click landed —
 * pointer-lock events were listened for on the canvas instead of the document,
 * so the request could only ever time out. Nothing in the suite noticed,
 * because every test either granted the lock virtually or drove a fake that
 * dispatched lock events on the element.
 *
 * These tests pin the whole entry path: acquisition, every failure mode, and
 * the guarantee that no state on the run screen can trap the player.
 */

// --------------------------------------------------------------------------
// A DOM double that behaves like the real thing on the two points that matter:
// lock events are dispatched at the DOCUMENT, and requestPointerLock()
// returns a Promise (Chromium >= 111, which is what Electron 44 embeds).
// --------------------------------------------------------------------------
class FakeTarget {
  readonly listeners = new Map<string, ((ev: unknown) => void)[]>();
  addEventListener(type: string, listener: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, listener: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    const i = list.indexOf(listener);
    if (i >= 0) list.splice(i, 1);
  }
  emit(type: string, ev: unknown = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(ev);
  }
  countFor(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }
}

interface HarnessOptions {
  /** How requestPointerLock() behaves. */
  behaviour?: "manual" | "resolve" | "reject" | "throw" | "silent";
  lockTimeoutMs?: number;
}

function makeHarness(options: HarnessOptions = {}) {
  const behaviour = options.behaviour ?? "manual";
  const elementTarget = new FakeTarget();
  const documentTarget = new FakeTarget();
  const windowTarget = new FakeTarget();
  const state = { pointerLockElement: null as unknown, hidden: false };
  let requests = 0;

  const grant = (): void => {
    state.pointerLockElement = elementTarget;
    documentTarget.emit("pointerlockchange");
  };
  const deny = (): void => {
    state.pointerLockElement = null;
    documentTarget.emit("pointerlockerror");
  };
  const releaseByUser = (): void => {
    state.pointerLockElement = null;
    documentTarget.emit("pointerlockchange");
  };

  const element = Object.assign(elementTarget, {
    requestPointerLock(): unknown {
      requests++;
      switch (behaviour) {
        case "resolve":
          // Chromium fires pointerlockchange first, then resolves.
          return Promise.resolve().then(() => grant());
        case "reject":
          return Promise.reject(new DOMException("user gesture required", "NotAllowedError"));
        case "throw":
          throw new TypeError("requestPointerLock is not a function");
        case "silent":
          // The rc.3 failure shape: nothing ever answers.
          return undefined;
        default:
          return undefined;
      }
    },
  }) as unknown as LockRequestableElement;

  const documentLike = Object.assign(documentTarget, {
    exitPointerLock(): void {
      if (state.pointerLockElement === null) return;
      releaseByUser();
    },
  });
  Object.defineProperty(documentLike, "pointerLockElement", {
    get: () => state.pointerLockElement,
  });
  Object.defineProperty(documentLike, "hidden", { get: () => state.hidden });

  const source = new PointerLockCaptureSource({
    element,
    document: documentLike as unknown as BrowserDocumentLike,
    window: windowTarget as unknown as DomEventTargetLike,
    viewportProvider: () => ({ widthPx: 1280, heightPx: 720 }),
    ...(options.lockTimeoutMs !== undefined ? { lockTimeoutMs: options.lockTimeoutMs } : {}),
  });
  source.start({ onEvent: () => undefined });

  return {
    source,
    elementTarget,
    documentTarget,
    grant,
    deny,
    releaseByUser,
    get requests(): number {
      return requests;
    },
  };
}

describe("pointer-lock entry: successful acquisition", () => {
  it("resolves granted when the DOCUMENT reports the element locked", async () => {
    const h = makeHarness();
    const pending = h.source.requestLock();
    h.grant();
    await expect(pending).resolves.toEqual(LOCK_GRANTED);
    expect(h.source.isLocked).toBe(true);
  });

  it("resolves granted from the promise Chromium returns", async () => {
    const h = makeHarness({ behaviour: "resolve" });
    await expect(h.source.requestLock()).resolves.toMatchObject({ granted: true });
  });

  it("subscribes to lock events on the document, never on the element", () => {
    const h = makeHarness();
    // The rc.3 bug in one assertion: these listeners on the element are dead.
    expect(h.elementTarget.countFor("pointerlockchange")).toBe(0);
    expect(h.elementTarget.countFor("pointerlockerror")).toBe(0);
    expect(h.documentTarget.countFor("pointerlockchange")).toBe(1);
    expect(h.documentTarget.countFor("pointerlockerror")).toBe(1);
  });

  it("shares one in-flight request between the gesture and the runner gate", async () => {
    const h = makeHarness();
    // The arena click starts the request inside the user gesture...
    const fromGesture = h.source.requestLock();
    // ...and the runner's execution gate joins it milliseconds later. Issuing
    // a second, gesture-less request there is what Chromium refuses.
    const fromGate = h.source.requestLock();
    expect(h.requests).toBe(1);
    h.grant();
    await expect(fromGesture).resolves.toMatchObject({ granted: true });
    await expect(fromGate).resolves.toMatchObject({ granted: true });
  });

  it("reports an already-held lock without re-requesting", async () => {
    const h = makeHarness();
    const pending = h.source.requestLock();
    h.grant();
    await pending;
    await expect(h.source.requestLock()).resolves.toMatchObject({ granted: true });
    expect(h.requests).toBe(1);
  });
});

describe("pointer-lock entry: rejection", () => {
  it("reports a denial as soon as pointerlockerror arrives", async () => {
    const h = makeHarness();
    const pending = h.source.requestLock();
    h.deny();
    const outcome = await pending;
    expect(outcome).toMatchObject({ granted: false, reasonCode: "denied" });
    expect(LOCK_FAILURE_GUIDANCE[outcome.reasonCode as "denied"]).toBeTruthy();
  });

  it("reports a denial when the returned promise rejects, carrying the reason", async () => {
    const h = makeHarness({ behaviour: "reject" });
    const outcome = await h.source.requestLock();
    expect(outcome.granted).toBe(false);
    expect(outcome.reasonCode).toBe("denied");
    expect(outcome.detail).toContain("NotAllowedError");
  });

  it("reports 'unsupported' when requestPointerLock() throws", async () => {
    const h = makeHarness({ behaviour: "throw" });
    await expect(h.source.requestLock()).resolves.toMatchObject({
      granted: false,
      reasonCode: "unsupported",
    });
  });

  it("never leaves the returned promise pending on any failure", async () => {
    for (const behaviour of ["reject", "throw"] as const) {
      const h = makeHarness({ behaviour });
      await expect(
        Promise.race([
          h.source.requestLock(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("hung")), 500)),
        ]),
      ).resolves.toBeTruthy();
    }
  });
});

describe("pointer-lock entry: timeout", () => {
  it("gives up with a 'timeout' reason when nothing ever answers", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({ behaviour: "silent", lockTimeoutMs: 4000 });
      const pending = h.source.requestLock();
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(3999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      const outcome = await pending;
      expect(outcome).toMatchObject({ granted: false, reasonCode: "timeout" });
      expect(outcome.detail).toContain("4000 ms");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pointer-lock entry: cancellation while capture is pending", () => {
  it("settles immediately when the player cancels (Esc / End session)", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({ behaviour: "silent", lockTimeoutMs: 60_000 });
      const pending = h.source.requestLock();
      h.source.abortPendingLock("escape pressed");
      // No timer advance at all: a cancel must not wait out the timeout.
      const outcome = await pending;
      expect(outcome).toMatchObject({ granted: false, reasonCode: "cancelled" });
      expect(outcome.detail).toBe("escape pressed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a lock that was granted between the request and the cancel", async () => {
    const h = makeHarness();
    const pending = h.source.requestLock();
    h.grant();
    await pending;
    expect(h.source.isLocked).toBe(true);
    h.source.abortPendingLock();
    expect(h.source.isLocked).toBe(false);
  });

  it("reports the source as unlocked once the player releases it again", async () => {
    // The run controller's execution gate reads exactly this before letting
    // the session enter running: a lock that was granted at click time but
    // released during setup must not be treated as held.
    const h = makeHarness();
    const pending = h.source.requestLock();
    h.grant();
    await expect(pending).resolves.toMatchObject({ granted: true });
    h.releaseByUser();
    expect(h.source.isLocked).toBe(false);
  });

  it("stops reporting a pending request once it has settled", async () => {
    const h = makeHarness();
    const pending = h.source.requestLock();
    expect(h.source.lockPending).toBe(true);
    h.deny();
    await pending;
    expect(h.source.lockPending).toBe(false);
    expect(h.source.lastLockOutcome).toMatchObject({ reasonCode: "denied" });
  });
});

// --------------------------------------------------------------------------
// Session runner: what the engine does with each outcome.
// --------------------------------------------------------------------------
function tinyDefinition() {
  return buildExperimentDefinition({
    id: makeExperimentId("capture-entry-test"),
    name: "capture entry",
    baselineSensitivity: { sensX: 7, sensY: 7 },
    dpi: 800,
    orderSeed: 11,
    measuredRepsPerCandidatePerRound: 1,
    warmupTrialsPerCandidateBlock: 0,
    stoppingCriteria: { maxSearchRounds: 1 },
    restBetweenCandidatesMs: 0,
  });
}

function stubTrial(id: string, scenarioId: string): TrialRecord {
  const scenario = scenarioById(scenarioId);
  return {
    id: makeTrialId(id),
    sessionId: "session-capture-entry" as never,
    experimentId: makeExperimentId("capture-entry-test"),
    candidateId: null,
    indexInSession: 0,
    phase: "measured",
    scenarioId: scenario.id,
    scenarioKind: scenario.kind,
    scenarioRepIndex: 0,
    viewport: { widthPx: 1280, heightPx: 720 },
    sensitivity: { sensX: 7, sensY: 7 },
    dpi: 800,
    expectedSampleIntervalMs: null,
    startedAtMonotonicMs: 0,
    endedAtMonotonicMs: 100,
    seedTag: "t",
    outcome: "hit",
    events: [],
    targets: [],
    shots: [],
    cursorSamples: [],
    validity: { status: "valid", reasons: [] },
  } as unknown as TrialRecord;
}

function makeRunner(
  requestLock: () => Promise<LockOutcome>,
): { runner: SessionRunner; released: { count: number } } {
  const released = { count: 0 };
  const execution: TrialExecutionPort = {
    requestLock,
    executeTrial: async (spec) => stubTrial(`t-${spec.sequenceNumber}`, spec.scenarioId),
    releaseCapture: async () => {
      released.count++;
    },
  };
  const definition = tinyDefinition();
  const runner = new SessionRunner(definition, {
    clock: { nowMs: () => 0 },
    sleep: async () => undefined,
    nowIso: () => "2026-09-06T00:00:00.000Z",
    store: new LocalJsonStore(new InMemoryBackend()),
    execution,
  });
  return { runner, released };
}

describe("session runner: the execution gate never hangs or lies", () => {
  it("aborts with the structured reason when the lock is denied", async () => {
    const { runner, released } = makeRunner(async () => ({
      granted: false,
      reasonCode: "denied",
      detail: "the user agent raised pointerlockerror",
    }));
    const outcome = await runner.run();
    expect(outcome.status).toBe("aborted");
    expect(outcome.abortReason).toEqual({
      code: "denied",
      detail: "the user agent raised pointerlockerror",
    });
    expect(outcome.trials).toHaveLength(0);
    // The mouse is always handed back.
    expect(released.count).toBe(1);
  });

  it("records the failure in the audit trail", async () => {
    const { runner } = makeRunner(async () => ({
      granted: false,
      reasonCode: "timeout",
      detail: "no answer within 5000 ms",
    }));
    await runner.run();
    const entry = runner
      .auditEntries()
      .find((e) => e.category === "capture-unavailable");
    expect(entry?.detail).toMatchObject({ reasonCode: "timeout" });
  });

  it("honours a cancel that arrived before capture was ever requested", async () => {
    const requestLock = vi.fn(async () => LOCK_GRANTED);
    const { runner } = makeRunner(requestLock);
    runner.cancel();
    const outcome = await runner.run();
    expect(outcome.status).toBe("aborted");
    expect(outcome.abortReason?.code).toBe("cancelled");
    // The player is never asked for the mouse after ending the session.
    expect(requestLock).not.toHaveBeenCalled();
  });

  it("honours a cancel that lands while capture is being requested", async () => {
    let cancelDuringRequest: (() => void) | null = null;
    const { runner } = makeRunner(async () => {
      cancelDuringRequest?.();
      return { granted: false, reasonCode: "cancelled", detail: "aborted by the player" };
    });
    cancelDuringRequest = () => runner.cancel();
    const outcome = await runner.run();
    expect(outcome.status).toBe("aborted");
    expect(outcome.abortReason?.code).toBe("cancelled");
  });

  it("runs no trial at all when the input path is not ready", async () => {
    const executed = vi.fn();
    const definition = tinyDefinition();
    const states: string[] = [];
    const runner = new SessionRunner(definition, {
      clock: { nowMs: () => 0 },
      sleep: async () => undefined,
      nowIso: () => "2026-09-06T00:00:00.000Z",
      store: new LocalJsonStore(new InMemoryBackend()),
      execution: {
        requestLock: async () => ({
          granted: false,
          reasonCode: "released-before-start" as const,
          detail: "the mouse was released before the first trial started",
        }),
        executeTrial: async (spec) => {
          executed();
          return stubTrial(`t-${spec.sequenceNumber}`, spec.scenarioId);
        },
        releaseCapture: async () => undefined,
      },
      onStateChange: (state) => states.push(state),
    });
    const outcome = await runner.run();
    expect(executed).not.toHaveBeenCalled();
    expect(outcome.abortReason?.code).toBe("released-before-start");
    // The gate is reached, and nothing past it is.
    expect(states).toContain("awaiting-lock");
    expect(states).not.toContain("trial-active");
    expect(states.at(-1)).toBe("aborted");
  });
});

// --------------------------------------------------------------------------
// Capture-tier selection: what the run screen is allowed to claim.
// --------------------------------------------------------------------------
const COALESCED = {
  pointerEventSupported: true,
  coalescingSupported: true,
  capturePath: "pointermove-coalesced" as const,
};

describe("capture tier selection", () => {
  it("selects tier 1 on a Windows machine whose helper is ready and validated", () => {
    const report = decideCaptureTier({
      shellPresent: true,
      platformSupported: true,
      helperState: "ready",
      selfTest: { verdict: "pass", sourceKind: "native" },
      browser: COALESCED,
      nativeLiveTransportEnabled: true,
    });
    expect(report.activeTier).toBe(1);
    expect(report.activeKind).toBe("native");
    expect(report.native.helperReady).toBe(true);
    expect(report.native.validatedByDiagnostics).toBe(true);
    expect(report.native.rejectedBecause).toBeNull();
    expect(report.caption).toBe("native capture · raw input");
  });

  it("keeps browser capture while the live native transport is still gated", () => {
    const report = decideCaptureTier({
      shellPresent: true,
      platformSupported: true,
      helperState: "ready",
      selfTest: { verdict: "pass", sourceKind: "native" },
      browser: COALESCED,
      nativeLiveTransportEnabled: false,
    });
    expect(report.activeKind).toBe("browser-pointer-lock");
    // A ready helper that is not carrying the session must SAY so.
    expect(report.native.helperReady).toBe(true);
    expect(report.native.rejectedBecause).toBe(NATIVE_LIVE_BLOCKER);
    expect(report.detail).toContain(NATIVE_LIVE_BLOCKER);
  });

  it("never trusts a ready-but-unvalidated helper", () => {
    const report = decideCaptureTier({
      shellPresent: true,
      platformSupported: true,
      helperState: "ready",
      selfTest: null,
      browser: COALESCED,
      nativeLiveTransportEnabled: true,
    });
    expect(report.activeKind).toBe("browser-pointer-lock");
    expect(report.native.validatedByDiagnostics).toBe(false);
    expect(report.native.rejectedBecause).toContain("unvalidated");
  });

  it("never counts a browser self-test as native validation", () => {
    const report = decideCaptureTier({
      shellPresent: true,
      platformSupported: true,
      helperState: "ready",
      selfTest: { verdict: "pass", sourceKind: "browser-pointer-lock" },
      browser: COALESCED,
      nativeLiveTransportEnabled: true,
    });
    expect(report.native.validatedByDiagnostics).toBe(false);
  });

  it("explains a helper that never came up", () => {
    const report = decideCaptureTier({
      shellPresent: true,
      platformSupported: true,
      helperState: "unavailable",
      selfTest: { verdict: "pass", sourceKind: "native" },
      browser: COALESCED,
      nativeLiveTransportEnabled: true,
    });
    expect(report.native.rejectedBecause).toContain("unavailable");
  });

  it("falls to tier 3 without coalesced pointer events", () => {
    const report = decideCaptureTier({
      shellPresent: false,
      platformSupported: false,
      helperState: "no-shell",
      selfTest: null,
      browser: {
        pointerEventSupported: false,
        coalescingSupported: false,
        capturePath: "mousemove",
      },
      nativeLiveTransportEnabled: false,
    });
    expect(report.activeTier).toBe(3);
    expect(report.native.rejectedBecause).toBe("not running in the desktop shell");
  });
});
