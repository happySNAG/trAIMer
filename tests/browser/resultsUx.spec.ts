import { test, expect, type Page } from "@playwright/test";
import type { SessionOutcomeReport } from "../../src/results/sessionOutcome.ts";
import type { Recommendation } from "../../src/domain/recommendation.ts";
import type { FinalResult } from "../../src/results/finalResult.ts";

/**
 * The results page, from the player's seat (Pass 14, requirement 16).
 *
 * The real rc.7 session ended on a page that opened with candidate utility
 * scores, standard errors, scenario contribution tables, search coverage and
 * two raw JSON dumps, and told the player their 43 lost drills had "Broken
 * timestamps". These tests hold the new order — and hold that nothing was
 * deleted to achieve it.
 */

/** The exact numbers from Aldo's real Windows session. */
const REAL_SESSION = {
  measured: 80,
  valid: 37,
  excluded: 43,
  accuracy: 0.71,
  overshoot: 0.12,
  undershoot: 0.09,
  trackingOnTarget: 0.39,
  trackingRms: 68,
  confidence: 0.24,
  sensPercent: 10.58,
  currentSensPercent: 9.2,
};

function outcomeReport(overrides: Partial<SessionOutcomeReport> = {}): SessionOutcomeReport {
  return {
    contractVersion: "session-outcome-v1",
    appVersion: "test",
    engineVersion: "engine-v4",
    experimentId: "experiment-real",
    endKind: "completed",
    endReasonCode: null,
    endReasonText: "You finished the whole calibration plan.",
    endedEarly: false,
    progress: {
      stepsCompleted: 100,
      stepsPlanned: 100,
      fraction: 1,
      roundIndex: 2,
      roundsPlanned: 2,
      blockIndex: 5,
      blocksPerRound: 5,
      measuredCompleted: 80,
      measuredPlanned: 80,
    },
    performance: {
      trialsCompleted: 100,
      warmupTrials: 20,
      measuredTrials: REAL_SESSION.measured,
      validMeasuredTrials: REAL_SESSION.valid,
      excludedTrials: REAL_SESSION.excluded,
      hitAccuracy: REAL_SESSION.accuracy,
      shotsFired: 120,
      reactionTimeMs: 85,
      movementTimeMs: 220,
      overshootTendency: REAL_SESSION.overshoot,
      undershootTendency: REAL_SESSION.undershoot,
      correctionsPerShot: 1.2,
      trackingTimeOnTarget: REAL_SESSION.trackingOnTarget,
      trackingRmsErrorPx: REAL_SESSION.trackingRms,
      acquisitionTimeCv: 0.31,
      trackingTrials: 12,
      exclusionsByReason: { IMPOSSIBLE_TIMESTAMPS: 43 },
    },
    sufficiency: {
      sufficient: true,
      reasons: [],
      additionalMeasuredTrialsNeeded: 0,
      estimatedAdditionalMinutes: 0,
      nextSteps: [],
    },
    recommendationAvailable: true,
    instrumentation: {
      captureTier: 2,
      captureTierCaption: "browser capture · pointer lock",
      captureTierDetail: "Measured samples come from browser Pointer Lock.",
      nativeRejectedBecause:
        "helper is ready but unvalidated — run the capture check in Diagnostics",
      clockSyncState: "not-established",
      clockSyncDetail: null,
      clockOffsetMs: null,
      clockSyncUncertaintyMs: null,
      timestampLead: {
        samples: 41230,
        maxLeadMs: 12.7,
        meanLeadMs: 4.4,
        toleranceMs: 40,
        aheadOfNow: 0,
        foreignDomain: 0,
        missing: 0,
      },
      modeId: "precision",
      targetValidTrialsPerCandidate: 12,
      replacement: { blocksRun: 1, drillsRun: 6, maxBlocks: 3, maxDrills: 40 },
      validTrialsByCandidateEdpi: [
        { edpi: 5451, valid: 7 },
        { edpi: 6400, valid: 8 },
        { edpi: 7360, valid: 7 },
        { edpi: 8464, valid: 8 },
        { edpi: 9936, valid: 7 },
      ],
    },
    ...overrides,
  } as SessionOutcomeReport;
}

