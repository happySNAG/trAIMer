import type { CandidateEvaluation } from "../optimizer/evaluate.ts";
import { lookupComparison, type PairedComparison } from "../optimizer/paired.ts";
import type { CurveAdequacy } from "../optimizer/adequacy.ts";
import type { SessionAdaptationReport } from "../optimizer/changepoint.ts";

/**
 * Information-driven candidate allocation (Pass 4, requirement I).
 *
 * After the minimum balanced measurements, additional trial blocks go where
 * they resolve the most decision-uncertainty:
 *
 *   - near-tied contenders (small |z| vs best),
 *   - uncertainty around a potential peak (wide vertex CI),
 *   - unresolved search boundaries,
 *   - suspected asymmetry,
 *   - X/Y interaction questions.
 *
 * Clearly dominated candidates are starved but never silently dropped
 * (periodic control refresh remains). Every request carries a machine-readable
 * reason; decisions are pure functions of observations + seed so identical
 * inputs always produce identical allocations. Fairness safeguards and hard
 * caps live in the caller (budget/fatigue limits).
 */

export type ExtraBlockReason =
  | "near-tied-contender"
  | "peak-uncertainty"
  | "unresolved-boundary"
  | "suspected-asymmetry"
  | "xy-interaction-question"
  | "control-refresh-dominated"
  | "budget-exhausted";

export interface ExtraBlockDecision {
  candidateId: string;
  reps: number;
  reason: ExtraBlockReason;
  /** Human-auditable explanation recorded in the audit log. */
  rationale: string;
  informationScore: number;
}

export interface ExtraAllocationInput {
  evaluations: readonly CandidateEvaluation[];
  pairedComparisons: ReadonlyMap<string, PairedComparison>;
  repsPerBlock: number;
  trialsSoFarPerCandidate: ReadonlyMap<string, number>;
  maxTotalMeasuredTrials: number;
  adequacy: CurveAdequacy | null;
  adaptation: Pick<SessionAdaptationReport, "contaminationDetected"> | null;
  /** Candidates planned for joint X/Y stage (interaction questions). */
  jointXYCandidateIds?: readonly string[];
  /** z threshold below which a contender counts as near-tied. */
  tieZThreshold?: number;
}

