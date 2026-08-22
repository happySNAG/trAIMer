export const INVALID_REASON_CODES = [
  "IMPOSSIBLE_TIMESTAMPS",
  "MISSING_TARGET_APPEARANCE",
  "CLICK_BEFORE_TARGET_APPEARANCE",
  "INSUFFICIENT_SAMPLES",
  "FOCUS_LOSS",
  "LARGE_SAMPLE_GAP",
  "IMPOSSIBLE_MOVEMENT",
  "TRIAL_TIMEOUT",
  "CONFIG_MISMATCH",
  "POINTER_LOCK_LOSS",
  "TAB_HIDDEN",
  "RESIZE_DURING_TRIAL",
  "TRIAL_ABORTED_BY_USER",
  "DUPLICATE_CLICKS",
] as const;

export type InvalidReasonCode = (typeof INVALID_REASON_CODES)[number];

export type ValiditySeverity = "fatal" | "suspect";

export interface InvalidReason {
  code: InvalidReasonCode;
  severity: ValiditySeverity;
  detail: string;
}

export type TrialValidityStatus = "valid" | "suspect" | "invalid";

export interface TrialValidity {
  status: TrialValidityStatus;
  reasons: InvalidReason[];
}

export function validTrial(): TrialValidity {
  return { status: "valid", reasons: [] };
}

export const DEFAULT_FATAL_REASONS: readonly InvalidReasonCode[] = [
  "IMPOSSIBLE_TIMESTAMPS",
  "MISSING_TARGET_APPEARANCE",
  "INSUFFICIENT_SAMPLES",
  "LARGE_SAMPLE_GAP",
  "IMPOSSIBLE_MOVEMENT",
  "CONFIG_MISMATCH",
  "POINTER_LOCK_LOSS",
  "TAB_HIDDEN",
  "RESIZE_DURING_TRIAL",
];

export const DEFAULT_SUSPECT_REASONS: readonly InvalidReasonCode[] = [
  "FOCUS_LOSS",
  "TRIAL_TIMEOUT",
  "CLICK_BEFORE_TARGET_APPEARANCE",
  "TRIAL_ABORTED_BY_USER",
  "DUPLICATE_CLICKS",
];
