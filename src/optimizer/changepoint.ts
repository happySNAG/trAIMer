import type { TrialRecord } from "../domain/trial.ts";
import { meanAndStandardError } from "../metrics/stats.ts";

/**
 * Formal deterministic segmented change-point analysis (Pass 4, requirement K).
 *
 * Replaces the Pass 3 early-half/late-half split. Given a player's measured
 * utilities in session order, a single change point k is scanned; the split
 * minimizing pooled within-segment sum of squared errors is selected with a
 * BIC-style penalty so noise cannot manufacture segments:
 *
 *   SSE(k) = Σ_{t≤k} (u_t − mean_pre)² + Σ_{t>k} (u_t − mean_post)²
 *   choose k* = argmin_k [ SSE(k) + penalty·log(n)·σ²_within ]
 *
 * Segment shapes are then classified:
 *   warmup-learning      early segment clearly worse, improving into stable
 *   fatigue-slope        gradual monotonic degradation (no single jump)
 *   abrupt-degradation    significant downward jump at k*
 *   collapse-and-recovery two-change pattern: down then back up
 *
 * The raw trial stream is never modified; only downstream interpretation is.
 */

export type ChangePointPattern =
  | "stable"
  | "warmup-learning"
  | "fatigue-slope"
  | "abrupt-degradation"
  | "temporary-collapse"
  | "insufficient-data";

export interface SegmentedAnalysis {
  pattern: ChangePointPattern;
  /** Index (within the analyzed sequence) of the primary change point. */
  changePointIndex: number | null;
  preMean: number | null;
  postMean: number | null;
  /** post − pre at the primary change point. */
  stepMagnitude: number | null;
  /** z-style strength of the primary step. */
  strengthZ: number | null;
  /** Secondary change point for temporary-collapse patterns. */
  recoveryIndex: number | null;
  /** Linear slope per trial across the whole sequence (for fatigue). */
  trendPerTrial: number | null;
  notes: string[];
}

export interface SessionAdaptationReport {
  overall: SegmentedAnalysis;
  perCandidate: {
    candidateId: string;
    analysis: SegmentedAnalysis;
    /** True when candidate comparison may be contaminated by this pattern. */
    mayContaminateComparison: boolean;
  }[];
  contaminationDetected: boolean;
  recommendedActions: AdaptationAction[];
}

export type AdaptationAction =
  | "add-extra-warmup"
  | "schedule-rest"
  | "re-expose-candidate"
  | "downweight-early-trials"
  | "exclude-contaminated-trials"
  | "none";

const MIN_SEGMENTS = 4;

function meanOf(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sampleSd(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = meanOf(values);
  const ss = values.reduce((acc, v) => acc + (v - m) ** 2, 0);
  return Math.sqrt(ss / (values.length - 1));
}

/** Welch-style z between two segments using their LOCAL standard deviations,
 * so a large change cannot inflate its own noise estimate. */
function welchZ(pre: readonly number[], post: readonly number[]): number {
  const se = Math.sqrt(
    sampleSd(pre) ** 2 / Math.max(pre.length, 1) +
      sampleSd(post) ** 2 / Math.max(post.length, 1),
  );
  const diff = meanOf(post) - meanOf(pre);
  if (!(se > 1e-12)) {
    // Zero variance on both sides: any nonzero difference is maximal.
    return diff === 0 ? 0 : diff > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  }
  return diff / se;
}

function linearTrend(values: readonly number[]): number | null {
  const n = values.length;
  if (n < 3) return null;
  const mx = (n - 1) / 2;
  const my = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (values[i]! - my);
    den += (i - mx) ** 2;
  }
  return den > 0 ? num / den : null;
}