function recommendation(confidence: number, label: string): Recommendation {
  return {
    experimentId: "experiment-real",
    recommendedEdpi: REAL_SESSION.sensPercent * 800,
    primarySensitivity: { sensX: REAL_SESSION.sensPercent, sensY: REAL_SESSION.sensPercent },
    edpiRange: { min: 6200, max: 11800 },
    confidence,
    confidenceLabel: label,
    refusedHighConfidence: confidence < 0.5,
    furtherTestingSuggested: confidence < 0.5,
    warnings: [],
    rationaleLines: ["paired comparison over 37 valid measured drills"],
    dimensionEstimates: {
      accuracy: { mean: 0.71, standardError: 0.04, sampleCount: 37 },
      speed: { mean: 0.62, standardError: 0.05, sampleCount: 37 },
    },
    evidence: {
      trialsAnalyzed: 37,
      trialsExcluded: 43,
      candidatesEvaluated: 5,
      separation: "weak",
      searchRoundsRun: 2,
      bestCandidateId: "cand-c",
      runnerUpCandidateId: "cand-b",
      validTrialsPerCandidate: { "cand-a": 7, "cand-b": 8, "cand-c": 7, "cand-d": 8, "cand-e": 7 },
    },
    utilityWeights: {},
  } as unknown as Recommendation;
}

function finalResult(rec: Recommendation): FinalResult {
  return {
    contractVersion: "final-result-v1",
    appVersion: "test",
    engineVersion: "engine-v4",
    experimentId: "experiment-real",
    currentSensitivity: {
      sensXPercent: REAL_SESSION.currentSensPercent,
      sensYPercent: REAL_SESSION.currentSensPercent,
      edpi: REAL_SESSION.currentSensPercent * 800,
    },
    immediateRecommended: {
      sensXPercent: REAL_SESSION.sensPercent,
      sensYPercent: REAL_SESSION.sensPercent,
      edpi: REAL_SESSION.sensPercent * 800,
    },
    fullInferredSensitivity: null,
    dpi: 800,
    plausibleXRangePercent: { min: 7.75, max: 14.75 },
    plausibleYRangePercent: { min: 7.75, max: 14.75 },
    plausibleEdpiRange: { min: 6200, max: 11800 },
    confidence: rec.confidence,
    confidenceLabel: rec.confidenceLabel,
    confidenceBasis: "heuristic (v1)",
    refusedHighConfidence: rec.refusedHighConfidence,
    captureQualityGrade: "acceptable",
    captureQualityScore: 0.72,
    searchAdequacyClassification: "broad-plateau",
    boundaryStatus: "resolved",
    adaptationContamination: false,
    rationaleLines: rec.rationaleLines,
    whyThisX: ["the middle candidate led on accuracy"],
    whyThisY: [],
    contradictoryEvidence: [],
    uncertaintyRemaining: ["the candidates are close together"],
    candidateComparisons: [
      { candidateId: "cand-a", edpiX: 5451, utilityMean: 0.61, utilityStandardError: 0.032, validTrials: 7, tiedWithBest: true, isBest: false },
      { candidateId: "cand-c", edpiX: 7360, utilityMean: 0.66, utilityStandardError: 0.029, validTrials: 7, tiedWithBest: null, isBest: true },
    ],
    scenarioContributions: [
      { scenarioId: "flick-static-small", difficultyTier: "hard", validTrials: 9, meanUtilityBest: 0.64, meanUtilityRunnerUp: 0.61 },
    ],
    excludedTrials: { count: 43, reasonsByCode: { IMPOSSIBLE_TIMESTAMPS: 43 } },
    calibrationState: null,
    recommendedNextAction: "collect-more-sessions",
    nextActionRationale: ["confidence is not yet high enough to justify changing settings"],
    retestProtocol: null,
    warnings: [],
  } as unknown as FinalResult;
}

