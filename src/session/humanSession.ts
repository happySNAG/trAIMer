import type { SessionId, ExperimentId, PlayerId } from "../domain/ids.ts";
import type { SensitivityConfiguration } from "../domain/settings.ts";
import type { Recommendation } from "../domain/recommendation.ts";
import { wrapEnvelope } from "../persistence/migrations.ts";
import type { SessionGameConversionRecord } from "../games/selection.ts";
import type { SessionArenaGainRecord } from "./arenaGainRecord.ts";

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
  /**
   * The game conversion this session produced, when a game profile was
   * selected (Game Profile Pass 1, requirement 18).
   *
   * OPTIONAL and type-only: no measurement code reads it, and every session
   * written before game profiles existed simply does not have the field.
   * Readers must treat absence as "no game profile", never as an error.
   */
  gameConversion?: SessionGameConversionRecord | null | undefined;
  /**
   * The sensitivity this session's arena actually applied, per candidate
   * (Pass 15, requirement I).
   *
   * OPTIONAL, and its ABSENCE is meaningful: every session written before the
   * arena applied candidate gain simply does not have it, and a reader must
   * treat that as "the player felt one sensitivity throughout", not as an
   * error and not as an unknown. See src/session/arenaGainRecord.ts.
   */
  arenaGain?: SessionArenaGainRecord | null | undefined;
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
  gameConversion: SessionGameConversionRecord | null = null,
  arenaGain: SessionArenaGainRecord | null = null,
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
    // Only written when a game profile was actually selected; a session with
    // none keeps the field absent rather than storing a null shape.
    ...(gameConversion ? { gameConversion } : {}),
    // Same rule: written only when the arena really applied per-candidate
    // gain, so a missing field is the honest marker for a pre-fix session
    // rather than a value that could be mistaken for one.
    ...(arenaGain ? { arenaGain } : {}),
  };
}

export function serializeHumanSession(record: HumanSessionRecord): string {
  return JSON.stringify(
    wrapEnvelope("human-session", record, new Date().toISOString()),
    null,
    2,
  );
}
