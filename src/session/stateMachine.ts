export const SESSION_STATES = [
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
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

export const SESSION_EVENTS = [
  "CONFIGURE",
  "REQUEST_LOCK",
  "LOCK_ACQUIRED",
  "LOCK_LOST",
  "BEGIN_WARMUP",
  "WARMUP_ENDED",
  "TRIAL_ANNOUNCED",
  "TRIAL_STARTED",
  "TRIAL_COMPLETED",
  "NEXT_TRIAL_READY",
  "REST_STARTED",
  "REST_ENDED",
  "PAUSE",
  "RESUME",
  "CANDIDATE_BLOCK_DONE",
  "ALL_TRIALS_DONE",
  "ANALYSIS_COMPLETE",
  "CANCEL",
  "FATAL_INTERRUPTION",
] as const;

export type SessionEvent = (typeof SESSION_EVENTS)[number];

type TransitionTable = Record<SessionState, Partial<Record<SessionEvent, SessionState>>>;

export const TRANSITIONS: TransitionTable = {
  idle: {
    CONFIGURE: "setup",
    CANCEL: "aborted",
  },
  setup: {
    REQUEST_LOCK: "awaiting-lock",
    CANCEL: "aborted",
  },
  "awaiting-lock": {
    LOCK_ACQUIRED: "candidate-transition",
    LOCK_LOST: "setup",
    CANCEL: "aborted",
  },
  "candidate-transition": {
    BEGIN_WARMUP: "warmup",
    TRIAL_ANNOUNCED: "trial-ready",
    ALL_TRIALS_DONE: "analyzing",
    PAUSE: "paused",
    CANCEL: "aborted",
    FATAL_INTERRUPTION: "aborted",
  },
  warmup: {
    TRIAL_STARTED: "trial-active",
    WARMUP_ENDED: "trial-ready",
    PAUSE: "paused",
    CANCEL: "aborted",
    FATAL_INTERRUPTION: "aborted",
  },
  "trial-ready": {
    TRIAL_STARTED: "trial-active",
    ALL_TRIALS_DONE: "analyzing",
    PAUSE: "paused",
    CANCEL: "aborted",
    FATAL_INTERRUPTION: "aborted",
  },
  "trial-active": {
    TRIAL_COMPLETED: "inter-trial",
    LOCK_LOST: "inter-trial",
    PAUSE: "paused",
    CANCEL: "aborted",
    FATAL_INTERRUPTION: "aborted",
  },
  "inter-trial": {
    NEXT_TRIAL_READY: "trial-ready",
    REST_STARTED: "rest",
    CANDIDATE_BLOCK_DONE: "candidate-transition",
    ALL_TRIALS_DONE: "analyzing",
    PAUSE: "paused",
    CANCEL: "aborted",
    FATAL_INTERRUPTION: "aborted",
  },
  rest: {
    REST_ENDED: "inter-trial",
    PAUSE: "paused",
    CANCEL: "aborted",
    FATAL_INTERRUPTION: "aborted",
  },
  paused: {
    RESUME: "inter-trial",
    CANCEL: "aborted",
  },
  analyzing: {
    ANALYSIS_COMPLETE: "complete",
    CANCEL: "aborted",
  },
  complete: {},
  aborted: {},
};

export class IllegalTransitionError extends Error {
  constructor(state: SessionState, event: SessionEvent) {
    super(`illegal session transition: ${event} while in state "${state}"`);
    this.name = "IllegalTransitionError";
  }
}

export function nextSessionState(
  state: SessionState,
  event: SessionEvent,
): SessionState | null {
  const target = TRANSITIONS[state][event];
  return target ?? null;
}
