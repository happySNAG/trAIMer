import type { CampaignCaseResult } from "./runner.ts";

/**
 * Population-level metrics for Monte Carlo campaigns (Pass 6).
 *
 * All aggregations are deterministic and computed from per-case results.
 * These metrics describe ENGINE BEHAVIOR ON SIMULATED PLAYERS ONLY — they
 * never constitute claims about human players (docs/PASS6-MONTE-CARLO.md).
 */

export interface ErrorDistribution {
  n: number;
  medianAbsoluteErrorEdpi: number;
  p90AbsoluteErrorEdpi: number;
  medianRelativeError: number;
  p90RelativeError: number;
  meanRelativeError: number;
}

export interface CampaignAggregate {
  population: string;
  cases: number;
  error: ErrorDistribution;
  coverageRate: number;
  /** Among boundary-eligible cases: fraction refusing confident precise claims. */
  unresolvedBoundaryHandledRate: number | null;
  falseBoundaryFlagRate: number;
  plateauDetectionRate: number | null;
  falseHighConfidenceRate: number;
  highConfidenceShare: number;
  confidenceAmongCorrectVsWrong: {
    medianConfidenceWhenCovered: number;
    medianConfidenceWhenNotCovered: number;
  };
  meanMeasuredTrials: number;
  meanEstimatedActiveSeconds: number;
  earlyStopRate: number;
  retestRecommendationRate: number;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! * (hi - pos) + sorted[hi]! * (pos - lo);
}

