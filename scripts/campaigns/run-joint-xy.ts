import { runCampaignCase, type CampaignCaseResult } from "../../src/campaigns/runner.ts";
import { scoreAsymmetryVerdicts } from "../../src/campaigns/metrics.ts";

/**
 * Joint X/Y asymmetry campaign (Pass 6 requirement 3/4 inputs).
 *
 * Runs the staged independent-Y exploration on symmetric players (any
 * unequal-Y verdict is a FALSE positive) and genuinely asymmetric players
 * (unequal verdicts are TRUE positives).
 *
 * Usage: npx tsx scripts/campaigns/run-joint-xy.ts [casesPerFamily] [outName]
 */

const casesPerFamily = Number(process.argv[2] ?? 12);
const outName = process.argv[3] ?? "joint-xy";
void outName;

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

const families = [
  "false-xy-asymmetry",
  "real-xy-asymmetry",
  "clean-unimodal",
] as const;

const results: CampaignCaseResult[] = [];
for (const family of families) {
  for (let k = 0; k < casesPerFamily; k++) {
    const seed = 900_000 + k * 7919 + (family === "false-xy-asymmetry" ? 0 : family === "real-xy-asymmetry" ? 1 : 2);
    results.push(
      runCampaignCase({
        seed,
        family,
        repsPerCandidatePerRound: 6,
        rounds: 1,
        jointXY: true,
      }),
    );
  }
  process.stderr.write(`done ${family}\n`);
}

const score = scoreAsymmetryVerdicts(results);
console.log(
  stableStringify({
    kind: "pass6-joint-xy-campaign",
    schemaVersion: 1,
    casesPerFamily,
    score,
    results: results.map((r) => ({
      seed: r.seed,
      family: r.family,
      jointXYOutcome: r.jointXYOutcome,
      truthAsymmetric: r.jointXYTruthAsymmetric,
      coveredByRange: r.coveredByRange,
      confidence: r.confidence,
    })),
  }),
);
