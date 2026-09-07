import type { LockOutcome } from "../capture/browserSource.ts";
import type { MonotonicClock } from "../capture/clock.ts";
import type { CaptureSourceMetadata } from "../capture/negotiation.ts";
import type { TrialRecord } from "../domain/trial.ts";
import type { TrialPlanSpec } from "../experiments/protocol.ts";
import type { LocalJsonStore } from "../persistence/store.ts";

export interface PlannedTrial {
  spec: TrialPlanSpec;
  round: number;
}

export interface TrialExecutionPort {
  /**
   * Acquires the input path the session needs. Returns a STRUCTURED outcome:
   * a refusal must always name its reason so the runner can abort with a
   * diagnostic instead of a bare "denied".
   */
  requestLock(): Promise<LockOutcome>;
  executeTrial(
    spec: TrialPlanSpec,
    round: number,
    repIndex: number | null,
  ): Promise<TrialRecord>;
  releaseCapture(): Promise<void>;
}

export interface SessionRunnerPorts {
  clock: MonotonicClock;
  sleep(ms: number): Promise<void>;
  nowIso(): string;
  store: LocalJsonStore;
  execution: TrialExecutionPort;
  onStateChange?: ((state: SessionStateName, detail?: string) => void) | undefined;
  onProgress?: ((progress: SessionProgressSnapshot) => void) | undefined;
  /**
   * A break started (with its planned length) or ended (null). Breaks are
   * always skippable through SessionRunner.skipRest().
   */
  onRest?: ((rest: RestNotice | null) => void) | undefined;
  onTrialPersisted?: ((trial: TrialRecord) => void) | undefined;
  /** Persisted into every checkpoint (requirement E/L provenance). */
  captureSourceMetadata?: (() => CaptureSourceMetadata | null) | undefined;
  playerIdentity?: (() => { playerId: string; playerName: string }) | undefined;
}

export interface RestNotice {
  durationMs: number;
  reason: string;
  skippable: boolean;
}

export interface SessionProgressSnapshot {
  state: SessionStateName;
  round: number;
  blindedCandidateLabel: string;
  scenarioInstruction: string;
  measuredCompleted: number;
  measuredPlannedUpperBound: number;
  lastEventDetail: string | null;
}

export interface SessionCheckpoint {
  sessionId: string;
  experimentId: string;
  status: "running" | "complete" | "aborted";
  completedSequenceKeys: string[];
  phaseLog: { state: string; tIso: string; detail?: string }[];
  activeTestingMs: number;
}

export type SessionStateName =
  | "idle"
  | "setup"
  | "awaiting-lock"
  | "candidate-transition"
  | "warmup"
  | "trial-ready"
  | "trial-active"
  | "inter-trial"
  | "rest"
  | "paused"
  | "analyzing"
  | "complete"
  | "aborted";

export const SESSION_STATE_NAMES: readonly SessionStateName[] = [
  "idle",
  "setup",
  "awaiting-lock",
  "candidate-transition",
  "warmup",
  "trial-ready",
  "trial-active",
  "inter-trial",
  "rest",
  "paused",
  "analyzing",
  "complete",
  "aborted",
];