async function bootHooks(page: Page): Promise<void> {
  await page.goto("/?e2e=1&nostart=1");
  await page.click(`#tabs button[data-tab="setup"]`);
  await page.locator("#view-setup input[type=text]").first().fill("ResultsPlayer");
  await page.click("#view-setup details.details summary");
  await page.locator("#setup-seed").fill("9");
  await page.locator("#setup-rounds").fill("1");
  await page.locator("#setup-reps").fill("3");
  await page.locator("#setup-warmups").fill("0");
  await page.click("#view-setup button[type=submit]");
  await page.waitForFunction(() => window.__ALDO_TEST_HOOKS__ !== undefined);
}

async function render(
  page: Page,
  confidence: number,
  label: string,
  outcomeOverrides: Partial<SessionOutcomeReport> = {},
): Promise<void> {
  const rec = recommendation(confidence, label);
  await page.evaluate(
    (payload) => window.__ALDO_TEST_HOOKS__!.renderResultsForTesting(payload),
    {
      recommendation: JSON.parse(JSON.stringify(rec)),
      finalResult: JSON.parse(JSON.stringify(finalResult(rec))),
      trialsAnalyzed: 37,
      outcome: JSON.parse(JSON.stringify(outcomeReport(outcomeOverrides))),
    },
  );
}

/** Text a player actually sees, with collapsed sections excluded. */
async function visibleText(page: Page): Promise<string> {
  return page.locator("#view-results").innerText();
}

