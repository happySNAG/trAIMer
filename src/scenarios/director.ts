import {
  TrialRecorder,
  type TrialRecordingRequest,
} from "../capture/recorder.ts";
import type { TrialOutcome, TrialRecord } from "../domain/trial.ts";
import type { TargetId } from "../domain/ids.ts";
import type { PlannedScenarioInstance, PlannedTarget } from "./planner.ts";

export interface DirectorTickStatus {
  finished: boolean;
  elapsedMs: number;
  spawnedCount: number;
}

const SWITCH_INTER_TARGET_GAP_MS = 120;

export class ScenarioDirector {
  readonly recorder: TrialRecorder;
  readonly #request: TrialRecordingRequest;
  readonly #instance: PlannedScenarioInstance;
  #startedAtMonotonicMs: number | null = null;
  #spawnedCount = 0;
  #lastRemovalAtMonotonicMs: number | null = null;
  #finished = false;

  constructor(
    request: TrialRecordingRequest,
    instance: PlannedScenarioInstance,
    recorder?: TrialRecorder,
  ) {
    this.#request = request;
    this.#instance = instance;
    this.recorder = recorder ?? new TrialRecorder(request);
  }

  start(nowMs: number): void {
    if (this.#startedAtMonotonicMs !== null) return;
    this.#startedAtMonotonicMs = nowMs;
  }

  get startedAtMonotonicMs(): number | null {
    return this.#startedAtMonotonicMs;
  }

  tick(nowMs: number): DirectorTickStatus {
    if (this.#finished || this.#startedAtMonotonicMs === null) {
      return { finished: true, elapsedMs: 0, spawnedCount: this.#spawnedCount };
    }
    const elapsed = nowMs - this.#startedAtMonotonicMs;

    while (this.#spawnedCount < this.#instance.targets.length) {
      const planned = this.#instance.targets[this.#spawnedCount]!;
      const scheduled =
        this.#startedAtMonotonicMs + planned.spawnDelayMs;
      const earliestAllowed =
        this.#lastRemovalAtMonotonicMs !== null
          ? this.#lastRemovalAtMonotonicMs + SWITCH_INTER_TARGET_GAP_MS
          : scheduled;
      const spawnAt = Math.max(scheduled, earliestAllowed);
      if (nowMs < spawnAt) break;
      this.#spawnTarget(planned, spawnAt);
      this.#spawnedCount++;
      if (planned.kind === "static" && this.#isSequentialScenario()) break;
    }

    if (this.#trialComplete(elapsed)) {
      this.#finish();
      return {
        finished: true,
        elapsedMs: elapsed,
        spawnedCount: this.#spawnedCount,
      };
    }

    return {
      finished: false,
      elapsedMs: elapsed,
      spawnedCount: this.#spawnedCount,
    };
  }

  observeRemoval(tMs: number): void {
    this.#lastRemovalAtMonotonicMs = tMs;
  }

  abort(nowMs: number, reason: string): void {
    if (this.#finished) return;
    this.recorder.abort(nowMs, reason);
    this.#finish();
  }

  get finished(): boolean {
    return this.#finished;
  }

  get outcome(): TrialOutcome | null {
    return this.#finished ? this.#computeOutcome() : null;
  }

  finishAndRecord(endedAtMonotonicMs: number): TrialRecord {
    this.#finish();
    return this.recorder.finish(this.#computeOutcome(), endedAtMonotonicMs);
  }

  isSequentialScenario(): boolean {
    return this.#isSequentialScenario();
  }

  #isSequentialScenario(): boolean {
    return (
      this.#request.scenarioKind === "target-switch" ||
      this.#request.scenarioKind === "tracking"
    );
  }

  #spawnTarget(planned: PlannedTarget, absoluteSpawnT: number): void {
    const targetId = `target-${this.#request.id}-${this.#spawnedCount}` as TargetId;
    this.recorder.add({
      kind: "target-spawn",
      tMs: absoluteSpawnT,
      targetId,
      radiusPx: planned.radiusPx,
      motion:
        planned.kind === "static"
          ? { kind: "static", position: planned.position }
          : {
              kind: "path",
              keyframes: planned.keyframes.map((k) => ({
                tMs:
                  (this.#startedAtMonotonicMs ?? absoluteSpawnT) + k.tMs,
                position: k.position,
              })),
            },
      });
  }

  #trialComplete(elapsedMs: number): boolean {
    const state = this.recorder.state;
    const allSpawned = this.#spawnedCount >= this.#instance.targets.length;
    const trackingKind = this.#request.scenarioKind === "tracking";
    if (!allSpawned && !trackingKind) {
      return false;
    }
    if (trackingKind) {
      return elapsedMs >= this.#instance.durationMs - 25;
    }
    if (this.#request.scenarioKind === "target-switch") {
      return state.spawnedTargets.every((t) => t.removedMs !== null);
    }
    const singleResolved = state.spawnedTargets.some(
      (t) => t.removedMs !== null || t.removalReason === "hit",
    );
    return singleResolved || elapsedMs >= this.#instance.durationMs - 25;
  }

  #computeOutcome(): TrialOutcome {
    const state = this.recorder.state;
    if (this.#request.scenarioKind === "tracking") {
      return "tracking-complete";
    }
    if (state.hitCount >= this.#instance.targets.length) return "hit";
    if (state.shotCount > 0) return "miss-shot-fired";
    return "timeout-no-shot";
  }

  #finish(): void {
    this.#finished = true;
  }
}
