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
import { initialReticlePosition, type CaptureEvent } from "./events.ts";

export interface TrialRecordingRequest {
  id: TrialId;
  sessionId: SessionId | null;
  experimentId: ExperimentId | null;
  candidateId: CandidateId | null;
  indexInSession: number;
  phase: ScenarioPhase;
  scenarioId: string;
  scenarioKind: ScenarioKind;
  viewport: { widthPx: number; heightPx: number };
  sensitivity: SensitivityConfiguration;
  dpi: number;
  expectedSampleIntervalMs: number | null;
  startedAtMonotonicMs: number;
  seedTag?: string;
}

export class TrialRecorder {
  readonly #request: TrialRecordingRequest;
  #cursor: Vec2;
  readonly #samples: TrialRecord["samples"] = [];
  readonly #targets: TargetSpan[] = [];
  readonly #shots: ShotEvent[] = [];
  readonly #focusInterruptions: TrialRecord["focusInterruptions"] = [];

  constructor(request: TrialRecordingRequest) {
    this.#request = request;
    this.#cursor = initialReticlePosition(request.viewport);
  }

  get cursorPosition(): Vec2 {
    return this.#cursor;
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
    }
  }

  finish(outcome: TrialOutcome, endedAtMonotonicMs: number): TrialRecord {
    for (const span of this.#targets) {
      if (span.removedMs === null) {
        span.removedMs = endedAtMonotonicMs;
        span.removalReason = "trial-end";
      }
    }
    const req = this.#request;
    return {
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
      outcome,
      validity: { status: "valid", reasons: [] },
      seedTag: req.seedTag ?? null,
    };
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
