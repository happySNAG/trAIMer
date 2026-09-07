import type {
  CandidateId,
  ExperimentId,
  SessionId,
  TrialId,
} from "../domain/ids.ts";
import { vecAdd, type Vec2 } from "../domain/geometry.ts";
import type {
  ScenarioKind,
  ScenarioPhase,
  ShotEvent,
  TargetSpan,
  TrialOutcome,
  TrialRecord,
} from "../domain/trial.ts";
import type { SensitivityConfiguration } from "../domain/settings.ts";
import { targetPositionAt } from "../domain/trial.ts";
import {
  POINTER_LOCK_LOSS_REASON,
  initialReticlePosition,
  type CaptureEvent,
} from "./events.ts";

export interface TrialRecordingRequest {
  id: TrialId;
  sessionId: SessionId | null;
  experimentId: ExperimentId | null;
  candidateId: CandidateId | null;
  indexInSession: number;
  phase: ScenarioPhase;
  scenarioId: string;
  scenarioKind: ScenarioKind;
  scenarioRepIndex: number | null;
  viewport: { widthPx: number; heightPx: number };
  sensitivity: SensitivityConfiguration;
  dpi: number;
  expectedSampleIntervalMs: number | null;
  startedAtMonotonicMs: number;
  seedTag?: string;
}

/** Presentation view of a live target (positions in logical px). */
export interface ActiveTargetView {
  id: TargetSpan["targetId"];
  x: number;
  y: number;
  radius: number;
  appearedMs: number;
  moving: boolean;
}

/** Presentation view of a target that has just left the arena. */
export interface RemovedTargetView {
  id: TargetSpan["targetId"];
  x: number;
  y: number;
  radius: number;
  removedMs: number;
  reason: "hit" | "expired" | "trial-end";
}

export class TrialRecorder {
  readonly #request: TrialRecordingRequest;
  #cursor: Vec2;
  readonly #samples: TrialRecord["samples"] = [];
  readonly #targets: TargetSpan[] = [];
  readonly #shots: ShotEvent[] = [];
  readonly #focusInterruptions: TrialRecord["focusInterruptions"] = [];
  readonly #resizes: TrialRecord["viewportResizes"] = [];
  #abortedMs: number | null = null;

  constructor(request: TrialRecordingRequest) {
    this.#request = request;
    this.#cursor = initialReticlePosition(request.viewport);
  }

  get cursorPosition(): Vec2 {
    return this.#cursor;
  }

  activeTargetsAt(tMs: number): ActiveTargetView[] {
    const out: ActiveTargetView[] = [];
    for (const span of this.#targets) {
      if (span.removedMs !== null && span.removedMs <= tMs) continue;
      if (span.appearedMs > tMs) continue;
      const pos =
        span.motion.kind === "static"
          ? span.motion.position
          : targetPositionAt(span, tMs);
      if (!pos) continue;
      out.push({
        id: span.targetId,
        x: pos.x,
        y: pos.y,
        radius: span.radiusPx,
        appearedMs: span.appearedMs,
        moving: span.motion.kind === "path",
      });
    }
    return out;
  }

  /**
   * Targets removed at or before `tMs` — presentation reads this to animate a
   * pop (hit) or a fade (expired) at the place the target was. Never used for
   * measurement.
   */
  removedTargetsAt(tMs: number): RemovedTargetView[] {
    const out: RemovedTargetView[] = [];
    for (const span of this.#targets) {
      if (span.removedMs === null || span.removedMs > tMs) continue;
      const pos =
        span.motion.kind === "static"
          ? span.motion.position
          : targetPositionAt(span, span.removedMs);
      if (!pos) continue;
      out.push({
        id: span.targetId,
        x: pos.x,
        y: pos.y,
        radius: span.radiusPx,
        removedMs: span.removedMs,
        reason: span.removalReason ?? "trial-end",
      });
    }
    return out;
  }

