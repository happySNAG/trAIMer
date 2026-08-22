import type { SensitivityCandidate } from "./candidate.ts";
import type { ExperimentId, SessionId } from "./ids.ts";
import type { ScenarioDefinition } from "./scenario.ts";
import type { InvalidReasonCode } from "./validity.ts";

export interface ScenarioMixEntry {
  scenarioId: string;
  weight: number;
}

export interface ExclusionRules {
  fatalReasons: readonly InvalidReasonCode[];
  suspectPolicy: "exclude" | "include-with-flag";
}

export interface StoppingCriteria {
  maxTotalMeasuredTrials: number;
  minValidTrialsPerCandidate: number;
  maxSearchRounds: number;
  targetUtilityCiHalfWidth: number | null;
}

export interface AdaptiveAllocationConfig {
  enabled: boolean;
  minRepsBeforeAdaptive: number;
  contenderZThreshold: number;
  controlRefreshEveryRounds: number;
}

export interface FatigueProtocolConfig {
  maxContinuousTestingMs: number;
  restDurationMs: number;
  degradationWindowTrials: number;
  degradationRatioThreshold: number;
}

export interface YExplorationConfig {
  enabled: boolean;
  yFactors: readonly number[];
  minImprovementZ: number;
}

export interface ExperimentDefinition {
  id: ExperimentId;
  name: string;
  baselineSensitivity: { sensX: number; sensY: number };
  dpi: number;
  candidates: SensitivityCandidate[];
  scenarioMix: readonly ScenarioMixEntry[];
  scenarioCatalog: readonly ScenarioDefinition[];
  warmupTrialsPerCandidateBlock: number;
  measuredRepsPerCandidatePerRound: number;
  randomizeOrder: boolean;
  orderSeed: number;
  restBetweenCandidatesMs: number;
  exclusionRules: ExclusionRules;
  stoppingCriteria: StoppingCriteria;
  adaptiveAllocation: AdaptiveAllocationConfig;
  fatigueProtocol: FatigueProtocolConfig;
  yExploration: YExplorationConfig;
  notes?: string | undefined;
}

export interface SessionPhaseLogEntry {
  state: string;
  tIso: string;
  detail?: string | undefined;
}

export interface AimSession {
  id: SessionId;
  experimentId: ExperimentId | null;
  playerProfileSnapshot: {
    displayName: string;
    dpi: number;
    sensitivityPreference: string;
  };
  startedAtIso: string;
  endedAtIso: string | null;
  deviceDescription: string;
  phaseLog: SessionPhaseLogEntry[];
}
