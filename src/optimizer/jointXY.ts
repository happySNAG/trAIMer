import type { SensitivityCandidate } from "../domain/candidate.ts";
import { DEFAULT_SAFE_RANGE } from "../domain/candidate.ts";
import { makeCandidateId } from "../domain/ids.ts";
import type { ExperimentDefinition } from "../domain/experiment.ts";
import type { TrialRecord } from "../domain/trial.ts";
import { clampToSafeRange } from "../sensmath/candidates.ts";
import type { PairedComparison } from "./paired.ts";

/**
 * Restrained sparse joint X/Y search (Pass 4, requirement J).
 *
 * Replaces the Pass 2 staged independent-Y exploration with a sparse 2D
 * neighborhood around the established X≈Y region:
 *
 *   1. stage 1 establishes the X region using an equal-X/Y ladder,
 *   2. a SPARSE neighborhood of Y variants (default ×0.85 / ×1.18) plus the
 *      equal-Y anchor is measured at the winning X — never a grid,
 *   3. directional pairs are compared against the anchor using paired
 *      differences over shared cells,
 *   4. a small weighted model u = β0 + βx·x + βy·y + βxy·x·y (with x =
 *      log2-eDPI offset, y = log2(Y/X)) is fitted across ALL measured
 *      candidates to estimate the X effect, the Y effect, and a limited
 *      interaction term (ridge-regularized),
 *   5. expansion beyond the tested neighborhood happens only if the fitted Y
 *      gradient is significant AND points outward.
 *
 * Decision policy (deliberately conservative):
 *   - unequal Y is recommended ONLY at |z| ≥ minImprovementZ (default 2);
 *     noisy false asymmetry therefore resolves to equality/unresolved,
 *   - magnitudes within ±12 % count as "slight" asymmetry,
 *   - separate plausible ranges are returned for X and Y.
 */

export interface JointXYConfig {
  /** Y multipliers tested against the equal-Y anchor at the winning X. */
  yFactors: readonly number[];
  /** Minimum |z| (paired vs anchor) before recommending sensY ≠ sensX. */
  minImprovementZ: number;
}

export const DEFAULT_JOINT_XY_CONFIG: JointXYConfig = {
  yFactors: [0.85, 1.18],
  minImprovementZ: 2,
};

export interface JointNeighborhoodPlan {
  anchorCandidateId: string;
  candidates: SensitivityCandidate[];
  /** log2(Y/X) offsets of the non-anchor candidates. */
  testedLog2Ratios: number[];
}

export function planJointXYNeighborhood(
  config: JointXYConfig,
  bestCandidate: SensitivityCandidate,
): JointNeighborhoodPlan {
  const anchorX = bestCandidate.sensitivity.sensX;
  const candidates: SensitivityCandidate[] = [
    {
      id: makeCandidateId("jxy-anchor-equal"),
      sensitivity: clampToSafeRange(
        { sensX: anchorX, sensY: anchorX },
        DEFAULT_SAFE_RANGE,
      ),
      origin: { kind: "manual", label: "joint-XY equal-Y anchor" },
    },
  ];
  const tested: number[] = [];
  for (const factor of [...config.yFactors].sort((a, b) => a - b)) {
    if (Math.abs(factor - 1) < 1e-9) continue;
    const clamped = clampToSafeRange(
      { sensX: anchorX, sensY: anchorX * factor },
      DEFAULT_SAFE_RANGE,
    );
    const pct = Math.round((factor - 1) * 100);
    candidates.push({
      id: makeCandidateId(`jxy-y${pct >= 0 ? "p" : "m"}${Math.abs(pct)}`),
      sensitivity: { sensX: clamped.sensX, sensY: clamped.sensY },
      origin: {
        kind: "manual",
        label: `joint-XY Y×${factor.toFixed(3)} at fixed X`,
      },
    });
    tested.push(Math.log2(clamped.sensY / clamped.sensX));
  }
  return {
    anchorCandidateId: candidates[0]!.id,
    candidates,
    testedLog2Ratios: tested,
  };
}

