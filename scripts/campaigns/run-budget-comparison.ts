import { runCampaignCase, type CampaignCaseResult } from "../../src/campaigns/runner.ts";
import { aggregateCases } from "../../src/campaigns/metrics.ts";

/**
 * Trial-budget comparison campaign (Pass 6 requirement 6).
 *
 * Policies (all on the canonical scenario mix):
 *  - budget-short:        reps 4 × 2 rounds (early-stop floor respected)
 *  - budget-standard:     reps 6 × 2 rounds (V1-RC-like default used in sims)
 *  - budget-high-conf:    reps 8 × 3 rounds
 *  - budget-retest-style: reps 4 × 1 round (what a targeted retest spends)
 *
 * Usage: npx tsx scripts/campaigns/run-budget-comparison.ts [casesPerArm] [outName]
 */

const casesPerArm = Number(process.argv[2] ?? 12);
const outName = process.argv[3] ?? "budget-comparison";
void outName;

interface BudgetArm {
  id: string;
  reps: number;
  rounds: number;
}

const arms: BudgetArm[] = [
  { id: "short", reps: 4, rounds: 2 },
  { id: "standard", reps: 6, rounds: 2 },
  { id: "high-confidence", reps: 8, rounds: 3 },
  { id: "retest-style", reps: 4, rounds: 1 },
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

const BUDGET_FAMILIES = [
  "clean-unimodal",
  "broad-plateau",
  "asymmetric-curve",
  "high-motor-noise",
  "low-motor-noise",
  "reaction-heavy",
  "precision-heavy",
  "tracking-heavy",
  "inconsistent-day",
  "boundary-optimum",
] as const;

const results: {
  armId: string;
  seed: number;
  result: CampaignCaseResult;
}[] = [];

for (const arm of arms) {
  let i = 0;
  for (const family of BUDGET_FAMILIES) {
    for (let k = 0; k < casesPerArm; k++) {
      const seed = 800_000 + i * 101 + k * 613;
      results.push({
        armId: arm.id,
        seed,
        result: runCampaignCase({
          seed,
          family,
          repsPerCandidatePerRound: arm.reps,
          rounds: arm.rounds,
        }),
      });
    }
    i++;
  }
  process.stderr.write(`done arm ${arm.id}\n`);
}

const summary = arms.map((arm) => {
  const rows = results.filter((r) => r.armId === arm.id).map((r) => r.result);
  const agg = aggregateCases(arm.id, rows);
  return {
    armId: arm.id,
    repsPerCandidatePerRound: arm.reps,
    rounds: arm.rounds,
    medianRelativeError: agg.error.medianRelativeError,
    p90RelativeError: agg.error.p90RelativeError,
    coverageRate: agg.coverageRate,
    meanMeasuredTrials: agg.meanMeasuredTrials,
    meanEstimatedActiveSeconds: agg.meanEstimatedActiveSeconds,
    highConfidenceShare: agg.highConfidenceShare,
    falseHighConfidenceRate: agg.falseHighConfidenceRate,
    earlyStopRate: agg.earlyStopRate,
    retestRecommendationRate: agg.retestRecommendationRate,
  };
});

console.log(
  stableStringify({
    kind: "pass6-budget-comparison",
    schemaVersion: 1,
    casesPerArm,
    families: BUDGET_FAMILIES,
    summary,
    results,
  }),
);
