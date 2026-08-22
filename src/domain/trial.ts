import type { Vec2 } from "./geometry.ts";
import type { TargetId, TrialId, CandidateId, SessionId, ExperimentId } from "./ids.ts";
import type { SensitivityConfiguration } from "./settings.ts";
import type { TrialValidity } from "./validity.ts";

export type ScenarioPhase = "warmup" | "measured";

export type TrialOutcome =
  | "hit"
  | "miss-shot-fired"
  | "timeout-no-shot"
  | "tracking-complete"
  | "aborted";

export interface PointerSample {
  tMs: number;
  cursor: Vec2;
  dx: number;
  dy: number;
}

export interface TargetKeyframe {
  tMs: number;
  position: Vec2;
}

export interface TargetSpan {
  targetId: TargetId;
  radiusPx: number;
  appearedMs: number;
  removedMs: number | null;
  removalReason: "hit" | "expired" | "trial-end" | null;
  motion: { kind: "static"; position: Vec2 } | { kind: "path"; keyframes: TargetKeyframe[] };
}

export interface ShotEvent {
  tMs: number;
  cursorAtShot: Vec2;
  aimedTargetId: TargetId | null;
  hit: boolean;
  missDistancePx: number | null;
}

export interface FocusInterruption {
  startMs: number;
  endMs: number | null;
  reason: string;
}

export interface ViewportResize {
  tMs: number;
  widthPx: number;
  heightPx: number;
}

export type ScenarioKind =
  | "flick-static"
  | "flick-dynamic"
  | "target-switch"
  | "tracking";

export interface TrialCaptureContext {
  scenarioKind: ScenarioKind;
  viewport: { widthPx: number; heightPx: number };
  sensitivity: SensitivityConfiguration;
  dpi: number;
  expectedSampleIntervalMs: number | null;
}

export interface TrialRecord {
  id: TrialId;
  sessionId: SessionId | null;
  experimentId: ExperimentId | null;
  candidateId: CandidateId | null;
  indexInSession: number;
  phase: ScenarioPhase;
  scenarioId: string;
  scenarioKind: ScenarioKind;
  captureContext: TrialCaptureContext;
  startedAtMonotonicMs: number;
  endedAtMonotonicMs: number;
  samples: PointerSample[];
  targets: TargetSpan[];
  shots: ShotEvent[];
  focusInterruptions: FocusInterruption[];
  viewportResizes: ViewportResize[];
  outcome: TrialOutcome;
  validity: TrialValidity;
  seedTag: string | null;
  scenarioRepIndex: number | null;
  abortedMs: number | null;
}

export function targetPositionAt(
  span: TargetSpan,
  tMs: number,
): Vec2 | null {
  if (span.motion.kind === "static") {
    return span.appearedMs <= tMs ? span.motion.position : null;
  }
  const keys = span.motion.keyframes;
  if (keys.length === 0 || tMs < keys[0]!.tMs) return null;
  let lo = 0;
  let hi = keys.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (keys[mid]!.tMs <= tMs) lo = mid;
    else hi = mid - 1;
  }
  const a = keys[lo]!;
  const b = keys[Math.min(lo + 1, keys.length - 1)]!;
  if (a === b || b.tMs === a.tMs) return a.position;
  const f = (tMs - a.tMs) / (b.tMs - a.tMs);
  return {
    x: a.position.x + (b.position.x - a.position.x) * f,
    y: a.position.y + (b.position.y - a.position.y) * f,
  };
}
