import type {
  AimDimension,
  Evidence,
  Recommendation,
  DimensionEstimate,
} from "../domain/recommendation.ts";
import type { ExperimentDefinition } from "../domain/experiment.ts";
import { DEFAULT_SAFE_RANGE, type SafeSensitivityRange } from "../domain/candidate.ts";
import type { SensitivityCandidate } from "../domain/candidate.ts";
import type { TrialRecord } from "../domain/trial.ts";
import { multiplicativeChange } from "../sensmath/sensitivity.ts";
import { clampToSafeRange } from "../sensmath/candidates.ts";
import { makeCandidateId } from "../domain/ids.ts";
import { validateTrial, DEFAULT_VALIDATION_CONFIG, type ValidationExpectations } from "../validation/validateTrial.ts";
import {
  computeScenarioCenters,
  evaluateCandidate,
  type CandidateEvaluation,
  type ExclusionPolicy,
} from "./evaluate.ts";
import {
  computeCellUtilities,
  computePairedComparisons,
  lookupComparison,
  type PairedComparison,
} from "./paired.ts";
import {
  computeConfidence,
  dunnettAdjustedExclusionZ,
  labelForConfidence,
} from "./confidence.ts";
import { fitQuadraticWeighted } from "./quadratic.ts";
import {
  DEFAULT_DIMENSION_SCORING,
  DEFAULT_UTILITY_WEIGHTS,
} from "./scoring.ts";

export interface OptimizerConfig {
  exclusionPolicy: ExclusionPolicy;
  validationExpectations: ValidationExpectations;
  minValidTrialsPerCandidate: number;
  maxSearchRounds: number;
}

export const DEFAULT_OPTIMIZER_CONFIG: OptimizerConfig = {
  exclusionPolicy: {
    fatalReasons: [
      "IMPOSSIBLE_TIMESTAMPS",
      "MISSING_TARGET_APPEARANCE",
      "INSUFFICIENT_SAMPLES",
      "LARGE_SAMPLE_GAP",
      "IMPOSSIBLE_MOVEMENT",
      "CONFIG_MISMATCH",
      "POINTER_LOCK_LOSS",
      "TAB_HIDDEN",
      "RESIZE_DURING_TRIAL",
    ],
    suspectPolicy: "exclude",
  },
  validationExpectations: {},
  minValidTrialsPerCandidate: 4,
  maxSearchRounds: 2,
};

export type OptimizerNextStep =
  | { kind: "done" }
  | { kind: "collect"; candidates: SensitivityCandidate[]; round: number };

export class SensitivityOptimizer {
  readonly #definition: ExperimentDefinition;
  readonly #config: OptimizerConfig;
  readonly #trialsByCandidate = new Map<string, TrialRecord[]>();
  #roundsRun = 0;

  constructor(definition: ExperimentDefinition, config?: Partial<OptimizerConfig>) {
    this.#definition = definition;
    this.#config = { ...DEFAULT_OPTIMIZER_CONFIG, ...config };
  }

  get roundsRun(): number {
    return this.#roundsRun;
  }

  addTrials(trials: readonly TrialRecord[]): void {
    for (const trial of trials) {
      const validity = validateTrial(trial, DEFAULT_VALIDATION_CONFIG, {
        sensitivity: this.findSensitivityFor(trial.candidateId),
      });
      trial.validity = validity;
      const key = trial.candidateId ?? "_unassigned";
      const list = this.#trialsByCandidate.get(key) ?? [];
      list.push(trial);
      this.#trialsByCandidate.set(key, list);
    }
    this.#roundsRun++;
  }

