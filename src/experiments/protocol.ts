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
import { RC_BUILDER_DEFAULTS, V1_RC_PROTOCOL_DEFAULTS } from "./rcDefaults.ts";

export const DEFAULT_LADDER_FACTORS: readonly number[] =
  RC_BUILDER_DEFAULTS.ladderFactors;

/** The canonical documented V1 RC defaults (see rcDefaults.ts). */
export { V1_RC_PROTOCOL_DEFAULTS };

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
  ...RC_BUILDER_DEFAULTS.exclusionRules,
};

export const DEFAULT_STOPPING_CRITERIA: StoppingCriteria = {
  ...RC_BUILDER_DEFAULTS.stoppingCriteria,
};

export const DEFAULT_ADAPTIVE_ALLOCATION: AdaptiveAllocationConfig = {
  ...RC_BUILDER_DEFAULTS.adaptiveAllocation,
};

export const DEFAULT_FATIGUE_PROTOCOL: FatigueProtocolConfig = {
  ...RC_BUILDER_DEFAULTS.fatigueProtocol,
};

export const DEFAULT_Y_EXPLORATION: YExplorationConfig = {
  ...RC_BUILDER_DEFAULTS.yExploration,
};

function scenarioCatalogSubset(ids: readonly string[]): ScenarioDefinition[] {
  return ids.map((id) => {
    const found = CORE_SCENARIOS.find((s) => s.id === id);
    if (!found) throw new Error(`Unknown scenario id: ${id}`);
    return found;
  });
}

export function buildExperimentDefinition(
  options: ExperimentBuildOptions,
): ExperimentDefinition {
  const scenarioIds = options.scenarioIds ?? RC_BUILDER_DEFAULTS.scenarioIds;
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
    warmupTrialsPerCandidateBlock:
      options.warmupTrialsPerCandidateBlock ??
      RC_BUILDER_DEFAULTS.warmupTrialsPerCandidateBlock,
    measuredRepsPerCandidatePerRound:
      options.measuredRepsPerCandidatePerRound ??
      RC_BUILDER_DEFAULTS.measuredRepsPerCandidatePerRound,
    randomizeOrder: options.randomizeOrder ?? true,
    orderSeed: options.orderSeed ?? 1,
    restBetweenCandidatesMs:
      options.restBetweenCandidatesMs ?? RC_BUILDER_DEFAULTS.restBetweenCandidatesMs,
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
  /**
   * Which paired-comparison cell this measured trial belongs to.
   *
   * The paired model cancels scenario and instance effects by comparing two
   * candidates on the SAME cell — `scenarioId#pairIndex` (see
   * src/optimizer/paired.ts). For that to work, two candidates playing the
   * same drill for the same time in the same round must land on the same
   * index, and must be given the same target layout.
   *
   * Until this field existed the index was a per-candidate running counter,
   * so candidate A's third measured drill and candidate B's third measured
   * drill shared a cell only when their independently shuffled block orders
   * happened to agree. Measured over 200 seeds with the standard five-
   * candidate ladder: about 20–25 % of cells paired, and in a 5-rep block the
   * average candidate PAIR shared one cell — some shared none. The paired
   * comparison was running at roughly a quarter of its design power, and the
   * shorter the session, the worse it got.
   *
   * `pairIndex` is the occurrence number of this scenario within this
   * candidate's block, offset by the round. Every candidate in a round draws
   * the identical multiset, so every occurrence has a partner BY
   * CONSTRUCTION. Null for warm-ups, which are never scored.
   */
  pairIndex: number | null;
}

/**
 * Rounds are separate exposures with their own target layouts, so their cells
 * must not merge. Far above any plausible per-round rep count.
 */
