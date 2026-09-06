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
  POINTER_LOCK_LOSS_REASON,
  type CaptureEvent,
} from "../../src/capture/events.ts";
import { ScenarioDirector } from "../../src/scenarios/director.ts";
import {
  createInstanceRng,
  planScenarioInstance,
} from "../../src/scenarios/planner.ts";
import { scenarioById } from "../../src/domain/scenario.ts";
import type { TrialRecord } from "../../src/domain/trial.ts";
import { buildExperimentDefinition, type TrialPlanSpec } from "../../src/experiments/protocol.ts";
import { LocalJsonStore } from "../../src/persistence/store.ts";
import { IndexedDbBackend } from "../../src/persistence/backends.ts";
import { openAimLabDb } from "./idb.ts";
import { SessionRunner, type SessionRunOutcome } from "../../src/session/runner.ts";
import type { SessionStateName } from "../../src/session/types.ts";
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

const SCENARIO_INSTRUCTIONS: Record<string, string> = {
  "flick-static": "Click the target as fast as you can.",
  "flick-static-small": "Small target — click it as fast as you can.",
  "flick-dynamic-horizontal": "Lead the moving target and click it.",
  "target-switch": "Hit every target in the sequence.",
  tracking: "Keep the crosshair on the moving target.",
};

export interface RunControllerCallbacks {
  onHud(state: SessionStateName, detail: string): void;
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
      ...(options.restBetweenCandidatesMs !== undefined
        ? { restBetweenCandidatesMs: options.restBetweenCandidatesMs }
        : {}),
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
      },
      onStateChange: (state, detail) => this.#callbacks.onHud(state, detail ?? ""),
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

  /**
   * Ends the session. This MUST work in every state, including before the
   * runner exists — "End session" that silently does nothing is the trap this
   * whole path is meant to make impossible.
   */
  cancel(): void {
    this.#cancelledBeforeStart = true;
    this.#runner?.cancel();
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
    const kind = scenarioById(scenarioId).kind;
    return SCENARIO_INSTRUCTIONS[kind] ?? "";
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
      if (latest?.hit && latest.aimTargetId) {
        active.recorder.add({
          kind: "target-remove",
          tMs: latest.tMs + 1,
          targetId: latest.aimTargetId as never,
          reason: "hit",
        });
        active.director.observeRemoval(latest.tMs + 1);
        // Presentation-only hit confirmation: a brief ring at the reticle.
        const pos = this.#capture?.reticle.position;
        if (pos) this.#hitFx.push({ x: pos.x, y: pos.y, t0: performance.now() });
      }
    }

    // Fatal interruptions (manual-test policy E4): losing pointer lock or
    // window focus mid-trial ends the trial as invalid and cancels the
    // session honestly — no trial measured without full control survives.
    const isFatal =
      (event.kind === "lock-change" && !event.locked) ||
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
      this.#drawFrame(ctx, director.recorder.activeTargetsAt(now));
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

  #stageGradient: CanvasGradient | null = null;

  /** Short-lived hit-confirmation rings (visual only, never measured). */
  #hitFx: { x: number; y: number; t0: number }[] = [];
  static readonly #HIT_FX_MS = 160;

  #drawFrame(
    ctx: CanvasRenderingContext2D,
    targets: { x: number; y: number; radius: number }[],
  ): void {
    const { widthPx: w, heightPx: h } = LOGICAL_VIEWPORT;
    // Subtle vignette stage (cached gradient; purely visual).
    if (!this.#stageGradient) {
      const g = ctx.createRadialGradient(w / 2, h / 2, h / 4, w / 2, h / 2, h);
      g.addColorStop(0, "#0a0d12");
      g.addColorStop(1, "#05070a");
      this.#stageGradient = g;
    }
    ctx.fillStyle = this.#stageGradient;
    ctx.fillRect(0, 0, w, h);

    // Targets: high-visibility volt spheres with a soft core highlight.
    for (const target of targets) {
      ctx.beginPath();
      ctx.arc(target.x, target.y, target.radius, 0, Math.PI * 2);
      ctx.fillStyle = "#c8f24e";
      ctx.fill();
      ctx.strokeStyle = "rgba(233, 255, 168, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      const core = Math.max(1.5, target.radius * 0.28);
      ctx.beginPath();
      ctx.arc(target.x, target.y, core, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(10, 13, 18, 0.55)";
      ctx.fill();
    }

    // Hit confirmation: an expanding ring that fades within ~160 ms. It draws
    // where the shot landed and never moves, so it cannot suggest motion.
    if (this.#hitFx.length > 0) {
      const now = performance.now();
      this.#hitFx = this.#hitFx.filter((fx) => now - fx.t0 < BrowserRunController.#HIT_FX_MS);
      for (const fx of this.#hitFx) {
        const p = (now - fx.t0) / BrowserRunController.#HIT_FX_MS;
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, 10 + p * 14, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(233, 255, 168, ${(0.7 * (1 - p)).toFixed(3)})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // Reticle: white cross with a dark halo for readability on any target.
    const reticlePos = this.#capture?.reticle.position;
    if (reticlePos) {
      const drawCross = (color: string, width: number): void => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(reticlePos.x - 10, reticlePos.y);
        ctx.lineTo(reticlePos.x - 3, reticlePos.y);
        ctx.moveTo(reticlePos.x + 3, reticlePos.y);
        ctx.lineTo(reticlePos.x + 10, reticlePos.y);
        ctx.moveTo(reticlePos.x, reticlePos.y - 10);
        ctx.lineTo(reticlePos.x, reticlePos.y - 3);
        ctx.moveTo(reticlePos.x, reticlePos.y + 3);
        ctx.lineTo(reticlePos.x, reticlePos.y + 10);
        ctx.stroke();
      };
      drawCross("rgba(0, 0, 0, 0.65)", 3.5);
      drawCross("#ffffff", 1.5);
    }
  }
}

