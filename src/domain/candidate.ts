import type { CandidateId } from "./ids.ts";
import type { SensitivityConfiguration } from "./settings.ts";

export interface SafeSensitivityRange {
  minSensX: number;
  maxSensX: number;
  minSensY: number;
  maxSensY: number;
}

export const DEFAULT_SAFE_RANGE: SafeSensitivityRange = {
  minSensX: 1,
  maxSensX: 20,
  minSensY: 1,
  maxSensY: 20,
};

export interface SensitivityCandidate {
  id: CandidateId;
  sensitivity: SensitivityConfiguration;
  origin:
    | { kind: "baseline" }
    | { kind: "generated"; multiplicativeFactorVsBaseline: number }
    | { kind: "manual"; label: string };
}
