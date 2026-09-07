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
import type { ExperimentDefinition } from "../../src/domain/experiment.ts";
import { LocalJsonStore } from "../../src/persistence/store.ts";
import { IndexedDbBackend } from "../../src/persistence/backends.ts";
import { openTraimerDb } from "./idb.ts";
import { SessionRunner, type SessionRunOutcome } from "../../src/session/runner.ts";
import {
  buildSessionOutcomeReport,
  type CalibrationProgressSnapshot,
} from "../../src/results/sessionOutcome.ts";
import type {
  RestNotice,
  SessionRunnerPorts,
  SessionStateName,
} from "../../src/session/types.ts";
import { makeExperimentId, makeSessionId, makeTrialId } from "../../src/domain/ids.ts";
import type { AppSettings } from "./state.ts";
import {
  buildHumanSessionRecord,
  finalizeHumanSessionRecord,
} from "../../src/session/humanSession.ts";
import { makePlayerId } from "../../src/domain/ids.ts";
import { OPTIMIZER_VERSION } from "../../src/version.ts";
import { assessTimeJump } from "../../src/lifecycle/lifecycle.ts";
import { ArenaAudio } from "./arenaAudio.ts";

export const LOGICAL_VIEWPORT = { widthPx: 1280, heightPx: 720 };

/**
 * Whether a capture event that arrives BETWEEN trials must end the session.
 *
 * Exported and pure so the guarantee can be tested without a DOM, a canvas or
 * IndexedDB — which is exactly why rc.6 shipped without it. A break releases
 * the mouse on purpose; treating that release as a lost lock is what made the
 * first break end the whole calibration and report it as an ordinary finish.
 *
 * Losing the mouse between trials with NO interlude in progress is still
 * fatal: the next drill would run with no capture at all, time out forever,
 * and explain nothing.
 */
export function isFatalBetweenTrials(
  event: CaptureEvent,
  context: { started: boolean; interludeDepth: number },
): boolean {
  if (!context.started) return false;
  // A break or a pause asked for this release. Never fatal, whatever reason
  // the user agent attaches to it.
  if (context.interludeDepth > 0) return false;
  return (
    event.kind === "lock-change" &&
    !event.locked &&
    event.reason === POINTER_LOCK_LOSS_REASON
  );
}

/**
 * Whether a capture event that arrives DURING a trial invalidates it.
 *
 * A release WE asked for is never a loss, and never happens mid-trial; every
 * other unlock, and any loss of window focus, means the trial was not measured
 * under full control and must not survive.
 */
export function isFatalDuringTrial(event: CaptureEvent): boolean {
  return (
    (event.kind === "lock-change" &&
      !event.locked &&
      event.reason !== CAPTURE_RELEASED_REASON) ||
    (event.kind === "focus-change" && !event.focused)
  );
}


/** Keyed by scenario KIND (the map once mixed ids in, so one drill had no instruction). */
const SCENARIO_INSTRUCTIONS: Record<ScenarioDefinition["kind"], string> = {
  "flick-static": "Click the target as fast as you can.",
  "flick-dynamic": "Lead the moving target and click it.",
  "target-switch": "Hit each target as it appears — three in a row.",
  // The ONLY drill that is not shot. Says so first, in the imperative, and
  // never uses the word "target" without the instruction attached — a player
  // who reads three words of this must still come away knowing not to click.
  tracking: "Keep your crosshair on the target — don't shoot.",
};

/**
 * Two-word banner shown over the arena for the whole drill. SHOOT vs TRACK is
 * the single most load-bearing distinction in the product: rc.6 drew the
 * tracking target in a different colour and nothing else, and a real player
 * read it as one more thing to shoot and felt every click was a miss.
 */
const SCENARIO_MODE: Record<ScenarioDefinition["kind"], "shoot" | "track"> = {
  "flick-static": "shoot",
  "flick-dynamic": "shoot",
  "target-switch": "shoot",
  tracking: "track",
};

/** Read-only arena state for E2E automation (see ). */
export interface ArenaSnapshot {
  scenarioKind: string;
  mode: "shoot" | "track";
  reticle: { x: number; y: number } | null;
  targets: { id: string; x: number; y: number; radius: number }[];
  liveTargets: number;
  spawnedTargets: number;
  removedTargets: number;
  shots: number;
  hits: number;
  elapsedMs: number;
  durationMs: number;
  onTarget: boolean;
  streak: number;
  trackingClicks: number;
  effectCount: number;
}

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
  /** SHOOT or TRACK — drives the arena banner and the topbar chip. */
  mode: "shoot" | "track";
  scenarioKind: ScenarioDefinition["kind"];
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
  /** Truthful position in the whole calibration plan (engine-computed). */
  onCalibrationProgress?(progress: CalibrationProgressSnapshot): void;
  onTrialPersisted(trial: TrialRecord): void;
  /**
   * The session ended, for ANY reason. The outcome always carries a report
   * explaining what happened, how far the calibration got, and whether the
   * evidence supports a recommendation — there is no ending without one.
   */
  onExperimentFinished(outcome: SessionRunOutcome): void;
}

