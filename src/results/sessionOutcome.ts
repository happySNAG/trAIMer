import type { ExperimentDefinition } from "../domain/experiment.ts";
import type { Recommendation } from "../domain/recommendation.ts";
import type { TrialRecord } from "../domain/trial.ts";
import { computeFlickMetrics } from "../metrics/flick.ts";
import { computeTrackingMetrics } from "../metrics/tracking.ts";
import {
  coefficientOfVariation,
  mean,
  median,
} from "../metrics/stats.ts";
import { APP_VERSION, ENGINE_VERSION } from "../version.ts";
import type { CalibrationModeId } from "../experiments/sessionModes.ts";

/**
 * What the player is told happened to their calibration session, and what
 * evidence it actually produced (Pass 13, requirements 1/4/5/10).
 *
 * Two rules shape this whole module:
 *
 *  1. A session that ends early must SAY SO, with the exact reason. rc.6
 *     returned to the main UI after the first break with nothing but a
 *     "completed" count, because the only thing the UI had to render was a
 *     recommendation that did not exist. This report always exists.
 *  2. A recommendation is shown only when the evidence supports one. When it
 *     does not, `sufficiency` says why, how much more testing is needed, and
 *     what to do — it never invents a number to fill the screen.
 *
 * Everything here is a pure function of the trial records and the experiment
 * definition, so the UI never re-derives a measurement.
 */

/** Why the session stopped. `completed` is the only non-early ending. */
export type SessionEndKind =
  | "completed"
  | "ended-by-player"
  | "capture-lost"
  | "resume-failed"
  | "capture-unavailable"
  | "error";

/** Player-facing sentence for each ending. Never blames, always concrete. */
export const SESSION_END_TEXT: Record<SessionEndKind, string> = {
  completed: "You finished the whole calibration plan.",
  "ended-by-player": "You ended the session from the arena controls.",
  "capture-lost":
    "The arena lost control of your mouse mid-session, so no further drill could be measured.",
  "resume-failed":
    "The arena could not take the mouse back after the break, so the remaining drills could not run.",
  "capture-unavailable":
    "The arena never got control of your mouse, so nothing could be measured.",
  error: "The session stopped because of an unexpected error.",
};

export interface CalibrationProgressSnapshot {
  /** Drills (warm-up + measured) finished. */
  stepsCompleted: number;
  /** Drills the CURRENT plan contains, across every planned round. */
  stepsPlanned: number;
  /** 0–1, `stepsCompleted / stepsPlanned`. Never above 1. */
  fraction: number;
  /** 1-based round the session reached. */
  roundIndex: number;
  roundsPlanned: number;
  /** 1-based candidate block within the round. */
  blockIndex: number;
  blocksPerRound: number;
  measuredCompleted: number;
  measuredPlanned: number;
}

export interface EvidenceSufficiency {
  /** True only when a defensible sensitivity recommendation exists. */
  sufficient: boolean;
  /** Plain-language reasons the evidence is not enough yet. */
  reasons: string[];
  /** Measured drills still needed before a call becomes defensible. */
  additionalMeasuredTrialsNeeded: number;
  /** Rough wall-clock for those drills, minutes (drill budgets + gaps). */
  estimatedAdditionalMinutes: number;
  /** What the player should do next, in order. */
  nextSteps: string[];
}

/**
 * The measurements the current engine can honestly report after any number of
 * completed drills. Every field is null when its inputs do not exist — an
 * absent measurement is shown as "not measured yet", never as zero.
 */
export interface SessionPerformanceSummary {
  trialsCompleted: number;
  warmupTrials: number;
  measuredTrials: number;
  validMeasuredTrials: number;
  excludedTrials: number;
  /** Shots that hit ÷ shots fired, click-to-hit measured drills only. */
  hitAccuracy: number | null;
  shotsFired: number;
  /** Median reaction time to target appearance, ms. */
  reactionTimeMs: number | null;
  /** Median time from first movement to the shot, ms. */
  movementTimeMs: number | null;
  /** Mean overshoot past the target centre, as a fraction of the throw. */
  overshootTendency: number | null;
  /** Mean shortfall before the target centre, as a fraction of the throw. */
  undershootTendency: number | null;
  /** Mean corrective sub-movements per acquisition. */
  correctionsPerShot: number | null;
  /** Mean fraction of a tracking drill spent inside the target. */
  trackingTimeOnTarget: number | null;
  /** Median tracking RMS error, px. */
  trackingRmsErrorPx: number | null;
  /** Coefficient of variation of acquisition time; lower is steadier. */
  acquisitionTimeCv: number | null;
  trackingTrials: number;
  /** Measured drills excluded, counted by engine reason code. */
  exclusionsByReason: Record<string, number>;
}

