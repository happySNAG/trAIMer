import { expect, test } from "@playwright/test";
import {
  buildFinalResult,
  planNextTest,
  type Recommendation,
} from "../../src/index.ts";

/**
 * Result-state torture matrix (Pass 7, requirement N).
 *
 * Every engine-reachable result state is pushed through the REAL results
 * renderer (via the ?e2e=1 test adapter → renderResultsView). For each state
 * the screen must show: no NaN/undefined text, no broken range bars, a
 * present next action, and confidence wording that matches the engine label.
 */

function baseRecommendation(overrides: Record<string, unknown> = {}): Recommendation {
  return {
    experimentId: "experiment-torture",
    primarySensitivity: { sensX: 7.4, sensY: 7.4 },
    recommendedEdpi: 5920,
    sensXRange: { min: 7.1, max: 7.8 },
    edpiRange: { min: 5680, max: 6240 },
    confidence: 0.85,
    confidenceLabel: "high",
    dimensionEstimates: {},
    utilityWeights: {},
    evidence: {
      trialsAnalyzed: 60,
      trialsExcluded: 0,
      exclusionReasonCounts: {},
      candidatesEvaluated: 5,
      validTrialsPerCandidate: { a: 12, b: 12, c: 12, d: 12, e: 12 },
      bestCandidateId: "cand-b",
      runnerUpCandidateId: "cand-c",
      utilityGapBestVsRunnerUp: 0.09,
      utilityGapZScore: 2.9,
      separation: "clear",
      searchRoundsRun: 2,
      notes: [],
    },
    warnings: [],
    refusedHighConfidence: false,
    rationaleLines: ["best candidate leads clearly"],
    unresolvedBoundary: false,
    furtherTestingSuggested: false,
    explanation: {
      whyThisX: ["clear paired contrast"],
      whyThisY: ["Y matched to X"],
      candidatesTested: [
        { candidateId: "cand-b", edpiX: 5920, utilityMean: 0.66, utilityStandardError: 0.03, validTrials: 12, tiedWithBest: false },
        { candidateId: "cand-c", edpiX: 5440, utilityMean: 0.55, utilityStandardError: 0.04, validTrials: 12, tiedWithBest: false },
      ],
      scenarioContributions: [
        { scenarioId: "flick-static-medium", difficultyTier: "core", validTrials: 12, meanUtilityBest: 0.68, meanUtilityRunnerUp: 0.54 },
      ],
      evidenceForWinner: ["clear separation"],
      evidenceAgainstWinner: [],
      uncertaintyRemaining: [],
      furtherTestingActions: [],
      boundaryReached: false,
      captureQualityAdequate: true,
    },
    confidenceCalibration: {
      basis: "heuristic",
      heuristicVersion: "heuristic-v2",
      diagnostics: {},
      empiricalModelVersion: null,
      notes: [],
    },
    sensitivityChangePlan: null,
    jointXY: null,
    curveAdequacy: null,
    inputQuality: null,
    changePointAnalysis: null,
    unresolvedLowBoundary: false,
    unresolvedHighBoundary: false,
    multimodalEvidence: false,
    engineVersion: "engine-v4",
    appVersion: "1.0.0-rc.1",
    optimizerVersion: "optimizer-v3",
    ...overrides,
  } as unknown as Recommendation;
}

function buildState(
  rec: Recommendation,
  calibration: { adequate: boolean; stale: boolean; detailLine: string } | null = null,
  dpi = 800,
) {
  const retestPlan =
    rec.furtherTestingSuggested || rec.unresolvedBoundary
      ? planNextTest(
          {
            id: rec.experimentId,
          } as never,
          rec,
          { priorSessionEndedAtIso: new Date().toISOString(), nowIso: new Date().toISOString(), orderSeed: 11 },
        )
      : null;
  return buildFinalResult({
    recommendation: rec,
    dpi,
    currentSensXPercent: 7,
    currentSensYPercent: 7,
    calibration,
    retestPlan,
  });
}

