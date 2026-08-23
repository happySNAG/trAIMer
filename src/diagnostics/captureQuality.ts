import type { TrialRecord } from "../domain/trial.ts";
import { computeInputQuality, type InputQualityReport } from "./inputQuality.ts";
import { median, percentile } from "../metrics/stats.ts";

/**
 * Session-level capture quality (Pass 4, requirement F).
 *
 * Pass 3 gated confidence on the WORST trial-level report, which let one
 * invalidated trial destroy an otherwise clean session. The session summary
 * below aggregates per-trial reports robustly (median + trimmed tails),
 * tracks degradation over time and trial-to-trial consistency, and classifies
 * whether the session is suitable for recommendations or needs retesting.
 */

export type CaptureSourceKindLabel =
  | "native-high-rate"
  | "browser-coalesced"
  | "browser-basic"
  | "synthetic"
  | "mixed"
  | "unknown";

export interface CaptureQualityTrialRow {
  trialId: string;
  indexInSession: number;
  phase: string;
  validityStatus: string;
  score: number;
  observedRateHz: number;
  jitterCv: number | null;
  lockInterruptions: number;
  viewportInstability: number;
}

export interface CaptureQualitySummary {
  sourceKind: CaptureSourceKindLabel;
  /** Robust central tendency of the event rate across trials. */
  typicalEventRateHz: number;
  /** p10/p90 of per-trial observed rates. */
  rateDistributionHz: { p10: number; p90: number };
  timingJitterCvMedian: number | null;
  /** Fraction of measured trials with any dropped-sample indication. */
  dropRateFraction: number;
  lockInterruptionsTotal: number;
  viewportUnstableTrials: number;
  /** Slope of per-trial quality vs session order (negative = degrading). */
  degradationSlopePer100Trials: number | null;
  /** 1 - robust CV of per-trial scores; high means consistent. */
  trialConsistency: number;
  sourceTransitions: { atTrialIndex: number; from: CaptureSourceKindLabel; to: CaptureSourceKindLabel }[];
  fractionHighQualityTrials: number;
  worstIssues: string[];
  /** Numeric quality score in [0,1]. */
  score: number;
  grade: "high" | "acceptable" | "degraded" | "poor";
  reasonCodes: CaptureQualityReasonCode[];
  recommendationSuitability:
    | "suitable"
    | "suitable-with-caveats"
    | "not-suitable-retest-required";
  retestingNecessary: boolean;
  trialsAnalyzed: number;
  perTrial: CaptureQualityTrialRow[];
}

export const CAPTURE_QUALITY_REASON_CODES = [
  "LOW_EVENT_RATE",
  "UNSTABLE_TIMING",
  "LOCK_INTERRUPTIONS",
  "VIEWPORT_INSTABILITY",
  "QUALITY_DEGRADED_OVER_TIME",
  "INCONSISTENT_TRIALS",
  "MIXED_CAPTURE_SOURCES",
  "HIGH_DROP_RATE",
  "INSUFFICIENT_MEASURED_TRIALS",
] as const;

export type CaptureQualityReasonCode = (typeof CAPTURE_QUALITY_REASON_CODES)[number];

export interface CaptureQualityThresholds {
  minTypicalRateHz: number;
  maxJitterCv: number;
  maxDropRateFraction: number;
  minHighQualityTrialFraction: number;
  minMeasuredTrials: number;
  /** Trials with score >= this count as "high quality" for the fraction. */
  highQualityScoreCut: number;
}

export const DEFAULT_CAPTURE_QUALITY_THRESHOLDS: CaptureQualityThresholds = {
  minTypicalRateHz: 40,
  maxJitterCv: 0.9,
  maxDropRateFraction: 0.2,
  minHighQualityTrialFraction: 0.75,
  minMeasuredTrials: 8,
  highQualityScoreCut: 0.7,
};

const SOURCE_LABEL_BY_KIND: Record<string, CaptureSourceKindLabel> = {
  native: "native-high-rate",
  "browser-pointer-lock": "browser-coalesced",
  synthetic: "synthetic",
};

