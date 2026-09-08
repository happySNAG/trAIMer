import { expect, test, type Page } from "@playwright/test";
import { drivePlayer } from "./arenaPlayer.ts";
import { finalResult, recommendation } from "./gameProfileFixtures.ts";

/**
 * The five public game profiles, through the real product
 * (Game Profile Campaign, Pass 2, requirement 16).
 *
 * Every number asserted here is the same number the unit suite derives from
 * the profile's declared constant; the point of this file is that the picker,
 * the results screen and the History tab show it.
 */

async function openSetup(page: Page): Promise<void> {
  await page.goto("/");
  await page.click(`#tabs button[data-tab="setup"]`);
}

async function enterCurrent(page: Page, profileId: string, value: string): Promise<void> {
  await page.selectOption("#game-profile-select", profileId);
  await page.fill("#game-current-hipfire", value);
  await page.locator("#game-current-hipfire").blur();
}

/** Boots the E2E hooks with a game chosen and a current value entered. */
async function bootWithGame(page: Page, profileId: string, currentHipfire: string): Promise<void> {
  await page.goto("/?e2e=1&nostart=1");
  await page.click(`#tabs button[data-tab="setup"]`);
  await enterCurrent(page, profileId, currentHipfire);
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

/** The "Recommended for …" card on the results screen. */
function gameCard(page: Page, game: string) {
  return page.locator("#view-results section.card", { hasText: `Recommended for ${game}` });
}

test.describe("each game shows only the settings it has", () => {
  test("Fortnite: X and Y, no field of view, one philosophy", async ({ page }) => {
    await openSetup(page);
    await page.selectOption("#game-profile-select", "fortnite");
    await expect(page.locator("#game-current-hipfire")).toBeVisible();
    await expect(page.locator("#game-current-vertical")).toBeVisible();
    await expect(page.locator("#setup-game-profile")).toContainText("x-axis sensitivity");
    await expect(page.locator("#setup-game-profile")).toContainText("y-axis sensitivity");
    await expect(page.locator("#game-fov")).toHaveCount(0);
    await expect(page.locator("#game-matching-select")).toHaveCount(0);
    await expect(page.locator("#game-profile-status")).toContainText("Partly verified");
  });

  test("Valorant: one sensitivity, a locked FOV, and a choice of scoped matching", async ({ page }) => {
    await openSetup(page);
    await page.selectOption("#game-profile-select", "valorant");
    await expect(page.locator("#game-current-hipfire")).toBeVisible();
    await expect(page.locator("#setup-game-profile")).toContainText("sensitivity: aim");
    await expect(page.locator("#game-current-vertical")).toHaveCount(0);
    await expect(page.locator("#game-fov")).toHaveCount(0);
    await expect(page.locator("#game-matching-select option")).toHaveCount(4);
    await expect(page.locator("#game-matching-select")).toHaveValue("3"); // the game's own default
    const details = page.locator("#setup-game-profile details");
    await details.locator("summary").click();
    await expect(details).toContainText("Fixed at 103°");
  });

  test("Counter-Strike 2: one sensitivity, no FOV input, zoom philosophies", async ({ page }) => {
    await openSetup(page);
    await page.selectOption("#game-profile-select", "counter-strike-2");
    await expect(page.locator("#game-current-hipfire")).toBeVisible();
    await expect(page.locator("#game-current-vertical")).toHaveCount(0);
    await expect(page.locator("#game-fov")).toHaveCount(0);
    await expect(page.locator("#game-matching-select option")).toHaveCount(4);
    // The one fully verified profile shows no caveat badge.
    await expect(page.locator("#game-profile-status")).toHaveCount(0);
  });

  test("Apex Legends: one sensitivity and nothing about optics", async ({ page }) => {
    await openSetup(page);
    await page.selectOption("#game-profile-select", "apex-legends");
    await expect(page.locator("#game-current-hipfire")).toBeVisible();
    await expect(page.locator("#game-current-vertical")).toHaveCount(0);
    // Its FOV slider is real but no conversion reads it, so no input.
    await expect(page.locator("#game-fov")).toHaveCount(0);
    await expect(page.locator("#game-matching-select")).toHaveCount(0);
    const details = page.locator("#setup-game-profile details");
    await details.locator("summary").click();
    await expect(details).toContainText("ADS and per-optic sensitivity are not converted");
    await expect(details).toContainText("70–110°");
  });

  test("Call of Duty / Warzone: sensitivity plus vertical multiplier, coefficient philosophies", async ({
    page,
  }) => {
    await openSetup(page);
    await page.selectOption("#game-profile-select", "call-of-duty-warzone");
    await expect(page.locator("#game-current-hipfire")).toBeVisible();
    await expect(page.locator("#game-current-vertical")).toBeVisible();
    await expect(page.locator("#setup-game-profile")).toContainText("vertical sensitivity multiplier");
    await expect(page.locator("#game-fov")).toHaveCount(0);
    const options = page.locator("#game-matching-select option");
    await expect(options).toHaveCount(3);
    await expect(page.locator("#game-matching-select")).not.toContainText("Same physical sensitivity");
  });
});

test.describe("current settings become a physical equivalent, before any calibration", () => {
  const cases: [string, string, string][] = [
    ["fortnite", "8", "25.7"],
    ["valorant", "0.4", "40.8"],
    ["counter-strike-2", "2", "26.0"],
    ["apex-legends", "1.5", "34.6"],
    ["call-of-duty-warzone", "6", "28.9"],
  ];
  for (const [id, value, cm] of cases) {
    test(`${id}: ${value} at 800 DPI is ${cm} cm/360`, async ({ page }) => {
      await openSetup(page);
      await enterCurrent(page, id, value);
      const equivalent = page.locator("#game-physical-equivalent");
      await expect(equivalent).toBeVisible();
      await expect(equivalent).toContainText(cm);
      await expect(equivalent).toContainText("cm/360");
    });
  }

  test("the same physical aim is one number in every game", async ({ page }) => {
    // CS 2.0 at 800 DPI ≈ 26.0 cm; Valorant 0.629 and Fortnite 7.9% are the
    // same hand movement, and the picker says so without a calibration.
    await openSetup(page);
    await enterCurrent(page, "valorant", "0.629");
    await expect(page.locator("#game-physical-equivalent")).toContainText("26.0");
    await enterCurrent(page, "fortnite", "7.9");
    await expect(page.locator("#game-physical-equivalent")).toContainText("26.0");
  });

  test("the profile's version, status and source are one click away for a named game", async ({
    page,
  }) => {
    await openSetup(page);
    await page.selectOption("#game-profile-select", "valorant");
    const details = page.locator("#setup-game-profile details");
    await expect(details).not.toHaveAttribute("open", "");
    await details.locator("summary").click();
    await expect(details).toContainText("Status");
    await expect(details).toContainText("Partly verified");
    await expect(details).toContainText("Conversion definition");
    await expect(details).toContainText("v1");
    await expect(details).toContainText("Last verified");
    // Pass 4 re-verified the Pass 2 profiles from scratch.
    await expect(details).toContainText("2026-09-08");
    await expect(details).toContainText("Reference");
    await expect(details).toContainText("https://");
    await expect(details).toContainText("What this profile does not cover");
  });
});

test.describe("a converted recommendation, per game", () => {
  test("Valorant: 0.400 becomes 0.480 with the scoped multipliers left at the game's default", async ({
    page,
  }) => {
    await bootWithGame(page, "valorant", "0.4");
    const results = page.locator("#view-results");
    await expect(results).toContainText("Recommended for Valorant");
    await expect(results).toContainText("0.480");
    await expect(results).toContainText("Sensitivity: Aim");
    await expect(results).toContainText("Scoped Sensitivity Multiplier");
    await expect(results).toContainText("1.000");
    await expect(results).toContainText("20.0% faster");
    await expect(results).toContainText("The game's own default");
  });

  test("Fortnite: 7.0% becomes 8.4% on both axes, targeting stays 100%, no scope line", async ({
    page,
  }) => {
    await bootWithGame(page, "fortnite", "7");
    const results = page.locator("#view-results");
    await expect(results).toContainText("Recommended for Fortnite");
    await expect(results).toContainText("8.4%");
    await expect(results).toContainText("Y-axis sensitivity");
    await expect(results).toContainText("Targeting sensitivity");
    await expect(results).toContainText("100.0%");
    const entryKeys = gameCard(page, "Fortnite").locator("dl.kv").first().locator("dt");
    await expect(entryKeys).toHaveText(["X-axis sensitivity", "Y-axis sensitivity", "Targeting sensitivity"]);
    await expect(results).toContainText("Partly verified");
  });

  test("Counter-Strike 2: exact, entry and console values are all shown", async ({ page }) => {
    // 1.73 × 1.2 = 2.076: the settings screen takes 2.08, the console 2.076.
    await bootWithGame(page, "counter-strike-2", "1.73");
    const results = page.locator("#view-results");
    await expect(results).toContainText("Recommended for Counter-Strike 2");
    await expect(results).toContainText("2.08");
    const exact = page.locator("#game-exact-vs-entered");
    await expect(exact).toBeVisible();
    await expect(exact).toContainText("exact equivalent");
    await expect(exact).toContainText("2.0760");
    await expect(exact).toContainText("enter in game");
    await expect(exact).toContainText("configuration file");
    await expect(exact).toContainText("2.076");
    await expect(results).toContainText("Zoom Sensitivity Multiplier");
  });

  test("Apex Legends: the 0.1 slider step is shown as a real loss, and no optic value appears", async ({
    page,
  }) => {
    // 1.7 × 1.2 = 2.04 → the slider takes 2.0; the settings file takes 2.04.
    await bootWithGame(page, "apex-legends", "1.7");
    const results = page.locator("#view-results");
    await expect(results).toContainText("Recommended for Apex Legends");
    await expect(results).toContainText("2.0");
    const exact = page.locator("#game-exact-vs-entered");
    await expect(exact).toContainText("2.040");
    await expect(exact).toContainText("configuration file");
    // The rows the player types: the sensitivity, and nothing about an optic.
    const entryKeys = gameCard(page, "Apex Legends").locator("dl.kv").first().locator("dt");
    await expect(entryKeys).toHaveCount(1);
    await expect(entryKeys.first()).toHaveText("Mouse sensitivity");
    await expect(results).toContainText("Partly verified");
  });

  test("Call of Duty / Warzone: the ADS answer is a coefficient and a mode, not a scalar", async ({
    page,
  }) => {
    await bootWithGame(page, "call-of-duty-warzone", "6");
    const results = page.locator("#view-results");
    await expect(results).toContainText("Recommended for Call of Duty / Warzone");
    await expect(results).toContainText("7.20");
    await expect(results).toContainText("Vertical Sensitivity Multiplier");
    await expect(results).toContainText("Monitor Distance Coefficient");
    await expect(results).toContainText("1.33");
    await expect(results).toContainText("ADS Sensitivity Type to Relative");
    // Exactly three rows: sensitivity, vertical multiplier, coefficient — no
    // per-zoom multipliers and no Legacy value.
    const entryKeys = gameCard(page, "Call of Duty / Warzone").locator("dl.kv").first().locator("dt");
    await expect(entryKeys).toHaveText([
      "Mouse Sensitivity",
      "Vertical Sensitivity Multiplier",
      "Monitor Distance Coefficient",
    ]);
  });

  test("choosing FOV-relative matching changes the Call of Duty coefficient to 0.00", async ({
    page,
  }) => {
    await page.goto("/?e2e=1&nostart=1");
    await page.click(`#tabs button[data-tab="setup"]`);
    await enterCurrent(page, "call-of-duty-warzone", "6");
    await page.selectOption("#game-matching-select", "0");
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
    await expect(results).toContainText("Monitor Distance Coefficient");
    await expect(results).toContainText("0.00");
    await expect(results).toContainText("Match what you see");
  });
});

// ---------------------------------------------------------------------------
// History: a real session, recorded with its profile and version
// ---------------------------------------------------------------------------

function sessionState(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector(".run-screen")?.getAttribute("data-session-state") ?? "",
  );
}

