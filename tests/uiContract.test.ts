import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * UI/engine contract audit (Pass 7, requirement C).
 *
 * docs/UI-CONTRACT.md §4/§5: presentation renders engine-owned values; it
 * never re-derives verdicts, thresholds, or confidence decisions; it never
 * reaches the network. These static checks pin that contract for the whole
 * app/src tree so drift fails CI instead of surfacing on Aldo's screen.
 */

const APP_SRC = "app/src";

function listAppSources(dir = APP_SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listAppSources(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

const sources = new Map(listAppSources().map((p) => [p, readFileSync(p, "utf8")]));

describe("UI/engine contract (static audit of app/src)", () => {
  it("contains no network-capable APIs anywhere in UI code", () => {
    for (const [path, src] of sources) {
      expect(src.includes("fetch("), path).toBe(false);
      expect(src.includes("XMLHttpRequest"), path).toBe(false);
      expect(src.includes("EventSource"), path).toBe(false);
      expect(src.includes("sendBeacon"), path).toBe(false);
      expect(/import\s*\(\s*["']https?:/.test(src), path).toBe(false);
    }
  });

  it("never embeds remote URLs (fonts, CDNs, images, analytics)", () => {
    for (const [path, src] of sources) {
      // The only allowed http(s) text is loopback ws:// in diagnostics and
      // comments; anything https:// is a remote reference by definition.
      expect(src.includes("https://"), `${path} references https://`).toBe(false);
    }
  });

  it("never re-derives confidence decisions from raw numbers", () => {
    // Confidence tone must come from engine-owned labels
    // (confidenceLabel / CONFIDENCE_LABEL_THRESHOLDS), not ad-hoc cutoffs.
    for (const [path, src] of sources) {
      expect(
        /confidence\s*(>=|>|<|<=)\s*0\.\d/.test(src),
        `${path} re-derives a confidence decision numerically`,
      ).toBe(false);
    }
  });

  it("uses only textContent-safe DOM construction (no innerHTML)", () => {
    for (const [path, src] of sources) {
      expect(/\.innerHTML\s*=/.test(src), path).toBe(false);
      expect(src.includes("insertAdjacentHTML"), path).toBe(false);
      expect(/\.outerHTML\s*=/.test(src), path).toBe(false);
      expect(src.includes("document.write"), path).toBe(false);
    }
  });

  it("run screen keeps target geometry in engine logical units", () => {
    const rc = sources.get("app/src/runController.ts") ?? "";
    expect(rc).toContain("LOGICAL_VIEWPORT = { widthPx: 1280, heightPx: 720 }");
    // Canvas backing store is fixed to the logical viewport — CSS scaling
    // may display it at any size but never distorts the coordinate model.
    expect(rc).toContain("canvas.width = LOGICAL_VIEWPORT.widthPx");
    expect(rc).toContain("canvas.height = LOGICAL_VIEWPORT.heightPx");
    // Trial instances are planned against the same logical viewport.
    expect(rc).toContain("planScenarioInstance(\n      scenario,\n      LOGICAL_VIEWPORT,");
    // Rendering reads positions from the director/recorder, never computes its own.
    expect(rc).toContain("activeTargetsAt(now)");
  });

  it("render loop drives simulation with performance.now() timestamps", () => {
    const rc = sources.get("app/src/runController.ts") ?? "";
    expect(rc).toContain("director.tick(now)");
    // Trial execution must never count frames as time.
    expect(/frameCount|framesElapsed/.test(rc)).toBe(false);
  });

  it("results render engine contracts instead of recomputing them", () => {
    const main = sources.get("app/src/main.ts") ?? "";
    expect(main).toContain("buildFinalResult");
    expect(main).toContain("planNextTest");
    expect(main).toContain("runPreflightChecks");
    const results = sources.get("app/src/resultsView.ts") ?? "";
    // Confidence tone derives from the engine label field.
    expect(results).toContain("confidenceLabelTone(fr.confidenceLabel)");
    expect(results).toContain("confidenceLabelTone(rec.confidenceLabel)");
  });

  it("history summaries carry the engine confidence label (no numeric reinterpretation)", () => {
    const api = readFileSync("src/history/api.ts", "utf8");
    expect(api).toContain("confidenceLabel");
  });
});