function classifySource(
  captureSources: ReadonlyMap<string, string>,
): { label: CaptureSourceKindLabel; transitions: CaptureQualitySummary["sourceTransitions"] } {
  // captureSources: captureSourceId -> kind label, ordered by first appearance.
  const orderedIds = [...captureSources.keys()];
  if (orderedIds.length === 0) return { label: "unknown", transitions: [] };
  const kindsInOrder = orderedIds.map(
    (id) => (captureSources.get(id) ?? "unknown") as CaptureSourceKindLabel,
  );
  const unique = [...new Set(kindsInOrder)];
  if (unique.length === 1 && unique[0] !== undefined && unique[0] !== "unknown") {
    return { label: unique[0], transitions: [] };
  }
  if (unique.every((k) => k === "unknown")) {
    return { label: "unknown", transitions: [] };
  }
  const transitions: CaptureQualitySummary["sourceTransitions"] = [];
  for (let i = 1; i < kindsInOrder.length; i++) {
    if (kindsInOrder[i] !== kindsInOrder[i - 1]) {
      transitions.push({
        atTrialIndex: i,
        from: kindsInOrder[i - 1]!,
        to: kindsInOrder[i]!,
      });
    }
  }
  return { label: "mixed", transitions };
}

function robustCv(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const med = median(values);
  if (!(Math.abs(med) > 1e-9)) return null;
  const absDev = values.map((v) => Math.abs(v - med));
  const mad = percentile(absDev, 50);
  return (mad * 1.4826) / Math.abs(med);
}

function slopePer100(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  if (den <= 0) return null;
  return (num / den) * 100;
}

export interface ComputeSessionQualityInput {
  trials: readonly TrialRecord[];
  /**
   * Optional pre-computed per-trial reports (e.g. persisted); falls back to
   * computing from raw samples.
   */
  reportsByTrialId?: ReadonlyMap<string, InputQualityReport>;
  /** captureSourceId -> display kind, in first-appearance order. */
  captureSourceKindsByTrialId?: ReadonlyMap<string, string>;
  thresholds?: Partial<CaptureQualityThresholds>;
}

/**
 * Robust session-level aggregation. A single bad trial lowers the score but
 * does not by itself destroy the grade — the fraction-based rules decide.
 */