  get state(): {
    spawnedTargets: {
      targetId: TargetSpan["targetId"];
      appearedMs: number;
      removedMs: number | null;
      removalReason: string | null;
    }[];
    shotCount: number;
    hitCount: number;
    latestShot: { aimTargetId: string | null; hit: boolean; tMs: number } | null;
  } {
    const last = this.#shots.at(-1);
    return {
      spawnedTargets: this.#targets.map((t) => ({
        targetId: t.targetId,
        appearedMs: t.appearedMs,
        removedMs: t.removedMs,
        removalReason: t.removalReason,
      })),
      shotCount: this.#shots.length,
      hitCount: this.#shots.filter((s) => s.hit).length,
      latestShot: last
        ? { aimTargetId: last.aimedTargetId, hit: last.hit, tMs: last.tMs }
        : null,
    };
  }

  add(event: CaptureEvent): void {
    switch (event.kind) {
      case "pointer-sample": {
        this.#cursor = vecAdd(this.#cursor, { x: event.dx, y: event.dy });
        this.#samples.push({
          tMs: event.tMs,
          cursor: { ...this.#cursor },
          dx: event.dx,
          dy: event.dy,
        });
        break;
      }
      case "button": {
        if (event.action !== "press") break;
        const aimedTargetId = this.#targetUnderCursor(event.tMs);
        const missDistancePx =
          aimedTargetId === null
            ? this.#nearestTargetDistance(event.tMs)
            : 0;
        this.#shots.push({
          tMs: event.tMs,
          cursorAtShot: { ...this.#cursor },
          aimedTargetId,
          hit: aimedTargetId !== null,
          missDistancePx,
        });
        break;
      }
      case "target-spawn": {
        this.#targets.push({
          targetId: event.targetId,
          radiusPx: event.radiusPx,
          appearedMs: event.tMs,
          removedMs: null,
          removalReason: null,
          motion: event.motion,
        });
        break;
      }
      case "target-remove": {
        const span = [...this.#targets]
          .reverse()
          .find((t) => t.targetId === event.targetId && t.removedMs === null);
        if (span) {
          span.removedMs = event.tMs;
          span.removalReason = event.reason;
        }
        break;
      }
      case "focus-change": {
        const last = this.#focusInterruptions.at(-1);
        if (!event.focused) {
          this.#focusInterruptions.push({
            startMs: event.tMs,
            endMs: null,
            reason: event.reason,
          });
        } else if (last && last.endMs === null) {
          last.endMs = event.tMs;
        }
        break;
      }
      case "lock-change": {
        if (!event.locked && event.reason === POINTER_LOCK_LOSS_REASON) {
          this.add({
            kind: "focus-change",
            tMs: event.tMs,
            focused: false,
            reason: POINTER_LOCK_LOSS_REASON,
          });
        }
        break;
      }
      case "resize": {
        this.#resizes.push({
          tMs: event.tMs,
          widthPx: event.widthPx,
          heightPx: event.heightPx,
        });
        break;
      }
    }
  }

  abort(tMs: number, reason: string): void {
    if (this.#abortedMs !== null) return;
    this.#abortedMs = tMs;
    this.#focusInterruptions.push({ startMs: tMs, endMs: null, reason });
  }

  finish(outcome: TrialOutcome, endedAtMonotonicMs: number): TrialRecord {
    for (const span of this.#targets) {
      if (span.removedMs === null) {
        span.removedMs = endedAtMonotonicMs;
        span.removalReason = "trial-end";
      }
    }
    const req = this.#request;
    const record: TrialRecord = {
      id: req.id,
      sessionId: req.sessionId,
      experimentId: req.experimentId,
      candidateId: req.candidateId,
      indexInSession: req.indexInSession,
      phase: req.phase,
      scenarioId: req.scenarioId,
      scenarioKind: req.scenarioKind,
      captureContext: {
        scenarioKind: req.scenarioKind,
        viewport: req.viewport,
        sensitivity: req.sensitivity,
        dpi: req.dpi,
        expectedSampleIntervalMs: req.expectedSampleIntervalMs,
      },
      startedAtMonotonicMs: req.startedAtMonotonicMs,
      endedAtMonotonicMs,
      samples: this.#samples,
      targets: this.#targets.map((t) => structuredClone(t)),
      shots: [...this.#shots],
      focusInterruptions: this.#focusInterruptions.map((f) => ({ ...f })),
      viewportResizes: this.#resizes.map((r) => ({ ...r })),
      outcome,
      validity: { status: "valid", reasons: [] },
      seedTag: req.seedTag ?? null,
      scenarioRepIndex: req.scenarioRepIndex,
      abortedMs: this.#abortedMs,
    };
    // Pass 6 birth validation: a record containing non-finite numbers can
    // never be born "valid". Downstream pipelines that evaluate raw records
    // without a later validateTrial pass (ground-truth estimation, replay
    // harnesses) are thereby protected from NaN poisoning by construction.
    const nonFinite =
      !Number.isFinite(record.startedAtMonotonicMs) ||
      !Number.isFinite(endedAtMonotonicMs) ||
      record.samples.some(
        (s) =>
          !Number.isFinite(s.tMs) ||
          !Number.isFinite(s.cursor.x) ||
          !Number.isFinite(s.cursor.y) ||
          !Number.isFinite(s.dx) ||
          !Number.isFinite(s.dy),
      ) ||
      record.targets.some(
        (t) => !Number.isFinite(t.appearedMs) || !Number.isFinite(t.radiusPx),
      );
    if (nonFinite && record.validity.status === "valid") {
      record.validity = {
        status: "invalid",
        reasons: [
          {
            code: "IMPOSSIBLE_TIMESTAMPS",
            severity: "fatal",
            detail:
              "record contains non-finite timestamps/positions at creation; fail-closed",
          },
        ],
      };
    }
    return record;
  }

  #targetUnderCursor(tMs: number): TargetSpan["targetId"] | null {
    for (const span of this.#targets) {
      if (span.appearedMs > tMs) continue;
      if (span.removedMs !== null && span.removedMs < tMs) continue;
      const pos = spanMotionPosition(span, tMs);
      if (
        pos &&
        Math.hypot(pos.x - this.#cursor.x, pos.y - this.#cursor.y) <=
          span.radiusPx
      ) {
        return span.targetId;
      }
    }
    return null;
  }

  #nearestTargetDistance(tMs: number): number | null {
    let best: number | null = null;
    for (const span of this.#targets) {
      if (span.appearedMs > tMs) continue;
      const pos = spanMotionPosition(span, tMs);
      if (!pos) continue;
      const d = Math.hypot(pos.x - this.#cursor.x, pos.y - this.#cursor.y);
      best = best === null ? d : Math.min(best, d);
    }
    return best;
  }
}

function spanMotionPosition(
  span: TargetSpan,
  tMs: number,
): Vec2 | null {
  if (span.motion.kind === "static") return span.motion.position;
  const keys = span.motion.keyframes;
  let prev: { tMs: number; position: Vec2 } | null = null;
  for (const key of keys) {
    if (key.tMs <= tMs) prev = key;
    else break;
  }
  if (!prev) return null;
  return prev.position;
}

export function lastSampleTime(record: TrialRecord): number | null {
  const recorderLast = record.samples.at(-1);
  return recorderLast ? recorderLast.tMs : null;
}