/**
 * Everything a second real-hardware session needs to be diagnosable without
 * showing a player raw debug output.
 *
 * Local only. Nothing here is transmitted; it is persisted with the session
 * and rendered under Advanced results and in Diagnostics.
 */
export interface SessionInstrumentation {
  /** The capture path that actually produced the measured samples. */
  captureTier: number | null;
  captureTierCaption: string | null;
  captureTierDetail: string | null;
  /** Why native high-rate capture did not carry this session, if it did not. */
  nativeRejectedBecause: string | null;
  /** Helper↔renderer clock synchronization state at session start. */
  clockSyncState: string | null;
  clockSyncDetail: string | null;
  clockOffsetMs: number | null;
  clockSyncUncertaintyMs: number | null;
  /**
   * Observed occurrence→observation lead of the DOM capture stream. The
   * distribution that proves this machine's input delivery sits inside the
   * tolerance the validator applies.
   */
  timestampLead: {
    samples: number;
    maxLeadMs: number;
    meanLeadMs: number | null;
    toleranceMs: number;
    aheadOfNow: number;
    foreignDomain: number;
    missing: number;
  } | null;
  /** Calibration mode the session was planned under. */
  modeId: CalibrationModeId | null;
  targetValidTrialsPerCandidate: number | null;
  replacement: {
    blocksRun: number;
    drillsRun: number;
    maxBlocks: number;
    maxDrills: number;
  } | null;
  /** Valid measured drills per candidate, by eDPI (candidates are unblinded here). */
  validTrialsByCandidateEdpi: { edpi: number; valid: number }[];
}

export interface SessionOutcomeReport {
  contractVersion: "session-outcome-v1";
  appVersion: string;
  engineVersion: string;
  experimentId: string;
  endKind: SessionEndKind;
  /** Machine-readable code from the engine (`abortReason.code`) when present. */
  endReasonCode: string | null;
  /** The exact sentence shown to the player. Never generic. */
  endReasonText: string;
  endedEarly: boolean;
  progress: CalibrationProgressSnapshot;
  performance: SessionPerformanceSummary;
  sufficiency: EvidenceSufficiency;
  /** True when `sufficiency.sufficient` AND a recommendation was produced. */
  recommendationAvailable: boolean;
  /**
   * Local diagnostics for this session. Optional so a report loaded from an
   * earlier build still parses.
   */
  instrumentation?: SessionInstrumentation;
}

export interface SessionOutcomeInput {
  definition: ExperimentDefinition;
  trials: readonly TrialRecord[];
  endKind: SessionEndKind;
  /** Engine abort reason, when the session did not simply complete. */
  abortReason?: { code: string; detail: string } | null | undefined;
  progress: CalibrationProgressSnapshot;
  /** The optimizer's output, when one was produced. */
  recommendation?: Recommendation | null | undefined;
  /** Local-only diagnostics gathered by the shell during the session. */
  instrumentation?: Partial<SessionInstrumentation> | null | undefined;
}

const CLICK_TO_HIT_KINDS = new Set(["flick-static", "flick-dynamic", "target-switch"]);

/**
 * Mean seconds a measured drill costs, including its inter-trial gap. Used
 * only to turn "N more drills" into "about M more minutes" — a presentation
 * estimate, never an input to any measurement.
 */
const SECONDS_PER_MEASURED_TRIAL = 3.2;

