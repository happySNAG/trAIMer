import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

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
    // Keys are normalised to POSIX separators so the lookups below
    // ("app/src/runController.ts") resolve on Windows too. Without this,
    // join() yields "app/src\\runController.ts" there, every sources.get()
    // returns undefined, and three contract tests silently compare against
    // the empty string.
    else if (full.endsWith(".ts")) out.push(full.split(sep).join("/"));
  }
  return out;
}

/**
 * Line endings are normalised to LF. Git checks the tree out with CRLF on
 * Windows, which silently broke every multi-line assertion below (they embed
 * "\n") on the Windows CI runner while passing everywhere else.
 */
const readNormalised = (path: string): string =>
  readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const sources = new Map(listAppSources().map((p) => [p, readNormalised(p)]));

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
    // How strongly a result may be PRESENTED is an engine decision, not a UI
    // one: the view asks `classifyRecommendation` (src/results/
    // recommendationState.ts) for the title, the tone and whether the range
    // or the point estimate leads, so the words, the colour and the layout
    // can never disagree with the confidence the optimizer produced.
    expect(results).toContain("classifyRecommendation({");
    expect(results).toContain("presentation.tone");
    expect(results).toContain("presentation.emphasizeRange");
    // The view must not invent its own confidence thresholds.
    expect(/confidence\s*[<>]=?\s*0\.\d/.test(results)).toBe(false);
    // The legacy (pre-FinalResult) path still takes its tone from the engine
    // label field rather than re-deriving one from the number.
    expect(results).toContain("confidenceLabelTone(rec.confidenceLabel)");
    // Plain-language aim tendency is an engine claim with its own support
    // test, never a sentence the UI composes from two percentages.
    expect(results).toContain("describeAimTendency({");
    // Every exclusion sentence comes from the engine's own explanation table.
    expect(results).toContain("explainExclusions(");
    expect(results).toContain("summarizeExclusions(");
  });

  /**
   * Pass 14. The default results view answers the player's five questions and
   * nothing else; every statistic rc.7 printed above the fold is still
   * rendered, inside Advanced results.
   */
  it("keeps statistical detail under Advanced results rather than deleting it", () => {
    const results = sources.get("app/src/resultsView.ts") ?? "";
    const advancedStart = results.indexOf("function renderAdvancedResults(");
    expect(advancedStart).toBeGreaterThan(0);
    const advanced = results.slice(advancedStart);
    // Nothing statistical was discarded to simplify the first screen.
    for (const kept of [
      "candidateComparisons",
      "utilityStandardError",
      "scenarioContributions",
      "searchAdequacyClassification",
      "boundaryStatus",
      "captureQualityGrade",
      "rationaleLines",
      "jsonBlock(fr)",
      "jsonBlock(rec)",
    ]) {
      expect(advanced).toContain(kept);
    }
    // And none of it is rendered before the player-facing summary.
    const summaryEnd = results.indexOf("function renderAdvancedResults(");
    const defaultView = results.slice(0, summaryEnd);
    expect(defaultView).not.toContain("jsonBlock(");
    expect(defaultView).not.toContain("scenarioContributions");
    expect(defaultView).not.toContain("utilityStandardError");
  });

  it("history summaries carry the engine confidence label (no numeric reinterpretation)", () => {
    const api = readFileSync("src/history/api.ts", "utf8");
    expect(api).toContain("confidenceLabel");
  });

  /**
   * Pass 10. The arena overlay is information, never a shield. rc.3 shipped it
   * at `inset: 0` over the canvas with the default `pointer-events: auto`, so
   * it silently ate every "click to lock in" click on real Windows hardware.
   * Only the explicit action row inside it may accept pointer events.
   */
  it("arena overlay cannot intercept pointer events", () => {
    const css = readNormalised("app/styles.css");
    const rule = /\.overlay-message\s*\{([^}]*)\}/.exec(css);
    expect(rule, ".overlay-message rule missing").not.toBeNull();
    expect(rule![1]).toContain("pointer-events: none");
    const actions = /\.overlay-actions\s*\{([^}]*)\}/.exec(css);
    expect(actions, ".overlay-actions rule missing").not.toBeNull();
    expect(actions![1]).toContain("pointer-events: auto");
  });

  /**
   * The click that starts a test must reach a listener that also sees clicks
   * landing on the overlay, and it must request Pointer Lock inside the user
   * gesture — Chromium refuses gesture-less requests.
   */
  it("the arena start click listens on the stage and locks inside the gesture", () => {
    const main = sources.get("app/src/main.ts") ?? "";
    expect(main).toContain('stageInner.addEventListener("click"');
    expect(main).not.toContain('canvas.addEventListener("click"');
    expect(main).toContain("c.requestCaptureFromUserGesture()");
  });

  /**
   * The run screen reports the capture path it is ACTUALLY on. A hardcoded
   * caption cannot tell the player that a ready native helper is sitting idle.
   */
  it("the capture caption is derived, never hardcoded in the view", () => {
    const main = sources.get("app/src/main.ts") ?? "";
    expect(main).toContain("reportCaptureTier");
    const captionLiterals = main.match(/"browser capture · pointer lock"/g) ?? [];
    // The only permitted literal is the degraded fallback when the report
    // itself fails; the caption otherwise comes from captureTiers.ts.
    expect(captionLiterals.length).toBeLessThanOrEqual(1);
    const tiers = sources.get("app/src/captureTiers.ts") ?? "";
    expect(tiers).toContain("decideCaptureTier");
  });

  /** Neither control may depend on a runner that does not exist yet. */
  it("Pause and End session never forward blindly to a missing runner", () => {
    const rc = sources.get("app/src/runController.ts") ?? "";
    expect(rc).toContain("#cancelledBeforeStart");
    expect(rc).toContain("abortPendingLock");
    const main = sources.get("app/src/main.ts") ?? "";
    // End session must have a path that works with no controller at all.
    expect(main).toContain("if (!controller) {");
  });
});
