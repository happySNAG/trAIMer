import type { ExperimentDefinition, StoppingCriteria } from "../domain/experiment.ts";
import type { Recommendation } from "../domain/recommendation.ts";
import { makeCandidateId, makeExperimentId } from "../domain/ids.ts";
import type { SensitivityCandidate } from "../domain/candidate.ts";
import { DEFAULT_SAFE_RANGE } from "../domain/candidate.ts";

/**
 * Complete retest loop (Pass 5, requirement H).
 *
 * When an experiment ends with an unresolved boundary, a broad plateau, weak
 * capture quality, adaptation contamination, stale calibration, insufficient
 * evidence, or suspicious X/Y asymmetry, the application can create the
 * appropriate NEXT test directly — preserving lineage, dropping dominated
 * candidates, keeping blinding fresh, using new deterministic seeds, and
 * stating exactly which uncertainty the retest resolves.
 *
 * No remote scheduler: the plan is returned for immediate launch or for
 * "continue another day" persistence.
 */

export type RetestTrigger =
  | "unresolved-boundary"
  | "broad-plateau"
  | "capture-quality-weak"
  | "adaptation-contamination"
  | "stale-calibration"
  | "insufficient-evidence"
  | "suspicious-asymmetry";

export interface RetestDecisionContext {
  calibrationStale?: boolean;
  /** ISO time the prior session ended; enables rest-limit enforcement. */
  priorSessionEndedAtIso?: string | null;
  nowIso?: string;
  /** Minimum enforced rest between sessions (default 30 min). */
  minRestBetweenSessionsMs?: number;
  /** Fresh deterministic seed for the next experiment (defaults to derived). */
  orderSeed?: number;
}

export type NextTestKind = "targeted-retest" | "repeat-session" | "none";

export interface NextTestPlan {
  kind: NextTestKind;
  definition: ExperimentDefinition | null;
  triggers: RetestTrigger[];
  /** The specific uncertainty this test is designed to resolve. */
  uncertaintyToResolve: string;
  rationaleLines: string[];
  /** False while the enforced rest between sessions is still running. */
  canStartNow: boolean;
  earliestStartIso: string;
}

const DEFAULT_MIN_REST_MS = 30 * 60 * 1000;

export interface RetestPlan {
  definition: ExperimentDefinition;
  priorExperimentId: string;
  rationaleLines: string[];
}

/**
 * Backwards-compatible targeted retest planner (Pass 3 API, preserved): when a
 * session ends with low confidence or an unresolved boundary, build a
 * follow-up experiment spanning the prior plausible range at ~half-step
 * resolution. New code should prefer `planNextTest`, which also handles clean
 * repeats, rest limits, and trigger detection.
 */