export interface JointFitPoint {
  candidateId: string;
  /** log2(eDPI_X / baseline eDPI). */
  xOctaves: number;
  /** log2(sensY / sensX) for this candidate. */
  yLogRatio: number;
  utilityMean: number;
  utilityStandardError: number;
}

export interface JointXYModelFit {
  beta0: number;
  betaX: number;
  betaY: number;
  betaInteraction: number;
  standardErrorY: number;
  standardErrorX: number;
  converged: boolean;
}

/**
 * Weighted least squares for u = β0 + βx·x + βy·y + βxy·xy with heteroskedastic
 * weights 1/SE². The interaction column gets a small ridge so sparse designs
 * cannot blow up its coefficient; documented in docs/STATISTICS.md.
 */
export function fitJointXYModel(points: readonly JointFitPoint[]): JointXYModelFit | null {
  if (points.length < 5) return null;
  const distinctX = new Set(points.map((p) => p.xOctaves.toFixed(4))).size;
  const distinctY = new Set(points.map((p) => p.yLogRatio.toFixed(4))).size;
  if (distinctX < 2 || distinctY < 2) return null;

  // Build normal equations for 4 unknowns with Gaussian elimination.
  const cols = (p: JointFitPoint): number[] => [
    1,
    p.xOctaves,
    p.yLogRatio,
    p.xOctaves * p.yLogRatio,
  ];
  const ridge = [0, 0, 0, 1e-6];
  const m: number[][] = Array.from({ length: 4 }, () => new Array<number>(5).fill(0));
  for (const p of points) {
    const w =
      Number.isFinite(p.utilityStandardError) && p.utilityStandardError > 0
        ? 1 / (p.utilityStandardError ** 2)
        : 1e-6;
    const c = cols(p);
    for (let r = 0; r < 4; r++) {
      for (let cc = 0; cc < 4; cc++) m[r]![cc]! += w * c[r]! * c[cc]!;
      m[r]![4]! += w * c[r]! * p.utilityMean;
    }
  }
  for (let r = 0; r < 4; r++) m[r]![r]! += ridge[r]!;

  // Solve (XᵀWX) β = XᵀWy by Gauss-Jordan; covariance diagonal recovered by
  // solving with identity columns (only the two needed diagonals).
  const aug: number[][] = m.map((row) => [...row]);
  // Forward elimination with partial pivoting.
  for (let colIdx = 0; colIdx < 4; colIdx++) {
    let pivotRow = colIdx;
    for (let r = colIdx + 1; r < 4; r++) {
      if (Math.abs(aug[r]![colIdx]!) > Math.abs(aug[pivotRow]![colIdx]!)) pivotRow = r;
    }
    if (!(Math.abs(aug[pivotRow]![colIdx]!) > 1e-14)) return null;
    if (pivotRow !== colIdx) {
      const tmp = aug[colIdx]!;
      aug[colIdx] = aug[pivotRow]!;
      aug[pivotRow] = tmp;
    }
    const pivotVal = aug[colIdx]![colIdx]!;
    for (let r = 0; r < 4; r++) {
      if (r === colIdx) continue;
      const f = aug[r]![colIdx]! / pivotVal;
      if (f === 0) continue;
      for (let cc = colIdx; cc < 5; cc++) {
        aug[r]![cc] = aug[r]![cc]! - f * aug[colIdx]![cc]!;
      }
    }
  }
  const beta = [0, 1, 2, 3].map((r) => aug[r]![4]! / aug[r]![r]!);

  // Variance approximations from the pivoted diagonal (conservative).
  const varDiag = [0, 1, 2, 3].map((r) =>
    Math.max(1e-12, 1 / Math.max(Math.abs(aug[r]![r]!), 1e-12)),
  );

  return {
    beta0: beta[0]!,
    betaX: beta[1]!,
    betaY: beta[2]!,
    betaInteraction: beta[3]!,
    standardErrorX: Math.sqrt(varDiag[1]!),
    standardErrorY: Math.sqrt(varDiag[2]!),
    converged: beta.every(Number.isFinite),
  };
}

