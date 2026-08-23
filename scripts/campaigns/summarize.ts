import { readFileSync } from "node:fs";
import {
  aggregateCases,
  auditConfidenceHonesty,
} from "../../src/campaigns/metrics.ts";
import type { CampaignCaseResult } from "../../src/campaigns/runner.ts";

/**
 * Prints aggregate tables for a saved Monte Carlo campaign JSON.
 * Usage: npx tsx scripts/campaigns/summarize.ts <file.json>
 */
const file = process.argv[2] ?? "/tmp/mc-main.json";
const data = JSON.parse(readFileSync(file, "utf8")) as { results: CampaignCaseResult[] };
const results = data.results;

const overall = aggregateCases("ALL", results);
console.log("== OVERALL ==");
console.log(JSON.stringify(overall, null, 1));

const byFamily = new Map<string, CampaignCaseResult[]>();
for (const r of results) {
  const list = byFamily.get(r.family) ?? [];
  list.push(r);
  byFamily.set(r.family, list);
}
console.log("\n== BY FAMILY ==");
for (const [family, rows] of [...byFamily.entries()].sort()) {
  const agg = aggregateCases(family, rows);
  console.log(
    family.padEnd(18),
    "n=", String(agg.cases).padStart(3),
    "medRelErr=", agg.error.medianRelativeError.toFixed(3),
    "p90=", agg.error.p90RelativeError.toFixed(3),
    "cov=", agg.coverageRate.toFixed(2),
    "confMed=", (
      rows.reduce((a, r) => a + r.confidence, 0) / rows.length
    ).toFixed(2),
    "highConf=", agg.highConfidenceShare.toFixed(2),
    "falseHC=", agg.falseHighConfidenceRate.toFixed(2),
    "retest=", agg.retestRecommendationRate.toFixed(2),
  );
}

console.log("\n== CONFIDENCE HONESTY ==");
for (const f of auditConfidenceHonesty(results)) {
  console.log(
    f.kind.padEnd(46),
    "rate=", f.rate === null ? "n/a" : f.rate.toFixed(4),
    "cases=", f.cases,
  );
}

console.log("\n== ERROR BUCKETS (relative) ==");
const buckets = [0.02, 0.05, 0.1, 0.15, 0.25, 0.5];
for (const b of buckets) {
  const n = results.filter((r) => r.relativeErrorFraction <= b).length;
  console.log(`  <=${(b * 100).toFixed(0)}%: ${(n / results.length).toFixed(3)}`);
}
const worst = [...results].sort((a, b) => b.relativeErrorFraction - a.relativeErrorFraction).slice(0, 8);
console.log("worst cases:");
for (const w of worst) {
  console.log(
    " ",
    w.family.padEnd(18), w.seed,
    "relErr=", w.relativeErrorFraction.toFixed(3),
    "truth=", w.groundTruthEdpi.toFixed(0),
    "rec=", w.recommendationEdpi.toFixed(0),
    "cov=", w.coveredByRange,
    "conf=", w.confidence.toFixed(2),
    "shape=", w.curveShape,
  );
}