type DirectorRecorder = InstanceType<typeof ScenarioDirector>["recorder"];

interface ActiveTrial {
  director: ScenarioDirector;
  recorder: DirectorRecorder;
  startedAtMonotonicMs: number;
  resolve: (record: TrialRecord) => void;
  fatalSeen: boolean;
}

/**
 * Everything needed to CONTINUE an unfinished calibration rather than start a
 * new one: the original experiment definition (so the candidate ladder,
 * blinding and seed are identical), the checkpoint, and the trials already
 * recorded against it. Nothing already completed is repeated.
 */
export interface ResumeInput {
  definition: ExperimentDefinition;
  checkpoint: unknown;
  trials: readonly TrialRecord[];
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
  /** Continue an existing calibration instead of starting a fresh one. */
  resume?: ResumeInput | undefined;
}

export class BrowserRunController {
  readonly #canvas: HTMLCanvasElement;
  readonly #settings: AppSettings;
  readonly #callbacks: RunControllerCallbacks;
  readonly #definition: ExperimentDefinition;
  readonly #virtualLock: boolean;
  readonly #resume: ResumeInput | null;
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
  /**
   * How many interludes (breaks, pauses) are currently in progress.
   *
   * > 0 means the session asked Windows for the mouse back on purpose. The
   * lock-change that follows is therefore expected, and must never be read as
   * a fatal loss — which is precisely what ended rc.6 sessions at the first
   * break. This is the belt to `PointerLockCaptureSource`'s braces: even if a
   * user agent reported a deliberate release as a loss, the session would
   * still survive its own break.
   */
  #interludeDepth = 0;
  /** Why the run controller decided the session cannot continue. */
  #interruptionReason: { code: string; detail: string } | null = null;
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
    this.#resume = options.resume ?? null;
    canvas.width = LOGICAL_VIEWPORT.widthPx;
    canvas.height = LOGICAL_VIEWPORT.heightPx;

    // Continuing a calibration MUST reuse the original definition: a rebuilt
    // one would have a new experiment id, a fresh candidate ladder and a
    // different blinding, so "continue" would silently be "start over".
    if (this.#resume) {
      this.#definition = this.#resume.definition;
      return;
    }

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
    const backend = new IndexedDbBackend(await openTraimerDb());
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
    // The arena click is the only user gesture the session ever gets, and an
    // AudioContext created outside one starts suspended and stays silent.
    this.#audio.unlock();
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

