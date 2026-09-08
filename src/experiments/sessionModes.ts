import type { ExperimentDefinition } from "../domain/experiment.ts";
import { CORE_SCENARIOS, type ScenarioDefinition } from "../domain/scenario.ts";
import { V1_RC_PROTOCOL_DEFAULTS } from "./rcDefaults.ts";

/**
 * Selectable calibration lengths, derived from the evidence model rather than
 * chosen for a round number.
 *
 * ------------------------------------------------------------------------
 * Where the counts come from
 * ------------------------------------------------------------------------
 *
 * Three numbers in the documented V1 protocol (rcDefaults.ts) fix everything
 * here; nothing below invents a threshold:
 *
 *  - `minValidTrialsPerCandidate = 4` — the optimizer's own floor. Below four
 *    VALID measured drills for a candidate its standard error explodes, the
 *    candidate is marked incomplete, and session confidence is capped at
 *    ≤ 0.45 whatever else the data says. A mode that cannot reach four per
 *    candidate cannot produce a recommendation at all.
 *  - `measuredRepsPerCandidatePerRound = 8` — the point at which the duration
 *    campaigns' median-error and range-width curves flatten. More reps in a
 *    round buy progressively less.
 *  - `adaptiveAllocation.minRepsBeforeAdaptive = 8` — adaptive allocation only
 *    starts once every candidate has its balanced minimum, so a mode running
 *    fewer than 8 reps in its only round is deliberately, entirely balanced.
 *
 * With the standard five-candidate ladder that gives exactly three useful
 * operating points, and the modes ARE those points:
 *
 *  | mode      | rounds | reps | warm-ups | drills | measured | valid target/cand |
 *  | quick     |   1    |  5   |    1     |   30   |    25    |  4 (floor + 1)    |
 *  | standard  |   1    |  8   |    2     |   50   |    40    |  6                |
 *  | precision |   2    |  8   |    2     |  100   |    80    | 12                |
 *
 * QUICK sits one rep above the optimizer's floor: four valid drills per
 * candidate is the least the engine will rank on, and the fifth rep is the
 * headroom that absorbs a single unusable measurement without a replacement
 * block. It is a directional estimate by construction — at n=4 the confidence
 * model cannot exceed "low" unless the candidates are far apart.
 *
 * STANDARD is one full documented round: the productive-band rep count, with
 * two reps of headroom per candidate above the floor.
 *
 * PRECISION is STANDARD plus the refinement round the protocol was designed
 * around, and is the only mode that can reach the search's second stage
 * (adaptive allocation, boundary expansion, change-point analysis over two
 * exposures of every candidate).
 *
 * ------------------------------------------------------------------------
 * What a mode does NOT change
 * ------------------------------------------------------------------------
 *
 * Candidate ladder, blinding, block randomization, paired scenario draws,
 * target geometry, hit detection, scoring weights, validation and exclusion
 * rules, and the confidence model are IDENTICAL in all three. A shorter mode
 * buys less evidence; it never buys easier evidence.
 */

export const CALIBRATION_MODE_IDS = [
  "quick",
  "standard",
  "precision",
  "custom",
] as const;

export type CalibrationModeId = (typeof CALIBRATION_MODE_IDS)[number];

export interface CalibrationMode {
  id: CalibrationModeId;
  label: string;
  /** One line under the label on the mode card. */
  tagline: string;
  rounds: number;
  measuredRepsPerCandidatePerRound: number;
  warmupTrialsPerCandidateBlock: number;
  /**
   * Valid measured drills per candidate this mode is planned to FINISH with.
   * Completion is judged against this, not against a raw drill count.
   */
  targetValidTrialsPerCandidate: number;
  /**
   * The strongest recommendation state this much evidence can support, in the
   * engine's own vocabulary. Never a promised confidence percentage: the
   * confidence model reads the separation between candidates, which is a
   * property of the player, not of the plan.
   */
  bestSupportedState: RecommendationState;
  /** What the player is told they will get, in plain language. */
  claim: string;
  /** Bounded top-up blocks allowed when measurements are lost. */
  maxReplacementBlocks: number;
}

/**
 * How strongly a result may be presented. Ordered weakest → strongest; the
 * results screen never shows a stronger label than the evidence earns.
 */
export const RECOMMENDATION_STATES = [
  "insufficient",
  "directional-estimate",
  "preliminary",
  "moderate-confidence",
  "high-confidence",
] as const;

export type RecommendationState = (typeof RECOMMENDATION_STATES)[number];

const MIN_VALID_PER_CANDIDATE =
  V1_RC_PROTOCOL_DEFAULTS.minValidTrialsPerCandidate.value;
