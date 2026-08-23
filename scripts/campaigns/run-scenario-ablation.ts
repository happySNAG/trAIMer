import { runCampaignCase, type CampaignCaseResult } from "../../src/campaigns/runner.ts";
import { aggregateCases } from "../../src/campaigns/metrics.ts";
import { RC_BUILDER_DEFAULTS } from "../../src/experiments/rcDefaults.ts";

/**
 * Scenario information & ablation campaign (Pass 6 requirement 5).
 *
 * Populations:
 *  - all scenarios (reference)
 *  - each single scenario REMOVED
 *  - each scenario ALONE
 *  - repetition reallocation variants (small-flick weighted)
 *
 * Usage: npx tsx scripts/campaigns/run-scenario-ablation.ts [casesPerArm] [outName]
 */

const casesPerArm = Number(process.argv[2] ?? 12);
const outName = process.argv[3] ?? "scenario-ablation";
void outName;

const ALL = RC_BUILDER_DEFAULTS.scenarioIds;

interface Arm {
  id: string;
  scenarios: readonly string[];
}

const arms: Arm[] = [
  { id: "all", scenarios: ALL },
  ...ALL.map((s) => ({
    id: `without-${s}`,
    scenarios: ALL.filter((x) => x !== s),
  })),
  ...ALL.map((s) => ({ id: `only-${s}`, scenarios: [s] })),
  {
    id: "realloc-flick-weighted",
    // Same five families; small flick emphasized via a doubled entry set is
    // not supported by weights in V1 (equal mix), so this arm approximates
    // reallocation with the three highest-information scenarios at higher
    // per-scenario reps instead.
    scenarios: ["flick-static-small", "flick-static-medium", "flick-dynamic-horizontal"],
  },
];

function stableStringify(value: unknown): string {
  function walk(v: unknown): string {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(walk).join(",")}]`;
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, val]) => `${JSON.stringify(k)}:${walk(val)}`);
    return `{${entries.join(",")}}`;
  }
  return walk(value);
}

// Families where sensitivity discrimination matters most for ablation reads.
const ABLATION_FAMILIES = [
  "clean-unimodal",
  "broad-plateau",
  "high-motor-noise",
  "low-motor-noise",
  "precision-heavy",
  "reaction-heavy",
  "tracking-heavy",
  "inconsistent-day",
] as const;

const results: {
  armId: string;
  scenarios: readonly string[];
  seed: number;
  result: CampaignCaseResult;
}[] = [];

for (const arm of arms) {
  let i = 0;
  for (const family of ABLATION_FAMILIES) {
    for (let k = 0; k < casesPerArm; k++) {
      const seed = 500_000 + i * 37 + k * 911;
      results.push({
        armId: arm.id,
        scenarios: arm.scenarios,
        seed,
        result: runCampaignCase({
          seed,
          family,
          scenarioIds: arm.scenarios,
          repsPerCandidatePerRound: 6,
          rounds: 2,
        }),
      });
    }
    i++;
  }
  process.stderr.write(`done arm ${arm.id}\n`);
}

const summary = [...new Set(results.map((r) => r.armId))].map((armId) => {
  const rows = results.filter((r) => r.armId === armId).map((r) => r.result);
  const agg = aggregateCases(armId, rows);
  return {
    armId,
    scenarios: results.find((r) => r.armId === armId)!.scenarios,
    medianRelativeError: agg.error.medianRelativeError,
    p90RelativeError: agg.error.p90RelativeError,
    coverageRate: agg.coverageRate,
    meanMeasuredTrials: agg.meanMeasuredTrials,
    meanEstimatedActiveSeconds: agg.meanEstimatedActiveSeconds,
    falseHighConfidenceRate: agg.falseHighConfidenceRate,
    highConfidenceShare: agg.highConfidenceShare,
  };
});

console.log(
  stableStringify({
    kind: "pass6-scenario-ablation",
    schemaVersion: 1,
    casesPerArm,
    families: ABLATION_FAMILIES,
    summary,
    results,
  }),
);
