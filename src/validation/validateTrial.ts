import type { SensitivityConfiguration } from "../domain/settings.ts";
import type { TrialRecord } from "../domain/trial.ts";
import type { InvalidReason, InvalidReasonCode, TrialValidity } from "../domain/validity.ts";

export interface ValidationConfig {
  minSamples: number;
  maxSampleGapMs: number;
  maxGapMultipleOfExpectedInterval: number;
  hardSilentGapMs: number;
  activeMotionEpsilonPx: number;
  resizeAreaFractionThreshold: number;
  duplicateClickWindowMs: number;
  maxDuplicateClicksFlickTrials: number;
  maxCursorSpeedPxPerMs: number;
  maxSingleSampleJumpPx: number;
  treatTimeoutAsFatal: boolean;
  requireTargetAppearance: boolean;
}

export const DEFAULT_VALIDATION_CONFIG: ValidationConfig = {
  minSamples: 10,
  maxSampleGapMs: 250,
  maxGapMultipleOfExpectedInterval: 25,
  hardSilentGapMs: 1500,
  activeMotionEpsilonPx: 0.3,
  resizeAreaFractionThreshold: 0.1,
  duplicateClickWindowMs: 80,
  maxDuplicateClicksFlickTrials: 3,
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

  const stepMoved = (a: (typeof samples)[number], b: (typeof samples)[number]): number =>
    Math.hypot(b.cursor.x - a.cursor.x, b.cursor.y - a.cursor.y);

  const gapLimit = (() => {
    const expectedInterval = record.captureContext.expectedSampleIntervalMs;
    return Math.max(
      config.maxSampleGapMs,
      expectedInterval !== null
        ? expectedInterval * config.maxGapMultipleOfExpectedInterval
        : 0,
    );
  })();

  let previousT: number | null = null;
  let previousCursor: { x: number; y: number } | null = null;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
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
    if (previousCursor !== null && previousT !== null) {
      const jump = Math.hypot(s.cursor.x - previousCursor.x, s.cursor.y - previousCursor.y);
      const dt = Math.max(s.tMs - previousT, 0.001);
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
      const gapMs = s.tMs - previousT;
      if (gapMs > gapLimit) {
        const prevStep = i >= 2 ? stepMoved(samples[i - 2]!, samples[i - 1]!) : 0;
        const nextStep = i + 1 < samples.length ? stepMoved(s, samples[i + 1]!) : 0;
        const motionOnBothSides =
          prevStep > config.activeMotionEpsilonPx &&
          nextStep > config.activeMotionEpsilonPx;
        if (
          motionOnBothSides ||
          gapMs > config.hardSilentGapMs
        ) {
          reasons.push(
            reason(
              "LARGE_SAMPLE_GAP",
              "fatal",
              motionOnBothSides
                ? `capture stall of ${gapMs.toFixed(1)}ms during continuous movement`
                : `silent gap of ${gapMs.toFixed(1)}ms exceeds hard limit ${config.hardSilentGapMs}ms`,
            ),
          );
          break;
        }
      }
    }
    previousT = s.tMs;
    previousCursor = s.cursor;
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

  for (const interruption of record.focusInterruptions) {
    if (interruption.reason === "pointer-lock-loss") {
      reasons.push(
        reason(
          "POINTER_LOCK_LOSS",
          "fatal",
          `pointer lock lost at ${interruption.startMs}ms during trial`,
        ),
      );
    } else if (interruption.reason === "tab-hidden") {
      reasons.push(
        reason("TAB_HIDDEN", "fatal", `tab hidden at ${interruption.startMs}ms`),
      );
    } else {
      reasons.push(
        reason(
          "FOCUS_LOSS",
          "suspect",
          `focus interruption (${interruption.reason}) at ${interruption.startMs}ms`,
        ),
      );
    }
  }

  const initialViewport = record.captureContext.viewport;
  for (const resize of record.viewportResizes) {
    const areaBefore = initialViewport.widthPx * initialViewport.heightPx;
    const areaAfter = resize.widthPx * resize.heightPx;
    const changeFraction =
      Math.abs(areaAfter - areaBefore) / Math.max(areaBefore, 1);
    if (changeFraction > config.resizeAreaFractionThreshold) {
      reasons.push(
        reason(
          "RESIZE_DURING_TRIAL",
          "fatal",
          `viewport resized at ${resize.tMs}ms to ${resize.widthPx}x${resize.heightPx}`,
        ),
      );
    }
  }

  if (record.abortedMs !== null || record.outcome === "aborted") {
    reasons.push(
      reason(
        "TRIAL_ABORTED_BY_USER",
        "suspect",
        `trial aborted at ${record.abortedMs ?? record.endedAtMonotonicMs}ms; raw data retained`,
      ),
    );
  }

  if (
    (record.scenarioKind === "flick-static" ||
      record.scenarioKind === "flick-dynamic") &&
    record.shots.length > config.maxDuplicateClicksFlickTrials
  ) {
    reasons.push(
      reason(
        "DUPLICATE_CLICKS",
        "suspect",
        `${record.shots.length} clicks in a single-target flick trial`,
      ),
    );
  } else if (record.shots.length >= 2) {
    let rapidPairs = 0;
    for (let i = 1; i < record.shots.length; i++) {
      if (
        record.shots[i]!.tMs - record.shots[i - 1]!.tMs <
        config.duplicateClickWindowMs
      ) {
        rapidPairs++;
      }
    }
    if (rapidPairs > 0) {
      reasons.push(
        reason(
          "DUPLICATE_CLICKS",
          "suspect",
          `${rapidPairs} accidental double-click pair(s) within ${config.duplicateClickWindowMs}ms`,
        ),
      );
    }
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