const PRODUCTIVE_REPS =
  V1_RC_PROTOCOL_DEFAULTS.measuredRepsPerCandidatePerRound.value;
const DEFAULT_WARMUPS =
  V1_RC_PROTOCOL_DEFAULTS.warmupTrialsPerCandidateBlock.value;

export const CALIBRATION_MODES: Readonly<
  Record<Exclude<CalibrationModeId, "custom">, CalibrationMode>
> = {
  quick: {
    id: "quick",
    label: "Quick",
    tagline: "A directional answer, fast",
    rounds: 1,
    // The optimizer's floor plus one rep of headroom for a lost measurement.
    measuredRepsPerCandidatePerRound: MIN_VALID_PER_CANDIDATE + 1,
    warmupTrialsPerCandidateBlock: 1,
    targetValidTrialsPerCandidate: MIN_VALID_PER_CANDIDATE,
    bestSupportedState: "directional-estimate",
    claim:
      "Enough to say which direction your sensitivity should move, and roughly how far. Not enough to settle a close call.",
    maxReplacementBlocks: 2,
  },
  standard: {
    id: "standard",
    label: "Standard",
    tagline: "The balance of time and evidence",
    rounds: 1,
    measuredRepsPerCandidatePerRound: PRODUCTIVE_REPS,
    warmupTrialsPerCandidateBlock: DEFAULT_WARMUPS,
    targetValidTrialsPerCandidate: MIN_VALID_PER_CANDIDATE + 2,
    bestSupportedState: "moderate-confidence",
    claim:
      "One full documented round across every candidate. Enough for a recommendation with a real plausible range, if your own curve has a clear shape.",
    maxReplacementBlocks: 2,
  },
  precision: {
    id: "precision",
    label: "Precision",
    tagline: "The full search, both rounds",
    rounds: 2,
    measuredRepsPerCandidatePerRound: PRODUCTIVE_REPS,
    warmupTrialsPerCandidateBlock: DEFAULT_WARMUPS,
    targetValidTrialsPerCandidate: 3 * MIN_VALID_PER_CANDIDATE,
    bestSupportedState: "high-confidence",
    claim:
      "The complete protocol: a second refinement round, adaptive allocation, and the narrowest range this engine can produce in one sitting.",
    maxReplacementBlocks: 3,
  },
} as const;

export type NamedCalibrationModeId = Exclude<CalibrationModeId, "custom">;

export const DEFAULT_CALIBRATION_MODE: NamedCalibrationModeId = "standard";

/** The three named modes in the order they are offered. */
export const CALIBRATION_MODE_ORDER: readonly NamedCalibrationModeId[] = [
  "quick",
  "standard",
  "precision",
];

export function calibrationMode(id: CalibrationModeId): CalibrationMode | null {
  if (id === "custom") return null;
  return CALIBRATION_MODES[id];
}

export function isCalibrationModeId(value: unknown): value is CalibrationModeId {
  return (
    typeof value === "string" &&
    (CALIBRATION_MODE_IDS as readonly string[]).includes(value)
  );
}

/**
 * The mode whose plan matches these parameters exactly, or "custom".
 *
 * Used when a stored session (or a hand-edited advanced form) has to be named
 * for the player: a plan is only called Standard if it IS the Standard plan.
 */
export function classifyPlan(plan: {
  rounds: number;
  measuredRepsPerCandidatePerRound: number;
  warmupTrialsPerCandidateBlock: number;
}): CalibrationModeId {
  for (const mode of Object.values(CALIBRATION_MODES)) {
    if (
      mode.rounds === plan.rounds &&
      mode.measuredRepsPerCandidatePerRound ===
        plan.measuredRepsPerCandidatePerRound &&
      mode.warmupTrialsPerCandidateBlock === plan.warmupTrialsPerCandidateBlock
    ) {
      return mode.id;
    }
  }
  return "custom";
}

export interface ModePlanEstimate {
  candidates: number;
  totalDrills: number;
  measuredDrills: number;
  warmupDrills: number;
  targetValidTrialsPerCandidate: number;
  totalValidTrialsTargeted: number;
  estimatedMinutes: number;
  /** Range around the estimate, minutes (breaks skipped ↔ breaks taken). */
  estimatedMinutesRange: { min: number; max: number };
}

/**
 * Mean wall-clock a single drill of this catalog costs, in milliseconds.
 *
 * Timed drills (tracking, the strafing flick) always run their whole window;
 * click-to-hit drills usually end on the hit, well before their timeout. The
 * fractions below are the share of the window a drill of that kind typically
 * consumes — deliberately conservative, and used ONLY to show the player a
 * duration. Nothing in this file feeds a measurement.
 */