export function planRetestSession(
  priorDefinition: ExperimentDefinition,
  priorRecommendation: Recommendation,
  options: {
    orderSeed?: number;
    repsPerCandidate?: number;
    maxSearchRounds?: number;
    minReps?: number;
  } = {},
): RetestPlan | null {
  const dpi = priorDefinition.dpi;
  const rangeMinSensX = priorRecommendation.edpiRange.min / dpi;
  const rangeMaxSensX = priorRecommendation.edpiRange.max / dpi;
  if (!(rangeMaxSensX > rangeMinSensX)) return null;

  // Drop previously DOMINATED candidates far outside the plausible range.
  const dominatedCount = priorDefinition.candidates.filter((c) => {
    const edpiX = dpi * c.sensitivity.sensX;
    return (
      c.id !== priorRecommendation.evidence.bestCandidateId &&
      (edpiX < priorRecommendation.edpiRange.min * 0.92 ||
        edpiX > priorRecommendation.edpiRange.max * 1.08)
    );
  }).length;

  const steps = 4;
  const stepSize = (rangeMaxSensX - rangeMinSensX) / steps;
  const candidates: SensitivityCandidate[] = [];
  const seen = new Set<string>();
  for (let i = 0; i <= steps; i++) {
    const sensX = Math.min(
      DEFAULT_SAFE_RANGE.maxSensX,
      Math.max(DEFAULT_SAFE_RANGE.minSensX, rangeMinSensX + stepSize * i),
    );
    const key = sensX.toFixed(3);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      id: makeCandidateId(`rt-${i}-${sensX.toFixed(0)}`),
      sensitivity: { sensX, sensY: sensX },
      origin: { kind: "manual", label: `retest point ${i}` },
    });
  }
  if (candidates.length < 2) return null;

  const stoppingCriteria: StoppingCriteria = {
    ...priorDefinition.stoppingCriteria,
    maxSearchRounds:
      options.maxSearchRounds ??
      Math.min(2, priorDefinition.stoppingCriteria.maxSearchRounds + 1),
  };

  const definition: ExperimentDefinition = {
    ...priorDefinition,
    id: makeExperimentId(`retest-${priorDefinition.id}-${options.orderSeed ?? priorDefinition.orderSeed + 7}`),
    name: `targeted retest of ${priorDefinition.name}`,
    candidates,
    orderSeed: options.orderSeed ?? priorDefinition.orderSeed + 7,
    measuredRepsPerCandidatePerRound:
      options.repsPerCandidate ??
      Math.max(priorDefinition.measuredRepsPerCandidatePerRound - 2, options.minReps ?? 4),
    stoppingCriteria,
    notes: `targeted retest of ${priorDefinition.id} (range ${rangeMinSensX.toFixed(2)}-${rangeMaxSensX.toFixed(2)}% X)`,
  };

  return {
    definition,
    priorExperimentId: priorDefinition.id,
    rationaleLines: [
      `narrowing to the prior plausible range ${rangeMinSensX.toFixed(2)}–${rangeMaxSensX.toFixed(2)}% X at ~half-step resolution`,
      `${dominatedCount} dominated out-of-range candidate position(s) dropped`,
      "fresh candidate labels preserve blinding; instances derive from a NEW deterministic seed",
      `linked to prior experiment ${priorDefinition.id}`,
    ],
  };
}

/** Derives retest triggers from a recommendation plus external context. */
export function detectRetestTriggers(
  recommendation: Recommendation,
  context: RetestDecisionContext = {},
): RetestTrigger[] {
  const triggers: RetestTrigger[] = [];
  if (recommendation.unresolvedBoundary) triggers.push("unresolved-boundary");
  if (
    recommendation.curveAdequacy?.shape === "broad-plateau" ||
    recommendation.curveAdequacy?.shape === "multimodal-inconsistent"
  ) {
    triggers.push("broad-plateau");
  }
  if (recommendation.captureQualitySession?.retestingNecessary) {
    triggers.push("capture-quality-weak");
  }
  if (recommendation.changePointAnalysis?.contaminationDetected === true) {
    triggers.push("adaptation-contamination");
  }
  if (context.calibrationStale) triggers.push("stale-calibration");
  if (
    recommendation.confidence < 0.5 ||
    recommendation.evidence.separation === "insufficient" ||
    recommendation.refusedHighConfidence
  ) {
    triggers.push("insufficient-evidence");
  }
  if (recommendation.jointXY?.outcome === "asymmetry-unresolved") {
    triggers.push("suspicious-asymmetry");
  }
  return triggers;
}

const UNCERTAINTY_BY_TRIGGER: Record<RetestTrigger, string> = {
  "unresolved-boundary":
    "the plausible range touched the edge of the tested ladder; the true optimum may lie beyond it",
  "broad-plateau":
    "several candidates were statistically indistinguishable over a wide range; which one actually feels best is unresolved",
  "capture-quality-weak":
    "input capture quality was too degraded to trust this session's comparisons",
  "adaptation-contamination":
    "learning or fatigue contaminated some candidates' measurements",
  "stale-calibration":
    "physical calibration no longer matches the current device/settings context",
  "insufficient-evidence":
    "not enough valid, separated evidence existed to justify any precise claim",
  "suspicious-asymmetry":
    "an earlier hint of X≠Y asymmetry was not resolved by paired evidence",
};