const STATES: { name: string; overrides: Record<string, unknown>; calibration?: null | { adequate: boolean; stale: boolean; detailLine: string } }[] = [
  { name: "strong-clear-optimum", overrides: {} },
  {
    name: "moderate-confidence",
    overrides: { confidence: 0.62, confidenceLabel: "moderate" },
  },
  {
    name: "low-confidence",
    overrides: { confidence: 0.3, confidenceLabel: "low", refusedHighConfidence: true, furtherTestingSuggested: true },
  },
  {
    name: "broad-plateau",
    overrides: {
      sensXRange: { min: 4.5, max: 10.5 },
      edpiRange: { min: 3600, max: 8400 },
      warnings: ["statistically tied candidates span a wide range"],
      confidence: 0.55,
      confidenceLabel: "moderate",
    },
  },
  {
    name: "unresolved-low-boundary",
    overrides: {
      unresolvedBoundary: true,
      unresolvedLowBoundary: true,
      primarySensitivity: { sensX: 4.6, sensY: 4.6 },
      recommendedEdpi: 3680,
      sensXRange: { min: 4.6, max: 5.4 },
      edpiRange: { min: 3680, max: 4320 },
      confidence: 0.42,
      confidenceLabel: "low",
      furtherTestingSuggested: true,
    },
  },
  {
    name: "unresolved-high-boundary",
    overrides: {
      unresolvedBoundary: true,
      unresolvedHighBoundary: true,
      primarySensitivity: { sensX: 10.4, sensY: 10.4 },
      recommendedEdpi: 8320,
      sensXRange: { min: 9.6, max: 10.4 },
      edpiRange: { min: 7680, max: 8320 },
      confidence: 0.42,
      confidenceLabel: "low",
      furtherTestingSuggested: true,
    },
  },
  {
    name: "multimodal-evidence",
    overrides: {
      multimodalEvidence: true,
      warnings: ["evidence suggests two distinct optima"],
      confidence: 0.35,
      confidenceLabel: "low",
      refusedHighConfidence: true,
      explanation: {
        whyThisX: ["local optimum at low eDPI"],
        whyThisY: ["matched"],
        candidatesTested: [
          { candidateId: "cand-a", edpiX: 3600, utilityMean: 0.61, utilityStandardError: 0.04, validTrials: 12, tiedWithBest: true },
          { candidateId: "cand-b", edpiX: 7200, utilityMean: 0.60, utilityStandardError: 0.05, validTrials: 12, tiedWithBest: true },
        ],
        scenarioContributions: [],
        evidenceForWinner: ["two peaks of similar height"],
        evidenceAgainstWinner: ["bimodal shape"],
        uncertaintyRemaining: ["which peak is real"],
        furtherTestingActions: ["retest between the peaks"],
        boundaryReached: false,
        captureQualityAdequate: true,
      },
    },
  },
  {
    name: "insufficient-evidence",
    overrides: {
      confidence: 0.22,
      confidenceLabel: "low",
      evidence: {
        trialsAnalyzed: 6,
        trialsExcluded: 1,
        exclusionReasonCounts: { INSUFFICIENT_SAMPLES: 1 },
        candidatesEvaluated: 2,
        validTrialsPerCandidate: { a: 3, b: 2 },
        bestCandidateId: "a",
        runnerUpCandidateId: null,
        utilityGapBestVsRunnerUp: 0.02,
        utilityGapZScore: 0.3,
        separation: "none",
        searchRoundsRun: 1,
        notes: [],
      },
      furtherTestingSuggested: true,
      refusedHighConfidence: true,
    },
  },
  {
    name: "capture-quality-failure",
    overrides: {
      inputQuality: { score: 0.31, jitterCv: 0.42, continuousMotionRatio: 0.4, verdict: "poor" },
      confidence: 0.4,
      confidenceLabel: "low",
      refusedHighConfidence: true,
      warnings: ["input quality below threshold"],
    },
  },
  {
    name: "adaptation-contamination",
    overrides: {
      changePointAnalysis: { detected: true, trialIndex: 18, direction: "improving", magnitude: 0.21 },
      adaptationContamination: true as never,
      warnings: ["performance shifted mid-session (learning or fatigue)"],
    },
  },
  {
    name: "stale-calibration",
    overrides: {},
    calibration: { adequate: true, stale: true, detailLine: "calibration is over 90 days old" },
  },
  {
    name: "staged-change",
    overrides: {
      sensitivityChangePlan: {
        policyApplied: true,
        currentSensX: 7,
        recommendedNowSensX: 7.25,
        recommendedNowEdpi: 5800,
        fullInferredSensX: 7.4,
        fullInferredEdpi: 5920,
        stepOctavesAllowed: 0.25,
        rationaleLines: ["change exceeds safe daily step"],
        retestAfterSessions: 1,
      },
    },
  },
  {
    name: "equal-x-y",
    overrides: { primarySensitivity: { sensX: 7.0, sensY: 7.0 }, recommendedEdpi: 5600 },
  },
  {
    name: "unequal-x-y",
    overrides: { primarySensitivity: { sensX: 7.8, sensY: 6.2 }, recommendedEdpi: 5600 },
  },
  {
    name: "retest-required",
    overrides: { furtherTestingSuggested: true, confidence: 0.5, confidenceLabel: "moderate" },
  },
  {
    name: "continue-another-day",
    overrides: { confidence: 0.28, confidenceLabel: "low", refusedHighConfidence: true, furtherTestingSuggested: true },
  },
];

