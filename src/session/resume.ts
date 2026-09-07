import type { ExperimentDefinition } from "../domain/experiment.ts";
import type { AuditEntry } from "./audit.ts";
import type { CaptureSourceMetadata } from "../capture/negotiation.ts";

/**
 * Production resume/recovery contracts (Pass 4, requirement L).
 *
 * A checkpoint captures EVERYTHING needed to restore a session exactly:
 * experiment seed, candidate labels/blinding, completed trial identities,
 * allocation counters, adaptive-search inputs, audit log, fatigue/timing
 * state, retest linkage, and calibration references. Restoring must never
 * silently repeat a completed measured trial; an interrupted in-progress
 * trial may be invalidated and repeated WITH explicit audit metadata.
 */

export interface ResumeCheckpoint {
  schemaVersion: number;
  kind: "session-resume";
  sessionId: string;
  experimentId: string;
  status: "running" | "interrupted" | "complete" | "aborted";
  /** ISO timestamp of the last successful persistence. */
  updatedAtIso: string;
  createdAtIso: string;

  // ---- restored execution state ----
  completedSequenceKeys: string[];
  /** Round the session was in when interrupted (-1 = not yet started). */
  currentRound: number;
  phaseLog: { state: string; tIso: string; detail?: string }[];
  activeTestingMs: number;
  continuousTestingMs: number;
  restCount: number;

  // ---- blinding / allocation ----
  blindedLabels: Record<string, string>;
  repCounterByCandidate: Record<string, number>;
  /** Completed measured trial ids, used to prove nothing repeats silently. */
  completedTrialIds: string[];

  // ---- provenance ----
  auditTrail: AuditEntry[];
  captureSource: CaptureSourceMetadata | null;
  playerId: string | null;
  playerName: string | null;
  dpi: number | null;
  retestOfExperimentId: string | null;
  calibrationRecordIdsX: string[];
  calibrationRecordIdsY: string[];

  // ---- versions ----
  appVersion: string;
  engineVersion: string;
  optimizerVersion: string;

  /**
   * Set when the process died while a trial was active. That trial's raw data
   * never made it to disk, so on resume it is INVALIDATED and repeated with
   * explicit audit metadata — never counted twice, never silently skipped.
   */
  interruptedTrial: {
    candidateId: string;
    scenarioId: string;
    phase: string;
    round: number;
    sequenceNumber: number;
  } | null;

  /** Last valid state name observed by the runner. */
  lastValidState: string;
}

export const RESUME_CHECKPOINT_SCHEMA_VERSION = 2;

export interface ResumeSummary {
  sessionId: string;
  experimentId: string;
  playerName: string;
  startedAtIso: string;
  updatedAtIso: string;
  ageMs: number;
  experimentLabel: string;
  completedMeasuredTrials: number;
  totalPlannedUpperBound: number;
  currentRound: number;
  captureSourceKind: string | null;
  lastValidState: string;
  hasInterruptedTrial: boolean;
  status: ResumeCheckpoint["status"];
}

/** Validates an untrusted parsed payload as a resume checkpoint (fail closed). */
export function parseResumeCheckpoint(raw: unknown): ResumeCheckpoint {
  const c = raw as Partial<ResumeCheckpoint> | null;
  if (!c || typeof c !== "object") {
    throw new Error("corrupted checkpoint: not an object");
  }
  if (c.schemaVersion !== RESUME_CHECKPOINT_SCHEMA_VERSION) {
    throw new Error(
      `unsupported checkpoint schemaVersion ${String(c.schemaVersion)} (expected ${RESUME_CHECKPOINT_SCHEMA_VERSION})`,
    );
  }
  if (c.kind !== "session-resume") {
    throw new Error(`corrupted checkpoint: wrong kind ${String(c.kind)}`);
  }
  if (
    typeof c.sessionId !== "string" ||
    typeof c.experimentId !== "string" ||
    !Array.isArray(c.completedSequenceKeys) ||
    !Array.isArray(c.phaseLog)
  ) {
    throw new Error("corrupted checkpoint: missing required fields");
  }
  return c as ResumeCheckpoint;
}