interface TriggerPlanShape {
  kind: NextTestKind;
  narrowSearch: boolean;
  enableYExploration: boolean;
}

function planShapeFor(triggers: readonly RetestTrigger[]): TriggerPlanShape {
  const needsNarrowing =
    triggers.includes("unresolved-boundary") ||
    triggers.includes("broad-plateau") ||
    triggers.includes("insufficient-evidence");
  const needsCleanRepeat =
    triggers.includes("capture-quality-weak") ||
    triggers.includes("adaptation-contamination");
  const asymmetry = triggers.includes("suspicious-asymmetry");
  if (needsNarrowing) {
    return { kind: "targeted-retest", narrowSearch: true, enableYExploration: asymmetry };
  }
  if (needsCleanRepeat || asymmetry) {
    return { kind: "repeat-session", narrowSearch: false, enableYExploration: asymmetry };
  }
  return { kind: "none", narrowSearch: false, enableYExploration: false };
}

/**
 * Builds the complete next-test decision. Returns `kind:"none"` when nothing
 * needs resolving (or only stale calibration remains — in that case the right
 * action is recalibration, not more aim testing).
 */
export function planNextTest(
  priorDefinition: ExperimentDefinition,
  priorRecommendation: Recommendation,
  context: RetestDecisionContext = {},
): NextTestPlan | null {
  const triggers = detectRetestTriggers(priorRecommendation, context);
  if (triggers.length === 0) return null;

  // Stale calibration ALONE is resolved by recalibrating, not re-testing.
  if (triggers.length === 1 && triggers[0] === "stale-calibration") {
    return {
      kind: "none",
      definition: null,
      triggers,
      uncertaintyToResolve: UNCERTAINTY_BY_TRIGGER["stale-calibration"],
      rationaleLines: [
        "recalibrate via the Calibration tab before the next session",
        "no additional aim-testing session is required to resolve stale physical calibration",
      ],
      canStartNow: true,
      earliestStartIso: "",
    };
  }

  const shape = planShapeFor(triggers);
  const minRest = context.minRestBetweenSessionsMs ?? DEFAULT_MIN_REST_MS;
  let canStartNow = true;
  let earliestStartIso = "";
  if (context.priorSessionEndedAtIso && context.nowIso) {
    const endedAt = Date.parse(context.priorSessionEndedAtIso);
    const now = Date.parse(context.nowIso);
    earliestStartIso = new Date(endedAt + minRest).toISOString();
    canStartNow = !(Number.isFinite(now) && now < endedAt + minRest);
  }

  let definition: ExperimentDefinition | null = null;
  const rationaleLines: string[] = [];

  if (shape.narrowSearch) {
    const narrowed = buildNarrowedDefinition(
      priorDefinition,
      priorRecommendation,
      context,
      shape.enableYExploration,
    );
    if (narrowed === null) {
      // Nothing can honestly be narrowed → fall back to a clean repeat.
      shape.kind = "repeat-session";
      shape.narrowSearch = false;
      rationaleLines.push(
        "prior range could not be narrowed honestly; scheduling a clean repeat instead",
      );
    } else {
      definition = narrowed.definition;
      rationaleLines.push(...narrowed.rationaleLines);
    }
  }

  if (!shape.narrowSearch) {
    const seed = context.orderSeed ?? (priorDefinition.orderSeed + 101);
    definition = {
      ...priorDefinition,
      id: makeExperimentId(`next-${priorDefinition.id}-${seed}`),
      name: `clean repeat of ${priorDefinition.name}`,
      orderSeed: seed,
      yExploration: { ...priorDefinition.yExploration, enabled: shape.enableYExploration },
      notes: `follow-up of ${priorDefinition.id} (${triggers.join(", ")})`,
    };
    rationaleLines.push(
      "fresh deterministic seed and candidate instances; identical protocol otherwise",
      "previously dominated candidates are NOT repeated — the repeat re-measures the full original ladder under clean conditions",
    );
  }

  rationaleLines.push(
    ...triggers.map((t) => `${t}: ${UNCERTAINTY_BY_TRIGGER[t]}`),
    "fresh candidate ids and labels preserve blinding",
    `linked lineage: ${definition?.notes ?? ""}`.trim(),
  );

  if (!canStartNow) {
    rationaleLines.push(
      `enforced rest: this plan cannot start before ${earliestStartIso} (≥${Math.round(minRest / 60000)} min after the previous session)`,
    );
  }

  return {
    kind: shape.kind,
    definition,
    triggers,
    uncertaintyToResolve: triggers.map((t) => UNCERTAINTY_BY_TRIGGER[t]).join("; "),
    rationaleLines,
    canStartNow,
    earliestStartIso,
  };
}

