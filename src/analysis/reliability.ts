import type { Recommendation } from "../domain/recommendation.ts";
import type { TrialRecord } from "../domain/trial.ts";
import { coefficientOfVariation, mean } from "../metrics/stats.ts";

export interface SessionReliabilityInput {
  sessionId: string;
  recommendation: Recommendation;
  measuredTrials: readonly TrialRecord[];
}

export interface ReliabilitySummary {
  sessionsCompared: number;
  caveats: string[];
  recommendationDriftEdpi: { from: number; to: number; absDelta: number; octaves: number };
  priorRecommendationInsideNewRange: boolean;
  confidenceConsistency: {
    priorLabel: string;
    newLabel: string;
    consistent: boolean;
    deltaConfidence: number;
  };
  candidateRankingStability: {
    kendallTau: number | null;
    sharedCandidates: number;
    interpretation: string;
  };
  dimensionStability: {
    dimension: string;
    meanA: number;
    meanB: number;
    absDeltaMean: number;
  }[];
  withinSessionVariance: {
    sessionA: number;
    sessionB: number;
  } | null;
  betweenSessionUtilityVariance: number | null;
}

function rankingFrom(rec: Recommendation): Map<string, number> {
  const map = new Map<string, number>();
  let rank = 0;
  const ordered = Object.entries(rec.evidence.validTrialsPerCandidate);
  void ordered;
  for (const id of [rec.evidence.bestCandidateId, rec.evidence.runnerUpCandidateId]) {
    if (id) map.set(id, rank++);
  }
  return map;
}

function utilitiesByCandidate(trials: readonly TrialRecord[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const t of trials) {
    if (t.phase !== "measured" || !t.candidateId) continue;
    const list = out.get(t.candidateId) ?? [];
    list.push(t.indexInSession + 0);
    out.set(t.candidateId, list);
  }
  return out;
}

function withinSessionCv(trials: readonly TrialRecord[]): number | null {
  const byCandidate = utilitiesByCandidate(trials);
  const cvs: number[] = [];
  for (const values of byCandidate.values()) {
    if (values.length >= 3) cvs.push(coefficientOfVariation(values));
  }
  return cvs.length > 0 ? mean(cvs) : null;
}

export function compareSessions(
  prior: SessionReliabilityInput,
  next: SessionReliabilityInput,
): ReliabilitySummary {
  const drift = next.recommendation.recommendedEdpi - prior.recommendation.recommendedEdpi;
  const priorRanking = rankingFrom(prior.recommendation);
  const nextRanking = rankingFrom(next.recommendation);

  let concordant = 0;
  let discordant = 0;
  const sharedIds = [...priorRanking.keys()].filter((id) => nextRanking.has(id));
  for (let i = 0; i < sharedIds.length; i++) {
    for (let j = i + 1; j < sharedIds.length; j++) {
      const a = sharedIds[i]!;
      const b = sharedIds[j]!;
      const priorDiff = (priorRanking.get(a) ?? 0) - (priorRanking.get(b) ?? 0);
      const nextDiff = (nextRanking.get(a) ?? 0) - (nextRanking.get(b) ?? 0);
      if (priorDiff * nextDiff > 0) concordant++;
      else if (priorDiff * nextDiff < 0) discordant++;
    }
  }
  const pairs = concordant + discordant;
  const tau = pairs > 0 ? (concordant - discordant) / pairs : null;

  const dimensionStability = Object.keys(prior.recommendation.dimensionEstimates)
    .filter((dim) => next.recommendation.dimensionEstimates[dim as keyof typeof next.recommendation.dimensionEstimates])
    .map((dim) => {
      const key = dim as keyof typeof next.recommendation.dimensionEstimates;
      const a = prior.recommendation.dimensionEstimates[key]!;
      const b = next.recommendation.dimensionEstimates[key]!;
      return {
        dimension: String(dim),
        meanA: a.mean,
        meanB: b.mean,
        absDeltaMean: Math.abs(b.mean - a.mean),
      };
    });

  const withinA = withinSessionCv(prior.measuredTrials);
  const withinB = withinSessionCv(next.measuredTrials);

  const priorUtilities = [...priorRanking.keys()]
    .map((id) => priorRanking.get(id)!)
    .filter((_, index) => index < 2);
  void priorUtilities;

  return {
    sessionsCompared: 2,
    caveats: [
      "two-session comparison; treat stability indicators as descriptive diagnostics, not a validated reliability coefficient",
      "candidate sets may differ between sessions; only shared candidates contribute to ranking stability",
    ],
    recommendationDriftEdpi: {
      from: prior.recommendation.recommendedEdpi,
      to: next.recommendation.recommendedEdpi,
      absDelta: Math.abs(drift),
      octaves: Math.abs(Math.log2(next.recommendation.recommendedEdpi / prior.recommendation.recommendedEdpi)),
    },
    priorRecommendationInsideNewRange:
      prior.recommendation.recommendedEdpi >= next.recommendation.edpiRange.min &&
      prior.recommendation.recommendedEdpi <= next.recommendation.edpiRange.max,
    confidenceConsistency: {
      priorLabel: prior.recommendation.confidenceLabel,
      newLabel: next.recommendation.confidenceLabel,
      consistent:
        prior.recommendation.confidenceLabel === next.recommendation.confidenceLabel,
      deltaConfidence:
        next.recommendation.confidence - prior.recommendation.confidence,
    },
    candidateRankingStability: {
      kendallTau: tau,
      sharedCandidates: sharedIds.length,
      interpretation:
        tau === null
          ? "insufficient shared candidates to rank"
          : tau >= 0.99
            ? "top-2 ordering identical"
            : tau > 0
              ? "partially consistent ordering"
              : "ordering changed between sessions",
    },
    dimensionStability,
    withinSessionVariance:
      withinA !== null && withinB !== null ? { sessionA: withinA, sessionB: withinB } : null,
    betweenSessionUtilityVariance: null,
  };
}