export function summarizeCaptureQuality(
  input: ComputeSessionQualityInput,
): CaptureQualitySummary {
  const thresholds = { ...DEFAULT_CAPTURE_QUALITY_THRESHOLDS, ...input.thresholds };
  const measured = input.trials.filter((t) => t.phase === "measured");
  const rows: CaptureQualityTrialRow[] = [];
  const scores: number[] = [];
  const rates: number[] = [];
  const jitters: number[] = [];
  let lockInterruptionsTotal = 0;
  let viewportUnstableTrials = 0;
  let dropIndications = 0;

  for (const trial of measured) {
    const report =
      input.reportsByTrialId?.get(trial.id) ?? computeInputQuality(trial);
    const lockCount = report.metrics.lockLossCount;
    const resizes = report.metrics.resizeCount;
    const row: CaptureQualityTrialRow = {
      trialId: trial.id,
      indexInSession: trial.indexInSession,
      phase: trial.phase,
      validityStatus: trial.validity.status,
      score: report.score,
      observedRateHz: report.metrics.observedRateHz,
      jitterCv: report.metrics.intervalJitterCv,
      lockInterruptions: lockCount,
      viewportInstability: resizes,
    };
    rows.push(row);
    scores.push(report.score);
    rates.push(report.metrics.observedRateHz);
    if (report.metrics.intervalJitterCv !== null) jitters.push(report.metrics.intervalJitterCv);
    lockInterruptionsTotal += lockCount;
    if (resizes > 0) viewportUnstableTrials++;
    if (
      report.metrics.largeGapCount > 0 ||
      (report.warnings.lowEventRate && report.metrics.sampleCount >= 20)
    ) {
      dropIndications++;
    }
  }

  const sourceKindsById = new Map<string, string>();
  if (input.captureSourceKindsByTrialId) {
    for (const trial of input.trials) {
      const kind = input.captureSourceKindsByTrialId.get(trial.id);
      if (kind !== undefined) {
        const mapped = SOURCE_LABEL_BY_KIND[kind] ?? (kind as CaptureSourceKindLabel);
        sourceKindsById.set(trial.id, mapped);
      }
    }
  } else {
    for (const trial of measured) sourceKindsById.set(trial.id, "unknown");
  }
  const { label: sourceKind, transitions } = classifySource(sourceKindsById);

  const typicalEventRateHz = rates.length > 0 ? median(rates) : 0;
  const rateP10 = rates.length > 0 ? percentile(rates, 10) : 0;
  const rateP90 = rates.length > 0 ? percentile(rates, 90) : 0;
  const jitterMedian = jitters.length > 0 ? median(jitters) : null;
  const dropRateFraction =
    rows.length > 0 ? dropIndications / rows.length : 0;
  const highQualityFraction =
    scores.length > 0
      ? scores.filter((s) => s >= thresholds.highQualityScoreCut).length / scores.length
      : 0;
  const degradationSlope = slopePer100(
    rows.map((r) => r.indexInSession),
    rows.map((r) => r.score),
  );
  const consistencyRaw = robustCv(scores);
  const trialConsistency =
    consistencyRaw === null ? 0.5 : Math.max(0, Math.min(1, 1 - consistencyRaw));

  // ---- scoring: start from robust median, subtract bounded penalties ----
  let score = scores.length > 0 ? Math.max(0.05, Math.min(1, median(scores))) : 0;
  const reasonCodes: CaptureQualityReasonCode[] = [];
  const worstIssues: string[] = [];

  if (rows.length < thresholds.minMeasuredTrials) {
    reasonCodes.push("INSUFFICIENT_MEASURED_TRIALS");
    score = Math.min(score, 0.4);
  }

  const lowRateTrials = rows.filter((r) => r.observedRateHz < thresholds.minTypicalRateHz).length;
  const lowRateFraction = rows.length > 0 ? lowRateTrials / rows.length : 0;
  if (typicalEventRateHz < thresholds.minTypicalRateHz && lowRateFraction > 0.4) {
    reasonCodes.push("LOW_EVENT_RATE");
    score -= 0.35 * Math.min(1, lowRateFraction / 0.8);
    worstIssues.push(`typical event rate ${typicalEventRateHz.toFixed(0)} Hz below ${thresholds.minTypicalRateHz} Hz`);
  }

  if (jitterMedian !== null && jitterMedian > thresholds.maxJitterCv) {
    reasonCodes.push("UNSTABLE_TIMING");
    score -= 0.15;
    worstIssues.push(`median timing jitter CV ${jitterMedian.toFixed(2)} exceeds ${thresholds.maxJitterCv}`);
  }

  if (lockInterruptionsTotal > 0) {
    reasonCodes.push("LOCK_INTERRUPTIONS");
    const penalty = 0.25 * Math.min(1, lockInterruptionsTotal / Math.max(rows.length, 1));
    // A single interruption among many trials is a small dent, not a wipeout.
    score -= Math.min(penalty, 0.3);
    worstIssues.push(`${lockInterruptionsTotal} pointer-lock interruption(s)`);
  }

  if (viewportUnstableTrials > 0) {
    reasonCodes.push("VIEWPORT_INSTABILITY");
    score -= Math.min(0.15 * viewportUnstableTrials, 0.3);
    worstIssues.push(`${viewportUnstableTrials} trial(s) with viewport resize`);
  }

  if (dropRateFraction > thresholds.maxDropRateFraction) {
    reasonCodes.push("HIGH_DROP_RATE");
    score -= 0.2;
    worstIssues.push(`drop indications in ${(dropRateFraction * 100).toFixed(0)}% of trials`);
  }

  const half = Math.floor(scores.length / 2);
  const earlyMedianScore = half > 0 ? median(scores.slice(0, half)) : null;
  const lateMedianScore = half > 0 ? median(scores.slice(half)) : null;
  const lateHalfDropped =
    earlyMedianScore !== null &&
    lateMedianScore !== null &&
    earlyMedianScore - lateMedianScore >= 0.15;
  if (
    scores.length >= 6 &&
    ((degradationSlope !== null && degradationSlope < -4) || lateHalfDropped)
  ) {
    reasonCodes.push("QUALITY_DEGRADED_OVER_TIME");
    if (degradationSlope !== null) {
      score -= Math.min(Math.abs(degradationSlope) / 100, 0.2);
    } else {
      score -= 0.1;
    }
    if (lateHalfDropped) score -= 0.1;
    worstIssues.push(
      `capture quality degraded over the session (late-half median ${lateMedianScore?.toFixed(2)} vs early ${earlyMedianScore?.toFixed(2)}${
        degradationSlope !== null ? `, slope ${degradationSlope.toFixed(1)} points/100 trials` : ""
      })`,
    );
  }

  if (trialConsistency < 0.5 && scores.length >= 6) {
    reasonCodes.push("INCONSISTENT_TRIALS");
    score -= 0.1;
    worstIssues.push("trial-to-trial capture quality is inconsistent");
  }

  if (transitions.length > 0) {
    reasonCodes.push("MIXED_CAPTURE_SOURCES");
    score -= 0.1;
    worstIssues.push(
      `capture source changed ${transitions.length} time(s) (${transitions.map((t) => `${t.from}→${t.to}`).join(", ")})`,
    );
  }

  if (highQualityFraction < thresholds.minHighQualityTrialFraction && rows.length > 0) {
    // Not its own penalty beyond what the low trials already cost via median;
    // recorded so downstream logic can require retesting.
    if (!reasonCodes.includes("LOW_EVENT_RATE") && !reasonCodes.includes("HIGH_DROP_RATE")) {
      reasonCodes.push("INCONSISTENT_TRIALS");
    }
  }

  score = Math.max(0, Math.min(1, score));
  const grade: CaptureQualitySummary["grade"] =
    score >= 0.85 ? "high" : score >= 0.65 ? "acceptable" : score >= 0.4 ? "degraded" : "poor";

  const blocking =
    reasonCodes.includes("INSUFFICIENT_MEASURED_TRIALS") ||
    // Interruptions/instability block only when they are widespread — a
    // single bad trial must not destroy an otherwise clean session.
    lockInterruptionsTotal > Math.max(1, Math.ceil(rows.length * 0.25)) ||
    viewportUnstableTrials > Math.max(1, Math.ceil(rows.length * 0.25)) ||
    (reasonCodes.includes("MIXED_CAPTURE_SOURCES") && transitions.some((t) => t.to !== t.from));

  const suitability: CaptureQualitySummary["recommendationSuitability"] =
    blocking || score < 0.4 || reasonCodes.includes("LOW_EVENT_RATE")
      ? "not-suitable-retest-required"
      : reasonCodes.length > 0 || score < 0.85
        ? "suitable-with-caveats"
        : "suitable";

  const retestingNecessary = suitability === "not-suitable-retest-required";

  return {
    sourceKind,
    typicalEventRateHz,
    rateDistributionHz: { p10: rateP10, p90: rateP90 },
    timingJitterCvMedian: jitterMedian,
    dropRateFraction,
    lockInterruptionsTotal,
    viewportUnstableTrials,
    degradationSlopePer100Trials: degradationSlope,
    trialConsistency,
    sourceTransitions: transitions,
    fractionHighQualityTrials: highQualityFraction,
    worstIssues,
    score,
    grade,
    reasonCodes: [...new Set(reasonCodes)],
    recommendationSuitability: suitability,
    retestingNecessary,
    trialsAnalyzed: rows.length,
    perTrial: rows,
  };
}