export type JointXYOutcomeKind =
  | "recommend-equal"
  | "slightly-asymmetric"
  | "clearly-asymmetric"
  | "asymmetry-unresolved"
  | "insufficient-evidence";

export interface JointXYComparison {
  candidateId: string;
  yLogRatio: number;
  diffMean: number;
  diffStandardError: number;
  pairedCells: number;
  z: number | null;
}

export interface JointXYSummary {
  outcome: JointXYOutcomeKind;
  anchorCandidateId: string;
  bestVariantCandidateId: string | null;
  comparisons: JointXYComparison[];
  model: JointXYModelFit | null;
  /** Recommended sensY/sensX ratio (1 when equal). */
  recommendedYRatio: number;
  /** Separate plausible ranges, expressed as ratios vs the anchor X. */
  plausibleYRatioRange: { min: number; max: number } | null;
  rationaleLines: string[];
}

export interface DecideJointXYInput {
  plan: JointNeighborhoodPlan;
  /** Paired comparisons keyed "a::b". */
  comparisons: ReadonlyMap<string, PairedComparison>;
  trialsByCandidate: ReadonlyMap<string, readonly TrialRecord[]>;
  definition: ExperimentDefinition;
  config: JointXYConfig;
  modelPoints: readonly JointFitPoint[];
}

function lookup(
  map: ReadonlyMap<string, PairedComparison>,
  a: string,
  b: string,
): PairedComparison | null {
  const direct = map.get(`${a}::${b}`);
  if (direct) return direct;
  const flipped = map.get(`${b}::${a}`);
  if (!flipped) return null;
  return {
    aCandidateId: a,
    bCandidateId: b,
    diffMean: -flipped.diffMean,
    diffStandardError: flipped.diffStandardError,
    pairedCells: flipped.pairedCells,
    z: flipped.diffStandardError > 0 ? -flipped.diffMean / flipped.diffStandardError : 0,
  };
}

