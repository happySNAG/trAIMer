import { runCampaignCase, type CampaignCaseResult } from "../../src/campaigns/runner.ts";
import { ALL_PLAYER_FAMILIES } from "../../src/campaigns/playerFamilies.ts";
import { RC_BUILDER_DEFAULTS } from "../../src/experiments/rcDefaults.ts";

/**
 * Pass 6 Monte Carlo campaign driver.
 *
 * Usage:
 *   npx tsx scripts/campaigns/run-monte-carlo.ts [casesPerFamily] [outName]
 *
 * Deterministic: identical arguments always produce identical JSON bytes
 * (sorted keys, fixed precision). Results land in docs/pass6-data/.
 */

const casesPerFamily = Number(process.argv[2] ?? 24);
const outName = process.argv[3] ?? "monte-carlo-main";

function main(): void {
  const results: CampaignCaseResult[] = [];
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  for (const family of ALL_PLAYER_FAMILIES) {
    for (let i = 0; i < casesPerFamily; i++) {
      // Seed space is strided so sub-ranges of the campaign can be rerun
      // independently while remaining disjoint.
      const seed = 1000 * (i + 1) + familyIndex(family);
      results.push(
        runCampaignCase({
          seed,
          family,
          repsPerCandidatePerRound: 6,
          rounds: 2,
        }),
      );
    }
    process.stderr.write(`done ${family} (${results.length} cases)\n`);
  }
  const durationMs = performance.now() - t0;

  const payload = {
    kind: "pass6-monte-carlo-campaign",
    schemaVersion: 1,
    startedAtIso: startedAt,
    durationMs,
    casesPerFamily,
    protocol: {
      repsPerCandidatePerRound: 6,
      rounds: 2,
      warmupPerBlock: 1,
      scenarios: RC_BUILDER_DEFAULTS.scenarioIds,
      sampleHz: 120,
    },
    results,
  };
  const json = stableStringify(payload);
  console.log(json);
  process.stderr.write(`\ncases=${results.length} ms=${durationMs.toFixed(0)} out=${outName}\n`);
}

function familyIndex(family: string): number {
  return ALL_PLAYER_FAMILIES.indexOf(family as never);
}

function stableStringify(value: unknown): string {
  const seen = new Set<unknown>();
  function walk(v: unknown): string {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (seen.has(v)) return '"[circular]"';
    seen.add(v);
    if (Array.isArray(v)) return `[${v.map(walk).join(",")}]`;
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, val]) => `${JSON.stringify(k)}:${walk(val)}`);
    return `{${entries.join(",")}}`;
  }
  return walk(value);
}

main();
