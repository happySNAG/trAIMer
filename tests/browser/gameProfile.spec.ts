import { expect, test, type Page } from "@playwright/test";
import type { Recommendation } from "../../src/domain/recommendation.ts";
import type { FinalResult } from "../../src/results/finalResult.ts";

/**
 * The player-facing game-profile flow (Game Profile Pass 1, requirements 11,
 * 14, 19, 22).
 *
 * What a player actually does: open the Aim Test screen, pick a game, type
 * the sensitivity they use today, and see what that is physically — with no
 * calibration and no completed session.
 */

test.describe("choosing a game profile", () => {
  test("the picker starts collapsed to a single question", async ({ page }) => {
    await page.goto("/");
    await page.click(`#tabs button[data-tab="setup"]`);

    const panel = page.locator("#setup-game-profile");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Game sensitivity");

    // Progressive disclosure: one select, and nothing that needs a game.
    await expect(page.locator("#game-profile-select")).toBeVisible();
    await expect(page.locator("#game-current-hipfire")).toHaveCount(0);
    await expect(page.locator("#game-physical-equivalent")).toHaveCount(0);
    await expect(panel).toContainText("physical sensitivity");
  });

  test("only the generic profile is offered in this pass", async ({ page }) => {
    await page.goto("/");
    await page.click(`#tabs button[data-tab="setup"]`);
    const options = page.locator("#game-profile-select option");
    await expect(options).toHaveCount(2);
    await expect(options.nth(0)).toHaveText(/No game selected/);
    await expect(options.nth(1)).toHaveText("Generic (raw sensitivity)");
  });

  test("picking a game reveals its settings and nothing else", async ({ page }) => {
    await page.goto("/");
    await page.click(`#tabs button[data-tab="setup"]`);
    await page.selectOption("#game-profile-select", "generic-raw");

    await expect(page.locator("#game-current-hipfire")).toBeVisible();
    await expect(page.locator("#game-current-vertical")).toBeVisible();
    // The generic profile models no field of view, so no FOV field appears.
    await expect(page.locator("#game-fov")).toHaveCount(0);
    // One matching philosophy means no choice is offered.
    await expect(page.locator("#game-matching-select")).toHaveCount(0);
    // The physical equivalent waits for a value.
    await expect(page.locator("#game-physical-equivalent")).toHaveCount(0);
  });

  test("entering a current sensitivity shows the physical equivalent immediately", async ({
    page,
  }) => {
    await page.goto("/");
    await page.click(`#tabs button[data-tab="setup"]`);
    await page.selectOption("#game-profile-select", "generic-raw");
    await page.fill("#game-current-hipfire", "1");
    await page.locator("#game-current-hipfire").blur();

    const equivalent = page.locator("#game-physical-equivalent");
    await expect(equivalent).toBeVisible();
    // 1.00 at the default 800 DPI is 57.2 cm for a full turn.
    await expect(equivalent).toContainText("57.1");
    await expect(equivalent).toContainText("cm/360");
    await expect(page.locator("#game-current-summary")).toContainText("800 DPI");
  });

  test("changing DPI re-states the same setting as a different physical sensitivity", async ({
    page,
  }) => {
    await page.goto("/");
    await page.click(`#tabs button[data-tab="setup"]`);
    await page.selectOption("#game-profile-select", "generic-raw");
    await page.fill("#game-current-hipfire", "1");
    await page.locator("#game-current-hipfire").blur();
    await expect(page.locator("#game-physical-equivalent")).toContainText("57.1");

    await page.fill("#setup-dpi", "1600");
    await page.locator("#setup-dpi").blur();
    // Same in-game number, twice the DPI, half the distance per turn.
    await expect(page.locator("#game-physical-equivalent")).toContainText("28.6");
    await expect(page.locator("#game-physical-equivalent")).toContainText("1600");
  });

  test("the selection and the entered sensitivity survive a reload", async ({ page }) => {
    await page.goto("/");
    await page.click(`#tabs button[data-tab="setup"]`);
    await page.selectOption("#game-profile-select", "generic-raw");
    await page.fill("#game-current-hipfire", "2.5");
    await page.locator("#game-current-hipfire").blur();
    await expect(page.locator("#game-physical-equivalent")).toBeVisible();

    await page.reload();
    await page.click(`#tabs button[data-tab="setup"]`);
    await expect(page.locator("#game-profile-select")).toHaveValue("generic-raw");
    await expect(page.locator("#game-current-hipfire")).toHaveValue("2.5");
  });

  test("the profile's provenance is one click away, not on the main form", async ({ page }) => {
    await page.goto("/");
    await page.click(`#tabs button[data-tab="setup"]`);
    await page.selectOption("#game-profile-select", "generic-raw");

    const details = page.locator("#setup-game-profile details");
    await expect(details).toHaveCount(1);
    await expect(details).not.toHaveAttribute("open", "");
    await details.locator("summary").click();
    await expect(details).toContainText("Last verified");
    await expect(details).toContainText("Conversion definition");
    await expect(details).toContainText("v1");
  });

  test("going back to no game returns to physical-only wording", async ({ page }) => {
    await page.goto("/");
    await page.click(`#tabs button[data-tab="setup"]`);
    await page.selectOption("#game-profile-select", "generic-raw");
    await expect(page.locator("#game-current-hipfire")).toBeVisible();
    await page.selectOption("#game-profile-select", "");
    await expect(page.locator("#game-current-hipfire")).toHaveCount(0);
    await expect(page.locator("#game-profile-empty")).toContainText("360");
  });
});