export function buildSessionOutcomeReport(
  input: SessionOutcomeInput,
): SessionOutcomeReport {
  const performance = summarizePerformance(input.trials);
  const sufficiency = assessEvidenceSufficiency(
    input.definition,
    input.trials,
    input.recommendation ?? null,
  );
  const endReasonText = composeEndReason(input.endKind, input.abortReason ?? null);
  return {
    contractVersion: "session-outcome-v1",
    appVersion: APP_VERSION,
    engineVersion: ENGINE_VERSION,
    experimentId: String(input.definition.id),
    endKind: input.endKind,
    endReasonCode: input.abortReason?.code ?? null,
    endReasonText,
    endedEarly: input.endKind !== "completed",
    progress: input.progress,
    performance,
    sufficiency,
    recommendationAvailable:
      sufficiency.sufficient && (input.recommendation ?? null) !== null,
    instrumentation: buildInstrumentation(input, performance),
  };
}

function buildInstrumentation(
  input: SessionOutcomeInput,
  performance: SessionPerformanceSummary,
): SessionInstrumentation {
  const provided = input.instrumentation ?? {};
  const validByEdpi: { edpi: number; valid: number }[] = [];
  for (const candidate of input.definition.candidates) {
    let valid = 0;
    for (const trial of input.trials) {
      if (trial.phase !== "measured") continue;
      if (trial.validity.status !== "valid") continue;
      if (trial.candidateId !== candidate.id) continue;
      valid++;
    }
    validByEdpi.push({
      edpi: Math.round(input.definition.dpi * candidate.sensitivity.sensX),
      valid,
    });
  }
  void performance;
  return {
    captureTier: provided.captureTier ?? null,
    captureTierCaption: provided.captureTierCaption ?? null,
    captureTierDetail: provided.captureTierDetail ?? null,
    nativeRejectedBecause: provided.nativeRejectedBecause ?? null,
    clockSyncState: provided.clockSyncState ?? null,
    clockSyncDetail: provided.clockSyncDetail ?? null,
    clockOffsetMs: provided.clockOffsetMs ?? null,
    clockSyncUncertaintyMs: provided.clockSyncUncertaintyMs ?? null,
    timestampLead: provided.timestampLead ?? null,
    modeId: provided.modeId ?? null,
    targetValidTrialsPerCandidate: provided.targetValidTrialsPerCandidate ?? null,
    replacement: provided.replacement ?? null,
    validTrialsByCandidateEdpi: validByEdpi,
  };
}

/**
 * Player-facing explanations for why measured drills could not be scored.
 *
 * A player should never have to know what "broken timestamps" means. Each
 * entry says, in one sentence, what actually happened and whether it is
 * something they can change. The technical code stays available beside it.
 */
export interface ExclusionExplanation {
  code: string;
  count: number;
  /** Short label for a chip. */
  label: string;
  /** One sentence of plain language. */
  plain: string;
  /** What (if anything) the player can do. Null when nothing is asked of them. */
  action: string | null;
  /** True when this category indicates an app defect rather than the player. */
  softwareFault: boolean;
}

const EXCLUSION_EXPLANATIONS: Record<
  string,
  { label: string; plain: string; action: string | null; softwareFault: boolean }
