import type { SensitivityConfiguration } from "../domain/settings.ts";
import type { TrialRecord } from "../domain/trial.ts";
import type { InvalidReason, InvalidReasonCode, TrialValidity } from "../domain/validity.ts";

export interface ValidationConfig {
  minSamples: number;
  maxSampleGapMs: number;
  maxGapMultipleOfExpectedInterval: number;
  maxCursorSpeedPxPerMs: number;
  maxSingleSampleJumpPx: number;
  treatTimeoutAsFatal: boolean;
  requireTargetAppearance: boolean;
}

export const DEFAULT_VALIDATION_CONFIG: ValidationConfig = {
  minSamples: 10,
  maxSampleGapMs: 250,
  maxGapMultipleOfExpectedInterval: 25,
  maxCursorSpeedPxPerMs: 60,
  maxSingleSampleJumpPx: 768,
  treatTimeoutAsFatal: false,
  requireTargetAppearance: true,
};

export interface ValidationExpectations {
  sensitivity?: SensitivityConfiguration | undefined;
  dpi?: number | undefined;
  sensitivityEpsilon?: number | undefined;
}

function reason(
  code: InvalidReasonCode,
  severity: "fatal" | "suspect",
  detail: string,
): InvalidReason {
  return { code, severity, detail };
}

export function validateTrial(
  record: TrialRecord,
  config: ValidationConfig = DEFAULT_VALIDATION_CONFIG,
  expectations: ValidationExpectations = {},
): TrialValidity {
  const reasons: InvalidReason[] = [];

  const samples = record.samples;
  if (samples.length < config.minSamples) {
    reasons.push(
      reason(
        "INSUFFICIENT_SAMPLES",
        "fatal",
        `expected at least ${config.minSamples} samples, found ${samples.length}`,
      ),
    );
  }

  let previousT: number | null = null;
  let previousCursor: { x: number; y: number } | null = null;
  let maxGapMs = 0;
  for (const s of samples) {
    if (s.tMs < record.startedAtMonotonicMs - 1e-6) {
      reasons.push(
        reason(
          "IMPOSSIBLE_TIMESTAMPS",
          "fatal",
          `sample at ${s.tMs}ms precedes trial start ${record.startedAtMonotonicMs}ms`,
        ),
      );
      break;
    }
    if (previousT !== null && s.tMs < previousT) {
      reasons.push(
        reason(
          "IMPOSSIBLE_TIMESTAMPS",
          "fatal",
          `non-monotonic timestamps: ${previousT}ms then ${s.tMs}ms`,
        ),
      );
      break;
    }
    if (previousT !== null) {
      maxGapMs = Math.max(maxGapMs, s.tMs - previousT);
    }
    if (previousCursor !== null) {
      const jump = Math.hypot(s.cursor.x - previousCursor.x, s.cursor.y - previousCursor.y);
      const dt = Math.max(previousT === null ? 1 : s.tMs - previousT, 0.001);
      if (jump / dt > config.maxCursorSpeedPxPerMs || jump > config.maxSingleSampleJumpPx) {
        reasons.push(
          reason(
            "IMPOSSIBLE_MOVEMENT",
            "fatal",
            `cursor jumped ${jump.toFixed(1)}px over ${dt.toFixed(2)}ms`,
          ),
        );
        break;
      }
    }
    previousT = s.tMs;
    previousCursor = s.cursor;
  }

  const expectedInterval = record.captureContext.expectedSampleIntervalMs;
  const gapLimit = Math.max(
    config.maxSampleGapMs,
    expectedInterval !== null
      ? expectedInterval * config.maxGapMultipleOfExpectedInterval
      : 0,
  );
  if (gapLimit > 0 && maxGapMs > gapLimit) {
    reasons.push(
      reason(
        "LARGE_SAMPLE_GAP",
        "fatal",
        `largest inter-sample gap ${maxGapMs.toFixed(1)}ms exceeds limit ${gapLimit.toFixed(1)}ms`,
      ),
    );
  }

  if (record.endedAtMonotonicMs < record.startedAtMonotonicMs) {
    reasons.push(
      reason(
        "IMPOSSIBLE_TIMESTAMPS",
        "fatal",
        "trial ends before it starts",
      ),
    );
  }

  const firstTarget = record.targets[0] ?? null;
  if (config.requireTargetAppearance && !firstTarget) {
    reasons.push(
      reason("MISSING_TARGET_APPEARANCE", "fatal", "no target was spawned"),
    );
  }

  if (firstTarget && record.shots.length > 0) {
    const firstShot = record.shots[0]!;
    if (firstShot.tMs < firstTarget.appearedMs) {
      reasons.push(
        reason(
          "CLICK_BEFORE_TARGET_APPEARANCE",
          "suspect",
          `shot at ${firstShot.tMs}ms before target appearance at ${firstTarget.appearedMs}ms`,
        ),
      );
    }
  }

  if (record.focusInterruptions.length > 0) {
    reasons.push(
      reason(
        "FOCUS_LOSS",
        "suspect",
        `${record.focusInterruptions.length} focus interruption(s) during trial`,
      ),
    );
  }

  if (
    config.treatTimeoutAsFatal &&
    record.outcome === "timeout-no-shot" &&
    (record.scenarioKind === "flick-static" ||
      record.scenarioKind === "flick-dynamic")
  ) {
    reasons.push(
      reason(
        "TRIAL_TIMEOUT",
        "suspect",
        `no shot fired within timeout for ${record.scenarioId}`,
      ),
    );
  }

  const eps = expectations.sensitivityEpsilon ?? 1e-6;
  if (expectations.sensitivity) {
    const actual = record.captureContext.sensitivity;
    if (
      Math.abs(actual.sensX - expectations.sensitivity.sensX) > eps ||
      Math.abs(actual.sensY - expectations.sensitivity.sensY) > eps
    ) {
      reasons.push(
        reason(
          "CONFIG_MISMATCH",
          "fatal",
          `trial sensitivity (${actual.sensX}/${actual.sensY}) differs from expected (${expectations.sensitivity.sensX}/${expectations.sensitivity.sensY})`,
        ),
      );
    }
  }
  if (
    expectations.dpi !== undefined &&
    Math.abs(record.captureContext.dpi - expectations.dpi) > 1e-6
  ) {
    reasons.push(
      reason(
        "CONFIG_MISMATCH",
        "fatal",
        `trial dpi ${record.captureContext.dpi} differs from expected ${expectations.dpi}`,
      ),
    );
  }

  const fatal = reasons.filter((r) => r.severity === "fatal");
  if (fatal.length > 0) {
    return { status: "invalid", reasons };
  }
  if (reasons.length > 0) {
    return { status: "suspect", reasons };
  }
  return { status: "valid", reasons: [] };
}