test.describe("results with a game profile", () => {
  test("the results screen asks for a game when none is selected", async ({ page }) => {
    await page.goto("/?e2e=1&nostart=1");
    await page.click(`#tabs button[data-tab="results"]`);
    // With no session and no game there is nothing to convert; the screen
    // must not invent a game section.
    await expect(page.locator("#view-results")).not.toContainText("Recommended for");
  });
});

// ---------------------------------------------------------------------------
// A converted recommendation, through the production results view
// ---------------------------------------------------------------------------

function recommendation(): Recommendation {
  return {
    experimentId: "experiment-game-e2e",
    primarySensitivity: { sensX: 8.4, sensY: 8.4 },
    recommendedEdpi: 6720,
    sensXRange: { min: 7.6, max: 9.2 },
    edpiRange: { min: 6080, max: 7360 },
    confidence: 0.66,
    confidenceLabel: "moderate",
    dimensionEstimates: {},
    utilityWeights: {},
    evidence: {
      trialsAnalyzed: 30,
      trialsExcluded: 0,
      exclusionReasonCounts: {},
      candidatesEvaluated: 5,
      validTrialsPerCandidate: {},
      bestCandidateId: "cand-c",
      runnerUpCandidateId: "cand-b",
      utilityGapBestVsRunnerUp: 0.05,
      utilityGapZScore: 2.1,
      separation: "clear",
      searchRoundsRun: 1,
      notes: [],
    },
    warnings: [],
    refusedHighConfidence: false,
    rationaleLines: ["the faster candidate led on accuracy"],
    unresolvedBoundary: false,
    furtherTestingSuggested: false,
  } as unknown as Recommendation;
}

function finalResult(rec: Recommendation): FinalResult {
  return {
    contractVersion: "final-result-v1",
    appVersion: "test",
    engineVersion: "engine-v4",
    experimentId: rec.experimentId,
    currentSensitivity: { sensXPercent: 7, sensYPercent: 7, edpi: 5600 },
    immediateRecommended: { sensXPercent: 8.4, sensYPercent: 8.4, edpi: 6720 },
    fullInferredSensitivity: null,
    dpi: 800,
    plausibleXRangePercent: { min: 7.6, max: 9.2 },
    plausibleYRangePercent: { min: 7.6, max: 9.2 },
    plausibleEdpiRange: { min: 6080, max: 7360 },
    confidence: rec.confidence,
    confidenceLabel: rec.confidenceLabel,
    confidenceBasis: "heuristic (v1)",
    refusedHighConfidence: false,
    captureQualityGrade: "acceptable",
    captureQualityScore: 0.72,
    searchAdequacyClassification: "clear-optimum",
    boundaryStatus: "resolved",
    adaptationContamination: false,
    rationaleLines: rec.rationaleLines,
    whyThisX: [],
    whyThisY: [],
    contradictoryEvidence: [],
    uncertaintyRemaining: [],
    candidateComparisons: [],
    scenarioContributions: [],
    excludedTrials: { count: 0, reasonsByCode: {} },
    calibrationState: null,
    recommendedNextAction: "apply-recommended-change",
    nextActionRationale: [],
    retestProtocol: null,
    warnings: [],
  } as unknown as FinalResult;
}

