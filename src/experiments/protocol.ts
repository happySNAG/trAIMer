import type {
  AdaptiveAllocationConfig,
  ExclusionRules,
  ExperimentDefinition,
  FatigueProtocolConfig,
  ScenarioMixEntry,
  StoppingCriteria,
  YExplorationConfig,
} from "../domain/experiment.ts";
import { CORE_SCENARIOS, type ScenarioDefinition } from "../domain/scenario.ts";
import type { SensitivityCandidate } from "../domain/candidate.ts";
import { DEFAULT_SAFE_RANGE } from "../domain/candidate.ts";
import type { ExperimentId } from "../domain/ids.ts";
import type { SensitivityConfiguration } from "../domain/settings.ts";
import {
  generateCandidateLadder,
  manualCandidate,
} from "../sensmath/candidates.ts";
import { Rng } from "../util/rng.ts";

export const DEFAULT_LADDER_FACTORS: readonly number[] = [
  1 / 1.35,
  1 / 1.15,
  1,
  1.15,
  1.35,
];

export interface ExperimentBuildOptions {
  id: ExperimentId;
  name: string;
  baselineSensitivity: SensitivityConfiguration;
  dpi: number;
  ladderFactors?: readonly number[];
  manualCandidates?: { label: string; sensitivity: SensitivityConfiguration }[];
  safeRangeMinX?: number;
  safeRangeMaxX?: number;
  scenarioIds?: readonly string[];
  warmupTrialsPerCandidateBlock?: number;
  measuredRepsPerCandidatePerRound?: number;
  orderSeed?: number;
  randomizeOrder?: boolean;
  restBetweenCandidatesMs?: number;
  exclusionRules?: Partial<ExclusionRules>;
  stoppingCriteria?: Partial<StoppingCriteria>;
  adaptiveAllocation?: Partial<AdaptiveAllocationConfig>;
  fatigueProtocol?: Partial<FatigueProtocolConfig>;
  yExploration?: Partial<YExplorationConfig>;
  notes?: string;
}

export const DEFAULT_EXCLUSION_RULES: ExclusionRules = {
  fatalReasons: [
    "IMPOSSIBLE_TIMESTAMPS",
    "MISSING_TARGET_APPEARANCE",
    "INSUFFICIENT_SAMPLES",
    "IMPOSSIBLE_MOVEMENT",
    "CONFIG_MISMATCH",
  ],
  suspectPolicy: "exclude",
};

export const DEFAULT_STOPPING_CRITERIA: StoppingCriteria = {
  maxTotalMeasuredTrials: 240,
  minValidTrialsPerCandidate: 4,
  maxSearchRounds: 2,
  targetUtilityCiHalfWidth: null,
};

export const DEFAULT_ADAPTIVE_ALLOCATION: AdaptiveAllocationConfig = {
  enabled: true,
  minRepsBeforeAdaptive: 8,
  contenderZThreshold: 2,
  controlRefreshEveryRounds: 2,
};

export const DEFAULT_FATIGUE_PROTOCOL: FatigueProtocolConfig = {
  maxContinuousTestingMs: 12 * 60 * 1000,
  restDurationMs: 45 * 1000,
  degradationWindowTrials: 6,
  degradationRatioThreshold: 1.25,
};

export const DEFAULT_Y_EXPLORATION: YExplorationConfig = {
  enabled: false,
  yFactors: [0.85, 1, 1.18],
  minImprovementZ: 2,
};

function scenarioCatalogSubset(ids: readonly string[]): ScenarioDefinition[] {
  return ids.map((id) => {
    const found = CORE_SCENARIOS.find((s) => s.id === id);
    if (!found) throw new Error(`Unknown scenario id: ${id}`);
    return found;
  });
}

const DEFAULT_MIX_IDS = [
  "flick-static-medium",
  "flick-static-small",
  "flick-dynamic-horizontal",
  "target-switch-triple",
  "tracking-smooth-sine",
];

