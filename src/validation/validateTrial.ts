import { DOM_CAPTURE_LEAD_TOLERANCE_MS } from "../capture/timebase.ts";
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
  /**
   * Pass 6 (false-exclusion fix): a genuine capture stall resumes the SAME
   * trajectory (the hand kept moving while events were lost), while a
   * deliberate inter-target re-aim pause changes direction substantially.
   * When the pre-gap and post-gap motion directions differ by more than
   * STALL_DIRECTION_COS_MIN (cosine similarity), the gap is treated as a
   * re-aim pause rather than a fatal stall. Optional; defaults preserve the
   * historical constant's intent while removing target-switch false
   * exclusions measured at ~17 % of simulated trials.
   */
  stallDirectionCosMin?: number;
  /** Post/pre-gap per-step speed ratio bounds consistent with a true stall. */
  stallSpeedRatioMax?: number;
  /**
   * Ceiling on the per-trial `timestampLeadToleranceMs` a capture source may
   * claim. A source that declares a larger tolerance than this is not
   * trusted: the ceiling exists so a future source cannot widen the rule by
   * declaring its way out of it.
   */
  maxTimestampLeadToleranceMs?: number;
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
  stallDirectionCosMin: 0.5,
  stallSpeedRatioMax: 5,
  maxTimestampLeadToleranceMs: DOM_CAPTURE_LEAD_TOLERANCE_MS,
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

  /**
   * How far a sample may precede the trial's recorded start.
   *
   * A capture source stamps an event with the moment the input OCCURRED; the
   * app starts a trial by reading the clock at the moment it OBSERVES that
   * the trial has begun. Same clock, different instants. Chromium delivers
   * coalesced pointer input aligned to the frame that consumes it, so the
   * first batch after a trial begins legitimately carries samples from a few
   * milliseconds earlier — measured at up to 12.7 ms in Chromium, and the
   * cause of 43 of 80 measured drills being thrown away as "broken
   * timestamps" on real Windows hardware in 1.0.0-rc.7.
   *
   * The tolerance comes from the SOURCE, is recorded in the trial, and is
   * capped here so no source can declare its way out of the rule. Absent (any
   * record written by rc.7 or earlier, and every synthetic stream) means 0 —
   * the historical rule, unchanged.
   *
   * This does not weaken the check it replaces: a genuine clock-domain error
   * produces leads of seconds, three orders of magnitude outside the window.
   */
  const leadToleranceMs = Math.min(
    Math.max(record.captureContext.timestampLeadToleranceMs ?? 0, 0),
    config.maxTimestampLeadToleranceMs ?? DOM_CAPTURE_LEAD_TOLERANCE_MS,
  );
  const earliestAllowedSampleMs = record.startedAtMonotonicMs - leadToleranceMs;

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
    // Non-finite values poison every downstream comparison (NaN > limit is
    // always false) — fail closed on them explicitly (Pass 5 adversarial fix).
    if (
      !Number.isFinite(s.tMs) ||
      !Number.isFinite(s.cursor.x) ||
      !Number.isFinite(s.cursor.y) ||
      !Number.isFinite(s.dx) ||
      !Number.isFinite(s.dy)
    ) {
      reasons.push(
        reason(
          "IMPOSSIBLE_TIMESTAMPS",
          "fatal",
          `sample ${i} contains non-finite values (tMs=${String(s.tMs)}, cursor=${String(s.cursor?.x)},${String(s.cursor?.y)})`,
        ),
      );
      break;
    }
    if (s.tMs < earliestAllowedSampleMs - 1e-6) {
      const leadMs = record.startedAtMonotonicMs - s.tMs;
      reasons.push(
        reason(
          "IMPOSSIBLE_TIMESTAMPS",
          "fatal",
          `sample at ${s.tMs}ms precedes trial start ${record.startedAtMonotonicMs}ms by ${leadMs.toFixed(1)}ms, beyond the ${leadToleranceMs}ms this capture source can lead by`,
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
        // Direction-aware stall discrimination (Pass 6): a device stall
        // resumes along the same trajectory; a deliberate re-aim pause
        // turns substantially. Only same-direction, similar-speed gaps
        // flanked by motion count as stalls.
        let reAimPause = false;
        if (motionOnBothSides && i >= 2 && i + 1 < samples.length) {
          const a = samples[i - 2]!;
          const b = samples[i - 1]!;
          const c = s;
          const d = samples[i + 1]!;
          const v1x = b.cursor.x - a.cursor.x;
          const v1y = b.cursor.y - a.cursor.y;
          const v2x = d.cursor.x - c.cursor.x;
          const v2y = d.cursor.y - c.cursor.y;
          const cosAngle = (v1x * v2x + v1y * v2y) / Math.max(prevStep * nextStep, 1e-9);
          const speedRatio = nextStep / Math.max(prevStep, 1e-9);
          const cosMin = config.stallDirectionCosMin ?? 0.5;
          const ratioMax = config.stallSpeedRatioMax ?? 5;
          reAimPause =
            cosAngle < cosMin || speedRatio > ratioMax || speedRatio < 1 / ratioMax;
        }
        if (
          (motionOnBothSides && !reAimPause) ||
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

  if (
    !Number.isFinite(record.startedAtMonotonicMs) ||
    !Number.isFinite(record.endedAtMonotonicMs)
  ) {
    reasons.push(
      reason(
        "IMPOSSIBLE_TIMESTAMPS",
        "fatal",
        "trial start/end timestamps must be finite numbers",
      ),
    );
  } else if (record.endedAtMonotonicMs < record.startedAtMonotonicMs) {
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
