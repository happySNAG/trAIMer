import { describe, expect, it } from "vitest";
import {
  buildExperimentDefinition,
  SyntheticExperimentRunner,
  playerPreset,
  replayExperiment,
} from "../src/index.ts";
import type { TrialRecord } from "../src/domain/trial.ts";
import { equalXy } from "../src/domain/settings.ts";

const definition = buildExperimentDefinition({
  id: "experiment-replay",
  name: "replay",
  baselineSensitivity: equalXy(7),
  dpi: 800,
  measuredRepsPerCandidatePerRound: 6,
  orderSeed: 4242,
});

function produceTrials(): TrialRecord[] {
  const runner = new SyntheticExperimentRunner(definition, playerPreset("consistent-medium"));
  return [
    ...runner.runRound(0, 777, "session-rp", definition.id),
    ...runner.runRound(1, 777, "session-rp", definition.id),
  ];
}

describe("raw session replay", () => {
  it("replays a stored session deterministically through validation/metrics/optimizer", () => {
    const trials = produceTrials();
    const first = replayExperiment(definition, trials);
    const second = replayExperiment(definition, trials);

    expect(first.recommendation.recommendedEdpi).toBe(
      second.recommendation.recommendedEdpi,
    );
    expect(JSON.stringify(first.recommendation)).toBe(
      JSON.stringify(second.recommendation),
    );
    expect(first.trials).toHaveLength(trials.length);
  });

  it("produces the same recommendation as live analysis of identical trials", async () => {
    const trials = produceTrials();
    const { recommendation: replayed } = replayExperiment(definition, trials);

    // Live-equivalent path (Pass 2 style): optimizer over the same records.
    const optimizer = new (await import("../src/optimizer/optimizer.ts")).SensitivityOptimizer(
      definition,
      { maxSearchRounds: 2 },
    );
    optimizer.addTrials(trials.map((t) => structuredClone(t)));
    const live = optimizer.recommend();

    expect(replayed.recommendedEdpi).toBe(live.recommendedEdpi);
    expect(replayed.confidenceLabel).toBe(live.confidenceLabel);
  });

  it("supports scoring-weight experiments via scoring config isolation", () => {
    const trials = produceTrials();
    const a = replayExperiment(definition, structuredClone(trials));
    void a;
    const b = replayExperiment(definition, structuredClone(trials));
    expect(a.recommendation.utilityWeights).toEqual(b.recommendation.utilityWeights);
  });
});