test.describe("results — the player-facing screen", () => {
  test("answers the five questions, in order, before any statistics", async ({ page }) => {
    await bootHooks(page);
    await render(page, REAL_SESSION.confidence, "low");
    const text = await visibleText(page);

    const order = [
      "Recommended sensitivity",
      "How you performed",
      "What to do next",
      "Drills that could not be scored",
      "Advanced results",
    ];
    let cursor = -1;
    for (const heading of order) {
      const at = text.indexOf(heading);
      expect(at, heading).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  test("a low-confidence result is labelled as one and leads with its range", async ({ page }) => {
    await bootHooks(page);
    await render(page, REAL_SESSION.confidence, "low");
    const text = await visibleText(page);
    expect(text).toContain("Directional estimate");
    expect(text).toContain("24% evidence strength");
    expect(text).toContain("The evidence supports this RANGE");
    expect(text).not.toContain("High-confidence recommendation");
    // The number is still THERE — it is just not the headline.
    expect(text).toContain("10.58");
    // And the point estimate is visually de-emphasised, not merely reworded.
    const bigFont = await page
      .locator(".sens-headline.range-first .sens-big")
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(bigFont).toBeLessThan(40);
  });

  test("a strong result is allowed to look strong", async ({ page }) => {
    await bootHooks(page);
    await render(page, 0.88, "high");
    const text = await visibleText(page);
    expect(text).toContain("High-confidence recommendation");
    expect(text).not.toContain("The evidence supports this RANGE");
  });

  test("the four performance cards populate from the session", async ({ page }) => {
    await bootHooks(page);
    await render(page, REAL_SESSION.confidence, "low");
    const cards = page.locator("#results-player-cards");
    await expect(cards).toContainText("Accuracy");
    await expect(cards).toContainText("71%");
    await expect(cards).toContainText("Aim control");
    await expect(cards).toContainText("12% / 9%");
    await expect(cards).toContainText("Slight overshoot tendency");
    await expect(cards).toContainText("Tracking");
    await expect(cards).toContainText("39%");
    await expect(cards).toContainText("68 px");
    await expect(cards).toContainText("Evidence quality");
    await expect(cards).toContainText("37");
  });

  test("exclusions are explained without engineering vocabulary", async ({ page }) => {
    await bootHooks(page);
    await render(page, REAL_SESSION.confidence, "low");
    const text = await visibleText(page);
    expect(text).toContain("43 of 80");
    expect(text).toContain("could not be used for scoring");
    expect(text).toContain("timing of the mouse data");
    // The words a player should never have to meet on the default screen.
    expect(text).not.toContain("Broken timestamps");
    expect(text).not.toContain("IMPOSSIBLE_TIMESTAMPS");
    // …but "Learn more" reveals the exact technical category.
    await page.click("text=Learn more — exactly what happened");
    await expect(page.locator("#view-results")).toContainText("IMPOSSIBLE_TIMESTAMPS");
  });

  test("a fault the app owns never becomes homework for the player", async ({ page }) => {
    await bootHooks(page);
    await render(page, REAL_SESSION.confidence, "low");
    const text = await visibleText(page);
    expect(text).toContain("lost to a measurement fault in the app");
    expect(text).not.toMatch(/retest|try again/i);
  });

  test("raw JSON is not the default experience", async ({ page }) => {
    await bootHooks(page);
    await render(page, REAL_SESSION.confidence, "low");
    const text = await visibleText(page);
    expect(text).not.toContain("contractVersion");
    expect(text).not.toContain("utilityStandardError");
    // Nothing is hidden by being absent: the JSON is in the DOM, collapsed.
    const full = (await page.locator("#view-results").textContent()) ?? "";
    expect(full).toContain("final-result-v1");
    expect(full).toContain("session-outcome-v1");
  });

  test("Advanced results opens and carries every statistic", async ({ page }) => {
    await bootHooks(page);
    await render(page, REAL_SESSION.confidence, "low");
    await page.click("text=Open advanced results");
    const text = await visibleText(page);
    for (const kept of [
      "Candidate comparison",
      "Performance dimensions",
      "Scenario contributions",
      "Search coverage and quality",
      "Capture and timing diagnostics",
      "The evidence so far",
    ]) {
      expect(text, kept).toContain(kept);
    }
    // The engineering values themselves, not just the headings.
    expect(text).toContain("broad-plateau");
    expect(text).toContain("acceptable");
    expect(text).toContain("0.0290");
    // Instrumentation for the next hardware session.
    expect(text).toContain("browser capture · pointer lock");
    expect(text).toContain("12.70 ms");
    expect(text).toContain("tolerance 40 ms");
    expect(text).toContain("Precision");
    expect(text).toContain("6 drill(s) in 1 of at most 3 block(s)");
  });

  test("the capture check is offered when running it would change the tier", async ({ page }) => {
    await bootHooks(page);
    await render(page, REAL_SESSION.confidence, "low");
    await expect(page.locator("#view-results")).toContainText("Run capture check");
    await page.click("#view-results button:has-text('Run capture check')");
    await expect(page.locator("#view-diagnostics")).toBeVisible();
  });

  test("insufficient evidence never looks like a verdict", async ({ page }) => {
    await bootHooks(page);
    await page.evaluate((payload) => {
      window.__ALDO_TEST_HOOKS__!.renderResultsForTesting(payload);
    }, {
      recommendation: null,
      finalResult: null,
      trialsAnalyzed: 0,
      outcome: JSON.parse(
        JSON.stringify(
          outcomeReport({
            recommendationAvailable: false,
            sufficiency: {
              sufficient: false,
              reasons: ["Every candidate sensitivity still needs at least 4 valid measured drills."],
              additionalMeasuredTrialsNeeded: 20,
              estimatedAdditionalMinutes: 2,
              nextSteps: ["Run about 20 more measured drills."],
            },
          }),
        ),
      ),
    });
    const text = await visibleText(page);
    expect(text).toContain("More data needed");
    expect(text).not.toContain("Recommended sensitivity");
    expect(text).not.toContain("eDPI ·");
    expect(text).toContain("What to do next");
    expect(text).toContain("Continue calibration");
    // The cards still populate — a player who played deserves their numbers.
    await expect(page.locator("#results-player-cards")).toContainText("Accuracy");
  });
});
