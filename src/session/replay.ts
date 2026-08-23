import type { ExperimentDefinition } from "../domain/experiment.ts";
import type { Recommendation } from "../domain/recommendation.ts";
import type { TrialRecord } from "../domain/trial.ts";
import { validateTrial, DEFAULT_VALIDATION_CONFIG } from "../validation/validateTrial.ts";
import { SensitivityOptimizer } from "../optimizer/optimizer.ts";
import type { InputQualityReport } from "../diagnostics/inputQuality.ts";

export interface ReplayResult {
  trials: TrialRecord[];
  recommendation: Recommendation;
}

/**
 * Deterministic replay: stored raw trials are re-run through validation,
 * scoring and the optimizer without any live input. Two replays of the same
 * bundle produce identical recommendations (regression-tested), enabling
 * optimizer upgrades and scoring-weight experiments to be evaluated against
 * historical sessions.
 */
export function replayExperiment(
  definition: ExperimentDefinition,
  rawTrials: readonly TrialRecord[],
  config?: {
    minValidTrialsPerCandidate?: number;
    maxSearchRounds?: number;
    inputQualityByTrialId?: ReadonlyMap<string, InputQualityReport>;
  },
): ReplayResult {
  const optimizer = new SensitivityOptimizer(definition, {
    ...(config?.minValidTrialsPerCandidate !== undefined
      ? { minValidTrialsPerCandidate: config.minValidTrialsPerCandidate }
      : {}),
    ...(config?.maxSearchRounds !== undefined
      ? { maxSearchRounds: config.maxSearchRounds }
      : {}),
  });
  for (const trial of rawTrials) {
    const validity = validateTrial(trial, DEFAULT_VALIDATION_CONFIG, {
      sensitivity: definition.candidates.find((c) => c.id === trial.candidateId)?.sensitivity,
      dpi: definition.dpi,
    });
    trial.validity = validity;
  }
  optimizer.addTrials(rawTrials);
  if (config?.inputQualityByTrialId && config.inputQualityByTrialId.size > 0) {
    let worst: InputQualityReport | null = null;
    for (const report of config.inputQualityByTrialId.values()) {
      if (!worst || report.score < worst.score) worst = report;
    }
    optimizer.setInputQuality(worst);
  }
  return { trials: [...rawTrials], recommendation: optimizer.recommend() };
}
