import type { ExperimentDefinition } from "../domain/experiment.ts";
import type { TrialRecord } from "../domain/trial.ts";
import { meanAndStandardError } from "../metrics/stats.ts";
import {
  DEFAULT_DIMENSION_SCORING,
  DEFAULT_UTILITY_WEIGHTS,
  scoreTrialDimensions,
  trialUtilityFromDimensions,
  type DimensionScoringConfig,
} from "./scoring.ts";
import type { ExclusionPolicy } from "./evaluate.ts";

export interface CellKey {
  scenarioId: string;
  repIndex: number;
}

export function cellKeyOf(trial: TrialRecord): string {
  return `${trial.scenarioId}#${trial.scenarioRepIndex ?? "na"}`;
}

export interface PairedComparison {
  aCandidateId: string;
  bCandidateId: string;
  diffMean: number;
  diffStandardError: number;
  pairedCells: number;
  z: number;
}

export type TrialUtilityFn = (trial: TrialRecord) => number | null;

function isIncluded(trial: TrialRecord, policy: ExclusionPolicy): boolean {
  if (trial.phase !== "measured") return false;
  if (trial.validity.status === "invalid") return false;
  if (trial.validity.status === "suspect" && policy.suspectPolicy === "exclude") {
    return false;
  }
  return true;
}

export function computeCellUtilities(
  definition: ExperimentDefinition,
  trialsByCandidate: ReadonlyMap<string, readonly TrialRecord[]>,
  policy: ExclusionPolicy,
  scoring: DimensionScoringConfig = DEFAULT_DIMENSION_SCORING,
  /** Deterministic injection seam for replay/synthetic analysis. */
  utilityOverride?: TrialUtilityFn,
): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const [candidateId, trials] of trialsByCandidate) {
    const cellAccum = new Map<string, number[]>();
    for (const trial of trials) {
      if (!isIncluded(trial, policy)) continue;
      let utility: number | null;
      if (utilityOverride) {
        utility = utilityOverride(trial);
      } else {
        const scenario =
          definition.scenarioCatalog.find((sc) => sc.id === trial.scenarioId) ??
          undefined;
        const { dimensions } = scoreTrialDimensions(trial, scenario, scoring);
        utility = trialUtilityFromDimensions(dimensions, DEFAULT_UTILITY_WEIGHTS);
      }
      if (utility === null) continue;
      const key = cellKeyOf(trial);
      const list = cellAccum.get(key) ?? [];
      list.push(utility);
      cellAccum.set(key, list);
    }
    const cells = new Map<string, number>();
    for (const [key, values] of cellAccum) {
      cells.set(key, values.reduce((a, b) => a + b, 0) / values.length);
    }
    out.set(candidateId, cells);
  }
  return out;
}

export function computePairedComparisons(
  trialsByCandidate: ReadonlyMap<string, readonly TrialRecord[]>,
  cellUtilities: ReadonlyMap<string, ReadonlyMap<string, number>>,
): Map<string, PairedComparison> {
  const ids = [...trialsByCandidate.keys()].sort();
  const comparisons = new Map<string, PairedComparison>();
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i]!;
      const b = ids[j]!;
      const aCells = cellUtilities.get(a);
      const bCells = cellUtilities.get(b);
      if (!aCells || !bCells) continue;
      const diffs: number[] = [];
      for (const [cell, aValue] of aCells) {
        const bValue = bCells.get(cell);
        if (bValue === undefined) continue;
        diffs.push(aValue - bValue);
      }
      if (diffs.length < 2) continue;
      const stats = meanAndStandardError(diffs)!;
      const key = `${a}::${b}`;
      comparisons.set(key, {
        aCandidateId: a,
        bCandidateId: b,
        diffMean: stats.mean,
        diffStandardError: stats.standardError,
        pairedCells: stats.sampleCount,
        z:
          stats.standardError > 0 ? stats.mean / stats.standardError : 0,
      });
    }
  }
  return comparisons;
}

export function lookupComparison(
  comparisons: ReadonlyMap<string, PairedComparison>,
  aId: string,
  bId: string,
): PairedComparison | null {
  const direct = comparisons.get(`${aId}::${bId}`);
  if (direct) return direct;
  const flipped = comparisons.get(`${bId}::${aId}`);
  if (!flipped) return null;
  return {
    aCandidateId: aId,
    bCandidateId: bId,
    diffMean: -flipped.diffMean,
    diffStandardError: flipped.diffStandardError,
    pairedCells: flipped.pairedCells,
    z:
      flipped.diffStandardError > 0
        ? -flipped.diffMean / flipped.diffStandardError
        : 0,
  };
}