> = {
  IMPOSSIBLE_TIMESTAMPS: {
    label: "Unreliable input timing",
    plain:
      "The timing of the mouse data for these drills could not be trusted, so they were not scored.",
    action: null,
    softwareFault: true,
  },
  IMPOSSIBLE_MOVEMENT: {
    label: "Impossible movement",
    plain:
      "The cursor appeared to jump further than a hand can move in the time available — usually a driver or macro layer injecting movement.",
    action: "Turn off mouse macros, smoothing or acceleration software and retest.",
    softwareFault: false,
  },
  LARGE_SAMPLE_GAP: {
    label: "Mouse data dropped out",
    plain:
      "The mouse stopped reporting mid-drill for long enough that the aim path has a hole in it.",
    action: "Close background apps that hog the CPU, and check the mouse cable or receiver.",
    softwareFault: false,
  },
  INSUFFICIENT_SAMPLES: {
    label: "Too little movement",
    plain: "Too few mouse samples arrived during these drills to measure anything.",
    action: null,
    softwareFault: false,
  },
  MISSING_TARGET_APPEARANCE: {
    label: "No target appeared",
    plain: "The drill ended before a target was shown, so there was nothing to measure.",
    action: null,
    softwareFault: true,
  },
  POINTER_LOCK_LOSS: {
    label: "Mouse was released",
    plain:
      "Windows took the mouse back mid-drill (Esc, Alt-Tab, or another window stealing focus).",
    action: "Keep the trAIMer window focused for the whole session.",
    softwareFault: false,
  },
  TAB_HIDDEN: {
    label: "Window was hidden",
    plain: "The window was minimised or covered mid-drill.",
    action: "Keep the trAIMer window in front for the whole session.",
    softwareFault: false,
  },
  FOCUS_LOSS: {
    label: "Window lost focus",
    plain: "Another window took focus mid-drill.",
    action: "Keep the trAIMer window focused for the whole session.",
    softwareFault: false,
  },
  RESIZE_DURING_TRIAL: {
    label: "Window changed size",
    plain: "The window was resized mid-drill, which changes what the aim distances mean.",
    action: "Leave the window size alone once a session has started.",
    softwareFault: false,
  },
  CONFIG_MISMATCH: {
    label: "Settings changed mid-session",
    plain:
      "The drill ran at a different sensitivity or DPI than it was planned for, so it cannot be compared with the rest.",
    action: "Do not change mouse DPI or in-game sensitivity during a calibration.",
    softwareFault: true,
  },
  DUPLICATE_CLICKS: {
    label: "Double clicks",
    plain: "More clicks arrived than the drill asked for, usually a bouncing mouse switch.",
    action: "One deliberate click per target; a worn switch can double-fire on its own.",
    softwareFault: false,
  },
  CLICK_BEFORE_TARGET_APPEARANCE: {
    label: "Clicked before the target",
    plain: "A click landed before the target appeared, so the reaction cannot be measured.",
    action: "Wait for the target rather than pre-firing.",
    softwareFault: false,
  },
  TRIAL_TIMEOUT: {
    label: "Ran out of time",
    plain: "No shot was fired before the drill's window closed.",
    action: null,
    softwareFault: false,
  },
  TRIAL_ABORTED_BY_USER: {
    label: "Drill was interrupted",
    plain: "The drill was stopped before it finished.",
    action: null,
    softwareFault: false,
  },
};

export function explainExclusions(
  byReason: Record<string, number>,
): ExclusionExplanation[] {
  return Object.entries(byReason)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => {
      const known = EXCLUSION_EXPLANATIONS[code];
      if (known) return { code, count, ...known };
      const words = code.toLowerCase().replaceAll("_", " ");
      return {
        code,
        count,
        label: words.charAt(0).toUpperCase() + words.slice(1),
        plain: `${count} drill(s) were excluded for: ${words}.`,
        action: null,
        softwareFault: false,
      };
    });
}

/** The single sentence shown before the per-reason breakdown. */
export function summarizeExclusions(
  excluded: number,
  measured: number,
  byReason: Record<string, number>,
): string {
  if (excluded === 0) {
    return measured === 0
      ? "No measured drills were completed."
      : "Every measured drill produced usable data.";
  }
  const top = explainExclusions(byReason)[0];
  const noun = excluded === 1 ? "measurement" : "measurements";
  if (!top) {
    return `${excluded} ${noun} out of ${measured} could not be used for scoring.`;
  }
  return `${excluded} of ${measured} ${noun} could not be used for scoring. ${top.plain}`;
}

/**
 * Decides whether the evidence supports a sensitivity recommendation at all.
 *
 * Deliberately conservative and deliberately explicit: every failed condition
 * produces a sentence the player can act on, and the shortfall is counted in
 * the same unit the session is measured in (measured drills).
 */