const KIND_WINDOW_FRACTION: Record<ScenarioDefinition["kind"], number> = {
  "flick-static": 0.75,
  "flick-dynamic": 1,
  "target-switch": 0.85,
  tracking: 1,
};

function meanDrillMs(catalog: readonly ScenarioDefinition[]): number {
  if (catalog.length === 0) return 0;
  let total = 0;
  for (const scenario of catalog) {
    const interTrialMs = scenario.kind === "tracking" ? 1200 : 700;
    total += scenario.timeoutMs * KIND_WINDOW_FRACTION[scenario.kind] + interTrialMs;
  }
  return total / catalog.length;
}

/**
 * What a mode will actually ask of the player, given the candidate ladder and
 * scenario catalog it will run against.
 */
export function estimateModePlan(
  mode: CalibrationMode,
  options: {
    candidateCount: number;
    scenarioCatalog?: readonly ScenarioDefinition[];
    /** Break between candidate blocks, ms. Zero when breaks are off. */
    restBetweenCandidatesMs?: number;
  },
): ModePlanEstimate {
  const candidates = Math.max(1, options.candidateCount);
  const catalog = options.scenarioCatalog ?? CORE_SCENARIOS;
  const perBlock =
    mode.warmupTrialsPerCandidateBlock + mode.measuredRepsPerCandidatePerRound;
  const totalDrills = candidates * perBlock * mode.rounds;
  const measuredDrills =
    candidates * mode.measuredRepsPerCandidatePerRound * mode.rounds;
  const warmupDrills = totalDrills - measuredDrills;

  const drillMs = meanDrillMs(catalog) * totalDrills;
  const blocks = candidates * mode.rounds;
  const breakMs = Math.max(0, options.restBetweenCandidatesMs ?? 0) * Math.max(0, blocks - 1);
  // Ceiling, not rounding: a duration shown to a player is a promise, and the
  // drill budgets above already exclude the seconds a real session spends on
  // the lock-in click, instruction reads and break screens.
  const minMinutes = Math.max(1, Math.ceil(drillMs / 60_000));
  const maxMinutes = Math.max(minMinutes, Math.ceil((drillMs + breakMs) / 60_000));

  return {
    candidates,
    totalDrills,
    measuredDrills,
    warmupDrills,
    targetValidTrialsPerCandidate: mode.targetValidTrialsPerCandidate,
    totalValidTrialsTargeted: mode.targetValidTrialsPerCandidate * candidates,
    estimatedMinutes: maxMinutes,
    estimatedMinutesRange: { min: minMinutes, max: maxMinutes },
  };
}

/**
 * Valid measured drills per candidate, and how far each is from the mode's
 * evidence target. This is what the runner uses to decide whether a session
 * is actually finished, and what a replacement block should contain.
 */
export interface EvidenceShortfall {
  /** Candidate id → valid measured drills recorded so far. */
  validByCandidate: Map<string, number>;
  /** Candidate id → drills still needed to reach the mode's target. */
  deficits: Map<string, number>;
  totalDeficit: number;
  /** Candidates still below the optimizer's hard floor. */
  belowFloor: string[];
  satisfied: boolean;
}

export function assessEvidenceShortfall(
  definition: ExperimentDefinition,
  trials: readonly { phase: string; candidateId: string | null; validity: { status: string } }[],
  targetValidPerCandidate: number,
): EvidenceShortfall {
  const validByCandidate = new Map<string, number>();
  for (const candidate of definition.candidates) validByCandidate.set(candidate.id, 0);
  for (const trial of trials) {
    if (trial.phase !== "measured") continue;
    if (trial.validity.status !== "valid") continue;
    const id = trial.candidateId;
    if (!id || !validByCandidate.has(id)) continue;
    validByCandidate.set(id, validByCandidate.get(id)! + 1);
  }
  const deficits = new Map<string, number>();
  const belowFloor: string[] = [];
  let totalDeficit = 0;
  const floor = definition.stoppingCriteria.minValidTrialsPerCandidate;
  for (const candidate of definition.candidates) {
    const have = validByCandidate.get(candidate.id) ?? 0;
    const need = Math.max(0, targetValidPerCandidate - have);
    if (need > 0) {
      deficits.set(candidate.id, need);
      totalDeficit += need;
    }
    if (have < floor) belowFloor.push(candidate.id);
  }
  return {
    validByCandidate,
    deficits,
    totalDeficit,
    belowFloor,
    satisfied: totalDeficit === 0,
  };
}
