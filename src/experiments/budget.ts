import type { Recommendation } from "../domain/recommendation.ts";
import type { CurveAdequacy } from "../optimizer/adequacy.ts";
import type { SessionAdaptationReport } from "../optimizer/changepoint.ts";
import type { CaptureQualitySummary } from "../diagnostics/captureQuality.ts";

/**
 * Experiment duration optimization (Pass 4, requirement O).
 *
 * Encodes the tradeoff between trial count, session duration, recommendation
 * error, range width, confidence and fatigue as explicit, deterministic
 * decisions:
 *
 *   - STOP when evidence is clearly sufficient AND further trials have low
 *     estimated information value,
 *   - CONTINUE when contenders remain tied / boundary unresolved / capture
 *     quality is weak / adaptation contamination is detected,
 *   - DEFER ("continue another session") when hard time or fatigue caps are
 *     reached — confidence is never chased indefinitely within one session.
 */

export interface SessionBudgetConfig {
  /** Hard cap on measured trials in one session. */
  maxTotalMeasuredTrials: number;
  /** Continuous active testing before a forced rest (ms). */
  maxContinuousActiveTestingMs: number;
  /** Minimum rest length once a rest is required (ms). */
  restRequirementMs: number;
  /** Hard wall-clock cap for a single session (ms). */
  maxTotalSessionMs: number;
  /**
   * Below this many measured trials per candidate, early stopping is never
   * considered regardless of separation.
   */
  minTrialsBeforeEarlyStop: number;
}

export const DEFAULT_SESSION_BUDGET: SessionBudgetConfig = {
  maxTotalMeasuredTrials: 160,
  maxContinuousActiveTestingMs: 10 * 60 * 1000,
  restRequirementMs: 45 * 1000,
  maxTotalSessionMs: 55 * 60 * 1000,
  minTrialsBeforeEarlyStop: 24,
};

export type BudgetDecision =
  | {
      action: "stop-sufficient";
      reason: string;
      savedTrialsEstimate: number;
    }
  | {
      action: "continue";
      reason: string;
      continueBecause: ContinueReason[];
    }
  | {
      action: "defer-to-next-session";
      reason: string;
    };

export type ContinueReason =
  | "contenders-tied"
  | "boundary-unresolved"
  | "capture-quality-weak"
  | "adaptation-contamination"
  | "below-minimum-trials"
  | "budget-remaining";

/**
 * Mid-session decision evaluated after every candidate block.
 * Pure function of observations — deterministic and replayable.
 */
