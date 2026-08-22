import type { MonotonicClock } from "../capture/clock.ts";
import type { TrialRecord } from "../domain/trial.ts";
import type { TrialPlanSpec } from "../experiments/protocol.ts";
import type { LocalJsonStore } from "../persistence/store.ts";

export interface PlannedTrial {
  spec: TrialPlanSpec;
  round: number;
}

export interface TrialExecutionPort {
  requestLock(): Promise<boolean>;
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
  onTrialPersisted?: ((trial: TrialRecord) => void) | undefined;
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
