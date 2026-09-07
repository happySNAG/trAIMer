import { describe, expect, it } from "vitest";
import {
  LOCK_GRANTED,
  PointerLockCaptureSource,
  type BrowserDocumentLike,
  type DomEventTargetLike,
  type LockOutcome,
  type LockRequestableElement,
} from "../src/capture/browserSource.ts";
import {
  CAPTURE_RELEASED_REASON,
  POINTER_LOCK_LOSS_REASON,
  type CaptureEvent,
} from "../src/capture/events.ts";
import { TrialRecorder } from "../src/capture/recorder.ts";
import { SessionRunner } from "../src/session/runner.ts";
import type { TrialExecutionPort } from "../src/session/types.ts";
import { buildExperimentDefinition } from "../src/experiments/protocol.ts";
import { makeExperimentId, makeTrialId } from "../src/domain/ids.ts";
import type { TrialRecord } from "../src/domain/trial.ts";
import { LocalJsonStore } from "../src/persistence/store.ts";
import { InMemoryBackend } from "../src/persistence/backends.ts";
import { scenarioById } from "../src/domain/scenario.ts";
import { validateTrial } from "../src/validation/validateTrial.ts";
import { trialRequest } from "./arenaHarness.ts";

/**
 * "The time out screen you can't skip cause it freezes your mouse."
 *   — Aldo, rc.5 on real Windows hardware.
 *
 * The break screen ("time out") offers a Skip break button, and the bottom bar
 * offers Pause and End session. rc.5 drew all of them while the arena still
 * held Pointer Lock: under a lock Windows hides the cursor and routes every
 * click to the locked element, so there was nothing to press those controls
 * with. Space and Enter worked, but a player who reaches for the mouse — which
 * is what a button asks you to do — finds it frozen.
 *
 * It stayed invisible to the suite because the browser E2E adapter grants the
 * lock VIRTUALLY: no real pointer lock is ever held there, so every overlay
 * button is trivially clickable. These tests use the real capture source and a
 * DOM double that behaves like Chromium on the points that matter.
 *
 * The guarantee: gameplay capture is released BEFORE any interlude UI is
 * presented, the release is not mistaken for a lost lock, and the mouse is
 * taken back on the way out — for breaks and pauses alike.
 */

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

