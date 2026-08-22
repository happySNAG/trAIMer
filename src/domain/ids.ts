export type PlayerId = `player-${string}`;
export type MouseConfigId = `mouse-${string}`;
export type SessionId = `session-${string}`;
export type ExperimentId = `experiment-${string}`;
export type TrialId = `trial-${string}`;
export type CandidateId = `cand-${string}`;
export type TargetId = `target-${string}`;

export function makePlayerId(suffix: string): PlayerId {
  return `player-${suffix}`;
}

export function makeMouseConfigId(suffix: string): MouseConfigId {
  return `mouse-${suffix}`;
}

export function makeSessionId(suffix: string): SessionId {
  return `session-${suffix}`;
}

export function makeExperimentId(suffix: string): ExperimentId {
  return `experiment-${suffix}`;
}

export function makeTrialId(suffix: string): TrialId {
  return `trial-${suffix}`;
}

export function makeCandidateId(suffix: string): CandidateId {
  return `cand-${suffix}`;
}

export function makeTargetId(suffix: string): TargetId {
  return `target-${suffix}`;
}