/** Core single-change-point scan. Pure and deterministic. */
export function analyzeSegmented(
  values: readonly number[],
  options: { minSegment?: number; strengthThresholdZ?: number } = {},
): SegmentedAnalysis {
  const minSeg = options.minSegment ?? 2;
  const strengthCut = options.strengthThresholdZ ?? 2;
  const notes: string[] = [];
  if (values.length < MIN_SEGMENTS * minSeg) {
    return {
      pattern: "insufficient-data",
      changePointIndex: null,
      preMean: null,
      postMean: null,
      stepMagnitude: null,
      strengthZ: null,
      recoveryIndex: null,
      trendPerTrial: null,
      notes: [`only ${values.length} observations; change-point analysis needs ≥ ${MIN_SEGMENTS * minSeg}`],
    };
  }

  // Best single split by pooled SSE with BIC-ish penalty.
  let bestK = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestPre = 0;
  let bestPost = 0;
  const totalSseFlat = (() => {
    const m = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((acc, v) => acc + (v - m) ** 2, 0);
  })();
  for (let k = minSeg; k <= values.length - minSeg; k++) {
    const pre = values.slice(0, k);
    const post = values.slice(k);
    const preM = pre.reduce((a, b) => a + b, 0) / pre.length;
    const postM = post.reduce((a, b) => a + b, 0) / post.length;
    const sse =
      pre.reduce((a, v) => a + (v - preM) ** 2, 0) +
      post.reduce((a, v) => a + (v - postM) ** 2, 0);
    // BIC-style penalty: one extra mean parameter ⇒ σ̂²·log(n).
    const sigmaWithin = Math.sqrt(Math.max(sse / Math.max(values.length - 2, 1), 1e-12));
    const score = sse + sigmaWithin ** 2 * Math.log(values.length);
    if (score < bestScore) {
      bestScore = score;
      bestK = k;
      bestPre = preM;
      bestPost = postM;
    }
  }

  const flatSseGuard = totalSseFlat <= 1e-12;
  const stats = meanAndStandardError(values);
  const sigma = stats ? Math.max(stats.standardError * Math.sqrt(values.length), 1e-9) : 1;

  const trend = linearTrend(values);

  if (bestK < 0 || flatSseGuard) {
    return {
      pattern: values.length >= MIN_SEGMENTS * minSeg ? "stable" : "insufficient-data",
      changePointIndex: null,
      preMean: null,
      postMean: null,
      stepMagnitude: null,
      strengthZ: null,
      recoveryIndex: null,
      trendPerTrial: trend,
      notes: ["no meaningful segmentation found"],
    };
  }

  const step = bestPost - bestPre;
  // Strength of the step via Welch SEs over the two segments (local noise).
  const preSeg = values.slice(0, bestK);
  const postSeg = values.slice(bestK);
  const strengthZ = welchZ(preSeg, postSeg);

  // Temporary-collapse scan: a second split after bestK where performance recovers.
  let recoveryIdx: number | null = null;
  let recoveryBestGain = 0;
  for (let k2 = bestK + minSeg; k2 <= values.length - minSeg; k2++) {
    const mid = values.slice(bestK, k2);
    const tail = values.slice(k2);
    if (mid.length < minSeg || tail.length < minSeg) continue;
    const gain = meanOf(tail) - meanOf(mid);
    if (gain > recoveryBestGain) {
      // Require the recovery itself to be significant (Welch z).
      if (welchZ(mid, tail) >= strengthCut) {
        recoveryBestGain = gain;
        recoveryIdx = k2;
      }
    }
  }

  let pattern: ChangePointPattern;
  if (Math.abs(strengthZ) >= strengthCut && step < 0) {
    pattern =
      recoveryIdx !== null
        ? "temporary-collapse"
        : "abrupt-degradation";
    if (pattern === "temporary-collapse") {
      notes.push(
        `collapse after trial ${bestK}, recovered after trial ${recoveryIdx}`,
      );
    }
  } else if (
    Math.abs(strengthZ) >= strengthCut &&
    step > 0 &&
    bestK <= Math.floor(values.length / 2)
  ) {
    pattern = "warmup-learning";
  } else if (
    Math.abs(strengthZ) >= strengthCut &&
    step > 0
  ) {
    // Primary split looks like a RECOVERY edge; check whether a genuine
    // collapse preceded it (three-segment shape: good → collapsed → recovered).
    let dipIdx: number | null = null;
    let deepestMidMean = Number.POSITIVE_INFINITY;
    for (let k1 = minSeg; k1 <= bestK - minSeg; k1++) {
      const mid = values.slice(k1, bestK);
      const m = mid.reduce((a, b) => a + b, 0) / mid.length;
      if (m < deepestMidMean) {
        deepestMidMean = m;
        dipIdx = k1;
      }
    }
    const headMean =
      dipIdx !== null
        ? values.slice(0, dipIdx).reduce((a, b) => a + b, 0) / dipIdx
        : Number.NaN;
    const seCollapse =
      dipIdx !== null && Number.isFinite(headMean)
        ? sigma * Math.sqrt(1 / dipIdx + 1 / Math.max(bestK - dipIdx, 1))
        : Infinity;
    const collapseZ = seCollapse > 0 ? (headMean - deepestMidMean) / seCollapse : 0;
    if (
      dipIdx !== null &&
      collapseZ >= strengthCut &&
      deepestMidMean < headMean &&
      deepestMidMean < bestPost
    ) {
      pattern = "temporary-collapse";
      recoveryIdx = bestK;
      notes.push(
        `collapse after trial ${dipIdx} (z=${collapseZ.toFixed(2)}), recovered after trial ${bestK} (recovery z=${strengthZ.toFixed(2)})`,
      );
      return {
        pattern,
        changePointIndex: dipIdx,
        preMean: headMean,
        postMean: deepestMidMean,
        stepMagnitude: deepestMidMean - headMean,
        strengthZ: -collapseZ,
        recoveryIndex: recoveryIdx,
        trendPerTrial: trend,
        notes,
      };
    }
    pattern = "stable";
  } else if (
    trend !== null &&
    stats !== null &&
    Math.abs((trend * values.length) / Math.max(sigma, 1e-9)) >= strengthCut &&
    trend < 0
  ) {
    pattern = "fatigue-slope";
  } else {
    pattern = "stable";
  }

  if (pattern === "warmup-learning") {
    notes.push(
      `performance improved by ${step.toFixed(3)} utility after trial ${bestK} (z=${strengthZ.toFixed(2)}); early trials were still learning`,
    );
  } else if (pattern === "abrupt-degradation") {
    notes.push(`performance dropped by ${Math.abs(step).toFixed(3)} after trial ${bestK} (z=${strengthZ.toFixed(2)})`);
  } else if (pattern === "temporary-collapse" && recoveryIdx !== null) {
    notes.push(
      `collapse after trial ${bestK}, recovered after trial ${recoveryIdx}`,
    );
  } else if (pattern === "fatigue-slope") {
    notes.push(`gradual fatigue trend of ${trend!.toFixed(4)} utility/trial`);
  } else {
    notes.push("no significant change point detected");
  }

  return {
    pattern,
    changePointIndex: bestK,
    preMean: bestPre,
    postMean: bestPost,
    stepMagnitude: step,
    strengthZ,
    recoveryIndex: pattern === "temporary-collapse" ? recoveryIdx : null,
    trendPerTrial: trend,
    notes,
  };
}