export function assessEvidenceSufficiency(
  definition: ExperimentDefinition,
  trials: readonly TrialRecord[],
  recommendation: Recommendation | null,
): EvidenceSufficiency {
  const minPer = definition.stoppingCriteria.minValidTrialsPerCandidate;
  const validByCandidate = new Map<string, number>();
  for (const candidate of definition.candidates) validByCandidate.set(candidate.id, 0);
  let validMeasured = 0;
  for (const trial of trials) {
    if (trial.phase !== "measured") continue;
    if (trial.validity.status !== "valid") continue;
    validMeasured++;
    if (!trial.candidateId) continue;
    if (!validByCandidate.has(trial.candidateId)) continue;
    validByCandidate.set(trial.candidateId, validByCandidate.get(trial.candidateId)! + 1);
  }

  const reasons: string[] = [];
  const nextSteps: string[] = [];
  let shortfall = 0;
  const short: string[] = [];
  for (const candidate of definition.candidates) {
    const have = validByCandidate.get(candidate.id) ?? 0;
    if (have < minPer) {
      shortfall += minPer - have;
      // Candidates are blinded DURING play; by the time this report is read
      // the session is over, so naming them by eDPI is both allowed and the
      // most useful identifier the player has.
      const edpi = Math.round(definition.dpi * candidate.sensitivity.sensX);
      short.push(`${edpi} eDPI (${have}/${minPer})`);
    }
  }

  if (validMeasured === 0) {
    reasons.push("No measured drill finished, so there is nothing to compare.");
  } else if (short.length > 0) {
    reasons.push(
      short.length === definition.candidates.length
        ? `Every candidate sensitivity still needs at least ${minPer} valid measured drills; none has reached that yet.`
        : `${short.length} of ${definition.candidates.length} candidate sensitivities are still below the ${minPer} valid measured drills needed to compare them: ${short.join(", ")}.`,
    );
  }

  // The engine's own floor, not a new one invented here: below
  // `minValidTrialsPerCandidate` valid trials the optimizer documents that
  // standard errors explode and confidence is capped hard, and it falls back
  // to a "cannot rank these" result. That is the line between "a low-
  // confidence finding" and "a number with nothing behind it".
  //
  // A WEAK separation is deliberately NOT treated as insufficient. A fully
  // populated session whose candidates are genuinely close is a real result:
  // the recommendation carries its own honest confidence, its plausible
  // range, and a "run a clean repeat" next action. Withholding it would tell
  // a player who did everything right that their session was worthless.
  const candidatesEvaluated = recommendation?.evidence.candidatesEvaluated ?? 0;
  if (short.length === 0 && validMeasured > 0 && candidatesEvaluated < 3) {
    reasons.push(
      `Only ${candidatesEvaluated} candidate sensitivity/sensitivities produced usable data; at least 3 are needed to fit a curve through them.`,
    );
  }
  if (recommendation === null && validMeasured > 0 && reasons.length === 0) {
    reasons.push("The optimizer did not produce a result for this session.");
  }
  const separation = recommendation?.evidence.separation ?? null;

  // A tie needs another full round of reps across every candidate, not a
  // handful of top-ups: the point is to shrink each candidate's error bar.
  if (shortfall === 0 && reasons.length > 0) {
    shortfall =
      definition.candidates.length * definition.measuredRepsPerCandidatePerRound;
  }

  const sufficient = reasons.length === 0 && recommendation !== null;
  if (!sufficient) {
    nextSteps.push(
      `Run about ${shortfall} more measured drills — use Continue calibration to pick up exactly where this session stopped.`,
    );
    nextSteps.push(
      "Keep the same mouse, DPI and in-game sensitivity between sessions, or the drills are not comparable.",
    );
    if (separation === "insufficient") {
      nextSteps.push(
        "If the candidates stay tied after another round, that is itself a real result: your sensitivity is already inside the flat part of your own curve.",
      );
    }
  }

  return {
    sufficient,
    reasons,
    additionalMeasuredTrialsNeeded: sufficient ? 0 : shortfall,
    estimatedAdditionalMinutes: sufficient
      ? 0
      : Math.max(1, Math.round((shortfall * SECONDS_PER_MEASURED_TRIAL) / 60)),
    nextSteps,
  };
}

