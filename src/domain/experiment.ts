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
  notes?: string | undefined;
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
}