/** Boots the E2E hooks with a game profile already chosen. */
async function bootWithGame(page: Page, currentHipfire: string): Promise<void> {
  await page.goto("/?e2e=1&nostart=1");
  await page.click(`#tabs button[data-tab="setup"]`);
  await page.selectOption("#game-profile-select", "generic-raw");
  await page.fill("#game-current-hipfire", currentHipfire);
  await page.locator("#game-current-hipfire").blur();
  await page.click("#view-setup button[type=submit]");
  await page.waitForFunction(() => window.__ALDO_TEST_HOOKS__ !== undefined);
  const rec = recommendation();
  await page.evaluate(
    (payload) => window.__ALDO_TEST_HOOKS__!.renderResultsForTesting(payload),
    {
      recommendation: JSON.parse(JSON.stringify(rec)),
      finalResult: JSON.parse(JSON.stringify(finalResult(rec))),
      trialsAnalyzed: 30,
      outcome: null,
    },
  );
}

test.describe("a converted recommendation on the results screen", () => {
  test("shows current, recommended and the physical equivalent for the chosen game", async ({
    page,
  }) => {
    await bootWithGame(page, "2");
    const results = page.locator("#view-results");
    await expect(results).toContainText("Recommended for Generic (raw sensitivity)");
    await expect(results).toContainText("Current");
    await expect(results).toContainText("Recommended");
    await expect(results).toContainText("Physical equivalent");
    // 7% → 8.4% is a 1.2x change, so 2.00 becomes 2.40.
    await expect(results).toContainText("2.40");
    await expect(results).toContainText("20.0% faster");
  });

  test("never claims more certainty than the calibration behind it", async ({ page }) => {
    await bootWithGame(page, "2");
    const results = page.locator("#view-results");
    await expect(results).toContainText(
      "Converting a recommendation cannot make it more certain than the measurement above.",
    );
    await expect(results).toContainText("Confidence in the measurement behind this: moderate");
  });

  test("keeps the conversion's provenance one click away", async ({ page }) => {
    await bootWithGame(page, "2");
    const details = page.locator("#view-results details", {
      hasText: "How this conversion was made",
    });
    await expect(details.first()).toBeVisible();
    await details.first().locator("summary").click();
    await expect(details.first()).toContainText("Last verified");
    await expect(details.first()).toContainText("Conversion definition");
  });

  test("asks for a current sensitivity instead of guessing one", async ({ page }) => {
    await page.goto("/?e2e=1&nostart=1");
    await page.click(`#tabs button[data-tab="setup"]`);
    await page.selectOption("#game-profile-select", "generic-raw");
    await page.click("#view-setup button[type=submit]");
    await page.waitForFunction(() => window.__ALDO_TEST_HOOKS__ !== undefined);
    const rec = recommendation();
    await page.evaluate(
      (payload) => window.__ALDO_TEST_HOOKS__!.renderResultsForTesting(payload),
      {
        recommendation: JSON.parse(JSON.stringify(rec)),
        finalResult: JSON.parse(JSON.stringify(finalResult(rec))),
        trialsAnalyzed: 30,
        outcome: null,
      },
    );
    const results = page.locator("#view-results");
    await expect(results).toContainText("Recommended for your game");
    await expect(results).toContainText("Enter the sensitivity you currently use");
  });
});