export function buildExperimentDefinition(
  options: ExperimentBuildOptions,
): ExperimentDefinition {
  const scenarioIds = options.scenarioIds ?? DEFAULT_MIX_IDS;
  const catalog = scenarioCatalogSubset(scenarioIds);
  const mix: ScenarioMixEntry[] = catalog.map((s) => ({
    scenarioId: s.id,
    weight: 1 / catalog.length,
  }));

  const candidates: SensitivityCandidate[] = generateCandidateLadder({
    baseline: options.baselineSensitivity,
    factors: options.ladderFactors ?? DEFAULT_LADDER_FACTORS,
    safeRange: {
      ...DEFAULT_SAFE_RANGE,
      minSensX: options.safeRangeMinX ?? DEFAULT_SAFE_RANGE.minSensX,
      maxSensX: options.safeRangeMaxX ?? DEFAULT_SAFE_RANGE.maxSensX,
      minSensY: options.safeRangeMinX ?? DEFAULT_SAFE_RANGE.minSensY,
      maxSensY: options.safeRangeMaxX ?? DEFAULT_SAFE_RANGE.maxSensY,
    },
  });
  for (const manual of options.manualCandidates ?? []) {
    candidates.push(manualCandidate(manual.label, manual.sensitivity));
  }

  return {
    id: options.id,
    name: options.name,
    baselineSensitivity: options.baselineSensitivity,
    dpi: options.dpi,
    candidates,
    scenarioMix: mix,
    scenarioCatalog: catalog,
    warmupTrialsPerCandidateBlock: options.warmupTrialsPerCandidateBlock ?? 2,
    measuredRepsPerCandidatePerRound:
      options.measuredRepsPerCandidatePerRound ?? 8,
    randomizeOrder: options.randomizeOrder ?? true,
    orderSeed: options.orderSeed ?? 1,
    restBetweenCandidatesMs: options.restBetweenCandidatesMs ?? 15000,
    exclusionRules: {
      fatalReasons:
        options.exclusionRules?.fatalReasons ??
        DEFAULT_EXCLUSION_RULES.fatalReasons,
      suspectPolicy:
        options.exclusionRules?.suspectPolicy ??
        DEFAULT_EXCLUSION_RULES.suspectPolicy,
    },
    stoppingCriteria: {
      ...DEFAULT_STOPPING_CRITERIA,
      ...options.stoppingCriteria,
    },
    adaptiveAllocation: {
      ...DEFAULT_ADAPTIVE_ALLOCATION,
      ...options.adaptiveAllocation,
    },
    fatigueProtocol: {
      ...DEFAULT_FATIGUE_PROTOCOL,
      ...options.fatigueProtocol,
    },
    yExploration: {
      ...DEFAULT_Y_EXPLORATION,
      ...options.yExploration,
    },
    notes: options.notes ?? undefined,
  };
}

export interface TrialPlanSpec {
  candidateId: string;
  scenarioId: string;
  phase: "warmup" | "measured";
  sequenceNumber: number;
}

export function planCandidateBlocks(
  definition: ExperimentDefinition,
  round: number,
  candidateIdFilter?: readonly string[],
  allocation?: ReadonlyMap<string, number>,
): TrialPlanSpec[] {
  const rng = new Rng(definition.orderSeed * 7919 + round * 104729);
  let candidateIds = definition.randomizeOrder
    ? rng.shuffle(definition.candidates.map((c) => c.id))
    : [...definition.candidates.map((c) => c.id)].sort();
  if (candidateIdFilter && candidateIdFilter.length > 0) {
    const allow = new Set(candidateIdFilter);
    candidateIds = candidateIds.filter((id) => allow.has(id));
  }

  const repsFromAllocation = (candidateId: string): number =>
    allocation?.get(candidateId) ?? definition.measuredRepsPerCandidatePerRound;
  const maxReps = Math.max(
    ...candidateIds.map((id) => repsFromAllocation(id)),
    0,
  );
  const reps = maxReps > 0 ? maxReps : definition.measuredRepsPerCandidatePerRound;
  void reps;
  const sharedScenarioDraws: string[] = [];
  const drawCount = Math.max(
    ...candidateIds.map((id) => repsFromAllocation(id)),
    0,
  );
  for (let r = 0; r < drawCount; r++) {
    sharedScenarioDraws.push(pickWeightedScenario(definition, rng));
  }

  const specs: TrialPlanSpec[] = [];
  let seq = 0;
  for (const candidateId of candidateIds) {
    const warmups: string[] = [];
    for (let w = 0; w < definition.warmupTrialsPerCandidateBlock; w++) {
      warmups.push(pickWeightedScenario(definition, rng));
    }
    const permRng = new Rng(definition.orderSeed * 31 + round * 977 + hashString(candidateId));
    const candidateReps = repsFromAllocation(candidateId);
    if (candidateReps <= 0) continue;
    const candidateScenarios = permRng.shuffle(sharedScenarioDraws).slice(0, candidateReps);
    for (const scenarioId of warmups) {
      specs.push({ candidateId, scenarioId, phase: "warmup", sequenceNumber: seq++ });
    }
    for (const scenarioId of candidateScenarios) {
      specs.push({ candidateId, scenarioId, phase: "measured", sequenceNumber: seq++ });
    }
  }
  return specs;
}

function hashString(value: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function pickWeightedScenario(
  definition: ExperimentDefinition,
  rng: Rng,
): string {
  const total = definition.scenarioMix.reduce((a, e) => a + e.weight, 0);
  let roll = rng.next() * total;
  for (const entry of definition.scenarioMix) {
    roll -= entry.weight;
    if (roll <= 0) return entry.scenarioId;
  }
  return definition.scenarioMix[definition.scenarioMix.length - 1]!.scenarioId;
}
