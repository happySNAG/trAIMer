import type { LockOutcome } from "../capture/browserSource.ts";
import type { MonotonicClock } from "../capture/clock.ts";
import type { CaptureSourceMetadata } from "../capture/negotiation.ts";
import type { TrialRecord } from "../domain/trial.ts";
import type { TrialPlanSpec } from "../experiments/protocol.ts";
import type { LocalJsonStore } from "../persistence/store.ts";
import type {
  CalibrationProgressSnapshot,
  SessionInstrumentation,
} from "../results/sessionOutcome.ts";

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
  /**
   * Hands the input path back for an INTERLUDE (a break, a pause) that shows
   * the player something to click.
   *
   * This is not the same as `releaseCapture`, which ends the session's claim
   * for good. Until rc.6 there was no such thing: a break drew a "Skip break"
   * button while the arena still held Pointer Lock, so there was no cursor to
   * press it with — "the time out screen you can't skip cause it freezes your
   * mouse".
   */
  suspendCapture(reason: string): Promise<void>;
  /**
   * Takes the input path back after an interlude. May legitimately have to
   * wait for a user gesture (Chromium refuses gesture-less pointer-lock
   * requests), so it returns the same structured outcome as `requestLock`.
   */
  resumeCapture(reason: string): Promise<LockOutcome>;
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
   * Truthful position in the CALIBRATION plan (not just this block). Fired
   * whenever the plan or the completed-step count changes, so the UI can show
   * "Calibration 28 %" from the engine's own numbers rather than guessing.
   */
  onCalibrationProgress?: ((progress: CalibrationProgressSnapshot) => void) | undefined;
  /**
   * A break started (with its planned length) or ended (null). Breaks are
   * always skippable through SessionRunner.skipRest().
   */
  onRest?: ((rest: RestNotice | null) => void) | undefined;
  onTrialPersisted?: ((trial: TrialRecord) => void) | undefined;
  /**
   * A bounded replacement block is being added because measurements were lost,
   * not because the plan was short. The player is told the count and the
   * reason before the drills start.
   */
  onReplacementBlock?: ((notice: ReplacementBlockNotice) => void) | undefined;
  /** Persisted into every checkpoint (requirement E/L provenance). */
  captureSourceMetadata?: (() => CaptureSourceMetadata | null) | undefined;
  playerIdentity?: (() => { playerId: string; playerName: string }) | undefined;
  /**
   * Local-only session diagnostics the shell can see and the engine cannot:
   * the capture tier that actually ran, clock-sync state, and the observed
   * DOM timestamp lead. Folded into every SessionOutcomeReport.
   */
  sessionInstrumentation?:
    | (() => Partial<SessionInstrumentation>)
    | undefined;
}

/**
 * Why extra drills are being added, in the player's own units.
 *
 * "3 additional drills needed because some measurements were unusable" — not
 * "the session was extended". A replacement block never adds evidence beyond
 * the mode's target; it replaces evidence the session already tried to
 * collect and lost.
 */
export interface ReplacementBlockNotice {
  blockIndex: number;
  maxBlocks: number;
  /** Measured drills this block contains. */
  drills: number;
  /** Candidate ids the drills are for, with how many each still needs. */
  perCandidate: { candidateId: string; blindedLabel: string; needed: number }[];
  reason: string;
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