/** Human/UI-facing summary of one incomplete session. */
export function summarizeCheckpointForUi(
  checkpoint: ResumeCheckpoint,
  definition: ExperimentDefinition,
  nowIso: string,
): ResumeSummary {
  return {
    sessionId: checkpoint.sessionId,
    experimentId: checkpoint.experimentId,
    playerName: checkpoint.playerName ?? "unknown player",
    startedAtIso: checkpoint.createdAtIso,
    updatedAtIso: checkpoint.updatedAtIso,
    ageMs: Math.max(
      0,
      new Date(nowIso).getTime() - new Date(checkpoint.updatedAtIso).getTime(),
    ),
    experimentLabel: definition.name,
    completedMeasuredTrials: countCompletedMeasured(checkpoint),
    totalPlannedUpperBound: definition.stoppingCriteria.maxTotalMeasuredTrials,
    currentRound: checkpoint.currentRound,
    captureSourceKind: checkpoint.captureSource?.kind ?? null,
    lastValidState: checkpoint.lastValidState,
    hasInterruptedTrial: checkpoint.interruptedTrial !== null,
    status: checkpoint.status,
  };
}

function countCompletedMeasured(checkpoint: ResumeCheckpoint): number {
  // Sequence keys of measured trials were recorded with their round prefix;
  // the authoritative count is completedTrialIds intersected with the audit.
  return checkpoint.completedTrialIds.length;
}

/**
 * Computes what resume will do WITHOUT executing anything — used by both the
 * UI preview and the runner itself so they can never disagree.
 */
export interface ResumePlan {
  /** Specs already completed and therefore never repeated. */
  completedKeys: Set<string>;
  /** True when an in-progress trial will be invalidated + repeated. */
  willInvalidateInterruptedTrial: boolean;
  startRound: number;
  notes: string[];
}

export function buildResumePlan(
  checkpoint: ResumeCheckpoint,
  definition: ExperimentDefinition,
): ResumePlan {
  const notes: string[] = [];
  const compat = checkDefinitionCompatible(checkpoint, definition);
  if (!compat.compatible) {
    throw new Error(`cannot resume: ${compat.reason}`);
  }
  const willInvalidate = checkpoint.interruptedTrial !== null;
  if (willInvalidate) {
    notes.push(
      `in-progress ${checkpoint.interruptedTrial!.phase} trial (${checkpoint.interruptedTrial!.scenarioId}) will be invalidated and repeated with audit metadata`,
    );
  }
  notes.push(
    `${checkpoint.completedSequenceKeys.length} completed step(s) will be skipped; no completed trial repeats`,
  );
  return {
    completedKeys: new Set(checkpoint.completedSequenceKeys),
    willInvalidateInterruptedTrial: willInvalidate,
    startRound: Math.max(0, checkpoint.currentRound),
    notes,
  };
}

export function checkDefinitionCompatible(
  checkpoint: ResumeCheckpoint,
  definition: ExperimentDefinition,
): { compatible: boolean; reason: string | null } {
  if (checkpoint.experimentId !== definition.id) {
    return {
      compatible: false,
      reason: `checkpoint belongs to ${checkpoint.experimentId}, not ${definition.id}`,
    };
  }
  if (checkpoint.completedSequenceKeys.length > 0 && definition.candidates.length === 0) {
    return { compatible: false, reason: "definition has no candidates" };
  }
  return { compatible: true, reason: null };
}

/**
 * What "Continue calibration" should actually run.
 *
 * A session can finish its whole plan and STILL not support a recommendation
 * — five candidates at three reps each is a complete plan and not enough
 * evidence. Resuming such a checkpoint as-is would replay nothing at all and
 * hand the player the same "more data needed" screen a second time, which is
 * the most demoralising possible outcome of a button labelled "continue".
 *
 * So: if every step of every planned round is already complete, continuing
 * adds ONE more search round. Otherwise it simply picks up the remaining
 * steps. Pure function of the checkpoint and the definition, so the UI and
 * the runner cannot disagree about what continuing means.
 */
export function planContinuation(
  checkpoint: ResumeCheckpoint,
  definition: ExperimentDefinition,
  plannedStepsForRound: (round: number) => readonly { sequenceNumber: number }[],
): { definition: ExperimentDefinition; addedRound: boolean; remainingSteps: number } {
  const completed = new Set(checkpoint.completedSequenceKeys);
  const rounds = Math.max(1, definition.stoppingCriteria.maxSearchRounds);
  let remaining = 0;
  for (let round = 0; round < rounds; round++) {
    for (const spec of plannedStepsForRound(round)) {
      if (!completed.has(`${round}:${spec.sequenceNumber}`)) remaining++;
    }
  }
  if (remaining > 0) {
    return { definition, addedRound: false, remainingSteps: remaining };
  }
  return {
    definition: {
      ...definition,
      candidates: [...definition.candidates],
      stoppingCriteria: {
        ...definition.stoppingCriteria,
        maxSearchRounds: rounds + 1,
      },
    },
    addedRound: true,
    remainingSteps: 0,
  };
}