test("a completed session records its profile and version, and changing game later does not rewrite it", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto("/?e2e=1");
  await page.click(`#tabs button[data-tab="setup"]`);
  await page.locator("#view-setup input[type=text]").first().fill("E2EPlayer");
  await page.click("#view-setup details.details summary");
  await page.locator("#setup-seed").fill("1234");
  await page.locator("#setup-rounds").fill("1");
  await page.locator("#setup-reps").fill("6");
  await page.locator("#setup-warmups").fill("0");
  await page.locator("#setup-ycheck").uncheck();
  await enterCurrent(page, "valorant", "0.4");

  await page.click(`#view-setup button[type=submit]`);
  await expect(page.locator("#run-canvas")).toBeVisible();
  await expect(page.locator(".run-screen")).toHaveAttribute("data-session-state", /.+/, {
    timeout: 20_000,
  });
  await page.click("#run-canvas");
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const state = await sessionState(page);
    if (state === "analyzing" || state === "complete" || state === "aborted") break;
    if (state === "awaiting-lock") {
      await page.click("#run-canvas");
      await page.waitForTimeout(150);
    }
    await drivePlayer(page);
    await page.waitForTimeout(60);
  }
  await expect(page.locator("#view-results h2").first()).toHaveText("Results", { timeout: 60_000 });
  await expect(page.locator("#view-results")).toContainText("Recommended for Valorant", {
    timeout: 15_000,
  });
  // Pass 5, requirement 22: "what do I do next?" names the manual step.
  await expect(page.locator("#view-results .next-steps")).toContainText(
    "Open Valorant's settings",
  );
  await expect(page.locator("#view-results .next-steps")).toContainText(
    "does not change game settings",
  );
  // The provenance reference is a real link, not a bare string.
  await expect(page.locator("#view-results a.reference-link").first()).toHaveAttribute(
    "href",
    /^https:\/\//,
  );

  // History carries the id and the definition version, never a display name.
  await page.click(`#tabs button[data-tab="history"]`);
  await page.locator("#view-history .session-row").first().click();
  const detail = page.locator("#view-history .session-detail").first();
  await expect(detail).toContainText("Game conversion");
  await expect(detail).toContainText("valorant v1");
  await expect(detail).toContainText("cm/360");

  // Switching games afterwards changes the setup, not the record.
  await page.click(`#tabs button[data-tab="setup"]`);
  await enterCurrent(page, "counter-strike-2", "2");
  await page.click(`#tabs button[data-tab="history"]`);
  await page.locator("#view-history .session-row").first().click();
  const again = page.locator("#view-history .session-detail").first();
  await expect(again).toContainText("valorant v1");
  await expect(again).not.toContainText("counter-strike-2");
  // ...and the calibration result itself is untouched.
  await expect(page.locator("#view-history")).toContainText("Sensitivity validity");
});