function median(values: readonly number[]): number {
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

export function summarizeErrors(values: readonly number[]): ErrorDistribution {
  const abs = values.map((v) => Math.abs(v)).sort((a, b) => a - b);
  return {
    n: values.length,
    medianAbsoluteErrorEdpi: quantile(abs, 0.5),
    p90AbsoluteErrorEdpi: quantile(abs, 0.9),
    medianRelativeError: median(values.map((v) => Math.abs(v))),
    p90RelativeError: quantile(values.map((v) => Math.abs(v)).sort((a, b) => a - b), 0.9),
    meanRelativeError: values.reduce((a, v) => a + Math.abs(v), 0) / Math.max(values.length, 1),
  };
}

export function aggregateCases(
  population: string,
  results: readonly CampaignCaseResult[],
): CampaignAggregate {
  const covered = results.filter((r) => r.coveredByRange);
  const notCovered = results.filter((r) => !r.coveredByRange);
  const boundaryEligible = results.filter((r) => r.boundaryExpectationCorrect !== null);
  const plateauEligible = results.filter(
    (r) => r.plateauExpectationCorrect !== null,
  );

  return {
    population,
    cases: results.length,
    error: summarizeErrors(results.map((r) => r.relativeErrorFraction)),
    coverageRate: covered.length / Math.max(results.length, 1),
    unresolvedBoundaryHandledRate:
      boundaryEligible.length > 0
        ? boundaryEligible.filter((r) => r.boundaryExpectationCorrect === true).length /
          boundaryEligible.length
        : null,
    falseBoundaryFlagRate:
      results.filter((r) => r.falseBoundaryFlag).length / Math.max(results.length, 1),
    plateauDetectionRate:
      plateauEligible.length > 0
        ? plateauEligible.filter((r) => r.plateauExpectationCorrect === true).length /
          plateauEligible.length
        : null,
    falseHighConfidenceRate:
      results.filter((r) => r.falseHighConfidence).length / Math.max(results.length, 1),
    highConfidenceShare:
      results.filter((r) => r.confidence >= 0.8).length / Math.max(results.length, 1),
    confidenceAmongCorrectVsWrong: {
      medianConfidenceWhenCovered: median(covered.map((r) => r.confidence)),
      medianConfidenceWhenNotCovered: median(notCovered.map((r) => r.confidence)),
    },
    meanMeasuredTrials:
      results.reduce((a, r) => a + r.measuredTrials, 0) / Math.max(results.length, 1),
    meanEstimatedActiveSeconds:
      results.reduce((a, r) => a + r.estimatedActiveSeconds, 0) / Math.max(results.length, 1),
    earlyStopRate: results.filter((r) => r.earlyStopped).length / Math.max(results.length, 1),
    retestRecommendationRate:
      results.filter((r) => r.retestPlanKind !== null).length / Math.max(results.length, 1),
  };
}

/** Confidence-honesty audit rows (requirement 4). */
export interface ConfidenceHonestyFinding {
  kind: string;
  detail: string;
  rate: number | null;
  cases: number;
}

export function auditConfidenceHonesty(
  results: readonly CampaignCaseResult[],
): ConfidenceHonestyFinding[] {
  const findings: ConfidenceHonestyFinding[] = [];
  const n = Math.max(results.length, 1);

  const wrongHigh = results.filter((r) => r.confidence >= 0.8 && !r.coveredByRange);
  findings.push({
    kind: "high-confidence-uncovered-truth",
    detail: "confidence ≥ 0.80 while the plausible range excludes ground truth",
    rate: wrongHigh.length / n,
    cases: wrongHigh.length,
  });

  const veryWrongHigh = results.filter(
    (r) => r.confidence >= 0.8 && r.relativeErrorFraction > 0.15,
  );
  findings.push({
    kind: "high-confidence-large-error",
    detail: "confidence ≥ 0.80 with relative error > 15 %",
    rate: veryWrongHigh.length / n,
    cases: veryWrongHigh.length,
  });

  const boundaryHigh = results.filter(
    (r) => r.unresolvedBoundary && r.confidence > 0.45 + 1e-9,
  );
  findings.push({
    kind: "confidence-above-cap-at-unresolved-boundary",
    detail: "unresolvedBoundary=true must cap confidence at 0.45",
    rate: boundaryHigh.length / n,
    cases: boundaryHigh.length,
  });

  const multimodalHigh = results.filter(
    (r) => r.curveShape === "multimodal-inconsistent" && r.confidence > 0.4 + 1e-9,
  );
  findings.push({
    kind: "confidence-above-cap-on-multimodal",
    detail: "multimodal-inconsistent shape must cap confidence at 0.40",
    rate: multimodalHigh.length / n,
    cases: multimodalHigh.length,
  });

  const monotonicityViolations = countMonotonicityViolations(results);
  findings.push({
    kind: "confidence-vs-error-monotonicity-violations",
    detail:
      "pairs where a WORSE-error case received ≥0.10 more confidence than a better-error case of the same family",
    rate: monotonicityViolations.rate,
    cases: monotonicityViolations.violations,
  });

  return findings;
}

/**
 * Monotonicity proxy: within each family, sort by relative error; count
 * adjacent pairs where the worse case is at least 0.10 MORE confident than
 * the better one. Some violations are statistically expected (confidence
 * reflects within-session separation, not post-hoc truth), but a HIGH rate
 * signals that confidence ignores evidence quality.
 */
export function countMonotonicityViolations(
  results: readonly CampaignCaseResult[],
): { violations: number; comparablePairs: number; rate: number } {
  const byFamily = new Map<string, CampaignCaseResult[]>();
  for (const r of results) {
    const list = byFamily.get(r.family) ?? [];
    list.push(r);
    byFamily.set(r.family, list);
  }
  let violations = 0;
  let pairs = 0;
  for (const list of byFamily.values()) {
    const sorted = [...list].sort(
      (a, b) => a.relativeErrorFraction - b.relativeErrorFraction,
    );
    for (let i = 0; i < sorted.length - 1; i++) {
      const better = sorted[i]!;
      const worse = sorted[i + 1]!;
      if (worse.relativeErrorFraction - better.relativeErrorFraction < 0.02) continue;
      pairs++;
      if (worse.confidence >= better.confidence + 0.1) violations++;
    }
  }
  return { violations, comparablePairs: pairs, rate: pairs > 0 ? violations / pairs : 0 };
}

/** X/Y asymmetry verdict scoring over jointXY-enabled cases. */
export interface AsymmetryScore {
  symmetricCases: number;
  asymmetricCases: number;
  falsePositiveRate: number;
  truePositiveRate: number;
  falseVerdicts: string[];
}

const ASYMMETRIC_VERDICTS = new Set(["clearly-asymmetric", "slightly-asymmetric"]);

export function scoreAsymmetryVerdicts(
  results: readonly CampaignCaseResult[],
): AsymmetryScore {
  const symmetric = results.filter((r) => !r.jointXYTruthAsymmetric && r.jointXYOutcome);
  const asymmetric = results.filter((r) => r.jointXYTruthAsymmetric && r.jointXYOutcome);
  const fp = symmetric.filter((r) => ASYMMETRIC_VERDICTS.has(r.jointXYOutcome!));
  const tp = asymmetric.filter((r) => ASYMMETRIC_VERDICTS.has(r.jointXYOutcome!));
  return {
    symmetricCases: symmetric.length,
    asymmetricCases: asymmetric.length,
    falsePositiveRate: fp.length / Math.max(symmetric.length, 1),
    truePositiveRate: tp.length / Math.max(asymmetric.length, 1),
    falseVerdicts: [...fp, ...asymmetric.filter((r) => !ASYMMETRIC_VERDICTS.has(r.jointXYOutcome!))]
      .slice(0, 20)
      .map(
        (r) =>
          `${r.family}#${r.seed}: outcome=${r.jointXYOutcome} truthAsym=${r.jointXYTruthAsymmetric}`,
      ),
  };
}