    const ports: SessionRunnerPorts = {
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
          // ARMED BEFORE the release, and cleared only once the mouse is
          // actually back. Between those two points a lock-change carrying
          // "lost" is the interlude WE asked for, never a fatal interruption
          // — see #handleCaptureEvent.
          this.#interludeDepth++;
          // The E2E adapter holds no real lock, but it MUST still report the
          // interlude: that the automated suite could not tell "mouse held"
          // from "mouse free" is exactly why a break screen shipped with an
          // unclickable button.
          if (!this.#virtualLock) capture.releaseLock();
          this.#callbacks.onCaptureSuspended?.(reason);
        },
        resumeCapture: async (reason) => {
          if (this.#virtualLock) {
            this.#interludeDepth = Math.max(0, this.#interludeDepth - 1);
            this.#callbacks.onCaptureResumed?.();
            return LOCK_GRANTED;
          }
          if (capture.isLocked) {
            this.#interludeDepth = Math.max(0, this.#interludeDepth - 1);
            this.#callbacks.onCaptureResumed?.();
            return LOCK_GRANTED;
          }
          // Chromium may grant a re-lock without a fresh gesture; when it
          // refuses, the honest answer is to ask the player for a click
          // rather than to end the session.
          const direct = await capture.requestLock();
          if (direct.granted && capture.isLocked) {
            this.#interludeDepth = Math.max(0, this.#interludeDepth - 1);
            this.#callbacks.onCaptureResumed?.();
            return direct;
          }
          if (this.#cancelledBeforeStart) {
            this.#interludeDepth = Math.max(0, this.#interludeDepth - 1);
            return direct;
          }
          const settled = await this.#awaitCaptureGesture(reason);
          this.#interludeDepth = Math.max(0, this.#interludeDepth - 1);
          return settled;
        },
      },
      onStateChange: (state, detail) => this.#callbacks.onHud(state, detail ?? ""),
      onCalibrationProgress: (progress) =>
        this.#callbacks.onCalibrationProgress?.(progress),
      onRest: (rest) => this.#callbacks.onRest?.(rest),
      onTrialPersisted: (trial) => {
        if (trial.phase === "measured") this.#measuredCount++;
        else this.#warmupCount++;
        if (trial.validity.status !== "valid") this.#invalidCount++;
        this.#callbacks.onTrialPersisted(trial);
      },
    };
    // Continuing an unfinished calibration restores the ORIGINAL session id,
    // completed steps, blinding and rep counters through the engine's resume
    // path — the same path the checkpoint list uses — so nothing already
    // measured is measured twice and nothing planned is skipped.
    const runner = this.#resume
      ? SessionRunner.resumeFrom(
          this.#resume.checkpoint,
          this.#definition,
          ports,
          this.#resume.trials,
        )
      : new SessionRunner(this.#definition, ports);
    if (this.#resume && runner.sessionId) this.#sessionId = runner.sessionId;
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

    this.#callbacks.onExperimentFinished(outcome);
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
      // so the UI always leaves the arena — WITH the same shaped outcome the
      // runner would have produced, so no caller has a second code path for
      // "ended before it began".
      this.#capture?.stop();
      const abortReason = {
        code: "cancelled",
        detail: "you ended the session before the first drill started",
      };
      this.#callbacks.onExperimentFinished({
        status: "aborted",
        trials: [],
        auditTrail: [],
        abortReason,
        recommendation: null,
        outcomeReport: buildSessionOutcomeReport({
          definition: this.#definition,
          trials: [],
          endKind: "ended-by-player",
          abortReason,
          progress: this.emptyProgress(),
        }),
      });
    }
  }

  /** True once start() has been entered (a runner exists or is being built). */
  get started(): boolean {
    return this.#started;
  }

  /**
   * The plan this session WOULD run, with nothing completed. Used when the
   * session ends before the runner exists, so even that ending reports a
   * truthful denominator instead of a blank.
   */
  emptyProgress(): CalibrationProgressSnapshot {
    const d = this.#definition;
    const rounds = Math.max(1, d.stoppingCriteria.maxSearchRounds);
    const stepsPlanned =
      d.candidates.length *
      (d.warmupTrialsPerCandidateBlock + d.measuredRepsPerCandidatePerRound) *
      rounds;
    return {
      stepsCompleted: 0,
      stepsPlanned,
      fraction: 0,
      roundIndex: 1,
      roundsPlanned: rounds,
      blockIndex: 1,
      blocksPerRound: d.candidates.length,
      measuredCompleted: 0,
      measuredPlanned: Math.min(
        d.candidates.length * d.measuredRepsPerCandidatePerRound * rounds,
        d.stoppingCriteria.maxTotalMeasuredTrials,
      ),
    };
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

  /**
   * READ-ONLY view of what is on screen right now, for automation only.
   *
   * The E2E player used to move in a fixed direction and click blindly, which
   * meant it never hit anything and produced trials the validator rejected —
   * so the browser suite exercised the arena's plumbing but never its
   * measurement. With this it can actually aim, which is what lets the suite
   * assert on hits, tracking quality, and evidence sufficiency.
   *
   * Everything here is derived from the recorder and the director; nothing is
   * recomputed, and nothing here can influence a measurement.
   */
  get arenaSnapshot(): ArenaSnapshot | null {
    const active = this.#active;
    if (!active) return null;
    const now = performance.now();
    const targets = active.recorder.activeTargetsAt(now).map((t) => ({
      id: String(t.id),
      x: t.x,
      y: t.y,
      radius: t.radius,
    }));
    const reticle = this.#capture?.reticle.position ?? null;
    const kind = this.#activeScenario?.kind ?? "flick-static";
    const first = targets[0] ?? null;
    return {
      scenarioKind: kind,
      mode: SCENARIO_MODE[kind],
      reticle,
      targets,
      liveTargets: targets.length,
      spawnedTargets: active.recorder.state.spawnedTargets.length,
      removedTargets: active.recorder.state.spawnedTargets.filter(
        (t) => t.removedMs !== null,
      ).length,
      shots: active.recorder.state.shotCount,
      hits: active.recorder.state.hitCount,
      elapsedMs: now - active.startedAtMonotonicMs,
      durationMs: active.director.durationMs,
      onTarget:
        first !== null &&
        reticle !== null &&
        Math.hypot(reticle.x - first.x, reticle.y - first.y) <= first.radius,
      streak: this.#streak,
      trackingClicks: this.#trackingClicks,
      effectCount: this.#fx.count,
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
      this.#runner.abort(
        this.#interruptionReason ?? {
          code: "capture-interrupted",
          detail:
            "the drill lost mouse capture or window focus, so it could not be measured",
        },
      );
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
        isFatalBetweenTrials(event, {
          started: this.#started,
          interludeDepth: this.#interludeDepth,
        })
      ) {
        this.#fatalInterruptionSeen = true;
        this.#runner?.abort({
          code: "pointer-lock-lost",
          detail:
            "Windows took the mouse back between drills (Esc, Alt-Tab, or another window stealing focus), so the next drill could not be measured",
        });
      }
      return;
    }
    // THE SHOT IS RECORDED FIRST. Every line below this one is presentation:
    // sound, hit markers, flashes, streaks. None of it can run before the
    // recorder has the event, none of it feeds back into hit detection, and
    // none of it changes what the target looked like at the moment the shot
    // was taken (docs/UI-CONTRACT.md §4, Pass 13 requirement 3).
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
      const isTracking = this.#activeScenario?.kind === "tracking";
      const pos = this.#capture?.reticle.position ?? null;
      const nowMs = performance.now();

      if (isTracking) {
        // Tracking is NOT shot. The click is still recorded above (it is real
        // behavioural data), but it gets no shot sound, no hit marker, no miss
        // ripple and no streak — dressing it up as a shot is what made every
        // click feel like a miss. It gets one thing: a hint, once.
        this.#trackingClicks++;
        if (this.#trackingClicks === 1) this.#fx.hintAt(nowMs);
      } else {
        this.#audio.shot();
        if (pos) this.#fx.muzzleAt(pos.x, pos.y, nowMs);
        if (removesOnHit && latest?.hit && latest.aimTargetId) {
          active.recorder.add({
            kind: "target-remove",
            tMs: latest.tMs + 1,
            targetId: latest.aimTargetId as never,
            reason: "hit",
          });
          active.director.observeRemoval(latest.tMs + 1);
          this.#streak++;
          this.#bestStreak = Math.max(this.#bestStreak, this.#streak);
          this.#audio.hit(this.#streak);
          if (pos) this.#fx.hitMarkerAt(pos.x, pos.y, nowMs, this.#streak);
        } else if (latest && !latest.hit) {
          this.#streak = 0;
          this.#audio.miss();
          if (pos) this.#fx.missAt(pos.x, pos.y, nowMs);
        }
      }
    }

    // Fatal interruptions (manual-test policy E4): losing pointer lock or
    // window focus mid-trial ends the trial as invalid and cancels the
    // session honestly — no trial measured without full control survives.
    // A release WE asked for (break/pause/session end) is not a loss and
    // never happens mid-trial.
    const isFatal = isFatalDuringTrial(event);
    if (isFatal && !active.fatalSeen) {
      active.fatalSeen = true;
      this.#fatalInterruptionSeen = true;
      this.#interruptionReason ??=
        event.kind === "focus-change"
          ? {
              code: "focus-lost",
              detail:
                "the window lost focus during a drill, so that drill (and everything after it) could not be measured",
            }
          : {
              code: "pointer-lock-lost",
              detail:
                "the mouse was released during a drill (Esc, Alt-Tab, or another window stealing focus), so that drill could not be measured",
            };
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
          this.#interruptionReason ??= {
            code: "time-jump",
            detail:
              "this PC slept or the clock jumped mid-drill, so the timing of that drill is not usable data",
          };
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
  readonly #audio = new ArenaAudio();
  #activeScenario: ScenarioDefinition | null = null;
  /** Consecutive hits, presentation only — never an input to any measurement. */
  #streak = 0;
  #bestStreak = 0;
  /** Set when a click lands during a tracking drill, so the hint can appear once. */
  #trackingClicks = 0;
  /**
   * Display-only running total of time the reticle spent inside the tracking
   * target this drill. The SCORED figure comes from
   * `computeTrackingMetrics()` over the recorded pointer stream; this is a
   * frame-rate approximation used purely to draw the on-target arc.
   */
  #trackOnTargetMs = 0;
  #trackLastFrameMs: number | null = null;
  #trackCompleteAtMs: number | null = null;
  #trackWasComplete = false;
  /** The last tracking drill that ran to its natural end, for automation. */
  #lastTrackingCompletion: {
    onTargetRatio: number;
    clicks: number;
    completedAtMs: number;
  } | null = null;
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
      mode: SCENARIO_MODE[scenario.kind],
      scenarioKind: scenario.kind,
    });
  }

  #beginTrialPresentation(scenario: ScenarioDefinition): void {
    this.#activeScenario = scenario;
    this.#removalFxSeen = new Set();
    this.#trackingClicks = 0;
    this.#trackOnTargetMs = 0;
    this.#trackLastFrameMs = null;
    this.#trackCompleteAtMs = null;
    this.#trackWasComplete = false;
    this.#fx.clear();
    if (scenario.kind === "tracking") this.#audio.trackStart();
  }

  /** Releases the audio graph when the session ends. */
  disposeAudio(): void {
    this.#audio.dispose();
  }

  /** Presentation state the arena tests read (streaks, tracking hints). */
  get presentationDebug(): {
    streak: number;
    bestStreak: number;
    trackingClicks: number;
    effectCount: number;
    lastTrackingCompletion: {
      onTargetRatio: number;
      clicks: number;
      completedAtMs: number;
    } | null;
  } {
    return {
      streak: this.#streak,
      bestStreak: this.#bestStreak,
      trackingClicks: this.#trackingClicks,
      effectCount: this.#fx.count,
      lastTrackingCompletion: this.#lastTrackingCompletion,
    };
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
    const tracking = kind === "tracking";

    // Departures: pop on hit, fade on expiry. Read from the recorder so the
    // animation happens exactly where the engine says the target was.
    for (const gone of director.recorder.removedTargetsAt(now)) {
      if (this.#removalFxSeen.has(gone.id)) continue;
      this.#removalFxSeen.add(gone.id);
      if (gone.reason === "hit") {
        this.#fx.hitAt(gone.x, gone.y, gone.radius, gone.removedMs, palette.core);
      } else if (gone.reason === "expired") {
        this.#fx.expireAt(gone.x, gone.y, gone.radius, gone.removedMs);
        this.#streak = 0;
        this.#audio.expired();
      }
    }

    // ---- tracking: on-target state, elapsed fraction, completion ----
    let onTargetNow = false;
    let trackFraction = 0;
    if (tracking) {
      const started = director.startedAtMonotonicMs;
      const total = director.durationMs;
      const primary = targets[0] ?? null;
      if (primary && reticlePos) {
        onTargetNow =
          Math.hypot(reticlePos.x - primary.x, reticlePos.y - primary.y) <=
          primary.radius;
      }
      // Display-only accumulation (the scored figure is computed from the
      // recorded pointer stream by computeTrackingMetrics()).
      if (this.#trackLastFrameMs !== null) {
        const dt = Math.max(0, Math.min(120, now - this.#trackLastFrameMs));
        if (onTargetNow) this.#trackOnTargetMs += dt;
      }
      this.#trackLastFrameMs = now;
      if (started !== null && total > 0) {
        trackFraction = Math.max(0, Math.min(1, (now - started) / total));
        // The director ends a tracking drill 25 ms before its nominal window,
        // so `fraction >= 1` alone never fires — and the completion banner
        // would be painted on a frame that is never drawn. `director.finished`
        // is set by the tick() that precedes this draw, so the LAST painted
        // frame carries the banner. That frame then stays on screen for the
        // inter-trial gap, which is what makes the signal visible at all.
        if ((trackFraction >= 1 || director.finished) && !this.#trackWasComplete) {
          this.#trackWasComplete = true;
          this.#trackCompleteAtMs = now;
          this.#audio.trackComplete();
          // Survives the end of the drill so automation (and the next
          // drill's HUD) can prove the completion signal actually fired.
          this.#lastTrackingCompletion = {
            onTargetRatio:
              total > 0 ? Math.max(0, Math.min(1, this.#trackOnTargetMs / total)) : 0,
            clicks: this.#trackingClicks,
            completedAtMs: now,
          };
        }
      }
    }

    for (const target of targets) {
      const age = now - target.appearedMs;
      if (tracking) {
        drawTrackingTarget(ctx, target, age, now, palette, onTargetNow, trackFraction);
      } else {
        drawTarget(ctx, target, age, palette);
      }
    }

    // A guide line from the reticle to the target while OFF target: it names
    // the one thing the drill wants ("be here"), and vanishes the instant the
    // crosshair arrives so it never clutters a good pass.
    if (tracking && reticlePos && targets[0] && !onTargetNow) {
      drawTrackingGuide(ctx, reticlePos, targets[0], palette);
    }

    this.#fx.draw(ctx, now);

    if (tracking) {
      const onTargetRatio =
        trackFraction > 0 && director.durationMs > 0
          ? Math.max(
              0,
              Math.min(1, this.#trackOnTargetMs / (trackFraction * director.durationMs)),
            )
          : 0;
      drawTrackingHud(ctx, w, h, {
        elapsedFraction: trackFraction,
        onTargetRatio,
        onTargetNow,
        palette,
        remainingMs: Math.max(0, director.durationMs * (1 - trackFraction)),
        completedAtMs: this.#trackCompleteAtMs,
        now,
        showNoShootHint: this.#trackingClicks > 0,
      });
    }

    // Sequence pips for the switch drill: how many of the three are done.
    if (kind === "target-switch") {
      const total = this.#activeScenario?.targetsPerTrial ?? 3;
      const done = director.recorder.state.spawnedTargets.filter((t) => t.removalReason === "hit").length;
      const missed = director.recorder.state.spawnedTargets.filter((t) => t.removalReason === "expired").length;
      drawSequencePips(ctx, w / 2, h - 26, total, done, missed, palette.core);
    }

    // The mode banner is drawn LAST of the HUD layers and never over the
    // playfield centre, so it can never hide a target or a shot.
    drawModeBanner(ctx, w, tracking ? "track" : "shoot", palette);

    if (reticlePos) {
      drawReticle(ctx, reticlePos.x, reticlePos.y, tracking, onTargetNow, palette);
      if (!tracking && this.#streak >= 3) {
        drawStreak(ctx, reticlePos.x, reticlePos.y, this.#streak);
      }
    }
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

}

/**
 * The tracking target, drawn so it CANNOT be mistaken for something to shoot.
 *
 * Three deliberate differences from a click-to-hit target:
 *   - it is a hollow ring, not a solid disc — there is nothing in the middle
 *     to aim at;
 *   - it carries a dashed, slowly rotating outer collar: a "follow me"
 *     affordance rather than a "hit me" one;
 *   - it answers the crosshair continuously (locked / not locked) instead of
 *     answering a click, once.
 *
 * rc.6 drew this drill as an ordinary filled disc in a different colour. A
 * real player read it as one more thing to shoot, clicked it repeatedly, and
 * because clicking is not how the drill ends, every click felt like a miss.
 */
function drawTrackingTarget(
  ctx: CanvasRenderingContext2D,
  target: ActiveTargetView,
  ageMs: number,
  now: number,
  palette: TargetPalette,
  onTarget: boolean,
  elapsedFraction: number,
): void {
  const { x, y, radius } = target;
  const spawn = easeOutCubic(ageMs / SPAWN_ANIM_MS);

  // Halo — brighter and tighter when the crosshair is inside.
  ctx.beginPath();
  ctx.arc(x, y, radius * (onTarget ? 1.5 : 1.75), 0, Math.PI * 2);
  ctx.fillStyle = onTarget ? palette.glow : "rgba(255, 111, 216, 0.12)";
  ctx.globalAlpha = 0.4 + 0.6 * spawn;
  ctx.fill();
  ctx.globalAlpha = 1;

  // Rotating dashed collar: the "follow me" affordance.
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((now / 2600) * Math.PI * 2);
  ctx.beginPath();
  ctx.arc(0, 0, radius + 11, 0, Math.PI * 2);
  ctx.setLineDash([9, 11]);
  ctx.strokeStyle = onTarget ? palette.rim : "rgba(255, 208, 242, 0.5)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // The scored radius: a thick ring, never a disc.
  ctx.beginPath();
  ctx.arc(x, y, Math.max(2, radius - 4), 0, Math.PI * 2);
  ctx.strokeStyle = palette.core;
  ctx.lineWidth = 7;
  ctx.stroke();

  // Hollow centre with only a faint cross, so the middle reads as "space the
  // crosshair sits in" rather than "a thing to click".
  ctx.beginPath();
  ctx.moveTo(x - 5, y);
  ctx.lineTo(x + 5, y);
  ctx.moveTo(x, y - 5);
  ctx.lineTo(x, y + 5);
  ctx.strokeStyle = onTarget ? palette.rim : "rgba(255, 208, 242, 0.35)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // On target: a bright lock ring that snaps on and off with the contact.
  if (onTarget) {
    ctx.beginPath();
    ctx.arc(x, y, radius + 4, 0, Math.PI * 2);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // Time-remaining arc drawn ON the target, so the clock is where the eyes
  // already are. Empties clockwise from the top as the window runs out.
  const arcR = radius + 19;
  ctx.beginPath();
  ctx.arc(x, y, arcR, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.13)";
  ctx.lineWidth = 3;
  ctx.stroke();
  const remaining = Math.max(0, 1 - elapsedFraction);
  if (remaining > 0) {
    ctx.beginPath();
    ctx.arc(x, y, arcR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * remaining);
    ctx.strokeStyle = palette.rim;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.lineCap = "butt";
  }
}

/** A soft dashed line from the crosshair to the tracking target while off it. */
function drawTrackingGuide(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  target: ActiveTargetView,
  palette: TargetPalette,
): void {
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < target.radius + 24) return;
  const ux = dx / dist;
  const uy = dy / dist;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(from.x + ux * 14, from.y + uy * 14);
  ctx.lineTo(target.x - ux * (target.radius + 6), target.y - uy * (target.radius + 6));
  ctx.setLineDash([4, 7]);
  ctx.strokeStyle = palette.glow;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function drawReticle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  tracking = false,
  onTarget = false,
  palette?: TargetPalette,
): void {
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
  // The crosshair ITSELF reports contact during a tracking drill: the player
  // gets on-target / off-target feedback without ever looking away from the
  // thing they are following.
  cross(tracking && onTarget ? (palette?.rim ?? "#ffffff") : "#ffffff", 1.5);
  if (tracking) {
    ctx.beginPath();
    ctx.arc(x, y, 6.5, 0, Math.PI * 2);
    ctx.strokeStyle = onTarget
      ? (palette?.core ?? "#ffffff")
      : "rgba(255,255,255,0.35)";
    ctx.lineWidth = onTarget ? 2 : 1;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(x, y, 1.4, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
}

/**
 * The two-word mode banner: SHOOT or TRACK, with the one instruction that
 * matters underneath. Anchored to the TOP of the arena, well clear of the
 * playfield centre, so it can never sit over a target or a shot.
 */
function drawModeBanner(
  ctx: CanvasRenderingContext2D,
  w: number,
  mode: "shoot" | "track",
  palette: TargetPalette,
): void {
  const track = mode === "track";
  const label = track ? "TRACK" : "SHOOT";
  const hint = track
    ? "Keep your crosshair on the target — don't shoot"
    : "Click the targets";
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.font = "700 15px system-ui, -apple-system, Segoe UI, sans-serif";
  const labelW = ctx.measureText(label).width;
  ctx.font = "500 12px system-ui, -apple-system, Segoe UI, sans-serif";
  const hintW = ctx.measureText(hint).width;
  const boxW = Math.max(labelW + 34, hintW + 34);
  const boxH = track ? 46 : 30;
  const x = (w - boxW) / 2;
  const y = 10;

  roundRect(ctx, x, y, boxW, boxH, 8);
  ctx.fillStyle = track ? "rgba(255, 111, 216, 0.14)" : "rgba(255,255,255,0.05)";
  ctx.fill();
  ctx.strokeStyle = track ? palette.core : "rgba(255,255,255,0.16)";
  ctx.lineWidth = track ? 1.5 : 1;
  ctx.stroke();

  ctx.font = "700 15px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillStyle = track ? palette.rim : "rgba(255,255,255,0.72)";
  ctx.fillText(label, w / 2, y + (track ? 16 : 15));
  if (track) {
    ctx.font = "500 12px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.82)";
    ctx.fillText(hint, w / 2, y + 33);
  }
  ctx.restore();
}

interface TrackingHudState {
  elapsedFraction: number;
  onTargetRatio: number;
  onTargetNow: boolean;
  palette: TargetPalette;
  remainingMs: number;
  completedAtMs: number | null;
  now: number;
  showNoShootHint: boolean;
}

/**
 * The tracking drill's own HUD: seconds remaining, an on-target meter, a
 * clear "no need to shoot" answer for a player who clicked anyway, and an
 * unmistakable completion state.
 *
 * Everything here is drawn along the BOTTOM edge; nothing overlaps the band
 * the Lissajous path sweeps through.
 */
function drawTrackingHud(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  state: TrackingHudState,
): void {
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Completion banner — the drill ENDED, it did not ignore you.
  if (state.completedAtMs !== null) {
    const age = state.now - state.completedAtMs;
    const alpha = Math.max(0, 1 - age / 900);
    if (alpha > 0) {
      ctx.globalAlpha = alpha;
      ctx.font = "700 26px system-ui, -apple-system, Segoe UI, sans-serif";
      ctx.fillStyle = state.palette.rim;
      ctx.fillText("TRACK COMPLETE", w / 2, h / 2 - 96);
      ctx.font = "500 14px system-ui, -apple-system, Segoe UI, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillText(
        `${Math.round(state.onTargetRatio * 100)}% on target`,
        w / 2,
        h / 2 - 70,
      );
      ctx.globalAlpha = 1;
    }
  }

  // On-target meter + countdown.
  const barW = Math.min(320, w * 0.28);
  const x = (w - barW) / 2;
  const y = h - 34;
  ctx.font = "600 11px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillStyle = state.onTargetNow ? state.palette.rim : "rgba(255,255,255,0.55)";
  ctx.fillText(
    state.onTargetNow ? "ON TARGET" : "OFF TARGET",
    w / 2,
    y - 10,
  );

  ctx.fillStyle = "rgba(255,255,255,0.14)";
  ctx.fillRect(x, y, barW, 4);
  ctx.fillStyle = state.palette.core;
  ctx.fillRect(x, y, barW * Math.max(0, Math.min(1, state.onTargetRatio)), 4);

  ctx.font = "500 11px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.textAlign = "left";
  ctx.fillText(`${(state.remainingMs / 1000).toFixed(1)}s left`, x + barW + 12, y + 2);
  ctx.textAlign = "right";
  ctx.fillText("on target", x - 12, y + 2);

  // Answers the exact question a click asks.
  if (state.showNoShootHint) {
    ctx.textAlign = "center";
    ctx.font = "600 13px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.fillStyle = "rgba(255, 208, 242, 0.92)";
    ctx.fillText("No need to shoot — just stay on it", w / 2, y - 30);
  }
  ctx.restore();
}

/** Consecutive-hit counter. Presentation only; never scored, never persisted. */
function drawStreak(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  streak: number,
): void {
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "700 13px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillText(`x${streak}`, x + 25, y - 19);
  ctx.fillStyle = streak >= 6 ? "#ffd76a" : "rgba(255,255,255,0.85)";
  ctx.fillText(`x${streak}`, x + 24, y - 20);
  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
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
/** A confirmed-hit tick mark and the flash of the shot that produced it. */
interface Mark {
  x: number;
  y: number;
  t0: number;
  kind: "hitmarker" | "muzzle";
  /** Streak at the moment of the hit (drives the tick colour only). */
  streak: number;
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
  static readonly HITMARKER_MS = 190;
  static readonly MUZZLE_MS = 70;
  static readonly MAX = 24;
  #bursts: Burst[] = [];
  #ripples: Ripple[] = [];
  #marks: Mark[] = [];
  #seed = 1;

  /** Live effect count — the leak guard the arena tests assert against. */
  get count(): number {
    return this.#bursts.length + this.#ripples.length + this.#marks.length;
  }

  /** Drops every effect. Called at each drill boundary so nothing carries over. */
  clear(): void {
    this.#bursts.length = 0;
    this.#ripples.length = 0;
    this.#marks.length = 0;
  }

  /** Instant confirmation at the crosshair that a shot connected. */
  hitMarkerAt(x: number, y: number, t0: number, streak: number): void {
    this.#marks.push({ x, y, t0, kind: "hitmarker", streak });
    if (this.#marks.length > ArenaFx.MAX) this.#marks.shift();
  }

  /** The visual half of "a shot went out": a brief flash at the crosshair. */
  muzzleAt(x: number, y: number, t0: number): void {
    this.#marks.push({ x, y, t0, kind: "muzzle", streak: 0 });
    if (this.#marks.length > ArenaFx.MAX) this.#marks.shift();
  }

  /** A click during a tracking drill. Recorded as data; shown as a nudge. */
  hintAt(_t0: number): void {
    // The hint itself is drawn by the tracking HUD (it needs the drill's own
    // layout); this exists so the controller has one place to signal it.
  }

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
    if (this.#marks.length > 0) {
      this.#marks = this.#marks.filter((m) =>
        m.kind === "muzzle"
          ? now - m.t0 < ArenaFx.MUZZLE_MS
          : now - m.t0 < ArenaFx.HITMARKER_MS,
      );
      for (const m of this.#marks) {
        if (m.kind === "muzzle") {
          // A soft flash AT THE CROSSHAIR. Deliberately not a weapon model and
          // deliberately not a screen shake: nothing may move the aiming
          // reference or cover a target the player is about to shoot.
          const p = Math.min(1, Math.max(0, (now - m.t0) / ArenaFx.MUZZLE_MS));
          ctx.beginPath();
          ctx.arc(m.x, m.y, 5 + p * 13, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255, 246, 214, ${(0.3 * (1 - p)).toFixed(3)})`;
          ctx.fill();
          continue;
        }
        // Hit marker: four diagonal ticks, the universal "that connected".
        const p = Math.min(1, Math.max(0, (now - m.t0) / ArenaFx.HITMARKER_MS));
        const spread = 6 + 5 * easeOutCubic(p);
        const len = 7 * (1 - 0.35 * p);
        const alpha = 1 - p;
        ctx.save();
        ctx.lineCap = "round";
        for (const [sx, sy] of [
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
        ] as const) {
          ctx.beginPath();
          ctx.moveTo(m.x + sx * spread, m.y + sy * spread);
          ctx.lineTo(m.x + sx * (spread + len), m.y + sy * (spread + len));
          ctx.strokeStyle = `rgba(0,0,0,${(0.5 * alpha).toFixed(3)})`;
          ctx.lineWidth = 4;
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(m.x + sx * spread, m.y + sy * spread);
          ctx.lineTo(m.x + sx * (spread + len), m.y + sy * (spread + len));
          ctx.strokeStyle =
            m.streak >= 6
              ? `rgba(255, 215, 106, ${alpha.toFixed(3)})`
              : `rgba(255,255,255,${alpha.toFixed(3)})`;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        ctx.restore();
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