export const PAIR_INDEX_ROUND_STRIDE = 1000;

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
  const drawCount = Math.max(
    ...candidateIds.map((id) => repsFromAllocation(id)),
    0,
  );
  // Shared across every candidate in the round (the multiset each block sees
  // is identical, which is what the paired comparison relies on), but drawn
  // BALANCED rather than independently: every drill family appears as evenly
  // as the rep count allows. Eight independent weighted draws from five
  // families routinely produced blocks with three of one drill and none of
  // another — the "same few tests over and over" that real-hardware feedback
  // called out — without buying any statistical power for it.
  const sharedScenarioDraws = drawBalancedScenarios(definition, drawCount, rng);

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
    // The MULTISET is a prefix of the shared draw — identical for every
    // candidate on a full allocation, and nested for a reduced one, so a
    // candidate that plays fewer reps still pairs on every cell it does play.
    // Only the ORDER varies per candidate (arranged so the same drill never
    // runs twice in a row inside a block).
    //
    // rc.7 shuffled the shared draw per candidate BEFORE slicing, which made
    // a reduced allocation a random subset rather than a nested one.
    const candidateScenarios = arrangeWithoutAdjacentRepeats(
      sharedScenarioDraws.slice(0, candidateReps),
      permRng,
    );
    for (const scenarioId of warmups) {
      specs.push({
        candidateId,
        scenarioId,
        phase: "warmup",
        sequenceNumber: seq++,
        pairIndex: null,
      });
    }
    // Occurrence number per scenario, so the same drill played twice in one
    // block occupies two distinct cells rather than collapsing into one.
    const occurrence = new Map<string, number>();
    for (const scenarioId of candidateScenarios) {
      const n = occurrence.get(scenarioId) ?? 0;
      occurrence.set(scenarioId, n + 1);
      specs.push({
        candidateId,
        scenarioId,
        phase: "measured",
        sequenceNumber: seq++,
        pairIndex: round * PAIR_INDEX_ROUND_STRIDE + n,
      });
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

/**
 * Draws `count` scenarios so that each family's share matches its mix weight
 * as closely as integer counts allow: floor shares first, then the remainder
 * goes to the families with the largest fractional entitlement (ties broken
 * by the seeded rng, so two rounds differ but every session with the same
 * seed is identical). Equal weights and count ≥ families ⇒ every family
 * appears at least once.
 */
export function drawBalancedScenarios(
  definition: ExperimentDefinition,
  count: number,
  rng: Rng,
): string[] {
  const mix = definition.scenarioMix.filter((e) => e.weight > 0);
  if (count <= 0 || mix.length === 0) return [];
  const total = mix.reduce((a, e) => a + e.weight, 0);
  const shares = mix.map((e) => ({
    scenarioId: e.scenarioId,
    exact: (e.weight / total) * count,
  }));
  const counts = new Map<string, number>();
  let assigned = 0;
  for (const s of shares) {
    const n = Math.floor(s.exact);
    counts.set(s.scenarioId, n);
    assigned += n;
  }
  const remainder = rng
    .shuffle(shares)
    .sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)));
  for (let i = 0; assigned < count; i++) {
    const s = remainder[i % remainder.length]!;
    counts.set(s.scenarioId, (counts.get(s.scenarioId) ?? 0) + 1);
    assigned++;
  }
  const out: string[] = [];
  for (const [scenarioId, n] of counts) for (let i = 0; i < n; i++) out.push(scenarioId);
  return rng.shuffle(out);
}

/**
 * Reorders a drill list so no two consecutive entries share a scenario, when
 * the multiset permits (a family holding more than half the slots cannot be
 * fully separated; the leftover repeats are pushed to the end). Greedy on
 * remaining counts — deterministic given the rng.
 */
export function arrangeWithoutAdjacentRepeats(list: readonly string[], rng: Rng): string[] {
  const remaining = new Map<string, number>();
  for (const id of list) remaining.set(id, (remaining.get(id) ?? 0) + 1);
  const out: string[] = [];
  while (out.length < list.length) {
    const last = out[out.length - 1];
    const candidates = [...remaining.entries()]
      .filter(([id, n]) => n > 0 && id !== last)
      .sort((a, b) => b[1] - a[1]);
    let pick: string | undefined;
    if (candidates.length > 0) {
      const top = candidates[0]![1];
      const tied = candidates.filter(([, n]) => n === top).map(([id]) => id);
      pick = rng.shuffle(tied)[0];
    } else {
      pick = [...remaining.entries()].find(([, n]) => n > 0)?.[0];
    }
    if (pick === undefined) break;
    out.push(pick);
    remaining.set(pick, (remaining.get(pick) ?? 0) - 1);
  }
  return out;
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