export interface AnalyzeSessionOptions {
  minTrialsPerCandidate?: number;
  utilityOf: (trial: TrialRecord) => number | null;
}

/**
 * Full-session adaptation report: an overall series plus per-candidate series.
 * Candidate comparison is flagged as contaminated when ANY candidate shows
 * warmup/learning (its first encounters understate it) — interleaving limits
 * but does not remove this bias when candidates have unequal rep counts.
 */
export function analyzeSessionAdaptation(
  trialsByCandidate: ReadonlyMap<string, readonly TrialRecord[]>,
  options: AnalyzeSessionOptions,
): SessionAdaptationReport {
  const minPerCandidate = options.minTrialsPerCandidate ?? 6;

  const perCandidateRows: SessionAdaptationReport["perCandidate"] = [];
  for (const [candidateId, trials] of trialsByCandidate) {
    const measured = trials
      .filter((t) => t.phase === "measured" && t.validity.status === "valid")
      .sort((a, b) => a.indexInSession - b.indexInSession)
      .map(options.utilityOf)
      .filter((v): v is number => v !== null);
    if (measured.length < minPerCandidate) continue;
    const analysis = analyzeSegmented(measured);
    perCandidateRows.push({
      candidateId,
      analysis,
      mayContaminateComparison:
        analysis.pattern === "warmup-learning" ||
        analysis.pattern === "temporary-collapse",
    });
  }

  // Overall series in true session order.
  const allMeasured = [...trialsByCandidate.values()]
    .flat()
    .filter((t) => t.phase === "measured" && t.validity.status === "valid")
    .sort((a, b) => a.indexInSession - b.indexInSession)
    .map(options.utilityOf)
    .filter((v): v is number => v !== null);
  const overall = analyzeSegmented(allMeasured);

  const contaminationDetected =
    perCandidateRows.some((r) => r.mayContaminateComparison) ||
    overall.pattern === "warmup-learning";

  const actions: AdaptationAction[] = [];
  if (overall.pattern === "warmup-learning") actions.push("add-extra-warmup");
  if (overall.pattern === "fatigue-slope") actions.push("schedule-rest");
  if (perCandidateRows.some((r) => r.analysis.pattern === "warmup-learning")) {
    actions.push("re-expose-candidate");
    actions.push("downweight-early-trials");
  }
  if (overall.pattern === "temporary-collapse") {
    actions.push("schedule-rest");
    actions.push("exclude-contaminated-trials");
  }
  if (actions.length === 0) actions.push("none");

  return {
    overall,
    perCandidate: perCandidateRows,
    contaminationDetected,
    recommendedActions: [...new Set(actions)],
  };
}
