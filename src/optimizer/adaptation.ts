import type { TrialRecord } from "../domain/trial.ts";
import { meanAndStandardError } from "../metrics/stats.ts";

export interface CandidateAdaptationEffect {
  candidateId: string;
  earlyMean: number;
  lateMean: number;
  improvement: number;
  z: number | null;
  significant: boolean;
}

export interface AdaptationReport {
  effects: CandidateAdaptationEffect[];
  anySignificantImprovement: boolean;
  notes: string[];
}

/**
 * Learning/adaptation detection: compares each candidate's first-encounter
 * trials against its later encounters. The interleaved block design means
 * every candidate is re-exposed after intervening blocks, so a significant
 * late-vs-early improvement indicates an adaptation/learning effect rather
 * than a sensitivity effect.
 */
export function detectAdaptation(
  trialsByCandidate: ReadonlyMap<string, readonly TrialRecord[]>,
  utilityOf: (trial: TrialRecord) => number | null,
  options: { minTrialsPerSide?: number; significanceZ?: number } = {},
): AdaptationReport {
  const minTrials = options.minTrialsPerSide ?? 3;
  const significanceZ = options.significanceZ ?? 2;
  const effects: CandidateAdaptationEffect[] = [];

  for (const [candidateId, trials] of trialsByCandidate) {
    const measured = trials
      .filter((t) => t.phase === "measured" && t.validity.status === "valid")
      .sort((a, b) => a.indexInSession - b.indexInSession);
    if (measured.length < minTrials * 2) continue;
    const half = Math.floor(measured.length / 2);
    const early = measured.slice(0, half).map(utilityOf).filter((v): v is number => v !== null);
    const late = measured.slice(half).map(utilityOf).filter((v): v is number => v !== null);
    if (early.length < minTrials || late.length < minTrials) continue;

    const earlyStats = meanAndStandardError(early)!;
    const lateStats = meanAndStandardError(late)!;
    const seCombined = Math.hypot(earlyStats.standardError, lateStats.standardError);
    const improvement = lateStats.mean - earlyStats.mean;
    effects.push({
      candidateId,
      earlyMean: earlyStats.mean,
      lateMean: lateStats.mean,
      improvement,
      z: seCombined > 0 ? improvement / seCombined : null,
      significant: seCombined > 0 && Math.abs(improvement / seCombined) >= significanceZ,
    });
  }

  return {
    effects,
    anySignificantImprovement: effects.some((e) => e.improvement > 0 && e.significant),
    notes: [
      "early-vs-late halves within a candidate measure adaptation; interleaving keeps this orthogonal to candidate differences",
    ],
  };
}
