import { expect, test, type Page } from "@playwright/test";
import { finalResult, recommendation } from "./gameProfileFixtures.ts";

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

  test("offers the eleven public games alphabetically, then Generic / Raw, and no fixture", async ({
    page,
  }) => {
    await page.goto("/");
    await page.click(`#tabs button[data-tab="setup"]`);
    const options = page.locator("#game-profile-select option");
    await expect(options).toHaveCount(13);
    await expect(options.nth(0)).toHaveText(/No game selected/);
    await expect(page.locator("#game-profile-select optgroup[label='Games (A–Z)'] option")).toHaveText([
      "Apex Legends",
      "Battlefield 6 (experimental)",
      "Call of Duty / Warzone",
      "Counter-Strike 2",
      "Fortnite",
      "Marvel Rivals",
      "Overwatch 2",
      "PUBG: Battlegrounds (experimental)",
      "Rainbow Six Siege",
      "The Finals",
      "Valorant",
    ]);
    await expect(page.locator("#game-profile-select optgroup[label='Other'] option")).toHaveText([
      "Generic / Raw",
    ]);
    await expect(page.locator("#game-profile-select")).not.toContainText("Fixture");
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
    await expect(results).toContainText("Recommended for Generic / Raw");
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
