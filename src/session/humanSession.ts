import type { SessionId, ExperimentId, PlayerId } from "../domain/ids.ts";
import type { SensitivityConfiguration } from "../domain/settings.ts";
import type { Recommendation } from "../domain/recommendation.ts";
import { wrapEnvelope } from "../persistence/migrations.ts";

export interface HumanSessionDevice {
  userAgent: string;
  platform: string;
  screenPx: { width: number; height: number };
  pointerCoalescingSupported: boolean | null;
}

export interface HumanSessionRestPeriod {
  startIso: string;
  endIso: string | null;
  reason: string;
}

export interface HumanSessionRecord {
  version: number;
  sessionId: SessionId;
  experimentId: ExperimentId;
  playerId: PlayerId;
  displayName: string;
  dpi: number;
  startingSensitivity: SensitivityConfiguration;
  device: HumanSessionDevice;
  startedAtIso: string;
  endedAtIso: string | null;
  activeTestingMs: number;
  wallClockMs: number;
  scenarioOrder: string[];
  candidateOrderBlinded: string[];
  candidateReveal: Record<string, string>;
  warmupCount: number;
  measuredCount: number;
  invalidTrialCount: number;
  pausePeriods: HumanSessionRestPeriod[];
  fatigueIndicators: {
    forcedRests: number;
    degradationDetected: boolean;
    degradationRatio: number | null;
  };
  recommendationEdpi: number | null;
  recommendationConfidence: number | null;
  recommendationRangeEdpi: { min: number; max: number } | null;
  optimizerVersion: string;
  scoringWeights: Record<string, number>;
  calibrationAdequateX: boolean | null;
  calibrationAdequateY: boolean | null;
  retestOfExperimentId: ExperimentId | null;
  sessionIndexForPlayer: number;
}

export const HUMAN_SESSION_RECORD_VERSION = 1;

export interface HumanSessionInput {
  sessionId: SessionId;
  experimentId: ExperimentId;
  playerId: PlayerId;
  displayName: string;
  dpi: number;
  startingSensitivity: SensitivityConfiguration;
  device: HumanSessionDevice;
  startedAtIso: string;
  scenarioOrder: string[];
  candidateOrderBlinded: string[];
  candidateReveal: Record<string, string>;
  warmupCount: number;
  measuredCount: number;
  invalidTrialCount: number;
  pausePeriods: HumanSessionRestPeriod[];
  fatigueIndicators: HumanSessionRecord["fatigueIndicators"];
  optimizerVersion: string;
  scoringWeights: Record<string, number>;
  calibrationAdequateX: boolean | null;
  calibrationAdequateY: boolean | null;
  retestOfExperimentId?: ExperimentId | null;
  sessionIndexForPlayer: number;
}

export function buildHumanSessionRecord(
  input: HumanSessionInput,
): HumanSessionRecord {
  return {
    version: HUMAN_SESSION_RECORD_VERSION,
    sessionId: input.sessionId,
    experimentId: input.experimentId,
    playerId: input.playerId,
    displayName: input.displayName,
    dpi: input.dpi,
    startingSensitivity: input.startingSensitivity,
    device: input.device,
    startedAtIso: input.startedAtIso,
    endedAtIso: null,
    activeTestingMs: 0,
    wallClockMs: 0,
    scenarioOrder: [...input.scenarioOrder],
    candidateOrderBlinded: [...input.candidateOrderBlinded],
    candidateReveal: { ...input.candidateReveal },
    warmupCount: input.warmupCount,
    measuredCount: input.measuredCount,
    invalidTrialCount: input.invalidTrialCount,
    pausePeriods: input.pausePeriods.map((p) => ({ ...p })),
    fatigueIndicators: { ...input.fatigueIndicators },
    recommendationEdpi: null,
    recommendationConfidence: null,
    recommendationRangeEdpi: null,
    optimizerVersion: input.optimizerVersion,
    scoringWeights: { ...input.scoringWeights },
    calibrationAdequateX: input.calibrationAdequateX,
    calibrationAdequateY: input.calibrationAdequateY,
    retestOfExperimentId: input.retestOfExperimentId ?? null,
    sessionIndexForPlayer: input.sessionIndexForPlayer,
  };
}

export function finalizeHumanSessionRecord(
  record: HumanSessionRecord,
  endedAtIso: string,
  recommendation: Recommendation | null,
  activeTestingMs: number,
): HumanSessionRecord {
  const ended = new Date(endedAtIso).getTime();
  const started = new Date(record.startedAtIso).getTime();
  return {
    ...record,
    endedAtIso,
    activeTestingMs,
    wallClockMs: Number.isFinite(ended) ? Math.max(0, ended - started) : 0,
    recommendationEdpi: recommendation?.recommendedEdpi ?? null,
    recommendationConfidence: recommendation?.confidence ?? null,
    recommendationRangeEdpi: recommendation
      ? {
          min: recommendation.edpiRange.min,
          max: recommendation.edpiRange.max,
        }
      : null,
  };
}

export function serializeHumanSession(record: HumanSessionRecord): string {
  return JSON.stringify(
    wrapEnvelope("human-session", record, new Date().toISOString()),
    null,
    2,
  );
}
