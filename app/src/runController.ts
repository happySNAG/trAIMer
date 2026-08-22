import { SystemMonotonicClock } from "../../src/capture/clock.ts";
import {
  PointerLockCaptureSource,
  type BrowserDocumentLike,
  type DomEventTargetLike,
  type LockRequestableElement,
} from "../../src/capture/browserSource.ts";
import type { CaptureEvent } from "../../src/capture/events.ts";
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
import { SessionRunner } from "../../src/session/runner.ts";
import type { SessionStateName } from "../../src/session/types.ts";
import { makeExperimentId, makeSessionId, makeTrialId } from "../../src/domain/ids.ts";
import type { AppSettings } from "./state.ts";

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
  onExperimentFinished(status: "complete" | "aborted"): void;
}

type DirectorRecorder = InstanceType<typeof ScenarioDirector>["recorder"];

interface ActiveTrial {
  director: ScenarioDirector;
  recorder: DirectorRecorder;
  startedAtMonotonicMs: number;
  resolve: (record: TrialRecord) => void;
  fatalSeen: boolean;
}

export class BrowserRunController {
  readonly #canvas: HTMLCanvasElement;
  readonly #settings: AppSettings;
  readonly #callbacks: RunControllerCallbacks;
  readonly #definition;
  #capture: PointerLockCaptureSource | null = null;
  #store: LocalJsonStore | null = null;
  #runner: SessionRunner | null = null;
  #active: ActiveTrial | null = null;
  #rafHandle: number | null = null;
  #fatalInterruptionSeen = false;
  #sessionId: ReturnType<typeof makeSessionId> | null = null;

  private constructor(
    canvas: HTMLCanvasElement,
    settings: AppSettings,
    callbacks: RunControllerCallbacks,
  ) {
    this.#canvas = canvas;
    this.#settings = settings;
    this.#callbacks = callbacks;
    canvas.width = LOGICAL_VIEWPORT.widthPx;
    canvas.height = LOGICAL_VIEWPORT.heightPx;

    this.#definition = buildExperimentDefinition({
      id: makeExperimentId(`live-${settings.experimentSeed}`),
      name: `live session (${settings.playerName})`,
      baselineSensitivity: { sensX: settings.sensX, sensY: settings.sensY },
      dpi: settings.dpi,
      orderSeed: settings.experimentSeed,
      measuredRepsPerCandidatePerRound: settings.repsPerCandidate,
      warmupTrialsPerCandidateBlock: settings.warmupTrials,
      stoppingCriteria: { maxSearchRounds: Math.max(1, settings.rounds) },
      yExploration: { enabled: settings.yExploration },
      notes: "browser live session",
    });
  }

  static async create(
    canvas: HTMLCanvasElement,
    settings: AppSettings,
    callbacks: RunControllerCallbacks,
  ): Promise<BrowserRunController> {
    const controller = new BrowserRunController(canvas, settings, callbacks);
    const backend = new IndexedDbBackend(await openAimLabDb());
    controller.#store = new LocalJsonStore(backend);
    return controller;
  }

  get definition() {
    return this.#definition;
  }

  async start(): Promise<{ status: "complete" | "aborted"; trials: TrialRecord[] }> {
    const capture = new PointerLockCaptureSource({
      element: this.#canvas as unknown as LockRequestableElement,
      document: window.document as unknown as BrowserDocumentLike,
      window: window as unknown as DomEventTargetLike,
      viewportProvider: () => ({ ...LOGICAL_VIEWPORT }),
    });
    capture.start({ onEvent: (event) => this.#handleCaptureEvent(event) });
    this.#capture = capture;

    if (!this.#store) throw new Error("store unavailable");
    this.#sessionId = makeSessionId(`live-${Date.now()}`);

    const runner = new SessionRunner(this.#definition, {
      clock: new SystemMonotonicClock(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      nowIso: () => new Date().toISOString(),
      store: this.#store,
      execution: {
        requestLock: () => capture.requestLock(),
        executeTrial: (spec, round, repIndex) =>
          this.#executeTrial(spec, round, repIndex),
        releaseCapture: async () => capture.releaseLock(),
      },
      onStateChange: (state, detail) => this.#callbacks.onHud(state, detail ?? ""),
      onTrialPersisted: (trial) => this.#callbacks.onTrialPersisted(trial),
    });
    this.#runner = runner;

    const outcome = await runner.run();
    capture.stop();
    this.#callbacks.onExperimentFinished(outcome.status);
    return outcome;
  }

  pause(): void {
    this.#runner?.pause();
  }

  resume(): void {
    this.#runner?.resume();
  }

  cancel(): void {
    this.#runner?.cancel();
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
    if (!active) return;
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
      }
    }

    const isFatal =
      (event.kind === "lock-change" && !event.locked) ||
      (event.kind === "focus-change" &&
        !event.focused &&
        event.reason !== "window-blur-focus-restore");
    if (isFatal && !active.fatalSeen) {
      active.fatalSeen = true;
      this.#fatalInterruptionSeen = true;
      active.recorder.abort(event.tMs, "pointer-lock-loss");
    }
  }

  #startRenderLoop(director: ScenarioDirector): void {
    const ctx = this.#canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas unavailable");
    const frame = (): void => {
      const now = performance.now();
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

  #drawFrame(
    ctx: CanvasRenderingContext2D,
    targets: { x: number; y: number; radius: number }[],
  ): void {
    ctx.clearRect(0, 0, LOGICAL_VIEWPORT.widthPx, LOGICAL_VIEWPORT.heightPx);
    ctx.fillStyle = "#101418";
    ctx.fillRect(0, 0, LOGICAL_VIEWPORT.widthPx, LOGICAL_VIEWPORT.heightPx);
    for (const target of targets) {
      ctx.beginPath();
      ctx.arc(target.x, target.y, target.radius, 0, Math.PI * 2);
      ctx.fillStyle = "#3aa0ff";
      ctx.fill();
      ctx.strokeStyle = "#bfe0ff";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    const reticlePos = this.#capture?.reticle.position;
    if (reticlePos) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
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
    }
  }
}