/** Aggregates the per-trial engine metrics into session-level evidence. */
export function summarizePerformance(
  trials: readonly TrialRecord[],
): SessionPerformanceSummary {
  const measured = trials.filter((t) => t.phase === "measured");
  const warmup = trials.filter((t) => t.phase === "warmup");
  const validMeasured = measured.filter((t) => t.validity.status === "valid");

  // Counted per DRILL, not per reason: a drill excluded for two reasons is one
  // lost measurement, and attributing it to its most severe reason keeps the
  // breakdown summing to the excluded total the player is shown.
  const exclusionsByReason: Record<string, number> = {};
  for (const trial of measured) {
    if (trial.validity.status === "valid") continue;
    const reasons = trial.validity.reasons;
    const primary =
      reasons.find((r) => r.severity === "fatal") ?? reasons[0] ?? null;
    const code = primary?.code ?? "UNKNOWN";
    exclusionsByReason[code] = (exclusionsByReason[code] ?? 0) + 1;
  }

  const clickTrials = validMeasured.filter((t) =>
    CLICK_TO_HIT_KINDS.has(t.scenarioKind),
  );
  const trackingTrials = validMeasured.filter((t) => t.scenarioKind === "tracking");

  let shotsFired = 0;
  let shotsHit = 0;
  const reaction: number[] = [];
  const movement: number[] = [];
  const overshoot: number[] = [];
  const undershoot: number[] = [];
  const corrections: number[] = [];
  const acquisition: number[] = [];
  for (const trial of clickTrials) {
    for (const shot of trial.shots) {
      shotsFired++;
      if (shot.hit) shotsHit++;
    }
    const m = computeFlickMetrics(trial);
    if (m.reactionTimeMs !== null) reaction.push(m.reactionTimeMs);
    if (m.movementTimeMs !== null) movement.push(m.movementTimeMs);
    if (m.totalAcquisitionTimeMs !== null) acquisition.push(m.totalAcquisitionTimeMs);
    overshoot.push(m.overshootRatio);
    undershoot.push(m.undershootRatio);
    corrections.push(m.correctionCount);
  }

  const onTarget: number[] = [];
  const rms: number[] = [];
  for (const trial of trackingTrials) {
    const m = computeTrackingMetrics(trial);
    if (m.timeOnTargetRatio !== null) onTarget.push(m.timeOnTargetRatio);
    if (m.rmsErrorPx !== null) rms.push(m.rmsErrorPx);
  }

  return {
    trialsCompleted: trials.length,
    warmupTrials: warmup.length,
    measuredTrials: measured.length,
    validMeasuredTrials: validMeasured.length,
    excludedTrials: measured.length - validMeasured.length,
    hitAccuracy: shotsFired > 0 ? shotsHit / shotsFired : null,
    shotsFired,
    reactionTimeMs: reaction.length > 0 ? median(reaction) : null,
    movementTimeMs: movement.length > 0 ? median(movement) : null,
    overshootTendency: overshoot.length > 0 ? mean(overshoot) : null,
    undershootTendency: undershoot.length > 0 ? mean(undershoot) : null,
    correctionsPerShot: corrections.length > 0 ? mean(corrections) : null,
    trackingTimeOnTarget: onTarget.length > 0 ? mean(onTarget) : null,
    trackingRmsErrorPx: rms.length > 0 ? median(rms) : null,
    acquisitionTimeCv:
      acquisition.length >= 3 ? coefficientOfVariation(acquisition) : null,
    trackingTrials: trackingTrials.length,
    exclusionsByReason,
  };
}

/**
 * The one sentence the player reads about how their session ended.
 *
 * The engine's reason is appended to the ending's own wording UNLESS it just
 * repeats it — "You ended the session from the arena controls. You ended the
 * session from the arena controls." helps nobody.
 */
export function composeEndReason(
  endKind: SessionEndKind,
  abortReason: { code: string; detail: string } | null,
): string {
  const base = SESSION_END_TEXT[endKind];
  if (!abortReason || endKind === "completed") return base;
  const detail = capitalize(abortReason.detail);
  const normalize = (t: string): string => t.toLowerCase().replace(/[^a-z ]/g, "").trim();
  if (normalize(base).includes(normalize(detail))) return base;
  return `${base} ${detail}`.trim();
}

function capitalize(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return trimmed;
  const withStop = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  return withStop.charAt(0).toUpperCase() + withStop.slice(1);
}
