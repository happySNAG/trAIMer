import { SystemMonotonicClock } from "../../src/capture/clock.ts";
import {
  LOCK_GRANTED,
  PointerLockCaptureSource,
  type BrowserDocumentLike,
  type DomEventTargetLike,
  type LockOutcome,
  type LockRequestableElement,
} from "../../src/capture/browserSource.ts";
import {
  CAPTURE_RELEASED_REASON,
  POINTER_LOCK_LOSS_REASON,
  type CaptureEvent,
} from "../../src/capture/events.ts";
import { ScenarioDirector } from "../../src/scenarios/director.ts";
import {
  createInstanceRng,
  planScenarioInstance,
} from "../../src/scenarios/planner.ts";
import { scenarioById, type ScenarioDefinition } from "../../src/domain/scenario.ts";
import type { ActiveTargetView } from "../../src/capture/recorder.ts";
import type { TrialRecord } from "../../src/domain/trial.ts";
import { buildExperimentDefinition, type TrialPlanSpec } from "../../src/experiments/protocol.ts";
import { LocalJsonStore } from "../../src/persistence/store.ts";
import { IndexedDbBackend } from "../../src/persistence/backends.ts";
import { openAimLabDb } from "./idb.ts";
import { SessionRunner, type SessionRunOutcome } from "../../src/session/runner.ts";
import type { RestNotice, SessionStateName } from "../../src/session/types.ts";
import { makeExperimentId, makeSessionId, makeTrialId } from "../../src/domain/ids.ts";
import type { AppSettings } from "./state.ts";
import {
  buildHumanSessionRecord,
  finalizeHumanSessionRecord,
} from "../../src/session/humanSession.ts";
import { makePlayerId } from "../../src/domain/ids.ts";
import { OPTIMIZER_VERSION } from "../../src/version.ts";
import { assessTimeJump } from "../../src/lifecycle/lifecycle.ts";

export const LOGICAL_VIEWPORT = { widthPx: 1280, heightPx: 720 };

/** Keyed by scenario KIND (the map once mixed ids in, so one drill had no instruction). */
const SCENARIO_INSTRUCTIONS: Record<ScenarioDefinition["kind"], string> = {
  "flick-static": "Click the target as fast as you can.",
  "flick-dynamic": "Lead the moving target and click it.",
  "target-switch": "Hit each target as it appears — three in a row.",
  tracking: "Keep the crosshair on the moving target.",
};

export interface DrillInfo {
  round: number;
  rounds: number;
  block: number;
  blocks: number;
  drill: number;
  /** Planned drills in this block (warm-ups + measured); adaptive allocation may shorten later blocks. */
  drillsPlanned: number;
  phase: "warmup" | "measured";
  scenarioLabel: string;
  instruction: string;
}

export interface RunControllerCallbacks {
  onHud(state: SessionStateName, detail: string): void;
  /**
   * Gameplay capture has been handed back for an interlude (break/pause):
   * the player has a real cursor and the on-screen controls are clickable.
   */
  onCaptureSuspended?(reason: string): void;
  /**
   * The mouse could not be taken back without a user gesture. `retry` MUST be
   * invoked synchronously from a click handler.
   */
  onCaptureGestureNeeded?(retry: () => void): void;
  /** Gameplay capture is held again; the interlude UI can come down. */
  onCaptureResumed?(): void;
  /** A break began (with its planned length) or ended (null). */
  onRest?(rest: RestNotice | null): void;
  /** The next drill is about to start: where it sits in the session and what to do. */
  onDrill?(info: DrillInfo): void;
  onTrialPersisted(trial: TrialRecord): void;
  onExperimentFinished(
    status: "complete" | "aborted",
    abortReason?: { code: string; detail: string },
  ): void;
}

type DirectorRecorder = InstanceType<typeof ScenarioDirector>["recorder"];

interface ActiveTrial {
  director: ScenarioDirector;
  recorder: DirectorRecorder;
  startedAtMonotonicMs: number;
  resolve: (record: TrialRecord) => void;
  fatalSeen: boolean;
}

export interface BrowserRunControllerOptions {
  /** Test-only override for candidate-block rest duration (ms). */
  restBetweenCandidatesMs?: number | undefined;
  /**
   * E2E adapter mode (?e2e=1): pointer-lock acquisition succeeds virtually
   * without a user gesture; scripted events flow through the production
   * recorder. Never enabled outside automated tests.
   */
  virtualLock?: boolean;
}

export class BrowserRunController {
  readonly #canvas: HTMLCanvasElement;
  readonly #settings: AppSettings;
  readonly #callbacks: RunControllerCallbacks;
  readonly #definition;
  readonly #virtualLock: boolean;
  #capture: PointerLockCaptureSource | null = null;
  #store: LocalJsonStore | null = null;
  #runner: SessionRunner | null = null;
  /**
   * A cancel can arrive BEFORE the runner exists (End session while the arena
   * still says "Click to lock in"). Without this flag the request landed on a
   * null runner and did nothing at all — which is exactly how rc.3 trapped a
   * player in the preparing state.
   */
  #cancelledBeforeStart = false;
  #started = false;
  #active: ActiveTrial | null = null;
  #rafHandle: number | null = null;
  #fatalInterruptionSeen = false;
  #sessionId: ReturnType<typeof makeSessionId> | null = null;
  #measuredCount = 0;
  #invalidCount = 0;
  #warmupCount = 0;
  #startedAtIso = new Date().toISOString();

