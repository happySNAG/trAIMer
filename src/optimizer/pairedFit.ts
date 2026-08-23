import type { ExperimentDefinition } from "../domain/experiment.ts";
import type { TrialRecord } from "../domain/trial.ts";
import type { ExclusionPolicy } from "./evaluate.ts";
import {
  computeCellUtilities,
  type PairedComparison,
} from "./paired.ts";
import type { DimensionScoringConfig } from "./scoring.ts";
import { DEFAULT_DIMENSION_SCORING } from "./scoring.ts";

/**
 * Fully paired repeated-measures fit (Pass 4, requirement G).
 *
 * Model (docs/STATISTICS.md):
 *
 *   u_ire = μ_i + s_c + b_(c,r) + ε_ire
 *
 * - μ_i   candidate effect (what we rank),
 * - s_c   scenario difficulty,
 * - b_cr  shared-instance effect per cell (scenario c, rep index r),
 *         IDENTICAL across candidates by construction of the paired planner,
 * - ε     within-cell noise.
 *
 * Estimator: every candidate PAIR contributes its paired difference over
 * shared cells, d̂_ij with estimated variance v_ij. Because instances are
 * shared, s_c and b_cr cancel EXACTLY inside each difference. The candidate
 * effects α_i = μ_i − μ_ref are then recovered by weighted least squares on
 * the contrast equations
 *
 *   minimize Σ_{i<j} ( (α_i − α_j) − d̂_ij )² / v_ij    subject to α_ref = 0,
 *
 * which is the classic paired/fixed-effects regression expressed purely in
 * differences — no additive centering anywhere. Weights are heteroskedastic
 * (1/variance of each pair difference). The same system yields SEs through
 * the covariance (AᵀWA)⁻¹.
 *
 * Sparse-data fallback: when fewer than three candidates have connectable
 * paired evidence, the caller must fall back to the Pass-2 pooled path.
 */

export interface PairedEffectEstimate {
  candidateId: string;
  /** Effect vs the reference candidate (reference has effect 0). */
  effect: number;
  standardError: number;
}

export interface PairedFitDiagnostics {
  referenceCandidateId: string;
  pairsUsed: { a: string; b: string; diffMean: number; variance: number }[];
  pairsRejectedSparse: number;
  /** Within-cell noise scale: median of per-pair difference variances. */
  medianPairVariance: number | null;
  converged: boolean;
}

export interface PairedEffectsResult {
  estimates: PairedEffectEstimate[];
  diagnostics: PairedFitDiagnostics;
  /** Additive scenario difficulty effects (for explanation only). */
  scenarioEffects: { scenarioId: string; effect: number }[];
}

const MAX_PROJECTION_ITERATIONS = 200;
const PROJECTION_TOLERANCE = 1e-12;

/**
 * Solves the weighted contrast system by Gauss–Seidel / coordinate descent on
 * the objective above. Deterministic, dependency-light, and numerically stable
 * for the handful of candidates involved (≤ ~12).
 */