export function evaluateBudgetDecision(input: {
  config: SessionBudgetConfig;
  trialsCompletedMeasured: number;
  activeTestingMsUsed: number;
  wallClockMsUsed: number;
  continuousActiveMs: number;
  recommendationPreview: Pick<
    Recommendation,
    "confidence" | "unresolvedBoundary" | "evidence" | "furtherTestingSuggested"
  > | null;
  adequacy: CurveAdequacy | null;
  adaptation: SessionAdaptationReport | null;
  captureQuality: CaptureQualitySummary | null;
}): BudgetDecision {
  const { config } = input;

  // Hard fatigue/wall-clock gates first: never chase confidence indefinitely.
  if (input.wallClockMsUsed >= config.maxTotalSessionMs) {
    return {
      action: "defer-to-next-session",
      reason: `session reached its ${Math.round(config.maxTotalSessionMs / 60000)} minute cap; continuing another day protects measurement quality`,
    };
  }

  const preview = input.recommendationPreview;
  const belowMinimum =
    input.trialsCompletedMeasured < config.minTrialsBeforeEarlyStop ||
    (preview !== null &&
      Object.values(preview.evidence.validTrialsPerCandidate).some(
        (n) => n < 4,
      ));

  const continueBecause: ContinueReason[] = [];
  if (belowMinimum) continueBecause.push("below-minimum-trials");
  if (
    preview?.unresolvedBoundary ||
    input.adequacy?.result.kind === "unresolved-boundary"
  ) {
    continueBecause.push("boundary-unresolved");
  }
  // Many statistically tied candidates over non-plateau geometry means real
  // decision uncertainty remains; plateau ties are already an honest answer.
  if (
    preview !== null &&
    !belowMinimum &&
    input.adequacy?.shape !== "broad-plateau" &&
    input.adequacy?.shape !== "multimodal-inconsistent" &&
    (preview.evidence.separation === "weak" ||
      Math.abs(preview.evidence.utilityGapZScore ?? 99) < 1)
  ) {
    continueBecause.push("contenders-tied");
  }
  if (
    input.captureQuality &&
    (input.captureQuality.retestingNecessary ||
      input.captureQuality.score < 0.65)
  ) {
    continueBecause.push("capture-quality-weak");
  }
  if (input.adaptation?.contaminationDetected) {
    continueBecause.push("adaptation-contamination");
  }

  // Early-stop sufficiency test.
  const separationClear = preview?.evidence.separation === "clear";
  const shapeSupportsPoint =
    input.adequacy === null ||
    input.adequacy.shape === "single-smooth-optimum" ||
    input.adequacy.shape === "asymmetric-optimum" ||
    input.adequacy.shape === "broad-plateau";
  const qualityAcceptable =
    !input.captureQuality || !input.captureQuality.retestingNecessary;
  const informationValueLow =
    !preview?.furtherTestingSuggested &&
    (input.adequacy === null ||
      (input.adequacy.shape !== "multimodal-inconsistent" &&
        input.adequacy.result.kind !== "unresolved-boundary"));

  const sufficient =
    !belowMinimum &&
    separationClear &&
    shapeSupportsPoint &&
    qualityAcceptable &&
    informationValueLow &&
    continueBecause.length === 0 &&
    preview !== null &&
    preview.confidence >= 0.6;

  if (sufficient) {
    return {
      action: "stop-sufficient",
      reason: `separation clear with ${input.trialsCompletedMeasured} measured trials and no open questions; further trials have low information value`,
      savedTrialsEstimate: Math.max(
        0,
        config.maxTotalMeasuredTrials - input.trialsCompletedMeasured,
      ),
    };
  }

  if (continueBecause.length === 0) continueBecause.push("budget-remaining");
  return {
    action: "continue",
    reason: `continuing because: ${continueBecause.join(", ")}`,
    continueBecause,
  };
}

/**
 * Simulation harness used by tests/campaigns to map (trials, duration) to
 * (recommendation error, range width, confidence). Returns summary rows so
 * default budgets are chosen from evidence rather than vibes.
 */
export interface DurationCampaignRow {
  repsPerCandidatePerRound: number;
  rounds: number;
  measuredTrials: number;
  activeMs: number;
  errorEdpi: number | null;
  rangeWidthEdpi: number | null;
  confidence: number | null;
  earlyStopped: boolean;
}

export interface DurationTradeoffRow {
  repsPerCandidatePerRound: number;
  rounds: number;
  measuredTrials: number;
  estimatedActiveMinutes: number;
  medianAbsoluteErrorEdpi: number | null;
  meanRangeWidthEdpi: number | null;
  meanConfidence: number | null;
  earlyStoppedSessions: number;
}

export function summarizeDurationCampaign(
  rows: readonly DurationCampaignRow[],
): DurationTradeoffRow[] {
  const groups = new Map<string, DurationCampaignRow[]>();
  for (const row of rows) {
    const key = `${row.repsPerCandidatePerRound}:${row.rounds}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const out: DurationTradeoffRow[] = [];
  for (const [key, list] of groups) {
    const [reps, rounds] = key.split(":").map(Number);
    const errors = list
      .map((r) => r.errorEdpi)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);
    const ranges = list.map((r) => r.rangeWidthEdpi).filter((v): v is number => v !== null);
    const confs = list.map((r) => r.confidence).filter((v): v is number => v !== null);
    out.push({
      repsPerCandidatePerRound: reps!,
      rounds: rounds!,
      measuredTrials: list.reduce((a, r) => a + r.measuredTrials, 0) / list.length,
      estimatedActiveMinutes:
        list.reduce((a, r) => a + r.activeMs, 0) / list.length / 60000,
      medianAbsoluteErrorEdpi:
        errors.length > 0 ? errors[Math.floor(errors.length / 2)]! : null,
      meanRangeWidthEdpi:
        ranges.length > 0 ? ranges.reduce((a, b) => a + b, 0) / ranges.length : null,
      meanConfidence:
        confs.length > 0 ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
      earlyStoppedSessions: list.filter((r) => r.earlyStopped).length,
    });
  }
  return out.sort(
    (a, b) =>
      a.repsPerCandidatePerRound * 10 + a.rounds - (b.repsPerCandidatePerRound * 10 + b.rounds),
  );
}