  addCandidates(candidates: readonly SensitivityCandidate[]): void {
    for (const candidate of candidates) {
      const exists = this.#definition.candidates.some(
        (c) =>
          Math.abs(c.sensitivity.sensX - candidate.sensitivity.sensX) < 1e-6 &&
          Math.abs(c.sensitivity.sensY - candidate.sensitivity.sensY) < 1e-6,
      );
      if (!exists) {
        this.#definition.candidates.push(candidate);
      }
    }
  }

  findSensitivityFor(candidateId: string | null) {
    if (!candidateId) return undefined;
    return this.#definition.candidates.find((c) => c.id === candidateId)?.sensitivity;
  }

  pairedComparisons(): Map<string, PairedComparison> {
    const cellUtilities = computeCellUtilities(
      this.#definition,
      this.#trialsByCandidate,
      this.#config.exclusionPolicy,
    );
    return computePairedComparisons(this.#trialsByCandidate, cellUtilities);
  }

  evaluations(): CandidateEvaluation[] {
    const centers = computeScenarioCenters(
      this.#definition,
      this.#trialsByCandidate,
      this.#config.exclusionPolicy,
    );
    const out: CandidateEvaluation[] = [];
    for (const [candidateId, trials] of this.#trialsByCandidate) {
      const evaluation = evaluateCandidate(
        this.#definition,
        trials,
        this.#config.exclusionPolicy,
        DEFAULT_DIMENSION_SCORING,
        centers,
      );
      if (evaluation && candidateId !== "_unassigned") out.push(evaluation);
    }
    out.sort((a, b) => b.utilityMean - a.utilityMean);
    return out;
  }

  needsMoreEvidence(): OptimizerNextStep {
    if (this.#roundsRun >= this.#config.maxSearchRounds) return { kind: "done" };
    const evals = this.evaluations();
    if (evals.length < 3) return { kind: "done" };
    const proposal = this.#proposeRefinementCandidates(evals);
    if (proposal.length === 0) return { kind: "done" };
    return { kind: "collect", candidates: proposal, round: this.#roundsRun };
  }

  #proposeRefinementCandidates(evals: readonly CandidateEvaluation[]): SensitivityCandidate[] {
    const points = evals
      .filter((e) => e.trialsIncluded.length > 0 && Number.isFinite(e.utilityStandardError))
      .map((e) => ({
        x: e.log2RatioVsBaseline,
        y: e.utilityMean,
        weight:
          e.utilityStandardError > 0
            ? 1 / (e.utilityStandardError * e.utilityStandardError)
            : 1e-6,
      }));
    const fit = fitQuadraticWeighted(points);
    const safeRange = DEFAULT_SAFE_RANGE;
    const proposals: SensitivityCandidate[] = [];
    const existingX = new Set(evals.map((e) => e.log2RatioVsBaseline.toFixed(4)));

    if (fit?.vertexX !== null && fit !== null) {
      const vx = Math.min(Math.max(fit.vertexX, -0.45), 0.45);
      const key = vx.toFixed(4);
      if (!existingX.has(key) && Math.abs(vx) > 0.02) {
        const sens = clampToSafeRange(
          multiplicativeChange(this.#definition.baselineSensitivity, Math.pow(2, vx)),
          safeRange,
        );
        proposals.push({
          id: makeCandidateId(`refine-v${key.replace("-", "m").replace(".", "_")}`),
          sensitivity: sens,
          origin: { kind: "manual", label: `refinement vertex ${vx.toFixed(3)} octaves` },
        });
        existingX.add(key);
      }
    }

    const best = evals[0]!;
    const runnerUp = evals[1];
    if (runnerUp && best.log2RatioVsBaseline !== runnerUp.log2RatioVsBaseline) {
      const midX = (best.log2RatioVsBaseline + runnerUp.log2RatioVsBaseline) / 2;
      const midKey = midX.toFixed(4);
      if (!existingX.has(midKey) && Math.abs(midX - best.log2RatioVsBaseline) > 0.03) {
        const sens = clampToSafeRange(
          multiplicativeChange(this.#definition.baselineSensitivity, Math.pow(2, midX)),
          safeRange,
        );
        proposals.push({
          id: makeCandidateId(`refine-gap-${midKey.replace("-", "m").replace(".", "_")}`),
          sensitivity: sens,
          origin: { kind: "manual", label: "midpoint between top two" },
        });
        existingX.add(midKey);
      }
    }

    const xs = evals.map((e) => e.log2RatioVsBaseline);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    if (best.log2RatioVsBaseline <= minX + 1e-9) {
      this.#pushUniqueProposal(proposals, existingX, minX - 0.35, safeRange, "boundary expansion down");
    } else if (best.log2RatioVsBaseline >= maxX - 1e-9) {
      this.#pushUniqueProposal(proposals, existingX, maxX + 0.35, safeRange, "boundary expansion up");
    }
    return proposals.slice(0, 3);
  }

  #pushUniqueProposal(
    proposals: SensitivityCandidate[],
    existingX: Set<string>,
    octaves: number,
    safeRange: SafeSensitivityRange,
    label: string,
  ): void {
    const key = octaves.toFixed(4);
    if (existingX.has(key)) return;
    const sens = clampToSafeRange(
      multiplicativeChange(this.#definition.baselineSensitivity, Math.pow(2, octaves)),
      safeRange,
    );
    if (
      proposals.some((p) =>
        Math.abs(p.sensitivity.sensX - sens.sensX) < 1e-6 &&
        Math.abs(p.sensitivity.sensY - sens.sensY) < 1e-6,
      )
    ) {
      return;
    }
    proposals.push({
      id: makeCandidateId(`refine-exp-${key.replace("-", "m").replace(".", "_")}`),
      sensitivity: sens,
      origin: { kind: "manual", label },
    });
    existingX.add(key);
  }

  recommend(): Recommendation {
    const baselineEdpiForRange = (): number =>
      this.#definition.dpi * this.#definition.baselineSensitivity.sensX;
    const evals = this.evaluations();
    const warnings: string[] = [];
    const rationale: string[] = [];
    const notes: string[] = [];
    const reasonTotals: Record<string, number> = {};
    let analyzed = 0;
    let excludedTotal = 0;
    const validPerCandidate: Record<string, number> = {};

    for (const e of evals) {
      analyzed += e.trialsIncluded.length;
      excludedTotal += e.trialsExcluded;
      validPerCandidate[e.candidateId] = e.trialsIncluded.length;
      for (const [code, count] of Object.entries(e.exclusionReasonCounts)) {
        reasonTotals[code] = (reasonTotals[code] ?? 0) + count;
      }
    }

    if (evals.length < 3 || analyzed < this.#config.minValidTrialsPerCandidate) {
      return this.#insufficientRecommendation(evals, analyzed, excludedTotal, reasonTotals, validPerCandidate);
    }

    const best = evals[0]!;
    const runnerUp = evals[1] ?? null;
    const paired = this.pairedComparisons();
    let gap: number | null = null;
    let z: number | null = null;
    let gapBasis: "paired" | "pooled" | "none" = "none";
    if (runnerUp !== null) {
      const pairedCmp = lookupComparison(paired, best.candidateId, runnerUp.candidateId);
      if (pairedCmp && pairedCmp.pairedCells >= 3 && pairedCmp.diffStandardError > 0) {
        gap = pairedCmp.diffMean;
        z = pairedCmp.z;
        gapBasis = "paired";
      } else {
        gap = best.utilityMean - runnerUp.utilityMean;
        const gapSe = Math.hypot(
          best.utilityStandardError,
          runnerUp.utilityStandardError,
        );
        z = gapSe > 0 ? gap / gapSe : null;
        gapBasis = "pooled";
      }
    }
    if (gapBasis === "paired") {
      notes.push("best-vs-runner-up gap uses paired instance differences");
    }

    const exclusionZ = dunnettAdjustedExclusionZ(evals.length);
    const tiedSet = new Set<string>([best.candidateId]);
    for (const e of evals) {
      if (e.candidateId === best.candidateId) continue;
      const cmp = lookupComparison(paired, best.candidateId, e.candidateId);
      if (cmp && cmp.pairedCells >= 3 && cmp.diffStandardError > 0) {
        if (cmp.z > -exclusionZ) tiedSet.add(e.candidateId);
      } else {
        const upper = e.utilityMean + 1.96 * e.utilityStandardError;
        const bestLower = best.utilityMean - 1.96 * best.utilityStandardError;
        if (upper >= bestLower) tiedSet.add(e.candidateId);
      }
    }
    const tiedEvals = evals.filter((e) => tiedSet.has(e.candidateId));
    const xs = tiedEvals.map((e) => e.edpi);
    let rangeMin = Math.min(...xs);
    let rangeMax = Math.max(...xs);

    const testedXs = evals.map((e) => e.log2RatioVsBaseline);
    const testedMinX = Math.min(...testedXs);
    const testedMaxX = Math.max(...testedXs);
    if (best.log2RatioVsBaseline <= testedMinX + 1e-9) {
      rangeMin = Math.min(
        rangeMin,
        baselineEdpiForRange() * Math.pow(2, testedMinX - 0.35),
      );
      warnings.push("best candidate at lower search boundary; range extended outward");
    } else if (best.log2RatioVsBaseline >= testedMaxX - 1e-9) {
      rangeMax = Math.max(
        rangeMax,
        baselineEdpiForRange() * Math.pow(2, testedMaxX + 0.35),
      );
      warnings.push("best candidate at upper search boundary; range extended outward");
    }

    const incompleteCandidates = evals.filter(
      (e) => e.trialsIncluded.length < this.#config.minValidTrialsPerCandidate,
    );
    const anyIncomplete = incompleteCandidates.length > 0;
    const bestIncomplete =
      best.trialsIncluded.length < this.#config.minValidTrialsPerCandidate;

    const sortedEdpis = evals.map((e) => e.edpi).sort((a, b) => a - b);
    const atBoundary =
      Math.abs(best.edpi - sortedEdpis[0]!) < 1e-9 ||
      Math.abs(best.edpi - sortedEdpis[sortedEdpis.length - 1]!) < 1e-9;
    void sortedEdpis;

    const roundsExhausted = this.#roundsRun >= this.#config.maxSearchRounds;
    const expansionCandidates = this.#definition.candidates.filter(
      (c) =>
        c.origin.kind === "manual" &&
        c.origin.label.startsWith("boundary expansion"),
    );
    const boundaryTouched = expansionCandidates.length > 0 || atBoundary;
    const evaluatedExpansionIncomplete = expansionCandidates.some((c) => {
      const evaluation = evals.find((e) => e.candidateId === c.id);
      return (
        evaluation !== undefined &&
        evaluation.trialsIncluded.length < this.#config.minValidTrialsPerCandidate
      );
    });
    const unresolvedBoundary =
      atBoundary && (evaluatedExpansionIncomplete || roundsExhausted);

    const vertexFit = fitQuadraticWeighted(
      evals.map((e) => ({
        x: e.log2RatioVsBaseline,
        y: e.utilityMean,
        weight: Number.isFinite(e.utilityStandardError) && e.utilityStandardError > 0
          ? 1 / (e.utilityStandardError ** 2)
          : 1e-6,
      })),
    );

    const baselineEdpi = baselineEdpiForRange();
    const peakTStat =
      vertexFit &&
      vertexFit.a < 0 &&
      vertexFit.standardErrorA !== null &&
      vertexFit.standardErrorA > 0
        ? Math.abs(vertexFit.a / vertexFit.standardErrorA)
        : 0;
    const significantPeak = peakTStat >= 2;
    const vertexInsideSpan =
      vertexFit?.vertexX !== null &&
      vertexFit !== null &&
      vertexFit.vertexX! >= Math.log2(rangeMin / baselineEdpi) - 1e-9 &&
      vertexFit.vertexX! <= Math.log2(rangeMax / baselineEdpi) + 1e-9;

    let confidence = computeConfidence({
      utilityGapZ: z,
      bestCandidateIncomplete: bestIncomplete,
      anyCandidateIncomplete: anyIncomplete,
      bestAtSearchBoundary: atBoundary,
      candidatesWithData: evals.filter((e) => e.trialsIncluded.length > 0).length,
    });
    if (significantPeak && vertexInsideSpan && !atBoundary) {
      confidence = Math.min(0.85, confidence + 0.25);
    }

    const separation: Evidence["separation"] =
      anyIncomplete || z === null
        ? "insufficient"
        : Math.abs(z) >= 2 || (significantPeak && vertexInsideSpan)
          ? "clear"
          : "weak";
    if (separation === "weak") {
      confidence = Math.min(confidence, 0.65);
    }
    if (unresolvedBoundary) {
      confidence = Math.min(confidence, 0.45);
      warnings.push(
        "unresolved boundary: the optimum may lie beyond the tested range; further testing suggested",
      );
    }
    if (boundaryTouched && !unresolvedBoundary) {
      confidence = Math.min(confidence, 0.65);
      warnings.push(
        "the search reached the edge of the initially tested range; confirm before large commitments",
      );
    }

    let vertexCiLine: string | null = null;
    if (significantPeak && vertexFit?.vertexStandardError != null && vertexInsideSpan) {
      const ciLo = baselineEdpi * Math.pow(2, vertexFit.vertexX! - 1.96 * vertexFit.vertexStandardError);
      const ciHi = baselineEdpi * Math.pow(2, vertexFit.vertexX! + 1.96 * vertexFit.vertexStandardError);
      vertexCiLine = `${ciLo.toFixed(0)}–${ciHi.toFixed(0)} eDPI`;
      const widenedMin = Math.min(rangeMin, ciLo);
      const widenedMax = Math.max(rangeMax, ciHi);
      const safeMinEdpi = this.#definition.dpi * DEFAULT_SAFE_RANGE.minSensX;
      const safeMaxEdpi = this.#definition.dpi * DEFAULT_SAFE_RANGE.maxSensX;
      const clippedMin = Math.max(widenedMin, safeMinEdpi);
      const clippedMax = Math.min(widenedMax, safeMaxEdpi);
      if (clippedMax > clippedMin && (clippedMin < rangeMin || clippedMax > rangeMax)) {
        rangeMin = clippedMin;
        rangeMax = clippedMax;
        notes.push("range widened to cover the quadratic-peak uncertainty interval");
      }
    }

    if (anyIncomplete) {
      warnings.push(
        `${incompleteCandidates.length} candidate(s) below ${this.#config.minValidTrialsPerCandidate} valid trials; confidence reduced`,
      );
    }
    if (atBoundary) {
      warnings.push(
        "best candidate lies at the edge of the tested range; the true optimum may lie beyond it",
      );
    }
    if (rangeMax - rangeMin > best.edpi * 0.35) {
      warnings.push("statistically tied candidates span a wide range; treat point estimate cautiously");
    }
    if (excludedTotal > 0) {
      notes.push(`${excludedTotal} trial(s) excluded by validity policy`);
    }

    const dimensionEstimates: Partial<Record<AimDimension, DimensionEstimate>> = {};
    for (const dim of Object.keys(DEFAULT_UTILITY_WEIGHTS) as AimDimension[]) {
      const values = evals
        .map((e) => e.dimensionEstimates[dim])
        .filter((v): v is DimensionEstimate => v !== undefined);
      if (values.length === 0) continue;
      const wsum = values.reduce((a, v) => a + v.sampleCount, 0);
      dimensionEstimates[dim] = {
        mean: values.reduce((a, v) => a + v.mean * v.sampleCount, 0) / wsum,
        standardError: Math.max(...values.map((v) => v.standardError)),
        sampleCount: wsum,
      };
    }

    rationale.push(
      `Best candidate ${best.candidateId} (${best.edpi.toFixed(0)} eDPI) utility ${best.utilityMean.toFixed(3)} ± ${best.utilityStandardError.toFixed(3)}`,
    );
    if (runnerUp) {
      rationale.push(
        `Runner-up ${runnerUp.candidateId} (${runnerUp.edpi.toFixed(0)} eDPI) trails by ${gap!.toFixed(3)} utility (z=${z === null ? "n/a" : z.toFixed(2)})`,
      );
    }
    const accBest = best.dimensionEstimates.accuracy;
    const accRun = runnerUp?.dimensionEstimates.accuracy;
    if (accBest && accRun) {
      rationale.push(
        `accuracy dimension: best ${(accBest.mean * 100).toFixed(0)}% vs runner-up ${(accRun.mean * 100).toFixed(0)}%`,
      );
    }
    if (vertexFit?.vertexX !== null && vertexFit !== null) {
      rationale.push(
        `quadratic surrogate over log2 eDPI ratio places the peak near baseline ×${Math.pow(2, vertexFit.vertexX!).toFixed(3)}`,
      );
    }
    rationale.push(
      `statistically indistinguishable candidates span ${rangeMin.toFixed(0)}–${rangeMax.toFixed(0)} eDPI`,
    );
    if (unresolvedBoundary) {
      rationale.push(
        "point estimate pinned to the best tested candidate because the optimum may lie beyond the tested range",
      );
    }
    if (vertexCiLine) {
      rationale.push(`surrogate vertex 95% CI: ${vertexCiLine}`);
    }

    const unweightedFit = fitQuadraticWeighted(
      evals.map((e) => ({ x: e.log2RatioVsBaseline, y: e.utilityMean, weight: 1 })),
    );
    const spanInterior = (xv: number): boolean =>
      xv > testedMinX + 0.02 && xv < testedMaxX - 0.02;
    const pointCandidates = [best.log2RatioVsBaseline];
    if (!unresolvedBoundary) {
      if (vertexFit?.vertexX != null && spanInterior(vertexFit.vertexX)) {
        pointCandidates.push(vertexFit.vertexX);
      }
      if (unweightedFit?.vertexX != null && spanInterior(unweightedFit.vertexX)) {
        pointCandidates.push(unweightedFit.vertexX);
      }
    }
    pointCandidates.sort((p, q) => p - q);
    const medianIndex = Math.floor(pointCandidates.length / 2);
    const vertexOctaves =
      pointCandidates.length % 2 === 1
        ? pointCandidates[medianIndex]!
        : (pointCandidates[medianIndex - 1]! + pointCandidates[medianIndex]!) / 2;
    const loOctaves = Math.log2(rangeMin / baselineEdpi);
    const hiOctaves = Math.log2(rangeMax / baselineEdpi);
    const clampedOctaves = Math.min(hiOctaves, Math.max(loOctaves, vertexOctaves));
    const clampedFactor = Math.pow(2, clampedOctaves);
    const primarySensitivity = clampToSafeRange(
      multiplicativeChange(this.#definition.baselineSensitivity, clampedFactor),
      DEFAULT_SAFE_RANGE,
    );
    const recommendedEdpi = this.#definition.dpi * primarySensitivity.sensX;

    return {
      experimentId: this.#definition.id,
      primarySensitivity,
      recommendedEdpi,
      sensXRange: {
        min: rangeMin / this.#definition.dpi,
        max: rangeMax / this.#definition.dpi,
      },
      edpiRange: { min: rangeMin, max: rangeMax },
      confidence,
      confidenceLabel: labelForConfidence(confidence),
      dimensionEstimates,
      utilityWeights: DEFAULT_UTILITY_WEIGHTS,
      evidence: {
        trialsAnalyzed: analyzed,
        trialsExcluded: excludedTotal,
        exclusionReasonCounts: reasonTotals,
        candidatesEvaluated: evals.length,
        validTrialsPerCandidate: validPerCandidate,
        bestCandidateId: best.candidateId,
        runnerUpCandidateId: runnerUp?.candidateId ?? null,
        utilityGapBestVsRunnerUp: gap,
        utilityGapZScore: z,
        separation,
        searchRoundsRun: this.#roundsRun,
        notes,
      },
      warnings,
      refusedHighConfidence: confidence < 0.5,
      rationaleLines: rationale,
      unresolvedBoundary,
      yExploration: undefined,
      furtherTestingSuggested:
        unresolvedBoundary ||
        boundaryTouched ||
        confidence < 0.5 ||
        separation !== "clear",
    };
  }

  #insufficientRecommendation(
    evals: readonly CandidateEvaluation[],
    analyzed: number,
    excludedTotal: number,
    reasonTotals: Record<string, number>,
    validPerCandidate: Record<string, number>,
  ): Recommendation {
    const xs = evals.map((e) => e.edpi);
    const rangeMin = xs.length > 0 ? Math.min(...xs) : this.#definition.dpi * this.#definition.baselineSensitivity.sensX;
    const rangeMax = xs.length > 0 ? Math.max(...xs) : rangeMin;
    const factor = rangeMin === rangeMax ? 1 : Math.sqrt((rangeMax / rangeMin));
    const primary = clampToSafeRange(
      multiplicativeChange(this.#definition.baselineSensitivity, factor),
      DEFAULT_SAFE_RANGE,
    );
    return {
      experimentId: this.#definition.id,
      primarySensitivity: primary,
      recommendedEdpi: this.#definition.dpi * primary.sensX,
      sensXRange: {
        min: rangeMin / this.#definition.dpi,
        max: rangeMax / this.#definition.dpi,
      },
      edpiRange: { min: rangeMin, max: rangeMax },
      confidence: 0.15,
      confidenceLabel: "low",
      dimensionEstimates: {},
      utilityWeights: DEFAULT_UTILITY_WEIGHTS,
      evidence: {
        trialsAnalyzed: analyzed,
        trialsExcluded: excludedTotal,
        exclusionReasonCounts: reasonTotals,
        candidatesEvaluated: evals.length,
        validTrialsPerCandidate: validPerCandidate,
        bestCandidateId: evals[0]?.candidateId ?? "none",
        runnerUpCandidateId: evals[1]?.candidateId ?? null,
        utilityGapBestVsRunnerUp: null,
        utilityGapZScore: null,
        separation: "insufficient",
        searchRoundsRun: this.#roundsRun,
        notes: ["insufficient data to rank candidates reliably"],
      },
      warnings: [
        "refusing high-confidence claim: too few valid trials to compare candidates",
      ],
      refusedHighConfidence: true,
      rationaleLines: [
        `only ${analyzed} valid trials across ${evals.length} candidates; minimum required is ${this.#config.minValidTrialsPerCandidate} per candidate and at least 3 candidates`,
      ],
      unresolvedBoundary: false,
      yExploration: undefined,
      furtherTestingSuggested: true,
    };
  }
}