export function fitPairedCandidateEffects(
  definition: ExperimentDefinition,
  trialsByCandidate: ReadonlyMap<string, readonly TrialRecord[]>,
  policy: ExclusionPolicy,
  comparisons: ReadonlyMap<string, PairedComparison>,
  scoring: DimensionScoringConfig = DEFAULT_DIMENSION_SCORING,
  /** Deterministic injection seam for replay/synthetic analysis. */
  utilityOverride?: (trial: TrialRecord) => number | null,
): PairedEffectsResult | null {
  const candidateIds = [...trialsByCandidate.keys()]
    .filter((id) => id !== "_unassigned")
    .sort();
  if (candidateIds.length < 3) return null;

  // Collect usable pair contrasts (>= 3 shared cells, positive variance).
  interface Edge {
    i: number;
    j: number;
    diffMean: number;
    variance: number;
  }
  const index = new Map<string, number>();
  candidateIds.forEach((id, idx) => index.set(id, idx));
  const edges: Edge[] = [];
  let rejectedSparse = 0;
  for (const cmp of comparisons.values()) {
    const i = index.get(cmp.aCandidateId);
    const j = index.get(cmp.bCandidateId);
    if (i === undefined || j === undefined) continue;
    if (cmp.pairedCells < 3 || !(cmp.diffStandardError > 0)) {
      rejectedSparse++;
      continue;
    }
    edges.push({
      i,
      j,
      diffMean: cmp.diffMean,
      variance: cmp.diffStandardError ** 2,
    });
  }

  // Every candidate needs at least one edge or the system cannot place it.
  const connected = new Set<number>();
  for (const e of edges) {
    connected.add(e.i);
    connected.add(e.j);
  }
  if (connected.size < 3 || connected.size < candidateIds.length) return null;

  const n = candidateIds.length;

  // Weighted Laplacian-style system: for each node i,
  //   Σ_{edges e touching i} w_e (α_i − α_j_e) = Σ_{edges e touching i} s_e w_e
  // where s_e = ±diffMean depending on orientation. Fix node 0 at 0.
  const adjacency: { other: number; sign: number; weight: number; rhs: number }[][] =
    Array.from({ length: n }, () => []);
  for (const e of edges) {
    const w = 1 / Math.max(e.variance, 1e-12);
    // α_i − α_j = diffMean  ⇒ for node i: term (+w, rhs +w·diffMean);
    //                        for node j: term (+w, rhs −w·diffMean).
    adjacency[e.i]!.push({ other: e.j, sign: 1, weight: w, rhs: w * e.diffMean });
    adjacency[e.j]!.push({ other: e.i, sign: 1, weight: w, rhs: -w * e.diffMean });
  }

  const alpha = new Array<number>(n).fill(0);
  let converged = false;
  for (let iter = 0; iter < MAX_PROJECTION_ITERATIONS; iter++) {
    let maxDelta = 0;
    for (let i = 1; i < n; i++) {
      // Contrast equations: α_i − α_j = d_ij  ⇒  α_i = d_ij + α_j.
      // Coordinate update: α_i = Σ_e w_e (d_e + α_other) / Σ_e w_e.
      let wsum = 0;
      let acc = 0;
      for (const link of adjacency[i]!) {
        wsum += link.weight;
        acc += link.rhs + link.weight * alpha[link.other]!;
      }
      if (!(wsum > 0)) continue;
      const next = acc / wsum;
      maxDelta = Math.max(maxDelta, Math.abs(next - alpha[i]!));
      alpha[i] = next;
    }
    if (maxDelta < PROJECTION_TOLERANCE) {
      converged = true;
      break;
    }
  }
  void converged;

  // Covariance: for this Gaussian Markov model, Var(α̂) = (AᵀWA)⁻¹ restricted
  // to free nodes with α_ref pinned. Approximated by one Jacobi sweep of the
  // diagonal inverse: var_i ≈ 1 / (Σ_e∈adj(i) w_e). This is exact for tree
  // graphs and slightly optimistic for dense cycles; documented in
  // docs/STATISTICS.md. A safety inflation factor accounts for cycle overlap.
  const degreeWeight = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (const link of adjacency[i]!) degreeWeight[i]! += link.weight;
  }
  const cycleFactor = Math.max(1, edges.length / Math.max(n - 1, 1));
  const estimates: PairedEffectEstimate[] = candidateIds.map((id, i) => ({
    candidateId: id,
    effect: alpha[i]!,
    standardError:
      i === 0 || !(degreeWeight[i]! > 0)
        ? Number.POSITIVE_INFINITY
        : Math.sqrt(cycleFactor / degreeWeight[i]!),
  }));

  const medianPairVariance =
    edges.length > 0
      ? [...edges.map((e) => e.variance)].sort((a, b) => a - b)[
          Math.floor(edges.length / 2)
        ] ?? null
      : null;

  // Scenario difficulty effects: additive decomposition for explanations only.
  // s_c = mean_i ( ū_ic − α̂_i ) − grand mean, computed from cell utilities so
  // it can never re-enter the ranking (the effects above are already
  // instance/scenario-free by construction).
  const cellUtilities = computeCellUtilities(
    definition,
    trialsByCandidate,
    policy,
    scoring,
    utilityOverride,
  );
  const perScenarioAcc = new Map<string, { sum: number; count: number }>();
  let grandSum = 0;
  let grandCount = 0;
  for (const [candidateId, cells] of cellUtilities) {
    const est = estimates.find((e) => e.candidateId === candidateId);
    if (!est || !Number.isFinite(est.effect)) continue;
    for (const [cellKey, utility] of cells) {
      const scenarioId = cellKey.slice(0, cellKey.lastIndexOf("#"));
      const residual = utility - est.effect;
      const acc = perScenarioAcc.get(scenarioId) ?? { sum: 0, count: 0 };
      acc.sum += residual;
      acc.count += 1;
      perScenarioAcc.set(scenarioId, acc);
      grandSum += residual;
      grandCount += 1;
    }
  }
  const grandMean = grandCount > 0 ? grandSum / grandCount : 0;
  const scenarioEffects = [...perScenarioAcc.entries()].map(([scenarioId, acc]) => ({
    scenarioId,
    effect: acc.sum / acc.count - grandMean,
  }));

  return {
    estimates,
    diagnostics: {
      referenceCandidateId: candidateIds[0]!,
      pairsUsed: edges.map((e) => ({
        a: candidateIds[e.i]!,
        b: candidateIds[e.j]!,
        diffMean: e.diffMean,
        variance: e.variance,
      })),
      pairsRejectedSparse: rejectedSparse,
      medianPairVariance,
      converged,
    },
    scenarioEffects,
  };
}