  private constructor(
    canvas: HTMLCanvasElement,
    settings: AppSettings,
    callbacks: RunControllerCallbacks,
    options: BrowserRunControllerOptions = {},
  ) {
    this.#canvas = canvas;
    this.#settings = settings;
    this.#callbacks = callbacks;
    this.#virtualLock = options.virtualLock ?? false;
    canvas.width = LOGICAL_VIEWPORT.widthPx;
    canvas.height = LOGICAL_VIEWPORT.heightPx;

    this.#definition = buildExperimentDefinition({
      // Every live session is its own experiment: recommendations, optimizer
      // runs, definitions, audit trails, and trial folders are keyed by this
      // id, so reusing one id across sessions would overwrite provenance and
      // mix trials from different sessions in history. The seed (which drives
      // candidate order, blinding, and scenario instances) stays independent
      // of the identity.
      id: makeExperimentId(`live-${settings.experimentSeed}-${Date.now().toString(36)}`),
      name: `live session (${settings.playerName})`,
      baselineSensitivity: { sensX: settings.sensX, sensY: settings.sensY },
      dpi: settings.dpi,
      orderSeed: settings.experimentSeed,
      measuredRepsPerCandidatePerRound: settings.repsPerCandidate,
      warmupTrialsPerCandidateBlock: settings.warmupTrials,
      stoppingCriteria: { maxSearchRounds: Math.max(1, settings.rounds) },
      yExploration: { enabled: settings.yExploration },
      // Breaks are the player's: off ⇒ no rest state at all; on ⇒ the chosen
      // length, and always skippable. The E2E override wins so automation can
      // run short rests.
      restBetweenCandidatesMs:
        options.restBetweenCandidatesMs ??
        (settings.autoBreaks ? settings.breakSeconds * 1000 : 0),
      notes: "browser live session",
    });
  }

  static async create(
    canvas: HTMLCanvasElement,
    settings: AppSettings,
    callbacks: RunControllerCallbacks,
    options: BrowserRunControllerOptions = {},
  ): Promise<BrowserRunController> {
    const controller = new BrowserRunController(canvas, settings, callbacks, options);
    const backend = new IndexedDbBackend(await openAimLabDb());
    controller.#store = new LocalJsonStore(backend);
    // The capture source exists BEFORE start(): the arena click must be able
    // to call requestPointerLock() synchronously inside the user gesture, and
    // start() does async storage work before it reaches its execution gate.
    const capture = new PointerLockCaptureSource({
      element: canvas as unknown as LockRequestableElement,
      document: window.document as unknown as BrowserDocumentLike,
      window: window as unknown as DomEventTargetLike,
      viewportProvider: () => ({ ...LOGICAL_VIEWPORT }),
    });
    capture.start({ onEvent: (event) => controller.#handleCaptureEvent(event) });
    controller.#capture = capture;
    return controller;
  }

  get definition() {
    return this.#definition;
  }

  /** Local store handle (used to read the persisted capture self-test). */
  get store(): LocalJsonStore | null {
    return this.#store;
  }

  /** Metadata for the capture path this session actually runs on. */
  get captureDescriptor(): { kind: string; description: string } {
    return this.#capture?.descriptor ?? {
      kind: "unavailable",
      description: "no capture source",
    };
  }

  /** The last settled pointer-lock outcome (the UI's failure diagnostic). */
  get lastLockOutcome(): LockOutcome | null {
    return this.#capture?.lastLockOutcome ?? null;
  }

  /**
   * Starts acquiring the mouse. MUST be called synchronously from the arena
   * click handler: Chromium requires user activation for the first Pointer
   * Lock of a document, so issuing the request after any `await` is what turns
   * a legitimate click into a silent refusal.
   *
   * start() joins this same request through the capture source rather than
   * issuing a second, gesture-less one.
   */
  requestCaptureFromUserGesture(): Promise<LockOutcome> {
    if (this.#virtualLock) return Promise.resolve(LOCK_GRANTED);
    if (!this.#capture) {
      return Promise.resolve({
        granted: false,
        reasonCode: "unsupported",
        detail: "capture source was not initialised",
      });
    }
    return this.#capture.requestLock();
  }

  async start(): Promise<SessionRunOutcome> {
    const capture = this.#capture;
    if (!capture) throw new Error("capture source unavailable");
    this.#started = true;

    if (!this.#store) throw new Error("store unavailable");
    this.#sessionId = makeSessionId(`live-${Date.now()}`);

    const runner = new SessionRunner(this.#definition, {
      clock: new SystemMonotonicClock(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      nowIso: () => new Date().toISOString(),
      store: this.#store,
      execution: {
        requestLock: async () => {
          if (this.#virtualLock) return LOCK_GRANTED;
          const outcome = await capture.requestLock();
          // Granted, but gone again already (Esc during setup, focus loss):
          // the session must NOT enter running on a lock it no longer holds.
          if (outcome.granted && !capture.isLocked) {
            return {
              granted: false,
              reasonCode: "released-before-start" as const,
              detail: "the mouse was released before the first trial started",
            };
          }
          return outcome;
        },
        executeTrial: (spec, round, repIndex) =>
          this.#executeTrial(spec, round, repIndex),
        releaseCapture: async () => {
          if (this.#virtualLock) return;
          capture.releaseLock();
        },
        // Interlude handling (rc.6). A break or a pause presents buttons the
        // player is meant to click; leaving the arena's pointer lock in place
        // means there is no cursor to click them WITH. The mouse now goes back
        // to Windows before any interlude UI is shown, and is taken again on
        // the way out.
        suspendCapture: async (reason) => {
          // The E2E adapter holds no real lock, but it MUST still report the
          // interlude: that the automated suite could not tell "mouse held"
          // from "mouse free" is exactly why a break screen shipped with an
          // unclickable button.
          if (!this.#virtualLock) capture.releaseLock();
          this.#callbacks.onCaptureSuspended?.(reason);
        },
        resumeCapture: async (reason) => {
          if (this.#virtualLock) {
            this.#callbacks.onCaptureResumed?.();
            return LOCK_GRANTED;
          }
          if (capture.isLocked) {
            this.#callbacks.onCaptureResumed?.();
            return LOCK_GRANTED;
          }
          // Chromium may grant a re-lock without a fresh gesture; when it
          // refuses, the honest answer is to ask the player for a click
          // rather than to end the session.
          const direct = await capture.requestLock();
          if (direct.granted && capture.isLocked) {
            this.#callbacks.onCaptureResumed?.();
            return direct;
          }
          if (this.#cancelledBeforeStart) return direct;
          return this.#awaitCaptureGesture(reason);
        },
      },
      onStateChange: (state, detail) => this.#callbacks.onHud(state, detail ?? ""),
      onRest: (rest) => this.#callbacks.onRest?.(rest),
      onTrialPersisted: (trial) => {
        if (trial.phase === "measured") this.#measuredCount++;
        else this.#warmupCount++;
        if (trial.validity.status !== "valid") this.#invalidCount++;
        this.#callbacks.onTrialPersisted(trial);
      },
    });
    this.#runner = runner;
    // A cancel that landed while create()/the click were still in flight must
    // be honoured by the runner rather than lost.
    if (this.#cancelledBeforeStart) runner.cancel();

    const outcome = await runner.run();
    capture.stop();

    try {
      let record = buildHumanSessionRecord({
        sessionId: this.#sessionId!,
        experimentId: this.#definition.id,
        playerId: makePlayerId(this.#settings.playerName.toLowerCase()),
        displayName: this.#settings.playerName,
        dpi: this.#settings.dpi,
        startingSensitivity: {
          sensX: this.#settings.sensX,
          sensY: this.#settings.sensY,
        },
        device: {
          userAgent: navigator.userAgent,
          platform: navigator.platform ?? "unknown",
          screenPx: { width: window.screen.width, height: window.screen.height },
          pointerCoalescingSupported:
            capture.capabilities?.coalescingSupported ?? null,
        },
        startedAtIso: this.#startedAtIso,
        scenarioOrder: [...new Set(outcome.trials.map((t) => t.scenarioId))],
        candidateOrderBlinded: [...runner.blindedLabels.values()],
        candidateReveal: Object.fromEntries(runner.blindedLabels),
        warmupCount: this.#warmupCount,
        measuredCount: this.#measuredCount,
        invalidTrialCount: this.#invalidCount,
        pausePeriods: [],
        fatigueIndicators: { forcedRests: 0, degradationDetected: false, degradationRatio: null },
        optimizerVersion: OPTIMIZER_VERSION,
        scoringWeights: {},
        calibrationAdequateX: null,
        calibrationAdequateY: null,
        retestOfExperimentId: null,
        sessionIndexForPlayer: 1,
      });
      const recommendation =
        this.#store !== null
          ? await this.#store.loadRecommendation(this.#definition.id)
          : null;
      record = finalizeHumanSessionRecord(
        record,
        new Date().toISOString(),
        recommendation,
        0,
      );
      await this.#store?.saveRaw(
        "human-session",
        `human-sessions/${this.#sessionId}.json`,
        record,
      );
      await this.#store?.saveRaw(
        "audit-trail",
        `audit/${this.#definition.id}.json`,
        { entries: outcome.auditTrail },
      );
    } catch {
      this.#humanSessionPersistFailed = true;
    }

    this.#callbacks.onExperimentFinished(
      outcome.status,
      outcome.abortReason,
    );
    return outcome;
  }

  #humanSessionPersistFailed = false;

  get humanSessionPersistFailed(): boolean {
    return this.#humanSessionPersistFailed;
  }

  /**
   * Pause. While capture is still being requested there is no trial boundary
   * to pause at, so the honest action is to withdraw the capture request:
   * control returns to the player immediately instead of the button appearing
   * dead. Resume re-arms the arena for a fresh click.
   */
  pause(): void {
    this.#runner?.pause();
    if (this.#capture?.lockPending || (!this.#started && !this.#cancelledBeforeStart)) {
      this.#capture?.abortPendingLock("paused while capture was being requested");
    }
  }

  resume(): void {
    this.#runner?.resume();
  }

  /** Ends the break in progress now (Skip break button, Space, Enter). */
  skipRest(): void {
    this.#runner?.skipRest();
  }

  /** True while a skippable break is in progress. */
  get resting(): boolean {
    return this.#runner?.resting ?? false;
  }

  /**
   * Ends the session. This MUST work in every state, including before the
   * runner exists — "End session" that silently does nothing is the trap this
   * whole path is meant to make impossible.
   */
  cancel(): void {
    this.#cancelledBeforeStart = true;
    this.#runner?.cancel();
    // A "click the arena to continue" gate must never outlive the session.
    this.#gestureAbort?.();
    // Settle any in-flight lock request immediately so nothing waits out the
    // timeout, and give the mouse back if it was already captured.
    this.#capture?.abortPendingLock("ended by the player");
    if (!this.#started) {
      // No runner will ever report a finish for this session: report it here
      // so the UI always leaves the arena.
      this.#capture?.stop();
      this.#callbacks.onExperimentFinished("aborted", {
        code: "cancelled",
        detail: "the session was ended before the first trial started",
      });
    }
  }

  /** True once start() has been entered (a runner exists or is being built). */
  get started(): boolean {
    return this.#started;
  }

  /** Settles a pending "click the arena to continue" gate (End session). */
  #gestureAbort: (() => void) | null = null;

  /**
   * Waits for the player to hand the mouse back with a real click. The UI
   * renders the prompt and calls `retry` from inside the click's user
   * activation, which is the only context Chromium reliably accepts a lock
   * request in. Ending the session settles this immediately — a gate the
   * player cannot leave would be the same trap in a new place.
   */
  #awaitCaptureGesture(reason: string): Promise<LockOutcome> {
    const capture = this.#capture;
    if (!capture) {
      return Promise.resolve({
        granted: false,
        reasonCode: "unsupported" as const,
        detail: "capture source was not initialised",
      });
    }
    return new Promise<LockOutcome>((resolve) => {
      let settled = false;
      const settle = (outcome: LockOutcome): void => {
        if (settled) return;
        settled = true;
        this.#gestureAbort = null;
        resolve(outcome);
      };
      this.#gestureAbort = () =>
        settle({
          granted: false,
          reasonCode: "cancelled",
          detail: `the session was ended while resuming from ${reason}`,
        });
      const attempt = (): void => {
        // SYNCHRONOUS inside the click gesture.
        void capture.requestLock().then((outcome) => {
          if (settled) return;
          if (outcome.granted && capture.isLocked) {
            this.#callbacks.onCaptureResumed?.();
            settle(outcome);
            return;
          }
          // Refused again: ask once more rather than ending the session.
          this.#callbacks.onCaptureGestureNeeded?.(attempt);
        });
      };
      this.#callbacks.onCaptureGestureNeeded?.(attempt);
    });
  }

  /** E2E adapter seam: feed a capture event through the production recorder. */
  emitForTesting(event: CaptureEvent): void {
    this.#capture?.emitForTesting(event);
  }

  /** E2E adapter seam: simulate a granted pointer lock without user gesture. */
  simulateLockAcquired(): void {
    this.#capture?.simulateLockAcquiredForTesting();
  }

  releaseCaptureForTesting(): void {
    void this.#capture?.releaseLock();
  }

  /** E2E diagnostics: current trial progress without touching internals. */
  get activeTrialDebug(): {
    phase: string;
    spawned: number;
    finished: boolean;
    shots: number;
    elapsedMs: number;
  } | null {
    if (!this.#active) return null;
    const status = this.#active.director.tick(0);
    void status;
    return {
      phase: "active",
      spawned: this.#active.recorder.state.spawnedTargets.length,
      finished: this.#active.director.finished,
      shots: this.#active.recorder.state.shotCount,
      elapsedMs: performance.now() - this.#active.startedAtMonotonicMs,
    };
  }

  instructionFor(scenarioId: string): string {
    return SCENARIO_INSTRUCTIONS[scenarioById(scenarioId).kind];
  }

  async #executeTrial(
    spec: TrialPlanSpec,
    round: number,
    repIndex: number | null,
  ): Promise<TrialRecord> {
    if (!this.#capture || !this.#sessionId) {
      throw new Error("run controller not initialised");
    }
    const scenario = scenarioById(spec.scenarioId);
    const candidate = this.#definition.candidates.find(
      (c) => c.id === spec.candidateId,
    );
    if (!candidate) throw new Error(`unknown candidate ${spec.candidateId}`);
    this.#announceDrill(spec, round, scenario);

    const instanceSeed =
      spec.phase === "measured" && repIndex !== null
        ? {
            experimentSeed: this.#settings.experimentSeed,
            round,
            scenarioId: spec.scenarioId,
            repIndex,
          }
        : {
            experimentSeed: this.#settings.experimentSeed + 7777,
            round,
            scenarioId: spec.scenarioId,
            repIndex: spec.sequenceNumber,
          };
    const instance = planScenarioInstance(
      scenario,
      LOGICAL_VIEWPORT,
      createInstanceRng(instanceSeed),
    );

    const request = {
      id: makeTrialId(`${this.#sessionId}-r${round}-${spec.sequenceNumber}`.replace(/[^a-zA-Z0-9-]/g, "-")),
      sessionId: this.#sessionId,
      experimentId: this.#definition.id,
      candidateId: candidate.id,
      indexInSession: spec.sequenceNumber,
      phase: spec.phase,
      scenarioId: scenario.id,
      scenarioKind: scenario.kind,
      scenarioRepIndex: repIndex,
      viewport: { ...LOGICAL_VIEWPORT },
      sensitivity: candidate.sensitivity,
      dpi: this.#definition.dpi,
      expectedSampleIntervalMs: null,
      startedAtMonotonicMs: performance.now(),
      seedTag: `${this.#settings.experimentSeed}:${round}:${spec.sequenceNumber}`,
    };

    const director = new ScenarioDirector(request, instance);
    const startedAt = performance.now();
    const completion = new Promise<TrialRecord>((resolve) => {
      this.#active = {
        director,
        recorder: director.recorder,
        startedAtMonotonicMs: startedAt,
        resolve,
        fatalSeen: false,
      };
    });

    this.#capture.reticle.reset();
    this.#beginTrialPresentation(scenario);
    director.start(performance.now());
    this.#startRenderLoop(director);

    const record = await completion;
    this.#stopRenderLoop();
    this.#active = null;
    if (this.#fatalInterruptionSeen && this.#runner) {
      this.#runner.cancel();
    }
    return record;
  }

  #handleCaptureEvent(event: CaptureEvent): void {
    const active = this.#active;
    if (!active) {
      // Losing the mouse BETWEEN trials has no trial to invalidate, but the
      // session cannot simply carry on: the next trial would run with no
      // capture at all and time out forever with no explanation. End honestly
      // — every completed trial is already persisted.
      //
      // Only a genuine locked→unlocked transition counts. A *refused* request
      // also emits lock-change{locked:false}, and treating that as a loss
      // would relabel every denial as "cancelled by the player" and hide the
      // real diagnostic.
      if (
        event.kind === "lock-change" &&
        !event.locked &&
        event.reason === POINTER_LOCK_LOSS_REASON &&
        this.#started
      ) {
        this.#fatalInterruptionSeen = true;
        this.#runner?.cancel();
      }
      return;
    }
    active.recorder.add(event);

    if (
      event.kind === "button" &&
      event.action === "press"
    ) {
      const latest = active.recorder.state.latestShot;
      // A shot removes the target it hit ONLY in the click-to-hit drills.
      //
      // The tracking drill (the fast pink target) is not shot at all — it is
      // followed for a fixed window. rc.5 removed it on a click anyway, which
      // left the arena empty for the rest of the six seconds with no target,
      // no feedback and nothing to do: the drill looked like it had registered
      // the hit and was waiting for another input before moving on. It was
      // not; it was running out a timer against an invisible target, which
      // also destroyed that trial's tracking measurement.
      const removesOnHit = active.director.removesTargetOnHit;
      if (removesOnHit && latest?.hit && latest.aimTargetId) {
        active.recorder.add({
          kind: "target-remove",
          tMs: latest.tMs + 1,
          targetId: latest.aimTargetId as never,
          reason: "hit",
        });
        active.director.observeRemoval(latest.tMs + 1);
      } else if (latest && !latest.hit) {
        // Presentation only: a faint ripple where a shot landed short.
        const pos = this.#capture?.reticle.position;
        if (pos) this.#fx.missAt(pos.x, pos.y, performance.now());
      }
    }

    // Fatal interruptions (manual-test policy E4): losing pointer lock or
    // window focus mid-trial ends the trial as invalid and cancels the
    // session honestly — no trial measured without full control survives.
    // A release WE asked for (break/pause/session end) is not a loss and
    // never happens mid-trial.
    const isFatal =
      (event.kind === "lock-change" &&
        !event.locked &&
        event.reason !== CAPTURE_RELEASED_REASON) ||
      (event.kind === "focus-change" && !event.focused);
    if (isFatal && !active.fatalSeen) {
      active.fatalSeen = true;
      this.#fatalInterruptionSeen = true;
      active.recorder.abort(event.tMs, "pointer-lock-loss");
    }
  }

  #startRenderLoop(director: ScenarioDirector): void {
    const ctx = this.#canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas unavailable");
    let previousFrameNowMs: number | null = null;
    const frame = (): void => {
      const now = performance.now();
      // Sleep/wake hardening: a >2 s monotonic jump mid-trial invalidates the
      // trial exactly like lock loss (timestamps across sleep are not data).
      if (previousFrameNowMs !== null) {
        const jump = assessTimeJump(previousFrameNowMs, now);
        if (jump.jumped && this.#active !== null && !this.#active.fatalSeen) {
          this.#active.fatalSeen = true;
          this.#fatalInterruptionSeen = true;
          this.#active.recorder.abort(now, "sleep-wake-time-jump");
        }
      }
      previousFrameNowMs = now;
      const status = director.tick(now);
      this.#drawFrame(ctx, director.recorder.activeTargetsAt(now), now, director);
      if (status.finished || this.#fatalInterruptionSeen) {
        const endedAt = performance.now();
        const outcome =
          this.#fatalInterruptionSeen && !status.finished
            ? "aborted"
            : undefined;
        const record = director.recorder.finish(
          outcome ?? director.outcome ?? "timeout-no-shot",
          endedAt,
        );
        this.#resolveActive(record);
        return;
      }
      this.#rafHandle = requestAnimationFrame(frame);
    };
    this.#rafHandle = requestAnimationFrame(frame);
  }

  #stopRenderLoop(): void {
    if (this.#rafHandle !== null) {
      cancelAnimationFrame(this.#rafHandle);
      this.#rafHandle = null;
    }
  }

  #resolveActive(record: TrialRecord): void {
    this.#active?.resolve(record);
    this.#active = null;
  }

  // -------------------------------------------------------------------------
  // Presentation. Everything below is visual only: hit detection, target
  // geometry and timing come from the recorder/director and are never
  // re-derived here. Effects are bounded arrays of tiny objects so a long
  // session allocates nothing per frame beyond what the canvas needs.
  // -------------------------------------------------------------------------

  #stage: HTMLCanvasElement | null = null;
  readonly #fx = new ArenaFx();
  #activeScenario: ScenarioDefinition | null = null;
  /** Target ids whose departure has already been animated this trial. */
  #removalFxSeen = new Set<string>();
  #block = 0;
  #blockCandidateId: string | null = null;
  #drillInBlock = 0;

  #announceDrill(spec: TrialPlanSpec, round: number, scenario: ScenarioDefinition): void {
    if (spec.candidateId !== this.#blockCandidateId) {
      this.#blockCandidateId = spec.candidateId;
      this.#block++;
      this.#drillInBlock = 0;
    }
    this.#drillInBlock++;
    const d = this.#definition;
    this.#callbacks.onDrill?.({
      round: round + 1,
      rounds: Math.max(1, d.stoppingCriteria.maxSearchRounds),
      block: ((this.#block - 1) % d.candidates.length) + 1,
      blocks: d.candidates.length,
      drill: this.#drillInBlock,
      drillsPlanned: d.warmupTrialsPerCandidateBlock + d.measuredRepsPerCandidatePerRound,
      phase: spec.phase,
      scenarioLabel: scenario.label,
      instruction: SCENARIO_INSTRUCTIONS[scenario.kind],
    });
  }

  #beginTrialPresentation(scenario: ScenarioDefinition): void {
    this.#activeScenario = scenario;
    this.#removalFxSeen = new Set();
  }

  #stageBackdrop(): HTMLCanvasElement {
    if (this.#stage) return this.#stage;
    const { widthPx: w, heightPx: h } = LOGICAL_VIEWPORT;
    const stage = document.createElement("canvas");
    stage.width = w;
    stage.height = h;
    const ctx = stage.getContext("2d");
    if (!ctx) throw new Error("2d canvas unavailable");
    // Deep, slightly blue-black stage with a soft centre lift.
    const g = ctx.createRadialGradient(w / 2, h / 2, h / 6, w / 2, h / 2, h * 0.95);
    g.addColorStop(0, "#0d1118");
    g.addColorStop(0.6, "#080b10");
    g.addColorStop(1, "#04060a");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // Faint grid: enough to read motion against, never enough to compete
    // with a target.
    ctx.strokeStyle = "rgba(120, 150, 190, 0.055)";
    ctx.lineWidth = 1;
    const step = 64;
    ctx.beginPath();
    for (let x = (w / 2) % step; x <= w; x += step) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
    }
    for (let y = (h / 2) % step; y <= h; y += step) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
    }
    ctx.stroke();
    // Vignette so the edges recede.
    const v = ctx.createRadialGradient(w / 2, h / 2, h * 0.45, w / 2, h / 2, h * 1.05);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, w, h);
    this.#stage = stage;
    return stage;
  }

  #drawFrame(
    ctx: CanvasRenderingContext2D,
    targets: ActiveTargetView[],
    now: number,
    director: ScenarioDirector,
  ): void {
    const { widthPx: w, heightPx: h } = LOGICAL_VIEWPORT;
    ctx.drawImage(this.#stageBackdrop(), 0, 0);

    const kind = this.#activeScenario?.kind ?? "flick-static";
    const palette = TARGET_PALETTE[kind];
    const reticlePos = this.#capture?.reticle.position ?? null;

    // Departures: pop on hit, fade on expiry. Read from the recorder so the
    // animation happens exactly where the engine says the target was.
    for (const gone of director.recorder.removedTargetsAt(now)) {
      if (this.#removalFxSeen.has(gone.id)) continue;
      this.#removalFxSeen.add(gone.id);
      if (gone.reason === "hit") {
        this.#fx.hitAt(gone.x, gone.y, gone.radius, gone.removedMs, palette.core);
      } else if (gone.reason === "expired") {
        this.#fx.expireAt(gone.x, gone.y, gone.radius, gone.removedMs);
      }
    }

    for (const target of targets) {
      const age = now - target.appearedMs;
      drawTarget(ctx, target, age, palette, kind === "tracking" && reticlePos !== null
        ? Math.hypot(reticlePos.x - target.x, reticlePos.y - target.y) <= target.radius
        : false);
    }

    this.#fx.draw(ctx, now);

    // The tracking drill runs a fixed window and ends by itself. Without a
    // visible clock an arena with nothing to click reads as "waiting for
    // input" — which is precisely how rc.5's tracking drill was reported.
    if (kind === "tracking") {
      const started = director.startedAtMonotonicMs;
      const total = director.durationMs;
      if (started !== null && total > 0) {
        drawDrillProgress(ctx, w, h, (now - started) / total, palette.core);
      }
    }

    // Sequence pips for the switch drill: how many of the three are done.
    if (kind === "target-switch") {
      const total = this.#activeScenario?.targetsPerTrial ?? 3;
      const done = director.recorder.state.spawnedTargets.filter((t) => t.removalReason === "hit").length;
      const missed = director.recorder.state.spawnedTargets.filter((t) => t.removalReason === "expired").length;
      drawSequencePips(ctx, w / 2, h - 26, total, done, missed, palette.core);
    }

    if (reticlePos) drawReticle(ctx, reticlePos.x, reticlePos.y);
  }
}



// ---------------------------------------------------------------------------
// Arena presentation helpers (visual only).
// ---------------------------------------------------------------------------

interface TargetPalette {
  /** Main disc colour. */
  core: string;
  /** Bright rim. */
  rim: string;
  /** Soft outer glow (rgba). */
  glow: string;
}

/**
 * One colour family per drill kind so a session reads as distinct drills
 * rather than "green circles", all high-contrast on the dark stage.
 */
const TARGET_PALETTE: Record<ScenarioDefinition["kind"], TargetPalette> = {
  "flick-static": { core: "#c8f24e", rim: "#eaffb0", glow: "rgba(200, 242, 78, 0.28)" },
  "flick-dynamic": { core: "#4fd8f0", rim: "#c6f6ff", glow: "rgba(79, 216, 240, 0.28)" },
  "target-switch": { core: "#ffb64a", rim: "#ffe0ae", glow: "rgba(255, 182, 74, 0.30)" },
  tracking: { core: "#ff6fd8", rim: "#ffd0f2", glow: "rgba(255, 111, 216, 0.26)" },
};

const SPAWN_ANIM_MS = 140;

function easeOutCubic(p: number): number {
  const q = 1 - Math.min(1, Math.max(0, p));
  return 1 - q * q * q;
}

function drawTarget(
  ctx: CanvasRenderingContext2D,
  target: ActiveTargetView,
  ageMs: number,
  palette: TargetPalette,
  onTarget: boolean,
): void {
  const { x, y, radius } = target;
  // The TRUE hit radius is outlined from the very first frame, so the visual
  // spawn-in never misrepresents where a shot counts.
  const spawn = easeOutCubic(ageMs / SPAWN_ANIM_MS);

  // Soft glow.
  ctx.beginPath();
  ctx.arc(x, y, radius * (1.55 + 0.25 * (1 - spawn)), 0, Math.PI * 2);
  ctx.fillStyle = palette.glow;
  ctx.globalAlpha = 0.45 + 0.55 * spawn;
  ctx.fill();
  ctx.globalAlpha = 1;

  // Hit-area ring (always full size).
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = palette.rim;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.9;
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Disc, scaling in.
  const discR = radius * (0.35 + 0.65 * spawn) - 1;
  if (discR > 0) {
    const g = ctx.createRadialGradient(x - discR * 0.35, y - discR * 0.35, discR * 0.1, x, y, discR);
    g.addColorStop(0, palette.rim);
    g.addColorStop(0.45, palette.core);
    g.addColorStop(1, shade(palette.core, 0.62));
    ctx.beginPath();
    ctx.arc(x, y, discR, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
  }

  // Dark centre so the reticle stays readable over the disc.
  const core = Math.max(1.5, radius * 0.22);
  ctx.beginPath();
  ctx.arc(x, y, core, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(8, 11, 16, 0.6)";
  ctx.fill();

  // Tracking: an "on target" lock ring so the player feels the contact.
  if (onTarget) {
    ctx.beginPath();
    ctx.arc(x, y, radius + 5, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawReticle(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const cross = (color: string, width: number): void => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x - 11, y);
    ctx.lineTo(x - 4, y);
    ctx.moveTo(x + 4, y);
    ctx.lineTo(x + 11, y);
    ctx.moveTo(x, y - 11);
    ctx.lineTo(x, y - 4);
    ctx.moveTo(x, y + 4);
    ctx.lineTo(x, y + 11);
    ctx.stroke();
  };
  cross("rgba(0, 0, 0, 0.7)", 3.5);
  cross("#ffffff", 1.5);
  ctx.beginPath();
  ctx.arc(x, y, 1.4, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
}

function drawSequencePips(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  total: number,
  done: number,
  missed: number,
  color: string,
): void {
  const gap = 18;
  const startX = cx - ((total - 1) * gap) / 2;
  for (let i = 0; i < total; i++) {
    ctx.beginPath();
    ctx.arc(startX + i * gap, cy, 4.5, 0, Math.PI * 2);
    if (i < done) {
      ctx.fillStyle = color;
      ctx.fill();
    } else if (i < done + missed) {
      ctx.fillStyle = "rgba(255, 96, 96, 0.7)";
      ctx.fill();
    } else {
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

/**
 * A thin time bar for drills that end on a clock rather than on a hit. It says
 * "this is running and it will finish on its own", so an arena the player
 * cannot act on never looks frozen.
 */
function drawDrillProgress(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  fraction: number,
  color: string,
): void {
  const f = Math.max(0, Math.min(1, fraction));
  const barW = Math.min(360, w * 0.32);
  const x = (w - barW) / 2;
  const y = h - 22;
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.14)";
  ctx.fillRect(x, y, barW, 3);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, barW * f, 3);
  ctx.restore();
}

/** Darkens a #rrggbb colour by `factor` (0–1). */
function shade(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * factor);
  const g = Math.round(((n >> 8) & 255) * factor);
  const b = Math.round((n & 255) * factor);
  return `rgb(${r}, ${g}, ${b})`;
}

interface Burst {
  x: number;
  y: number;
  radius: number;
  t0: number;
  color: string;
  /** Deterministic shard angles (no per-frame randomness). */
  seed: number;
}
interface Ripple {
  x: number;
  y: number;
  radius: number;
  t0: number;
  kind: "miss" | "expired";
}

/**
 * Bounded, allocation-light effect layer. Hits pop (flash + ring + shards),
 * expiries fade and sink, misses ripple. Durations are short enough never to
 * cover the next target.
 */
class ArenaFx {
  static readonly HIT_MS = 260;
  static readonly EXPIRE_MS = 240;
  static readonly MISS_MS = 180;
  static readonly MAX = 24;
  #bursts: Burst[] = [];
  #ripples: Ripple[] = [];
  #seed = 1;

  hitAt(x: number, y: number, radius: number, t0: number, color: string): void {
    this.#seed = (this.#seed * 1103515245 + 12345) >>> 0;
    this.#bursts.push({ x, y, radius, t0, color, seed: this.#seed });
    if (this.#bursts.length > ArenaFx.MAX) this.#bursts.shift();
  }

  expireAt(x: number, y: number, radius: number, t0: number): void {
    this.#ripples.push({ x, y, radius, t0, kind: "expired" });
    if (this.#ripples.length > ArenaFx.MAX) this.#ripples.shift();
  }

  missAt(x: number, y: number, t0: number): void {
    this.#ripples.push({ x, y, radius: 10, t0, kind: "miss" });
    if (this.#ripples.length > ArenaFx.MAX) this.#ripples.shift();
  }

  draw(ctx: CanvasRenderingContext2D, now: number): void {
    if (this.#bursts.length > 0) {
      this.#bursts = this.#bursts.filter((b) => now - b.t0 < ArenaFx.HIT_MS);
      for (const b of this.#bursts) {
        const p = Math.min(1, Math.max(0, (now - b.t0) / ArenaFx.HIT_MS));
        const fade = 1 - p;
        // Flash disc.
        if (p < 0.35) {
          ctx.beginPath();
          ctx.arc(b.x, b.y, b.radius * (1 + p * 0.6), 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,255,255,${(0.75 * (1 - p / 0.35)).toFixed(3)})`;
          ctx.fill();
        }
        // Expanding ring.
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.radius * (1 + p * 1.4), 0, Math.PI * 2);
        ctx.strokeStyle = b.color;
        ctx.globalAlpha = 0.8 * fade;
        ctx.lineWidth = 2.5 * fade + 0.5;
        ctx.stroke();
        // Shards.
        const shards = 10;
        const e = easeOutCubic(p);
        for (let i = 0; i < shards; i++) {
          const jitter = ((b.seed >>> (i % 16)) & 7) / 7 - 0.5;
          const a = (i / shards) * Math.PI * 2 + jitter * 0.4;
          const dist = b.radius * (0.6 + 1.9 * e);
          const sx = b.x + Math.cos(a) * dist;
          const sy = b.y + Math.sin(a) * dist + 12 * p * p; // slight gravity
          ctx.beginPath();
          ctx.arc(sx, sy, Math.max(0.6, 2.6 * fade), 0, Math.PI * 2);
          ctx.fillStyle = i % 3 === 0 ? "#ffffff" : b.color;
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    }
    if (this.#ripples.length > 0) {
      this.#ripples = this.#ripples.filter(
        (r) => now - r.t0 < (r.kind === "miss" ? ArenaFx.MISS_MS : ArenaFx.EXPIRE_MS),
      );
      for (const r of this.#ripples) {
        const dur = r.kind === "miss" ? ArenaFx.MISS_MS : ArenaFx.EXPIRE_MS;
        const p = Math.min(1, Math.max(0, (now - r.t0) / dur));
        ctx.beginPath();
        if (r.kind === "miss") {
          ctx.arc(r.x, r.y, r.radius + p * 16, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255, 110, 110, ${(0.55 * (1 - p)).toFixed(3)})`;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        } else {
          // Expired: the ring dims to red and sinks slightly.
          ctx.arc(r.x, r.y + p * 6, r.radius * (1 - 0.25 * p), 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255, 96, 96, ${(0.6 * (1 - p)).toFixed(3)})`;
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.fillStyle = `rgba(255, 96, 96, ${(0.12 * (1 - p)).toFixed(3)})`;
          ctx.fill();
        }
      }
    }
  }
}