export function allocateExtraBlocks(
  input: ExtraAllocationInput,
): ExtraBlockDecision[] {
  const tieZ = input.tieZThreshold ?? 1.5;
  const sorted = [...input.evaluations].sort((a, b) => b.utilityMean - a.utilityMean);
  const best = sorted[0] ?? null;
  if (!best) return [];

  const totalSoFar = [...input.trialsSoFarPerCandidate.values()].reduce((a, b) => a + b, 0);
  let budgetRemaining = Math.max(0, input.maxTotalMeasuredTrials - totalSoFar);

  const decisions: ExtraBlockDecision[] = [];
  const push = (
    candidateId: string,
    reps: number,
    reason: ExtraBlockReason,
    infoScore: number,
    rationale: string,
  ): void => {
    const capped = Math.min(reps, budgetRemaining);
    budgetRemaining -= capped;
    decisions.push({
      candidateId,
      reps: capped,
      reason: capped === 0 ? "budget-exhausted" : reason,
      rationale: capped === 0 ? "trial budget exhausted" : rationale,
      informationScore: Number.isFinite(infoScore) ? infoScore : 0,
    });
  };

  // Information scoring per candidate.
  interface Scored {
    id: string;
    score: number;
    reasons: { reason: ExtraBlockReason; why: string }[];
  }
  const scored = new Map<string, Scored>();
  for (const e of input.evaluations) scored.set(e.candidateId, { id: e.candidateId, score: 0, reasons: [] });

  // Near ties: every non-best candidate whose paired z vs best is small.
  for (const e of sorted.slice(1)) {
    const cmp = lookupComparison(input.pairedComparisons, best.candidateId, e.candidateId);
    if (!cmp || cmp.pairedCells < 3 || !(cmp.diffStandardError > 0)) continue;
    if (Math.abs(cmp.z) <= tieZ && cmp.z > -2) {
      const s = scored.get(e.candidateId)!;
      s.score += 2 + tieZ - Math.abs(cmp.z);
      s.reasons.push({
        reason: "near-tied-contender",
        why: `paired gap vs best z=${cmp.z.toFixed(2)} within tie threshold ${tieZ}`,
      });
    }
  }

  // Peak uncertainty: wide relative SE on the best candidate.
  if (
    best.utilityStandardError > 0 &&
    Number.isFinite(best.utilityStandardError)
  ) {
    const s = scored.get(best.candidateId)!;
    s.score += 1;
    s.reasons.push({
      reason: "peak-uncertainty",
      why: `best candidate utility SE ${best.utilityStandardError.toFixed(3)} still material relative to gaps`,
    });
  }

  // Unresolved boundary: extend beyond the edge in the boundary direction by
  // boosting the EDGE candidates themselves (new candidates are created by the
  // optimizer's refinement step, not here).
  if (input.adequacy?.result.kind === "unresolved-boundary") {
    const direction = input.adequacy.result.direction;
    const xs = input.evaluations.map((e) => e.log2RatioVsBaseline);
    const edgeId =
      direction === "high"
        ? input.evaluations.find((e) => e.log2RatioVsBaseline === Math.max(...xs))?.candidateId
        : input.evaluations.find((e) => e.log2RatioVsBaseline === Math.min(...xs))?.candidateId;
    if (edgeId) {
      const s = scored.get(edgeId)!;
      s.score += 3;
      s.reasons.push({
        reason: "unresolved-boundary",
        why: `${direction} boundary unresolved; more evidence at the edge sharpens the range before expansion`,
      });
    }
  }

  // Suspected asymmetry: asymmetric-optimum shape boosts both neighbors of best.
  if (input.adequacy?.shape === "asymmetric-optimum") {
    const neighbors = ladderNeighbors(input.evaluations, best.candidateId);
    for (const id of neighbors) {
      const s = scored.get(id);
      if (!s) continue;
      s.score += 1.5;
      s.reasons.push({
        reason: "suspected-asymmetry",
        why: "curve falls off asymmetrically; neighbor evidence pins the peak side",
      });
    }
  }

  // X/Y interaction questions.
  for (const id of input.jointXYCandidateIds ?? []) {
    const s = scored.get(id);
    if (!s) continue;
    s.score += 2;
    s.reasons.push({
      reason: "xy-interaction-question",
      why: "candidate participates in the sparse joint X/Y neighborhood",
    });
  }

  // Adaptation contamination: spread one extra rep to re-expose everyone.
  const reExposureBonus = input.adaptation?.contaminationDetected ? 0.75 : 0;

  // Dominated candidates get periodic controls only.
  for (const e of sorted.slice(1)) {
    const cmp = lookupComparison(input.pairedComparisons, best.candidateId, e.candidateId);
    const clearlyDominated =
      cmp !== null &&
      cmp.pairedCells >= 3 &&
      cmp.diffStandardError > 0 &&
      cmp.z >= 4;
    if (clearlyDominated) {
      const s = scored.get(e.candidateId)!;
      s.score = Math.min(s.score, 0.25);
      if (s.reasons.length === 0) {
        s.reasons.push({
          reason: "control-refresh-dominated",
          why: `clearly dominated (z=${cmp.z.toFixed(1)}); periodic control only`,
        });
      }
    }
  }

  // Emit decisions ordered by information value; best always keeps a baseline share.
  const ranked = [...scored.values()].sort((a, b) => b.score - a.score);
  for (const item of ranked) {
    const isBest = item.id === best.candidateId;
    const baselineReps = isBest ? input.repsPerBlock : Math.ceil(input.repsPerBlock * 0.5);
    const bonus = item.score > 0 ? input.repsPerBlock : 0;
    const reps = isBest ? baselineReps : baselineReps + bonus * (item.score / 3);
    const finalReps = Math.max(
      isBest ? input.repsPerBlock : 0,
      Math.round(reps + reExposureBonus * input.repsPerBlock * (isBest ? 1 : 0.5)),
    );
    if (finalReps <= 0) continue;
    const top = item.reasons[0];
    push(
      item.id,
      finalReps,
      top?.reason ?? (isBest ? "near-tied-contender" : "control-refresh-dominated"),
      item.score,
      item.reasons.map((r) => r.why).join("; ") || (isBest ? "baseline contender share" : "periodic control"),
    );
    if (budgetRemaining <= 0) break;
  }

  return decisions.filter((d) => d.reps > 0 || d.reason === "budget-exhausted");
}

function ladderNeighbors(
  evals: readonly CandidateEvaluation[],
  centerId: string,
): string[] {
  const center = evals.find((e) => e.candidateId === centerId);
  if (!center) return [];
  const others = evals.filter((e) => e.candidateId !== centerId);
  const below = others
    .filter((e) => e.log2RatioVsBaseline < center.log2RatioVsBaseline)
    .sort((a, b) => b.log2RatioVsBaseline - a.log2RatioVsBaseline)[0];
  const above = others
    .filter((e) => e.log2RatioVsBaseline > center.log2RatioVsBaseline)
    .sort((a, b) => a.log2RatioVsBaseline - b.log2RatioVsBaseline)[0];
  return [below?.candidateId, above?.candidateId].filter((v): v is string => v !== undefined);
}