for (const state of STATES) {
  test(`result state renders honestly and completely: ${state.name}`, async ({ page }) => {
    await page.goto("/?e2e=1&nostart=1");
    await page.click(`#tabs button[data-tab="setup"]`);
    // Start + immediately abort a minimal session so the e2e controller (and
    // therefore the test hooks) exists.
    await page.locator("#view-setup input[type=text]").first().fill("TorturePlayer");
    await page.click("#view-setup details.details summary");
    await page.locator("#setup-seed").fill("7");
    await page.locator("#setup-rounds").fill("1");
    await page.locator("#setup-reps").fill("3");
    await page.locator("#setup-warmups").fill("0");
    await page.locator("#setup-ycheck").uncheck();
    await page.click("#view-setup button[type=submit]");
    await page.waitForFunction(() => window.__ALDO_TEST_HOOKS__ !== undefined);

    const rec = baseRecommendation(state.overrides);
    const finalResult = buildState(
      rec,
      state.calibration ?? null,
    );

    await page.evaluate((payload) => {
      window.__ALDO_TEST_HOOKS__!.renderResultsForTesting(payload);
    }, {
      recommendation: JSON.parse(JSON.stringify(rec)),
      finalResult: JSON.parse(JSON.stringify(finalResult)),
      trialsAnalyzed: rec.evidence.trialsAnalyzed,
    });

    const results = page.locator("#view-results");
    await expect(results).toContainText("Recommended sensitivity");

    // No NaN / undefined may ever be visible.
    const bodyText = (await results.innerText()) ?? "";
    expect(bodyText).not.toMatch(/NaN|undefined|null\b|Infinity/);

    // A next action is always present.
    expect(bodyText).toContain("What to do next");

    // The words above the number come from the engine's confidence, and the
    // strongest wording is reserved for the strongest evidence.
    const titles: Record<string, string> = {
      high: "High-confidence recommendation",
      moderate: "Moderate-confidence recommendation",
    };
    const expectedTitle = titles[finalResult.confidenceLabel];
    if (expectedTitle) {
      expect(bodyText).toContain(expectedTitle);
    } else {
      // A "low" label must never be typeset as a confident verdict.
      expect(bodyText).not.toContain("High-confidence recommendation");
      expect(bodyText).not.toContain("Moderate-confidence recommendation");
      expect(bodyText).toMatch(/Preliminary recommendation|Directional estimate/);
      // …and the RANGE, not the point estimate, carries the message.
      expect(bodyText).toContain("The evidence supports this RANGE");
    }

    // Range bars have finite widths (no broken chart geometry).
    for (const bar of await page.locator(".range-bar-fill, .meter-fill").all()) {
      const width = await bar.evaluate((el) => el.getBoundingClientRect().width);
      expect(width, "range/meter fill width").toBeGreaterThanOrEqual(0);
      expect(width).toBeLessThanOrEqual(2000);
    }
  });
}
