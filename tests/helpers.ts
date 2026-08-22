import { initialReticlePosition } from "../src/capture/events.ts";
import type { TrialRecordingRequest } from "../src/capture/recorder.ts";
import type { SensitivityConfiguration } from "../src/domain/settings.ts";
import type {
  ScenarioKind,
  ScenarioPhase,
  TargetSpan,
  TrialOutcome,
  TrialRecord,
} from "../src/domain/trial.ts";
import { equalXy } from "../src/domain/settings.ts";

export const TEST_VIEWPORT = { widthPx: 1280, heightPx: 720 };

export interface MakeTrialOptions {
  id?: string;
  scenarioId?: string;
  scenarioKind?: ScenarioKind;
  phase?: ScenarioPhase;
  candidateId?: string;
  scenarioRepIndex?: number | null;
  sensitivity?: SensitivityConfiguration;
  dpi?: number;
  startedAtMonotonicMs?: number;
  samples?: { tMs: number; cursor: { x: number; y: number }; dx?: number; dy?: number }[];
  targets?: TargetSpan[];
  shots?: TrialRecord["shots"];
  outcome?: TrialOutcome;
  focusInterruptions?: TrialRecord["focusInterruptions"];
}

export function makeTrial(options: MakeTrialOptions = {}): TrialRecord {
  const sensitivity = options.sensitivity ?? equalXy(7);
  const request: TrialRecordingRequest = {
    id: (options.id ?? "trial-test") as TrialRecord["id"],
    sessionId: "session-test",
    experimentId: null,
    candidateId: (options.candidateId ?? "cand-baseline") as TrialRecord["candidateId"],
    indexInSession: 0,
    phase: options.phase ?? "measured",
    scenarioId: options.scenarioId ?? "flick-static-medium",
    scenarioKind: options.scenarioKind ?? "flick-static",
    viewport: TEST_VIEWPORT,
    sensitivity,
    dpi: options.dpi ?? 800,
    expectedSampleIntervalMs: 4.1667,
    startedAtMonotonicMs: options.startedAtMonotonicMs ?? 0,
    scenarioRepIndex: null,
  };
  return {
    id: request.id,
    sessionId: request.sessionId,
    experimentId: request.experimentId,
    candidateId: request.candidateId,
    indexInSession: 0,
    phase: request.phase,
    scenarioRepIndex: options.scenarioRepIndex ?? null,
    scenarioId: request.scenarioId,
    scenarioKind: request.scenarioKind,
    captureContext: {
      scenarioKind: request.scenarioKind,
      viewport: request.viewport,
      sensitivity: request.sensitivity,
      dpi: request.dpi,
      expectedSampleIntervalMs: request.expectedSampleIntervalMs,
    },
    startedAtMonotonicMs: request.startedAtMonotonicMs,
    endedAtMonotonicMs:
      options.samples && options.samples.length > 0
        ? options.samples[options.samples.length - 1]!.tMs
        : (request.startedAtMonotonicMs),
    samples: (options.samples ?? []).map((s) => ({
      tMs: s.tMs,
      cursor: s.cursor,
      dx: s.dx ?? 0,
      dy: s.dy ?? 0,
    })),
    targets: options.targets ?? [],
    shots: options.shots ?? [],
    focusInterruptions: options.focusInterruptions ?? [],
    viewportResizes: [],
    outcome: options.outcome ?? "hit",
    abortedMs: null,
    validity: { status: "valid", reasons: [] },
    seedTag: null,
  };
}

export function straightFlickTrial(overrides: {
  reactionMs?: number;
  moveDurationMs?: number;
  distancePx?: number;
  targetRadiusPx?: number;
  overshootPx?: number;
  stopShortRatio?: number;
  shotDelayAfterArrivalMs?: number;
} = {}): TrialRecord {
  const reactionMs = overrides.reactionMs ?? 200;
  const moveMs = overrides.moveDurationMs ?? 150;
  const distance = overrides.distancePx ?? 400;
  const radius = overrides.targetRadiusPx ?? 26;
  const start = initialReticlePosition(TEST_VIEWPORT);
  const targetCenter = { x: start.x + distance, y: start.y };
  const dt = 4;
  const appearT = 100;
  const onsetT = appearT + reactionMs;

  const progressFor = (t: number): number => {
    const z = Math.min(1, Math.max(0, (t - onsetT) / moveMs));
    return z * z * (3 - 2 * z);
  };

  let executedRatio = 1;
  if (overrides.overshootPx !== undefined) executedRatio = 1 + overrides.overshootPx / distance;
  else if (overrides.stopShortRatio !== undefined) executedRatio = overrides.stopShortRatio;

  const arrivalOrStopT = onsetT + moveMs;
  const settle = overrides.shotDelayAfterArrivalMs ?? 60;
  const shotT = arrivalOrStopT + settle;

  const samples: MakeTrialOptions["samples"] = [];
  let prevCursor = start;
  for (let t = 0; t <= shotT; t += dt) {
    const z = progressFor(Math.min(t, arrivalOrStopT));
    const cursor = {
      x: start.x + (targetCenter.x - start.x) * z * executedRatio,
      y: start.y,
    };
    samples.push({
      tMs: t,
      cursor,
      dx: cursor.x - prevCursor.x,
      dy: cursor.y - prevCursor.y,
    });
    prevCursor = cursor;
  }

  const recorderCursor = samples[samples.length - 1]!.cursor;
  const hit =
    Math.abs(recorderCursor.x - targetCenter.x) <= radius &&
    Math.abs(recorderCursor.y - targetCenter.y) <= radius;

  return makeTrial({
    samples,
    targets: [
      {
        targetId: "target-t1",
        radiusPx: radius,
        appearedMs: appearT,
        removedMs: hit ? shotT : null,
        removalReason: hit ? "hit" : null,
        motion: { kind: "static", position: targetCenter },
      },
    ],
    shots: [
      {
        tMs: shotT,
        cursorAtShot: recorderCursor,
        aimedTargetId: hit ? "target-t1" : null,
        hit,
        missDistancePx: hit
          ? 0
          : Math.abs(recorderCursor.x - targetCenter.x) - radius,
      },
    ],
    outcome: hit ? "hit" : "miss-shot-fired",
  });
}