/** A Chromium-shaped pointer-lock double: lock events land on the DOCUMENT. */
function makeCapture(options: { grantOnRequest?: boolean } = {}) {
  const grantOnRequest = options.grantOnRequest ?? true;
  const elementTarget = new FakeTarget();
  const documentTarget = new FakeTarget();
  const windowTarget = new FakeTarget();
  const state = { pointerLockElement: null as unknown, hidden: false };
  const events: CaptureEvent[] = [];
  let requests = 0;
  let exits = 0;

  const element = Object.assign(elementTarget, {
    requestPointerLock(): unknown {
      requests++;
      if (!grantOnRequest) {
        return Promise.reject(new Error("NotAllowedError: user gesture required"));
      }
      return Promise.resolve().then(() => {
        state.pointerLockElement = elementTarget;
        documentTarget.emit("pointerlockchange");
      });
    },
  }) as unknown as LockRequestableElement;

  const documentLike = Object.assign(documentTarget, {
    exitPointerLock(): void {
      if (state.pointerLockElement === null) return;
      exits++;
      state.pointerLockElement = null;
      documentTarget.emit("pointerlockchange");
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
  });
  source.start({ onEvent: (event) => events.push(event) });

  return {
    source,
    events,
    elementTarget,
    documentTarget,
    /** True when Windows would show a normal cursor. */
    get cursorFree(): boolean {
      return state.pointerLockElement === null;
    },
    get requests(): number {
      return requests;
    },
    get exits(): number {
      return exits;
    },
    loseLockLikeEscape(): void {
      state.pointerLockElement = null;
      documentTarget.emit("pointerlockchange");
    },
  };
}

describe("a deliberate release is not a lost lock", () => {
  it("reports CAPTURE_RELEASED_REASON, not a pointer-lock loss", async () => {
    const h = makeCapture();
    await h.source.requestLock();
    expect(h.source.isLocked).toBe(true);
    h.source.releaseLock();
    const lockEvents = h.events.filter((e) => e.kind === "lock-change");
    expect(lockEvents.at(-1)).toMatchObject({
      locked: false,
      reason: CAPTURE_RELEASED_REASON,
    });
    expect(h.cursorFree).toBe(true);
  });

  it("still reports a REAL loss (Esc, focus steal) as a loss", async () => {
    const h = makeCapture();
    await h.source.requestLock();
    h.loseLockLikeEscape();
    expect(h.events.filter((e) => e.kind === "lock-change").at(-1)).toMatchObject({
      locked: false,
      reason: POINTER_LOCK_LOSS_REASON,
    });
  });

  it("does not let the deliberate flag leak into the next real loss", async () => {
    const h = makeCapture();
    await h.source.requestLock();
    h.source.releaseLock();
    await h.source.requestLock();
    h.loseLockLikeEscape();
    expect(h.events.filter((e) => e.kind === "lock-change").at(-1)).toMatchObject({
      reason: POINTER_LOCK_LOSS_REASON,
    });
  });

  it("a released lock is not recorded as a focus interruption", () => {
    const scenario = scenarioById("flick-static-medium");
    const recorder = new TrialRecorder(trialRequest(scenario, "released"));
    recorder.add({
      kind: "target-spawn",
      tMs: 1050,
      targetId: "t" as never,
      radiusPx: 26,
      motion: { kind: "static", position: { x: 700, y: 360 } },
    });
    recorder.add({
      kind: "lock-change",
      tMs: 1200,
      locked: false,
      reason: CAPTURE_RELEASED_REASON,
    });
    const record = recorder.finish("hit", 1400);
    expect(record.focusInterruptions).toHaveLength(0);
    const validated = validateTrial(record);
    expect(validated.reasons.map((r) => r.code)).not.toContain("POINTER_LOCK_LOSS");
  });

  it("gameplay input is inert while the mouse is released", async () => {
    const h = makeCapture();
    await h.source.requestLock();
    h.elementTarget.emit("mousedown", { button: 0 });
    const whileLocked = h.events.filter((e) => e.kind === "button").length;
    expect(whileLocked).toBe(1);
    h.source.releaseLock();
    h.elementTarget.emit("mousedown", { button: 0 });
    h.elementTarget.emit("pointermove", { movementX: 40, movementY: 40 });
    expect(h.events.filter((e) => e.kind === "button").length).toBe(whileLocked);
    expect(h.events.filter((e) => e.kind === "pointer-sample")).toHaveLength(0);
  });

  it("repeated release/acquire cycles leak no listeners", async () => {
    const h = makeCapture();
    for (let i = 0; i < 6; i++) {
      await h.source.requestLock();
      h.source.releaseLock();
    }
    expect(h.documentTarget.countFor("pointerlockchange")).toBe(1);
    expect(h.documentTarget.countFor("pointerlockerror")).toBe(1);
    expect(h.elementTarget.countFor("mousedown")).toBe(1);
    expect(h.exits).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// The session runner side: the mouse goes back BEFORE the break screen.
// ---------------------------------------------------------------------------

function manualTime() {
  let now = 0;
  const pending: { at: number; resolve: () => void }[] = [];
  return {
    clock: { nowMs: () => now },
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        pending.push({ at: now + ms, resolve });
      }),
    async advance(ms: number): Promise<void> {
      now += ms;
      for (const p of [...pending]) {
        if (p.at <= now) {
          pending.splice(pending.indexOf(p), 1);
          p.resolve();
        }
      }
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
  };
}

function stubTrial(id: string, scenarioId: string, startedAt: number): TrialRecord {
  const scenario = scenarioById(scenarioId);
  return {
    id: makeTrialId(id),
    sessionId: "session-break" as never,
    experimentId: makeExperimentId("break-release"),
    candidateId: null,
    indexInSession: 0,
    phase: "measured",
    scenarioId: scenario.id,
    scenarioKind: scenario.kind,
    captureContext: {
      scenarioKind: scenario.kind,
      viewport: { widthPx: 1280, heightPx: 720 },
      sensitivity: { sensX: 7, sensY: 7 },
      dpi: 800,
      expectedSampleIntervalMs: null,
    },
    scenarioRepIndex: 0,
    startedAtMonotonicMs: startedAt,
    endedAtMonotonicMs: startedAt + 500,
    seedTag: "t",
    outcome: "hit",
    samples: Array.from({ length: 40 }, (_, i) => ({
      tMs: startedAt + i * 8,
      cursor: { x: 640 + i, y: 360 },
      dx: 1,
      dy: 0,
    })),
    targets: [
      {
        targetId: "target-x" as never,
        radiusPx: 24,
        appearedMs: startedAt + 50,
        removedMs: startedAt + 480,
        removalReason: "hit",
        motion: { kind: "static", position: { x: 700, y: 360 } },
      },
    ],
    shots: [
      {
        tMs: startedAt + 470,
        cursorAtShot: { x: 700, y: 360 },
        aimedTargetId: "target-x" as never,
        hit: true,
        missDistancePx: 0,
      },
    ],
    focusInterruptions: [],
    viewportResizes: [],
    validity: { status: "valid", reasons: [] },
    abortedMs: null,
  } as unknown as TrialRecord;
}

/**
 * A runner wired to the REAL capture source through the same execution port
 * shape the browser controller supplies.
 */
function makeSession(options: { restMs?: number; resumeGranted?: boolean } = {}) {
  const restMs = options.restMs ?? 10_000;
  const resumeGranted = options.resumeGranted ?? true;
  const time = manualTime();
  const capture = makeCapture();
  const log: string[] = [];
  /** Was the mouse free at the moment the break UI was announced? */
  const cursorFreeAtRestStart: boolean[] = [];

  const execution: TrialExecutionPort = {
    requestLock: async () => {
      const outcome = await capture.source.requestLock();
      log.push(`requestLock:${outcome.reasonCode}`);
      return outcome;
    },
    executeTrial: async (spec) =>
      stubTrial(`t-${spec.sequenceNumber}`, spec.scenarioId, time.clock.nowMs()),
    releaseCapture: async () => {
      capture.source.releaseLock();
      log.push("releaseCapture");
    },
    suspendCapture: async (reason) => {
      capture.source.releaseLock();
      log.push(`suspend:${reason}`);
    },
    resumeCapture: async (reason): Promise<LockOutcome> => {
      log.push(`resume:${reason}`);
      if (!resumeGranted) {
        return { granted: false, reasonCode: "denied", detail: "scripted refusal" };
      }
      return capture.source.requestLock();
    },
  };

  const definition = buildExperimentDefinition({
    id: makeExperimentId("break-release"),
    name: "break release",
    baselineSensitivity: { sensX: 7, sensY: 7 },
    dpi: 800,
    orderSeed: 3,
    measuredRepsPerCandidatePerRound: 1,
    warmupTrialsPerCandidateBlock: 0,
    stoppingCriteria: { maxSearchRounds: 1 },
    restBetweenCandidatesMs: restMs,
  });

  const runner = new SessionRunner(definition, {
    clock: time.clock,
    sleep: time.sleep,
    nowIso: () => "2026-09-06T00:00:00.000Z",
    store: new LocalJsonStore(new InMemoryBackend()),
    execution,
    onRest: (rest) => {
      log.push(rest ? "onRest:start" : "onRest:end");
      if (rest) cursorFreeAtRestStart.push(capture.cursorFree);
    },
  });

  return { runner, time, capture, log, cursorFreeAtRestStart };
}

async function drive(
  session: ReturnType<typeof makeSession>,
  onTick?: (elapsed: number) => void,
  stepMs = 100,
): Promise<Awaited<ReturnType<SessionRunner["run"]>>> {
  let result: Awaited<ReturnType<SessionRunner["run"]>> | null = null;
  void session.runner.run().then((r) => (result = r));
  let elapsed = 0;
  while (result === null && elapsed < 600_000) {
    await session.time.advance(stepMs);
    elapsed += stepMs;
    onTick?.(elapsed);
  }
  if (result === null) throw new Error("session did not finish");
  return result;
}

describe("the break screen gets the mouse back before it asks for a click", () => {
  it("releases pointer lock BEFORE the break is announced", async () => {
    const session = makeSession();
    await drive(session);
    const firstRest = session.log.indexOf("onRest:start");
    const firstSuspend = session.log.findIndex((e) => e.startsWith("suspend:rest:"));
    expect(firstSuspend).toBeGreaterThanOrEqual(0);
    expect(firstSuspend).toBeLessThan(firstRest);
    // Every break began with a usable cursor.
    expect(session.cursorFreeAtRestStart.length).toBeGreaterThan(0);
    expect(session.cursorFreeAtRestStart.every(Boolean)).toBe(true);
  });

  it("keeps the mouse free for the whole break, then takes it back", async () => {
    const session = makeSession();
    const duringRest: boolean[] = [];
    let restSeen = false;
    let lockedAgainAfterRest = false;
    await drive(session, () => {
      if (session.runner.resting) {
        restSeen = true;
        duringRest.push(session.capture.cursorFree);
        return;
      }
      // A drill after the break must be running under a real lock again.
      if (restSeen && session.runner.state !== "complete" && !session.capture.cursorFree) {
        lockedAgainAfterRest = true;
      }
    });
    expect(duringRest.length).toBeGreaterThan(3);
    expect(duringRest.every(Boolean)).toBe(true);
    expect(session.log.filter((e) => e.startsWith("resume:rest:")).length).toBeGreaterThan(0);
    expect(lockedAgainAfterRest).toBe(true);
  });

  it("Skip break works while the mouse is free, and play resumes locked", async () => {
    const session = makeSession({ restMs: 30_000 });
    let skipped = false;
    let cursorFreeWhenSkipped: boolean | null = null;
    const outcome = await drive(session, () => {
      if (!skipped && session.runner.resting) {
        cursorFreeWhenSkipped = session.capture.cursorFree;
        session.runner.skipRest();
        skipped = true;
      }
    });
    expect(skipped).toBe(true);
    expect(cursorFreeWhenSkipped).toBe(true);
    expect(outcome.status).toBe("complete");
    const restEnded = outcome.auditTrail.filter((e) => e.category === "rest-ended");
    expect(restEnded.some((e) => e.detail.skipped === 1)).toBe(true);
  });

  it("records the suspend/resume pair in the audit trail", async () => {
    const session = makeSession();
    const outcome = await drive(session);
    const suspends = outcome.auditTrail.filter((e) => e.category === "capture-suspended");
    const resumes = outcome.auditTrail.filter((e) => e.category === "capture-resumed");
    expect(suspends.length).toBeGreaterThan(0);
    expect(resumes.length).toBe(suspends.length);
    expect(resumes.every((e) => e.detail.granted === 1)).toBe(true);
  });

  it("re-acquires cleanly across repeated break cycles and leaks no listeners", async () => {
    const session = makeSession();
    const outcome = await drive(session);
    expect(outcome.status).toBe("complete");
    expect(session.capture.documentTarget.countFor("pointerlockchange")).toBe(1);
    expect(session.capture.elementTarget.countFor("mousedown")).toBe(1);
    // One release and one re-acquisition per break, plus the session's own
    // final release.
    const suspends = session.log.filter((e) => e.startsWith("suspend:")).length;
    const resumes = session.log.filter((e) => e.startsWith("resume:")).length;
    expect(suspends).toBe(resumes);
    expect(suspends).toBeGreaterThanOrEqual(4);
  });

  it("a pause uses the SAME cleanup as a break", async () => {
    const session = makeSession({ restMs: 0 });
    let paused = false;
    let cursorFreeWhilePaused: boolean | null = null;
    const outcome = await drive(session, (elapsed) => {
      if (!paused && elapsed >= 200) {
        session.runner.pause();
        paused = true;
        return;
      }
      if (paused && session.runner.state === "paused" && cursorFreeWhilePaused === null) {
        cursorFreeWhilePaused = session.capture.cursorFree;
        session.runner.resume();
      }
    });
    expect(cursorFreeWhilePaused).toBe(true);
    expect(session.log).toContain("suspend:pause");
    expect(session.log).toContain("resume:pause");
    expect(outcome.status).toBe("complete");
    // Same shape as a break: release, then re-acquire — one cleanup path.
    expect(session.log.indexOf("suspend:pause")).toBeLessThan(
      session.log.indexOf("resume:pause"),
    );
  });

  it("a refused re-acquisition ends the session with a named reason", async () => {
    const session = makeSession({ resumeGranted: false });
    const outcome = await drive(session);
    expect(outcome.status).toBe("aborted");
    expect(outcome.abortReason?.code).toBe("denied");
    expect(
      outcome.auditTrail.some((e) => e.category === "capture-unavailable"),
    ).toBe(true);
  });

  it("ending the session during a break does not ask for the mouse back", async () => {
    const session = makeSession({ restMs: 30_000 });
    let cancelled = false;
    const outcome = await drive(session, () => {
      if (!cancelled && session.runner.resting) {
        session.runner.cancel();
        cancelled = true;
      }
    });
    expect(cancelled).toBe(true);
    expect(outcome.status).toBe("aborted");
    expect(outcome.abortReason).toBeUndefined();
    expect(session.log.filter((e) => e === "resume:rest:candidate-transition")).toHaveLength(0);
  });
});

describe("the session's own lock request is unchanged", () => {
  it("still acquires normally at the start of a session", async () => {
    const session = makeSession({ restMs: 0 });
    const outcome = await drive(session);
    expect(outcome.status).toBe("complete");
    expect(session.log[0]).toBe("requestLock:acquired");
    expect(LOCK_GRANTED.granted).toBe(true);
  });
});