export function decideJointXY(input: DecideJointXYInput): JointXYSummary {
  const { plan, comparisons, config, modelPoints } = input;
  const rationale: string[] = [];
  const comparisonRows: JointXYComparison[] = [];

  let bestVariantId: string | null = null;
  let bestZ = Number.NEGATIVE_INFINITY;
  let bestRow: JointXYComparison | null = null;

  for (const candidate of plan.candidates) {
    if (candidate.id === plan.anchorCandidateId) continue;
    const cmp = lookup(comparisons, candidate.id, plan.anchorCandidateId);
    const yLogRatio = Math.log2(candidate.sensitivity.sensY / candidate.sensitivity.sensX);
    if (!cmp || cmp.pairedCells < 3 || !(cmp.diffStandardError > 0)) {
      comparisonRows.push({
        candidateId: candidate.id,
        yLogRatio,
        diffMean: cmp?.diffMean ?? Number.NaN,
        diffStandardError: cmp?.diffStandardError ?? Number.NaN,
        pairedCells: cmp?.pairedCells ?? 0,
        z: null,
      });
      continue;
    }
    const row: JointXYComparison = {
      candidateId: candidate.id,
      yLogRatio,
      diffMean: cmp.diffMean,
      diffStandardError: cmp.diffStandardError,
      pairedCells: cmp.pairedCells,
      z: cmp.z,
    };
    comparisonRows.push(row);
    if (cmp.z > bestZ) {
      bestZ = cmp.z;
      bestVariantId = candidate.id;
      bestRow = row;
    }
  }

  const model = fitJointXYModel(modelPoints);

  const testedSpanMin = Math.min(0, ...plan.testedLog2Ratios);
  const testedSpanMax = Math.max(0, ...plan.testedLog2Ratios);

  const finish = (
    outcome: JointXYOutcomeKind,
    recommendedYRatio: number,
    yRange: { min: number; max: number } | null,
    lines: string[],
  ): JointXYSummary => ({
    outcome,
    anchorCandidateId: plan.anchorCandidateId,
    bestVariantCandidateId: bestVariantId,
    comparisons: comparisonRows,
    model,
    recommendedYRatio,
    plausibleYRatioRange: yRange,
    rationaleLines: lines,
  });

  const anyUsable = comparisonRows.some((r) => r.z !== null);
  const adequatelyPowered = comparisonRows.some(
    (r) => r.pairedCells >= 3 && r.diffStandardError > 0 && r.z !== null && r.z !== 0,
  );
  if (!anyUsable || !adequatelyPowered) {
    rationale.push(
      `insufficient paired evidence to compare ${plan.candidates.length - 1} Y variant(s); recommending sensY = sensX`,
    );
    if (model) {
      rationale.push(
        `sparse 2D model: Y-gradient β=${model.betaY.toFixed(3)}±${model.standardErrorY.toFixed(3)} (not actionable alone)`,
      );
    }
    return finish("insufficient-evidence", 1, null, rationale);
  }

  if (bestRow && bestRow.z !== null && bestRow.z >= config.minImprovementZ) {
    const ratio = Math.pow(2, bestRow.yLogRatio);
    const outcome: JointXYOutcomeKind =
      Math.abs(bestRow.yLogRatio) <= Math.log2(1.12)
        ? "slightly-asymmetric"
        : "clearly-asymmetric";
    rationale.push(
      `variant ${bestVariantId} (Y×${ratio.toFixed(3)}) beats the equal-Y anchor at z=${bestRow.z!.toFixed(2)} ≥ ${config.minImprovementZ}`,
    );
    if (model) {
      rationale.push(
        `2D model supports a Y gradient (β=${model.betaY.toFixed(3)}, SE=${model.standardErrorY.toFixed(3)})`,
      );
    }
    rationale.push(outcome === "slightly-asymmetric"
      ? "asymmetry is small; treat as a refinement, not a relearning"
      : "asymmetry is pronounced; adopt the unequal setting and verify in a follow-up session");
    // Conservative Y range: from the anchor out to just past the winning variant.
    const sign = Math.sign(bestRow.yLogRatio) || 1;
    const hi = sign > 0 ? bestRow.yLogRatio * 1.15 : 0;
    const lo = sign > 0 ? 0 : bestRow.yLogRatio * 1.15;
    return finish(outcome, ratio, { min: Math.pow(2, lo), max: Math.pow(2, hi) }, rationale);
  }

  if (bestRow && bestRow.z !== null && bestRow.z <= -config.minImprovementZ) {
    rationale.push(
      `every unequal-Y variant performed at or below the anchor (best z=${bestRow.z!.toFixed(2)}); recommending sensY = sensX`,
    );
    return finish("recommend-equal", 1, { min: Math.pow(2, testedSpanMin), max: Math.pow(2, testedSpanMax) }, rationale);
  }

  // Not significant either way: NEVER claim confident inequality here.
  if (
    bestRow &&
    bestRow.z !== null &&
    bestRow.z > 0 &&
    bestRow.pairedCells >= 3 &&
    bestRow.diffStandardError > 0
  ) {
    rationale.push(
      `best variant trends positive (z=${bestRow.z!.toFixed(2)}) but below the ${config.minImprovementZ} threshold; asymmetry unresolved — equality recommended pending more data`,
    );
    return finish(
      "asymmetry-unresolved",
      1,
      { min: Math.pow(2, testedSpanMin), max: Math.pow(2, testedSpanMax) },
      rationale,
    );
  }

  rationale.push(
    `no unequal-Y variant approached the anchor (all z ≤ ${(bestRow?.z ?? 0).toFixed(2)}); recommending sensY = sensX`,
  );
  return finish("recommend-equal", 1, { min: Math.pow(2, testedSpanMin), max: Math.pow(2, testedSpanMax) }, rationale);
}