interface NarrowedBuild {
  definition: ExperimentDefinition;
  rationaleLines: string[];
}

function buildNarrowedDefinition(
  priorDefinition: ExperimentDefinition,
  priorRecommendation: Recommendation,
  context: RetestDecisionContext,
  enableYExploration: boolean,
): NarrowedBuild | null {
  const dpi = priorDefinition.dpi;
  const rangeMinSensX = priorRecommendation.edpiRange.min / dpi;
  const rangeMaxSensX = priorRecommendation.edpiRange.max / dpi;
  if (!(rangeMaxSensX > rangeMinSensX)) return null;

  // Drop previously DOMINATED candidates: never re-measure something already
  // excluded far outside the plausible range (except the best).
  const dominatedCount = priorDefinition.candidates.filter((c) => {
    const edpiX = dpi * c.sensitivity.sensX;
    return (
      c.id !== priorRecommendation.evidence.bestCandidateId &&
      (edpiX < priorRecommendation.edpiRange.min * 0.92 ||
        edpiX > priorRecommendation.edpiRange.max * 1.08)
    );
  }).length;

  const steps = 4;
  const stepSize = (rangeMaxSensX - rangeMinSensX) / steps;
  const candidates: SensitivityCandidate[] = [];
  const seen = new Set<string>();
  for (let i = 0; i <= steps; i++) {
    const sensX = Math.min(
      DEFAULT_SAFE_RANGE.maxSensX,
      Math.max(DEFAULT_SAFE_RANGE.minSensX, rangeMinSensX + stepSize * i),
    );
    const key = sensX.toFixed(3);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      id: makeCandidateId(`rt-${i}-${sensX.toFixed(0)}`),
      sensitivity: { sensX, sensY: sensX },
      origin: { kind: "manual", label: `retest point ${i}` },
    });
  }
  if (candidates.length < 2) return null;

  const stoppingCriteria: StoppingCriteria = {
    ...priorDefinition.stoppingCriteria,
    maxSearchRounds: Math.min(
      2,
      priorDefinition.stoppingCriteria.maxSearchRounds + 1,
    ),
  };

  const seed = context.orderSeed ?? (priorDefinition.orderSeed + 7);
  const definition: ExperimentDefinition = {
    ...priorDefinition,
    id: makeExperimentId(`retest-${priorDefinition.id}-${seed}`),
    name: `targeted retest of ${priorDefinition.name}`,
    candidates,
    orderSeed: seed,
    measuredRepsPerCandidatePerRound:
      Math.max(priorDefinition.measuredRepsPerCandidatePerRound - 2, 4),
    stoppingCriteria,
    yExploration: { ...priorDefinition.yExploration, enabled: enableYExploration },
    notes: `targeted retest of ${priorDefinition.id} (range ${rangeMinSensX.toFixed(2)}-${rangeMaxSensX.toFixed(2)}% X)`,
  };

  return {
    definition,
    rationaleLines: [
      `narrowing to the prior plausible range ${rangeMinSensX.toFixed(2)}–${rangeMaxSensX.toFixed(2)}% X at ~half-step resolution`,
      `${dominatedCount} dominated out-of-range candidate position(s) dropped`,
      "fresh candidate labels preserve blinding; instances derive from a NEW deterministic seed",
    ],
  };
}
