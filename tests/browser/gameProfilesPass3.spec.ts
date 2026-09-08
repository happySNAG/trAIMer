import { expect, test, type Page } from "@playwright/test";
import { finalResult, recommendation } from "./gameProfileFixtures.ts";

/**
 * The second public game batch and the reorganised picker, through the real
 * product (Game Profile Campaign, Pass 3, requirements 9 and 19).
 */

const NEW_IDS = [
  "overwatch-2",
  "rainbow-six-siege",
  "marvel-rivals",
  "pubg-battlegrounds",
  "the-finals",
  "battlefield-6",
];
const PASS_2_IDS = ["fortnite", "valorant", "counter-strike-2", "apex-legends", "call-of-duty-warzone"];

async function openSetup(page: Page): Promise<void> {
  await page.goto("/");
  await page.click(`#tabs button[data-tab="setup"]`);
}

async function enterCurrent(page: Page, profileId: string, value: string): Promise<void> {
  await page.selectOption("#game-profile-select", profileId);
  await page.fill("#game-current-hipfire", value);
  await page.locator("#game-current-hipfire").blur();
}

async function bootWithGame(page: Page, profileId: string, currentHipfire: string, extra?: () => Promise<void>): Promise<void> {
  await page.goto("/?e2e=1&nostart=1");
  await page.click(`#tabs button[data-tab="setup"]`);
  await enterCurrent(page, profileId, currentHipfire);
  if (extra) await extra();
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

function gameCard(page: Page, game: string) {
  return page.locator("#view-results section.card", { hasText: `Recommended for ${game}` });
}

test.describe("the picker with twelve profiles", () => {
  test("all six new profiles, the five from Pass 2, and Generic / Raw are offered; no fixture", async ({ page }) => {
    await openSetup(page);
    const values = await page.locator("#game-profile-select option").evaluateAll((els) =>
      els.map((e) => (e as HTMLOptionElement).value),
    );
    for (const id of [...NEW_IDS, ...PASS_2_IDS, "generic-raw"]) expect(values).toContain(id);
    expect(values.filter((v) => v !== "")).toHaveLength(12);
    await expect(page.locator("#game-profile-select")).not.toContainText("Fixture");
    await expect(page.locator("#game-profile-select")).not.toContainText("Aldo");
  });

  test("the filter box narrows the list by name and clears back to the full list", async ({ page }) => {
    await openSetup(page);
    await expect(page.locator("#game-profile-filter")).toBeVisible();
    await page.fill("#game-profile-filter", "rain");
    const narrowed = await page.locator("#game-profile-select option").evaluateAll((els) =>
      els.map((e) => (e as HTMLOptionElement).value).filter((v) => v !== ""),
    );
    expect(narrowed).toEqual(["rainbow-six-siege"]);
    await page.fill("#game-profile-filter", "");
    await expect(page.locator("#game-profile-select option")).toHaveCount(13);
  });

  test("a game once chosen is listed under Recently used, and the choice survives a reload", async ({ page }) => {
    await openSetup(page);
    await enterCurrent(page, "overwatch-2", "5");
    await expect(page.locator("#game-physical-equivalent")).toContainText("34.6");
    await page.reload();
    await page.click(`#tabs button[data-tab="setup"]`);
    await expect(page.locator("#game-profile-select")).toHaveValue("overwatch-2");
    await expect(page.locator("#game-current-hipfire")).toHaveValue("5");
    await expect(
      page.locator("#game-profile-select optgroup[label='Recently used'] option"),
    ).toHaveText(["Overwatch 2"]);
  });
});

test.describe("each new game shows only the settings it has", () => {
  test("Overwatch 2: one sensitivity, an FOV slider that matters, per-hero zoom philosophies", async ({ page }) => {
    await openSetup(page);
    await page.selectOption("#game-profile-select", "overwatch-2");
    await expect(page.locator("#game-current-hipfire")).toBeVisible();
    await expect(page.locator("#game-current-vertical")).toHaveCount(0);
    await expect(page.locator("#game-fov")).toHaveValue("103");
    await expect(page.locator("#game-matching-select option")).toHaveCount(4);
    await expect(page.locator("#game-profile-status")).toContainText("Partly verified");
    // Pass 4, requirement 22: the badge names THIS game's own limitation.
    await expect(page.locator("#game-profile-status")).toContainText(
      "What it does not cover:",
    );
  });

  test("Rainbow Six Siege: horizontal and vertical whole numbers, a vertical FOV, per-optic philosophies", async ({ page }) => {
    await openSetup(page);
    await page.selectOption("#game-profile-select", "rainbow-six-siege");
    await expect(page.locator("#game-current-hipfire")).toBeVisible();
    await expect(page.locator("#game-current-vertical")).toBeVisible();
    await expect(page.locator("#setup-game-profile")).toContainText("mouse sensitivity — horizontal");
    await expect(page.locator("#game-fov")).toHaveValue("60");
    await expect(page.locator("#game-matching-select option")).toHaveCount(4);
  });

  test("Marvel Rivals: one sensitivity and nothing else", async ({ page }) => {
    await openSetup(page);
    await page.selectOption("#game-profile-select", "marvel-rivals");
    await expect(page.locator("#game-current-hipfire")).toBeVisible();
    await expect(page.locator("#game-current-vertical")).toHaveCount(0);
    await expect(page.locator("#game-fov")).toHaveCount(0);
    await expect(page.locator("#game-matching-select")).toHaveCount(0);
    const details = page.locator("#setup-game-profile details");
    await details.locator("summary").click();
    await expect(details).toContainText("Black Widow");
  });

  test("PUBG: one sensitivity plus the FOV that changes it, labelled experimental", async ({ page }) => {
    await openSetup(page);
    await page.selectOption("#game-profile-select", "pubg-battlegrounds");
    await expect(page.locator("#game-current-hipfire")).toBeVisible();
    await expect(page.locator("#game-current-vertical")).toHaveCount(0);
    // Pass 4 corrected this to the game's own default; 80 is the slider's
    // floor, and separately the FOV the constant is stated at.
    await expect(page.locator("#game-fov")).toHaveValue("90");
    await expect(page.locator("#game-matching-select")).toHaveCount(0);
    await expect(page.locator("#game-profile-status")).toContainText("Experimental");
    // Pass 5, requirement 7: the qualification is visible IN THE LIST, the
    // status block sits above the inputs (before a value can be typed), it
    // is tone-coded so it cannot read as verified, and it says what to do.
    await expect(
      page.locator("#game-profile-select optgroup[label='Games (A–Z)'] option[value='pubg-battlegrounds']"),
    ).toHaveText("PUBG: Battlegrounds (experimental)");
    await expect(page.locator("#game-profile-status")).toHaveClass(/profile-status-experimental/);
    await expect(page.locator("#game-profile-status")).toContainText("check it in the game");
    const statusBeforeInput = await page.evaluate(() => {
      const status = document.querySelector("#game-profile-status");
      const input = document.querySelector("#game-current-hipfire");
      return !!status && !!input && !!(status.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(statusBeforeInput).toBe(true);
  });

  test("The Finals: one whole-number sensitivity, no FOV input, no philosophy choice", async ({ page }) => {
    await openSetup(page);
    await page.selectOption("#game-profile-select", "the-finals");
    await expect(page.locator("#game-current-hipfire")).toBeVisible();
    await expect(page.locator("#game-current-vertical")).toHaveCount(0);
    await expect(page.locator("#game-fov")).toHaveCount(0);
    await expect(page.locator("#game-matching-select")).toHaveCount(0);
  });

  test("Battlefield 6: one sensitivity, coefficient philosophies, labelled experimental", async ({ page }) => {
    await openSetup(page);
    await page.selectOption("#game-profile-select", "battlefield-6");
    await expect(page.locator("#game-current-hipfire")).toBeVisible();
    await expect(page.locator("#game-current-vertical")).toHaveCount(0);
    await expect(page.locator("#game-fov")).toHaveCount(0);
    await expect(page.locator("#game-matching-select option")).toHaveCount(3);
    await expect(page.locator("#game-matching-select")).not.toContainText("Same physical sensitivity");
    await expect(page.locator("#game-profile-status")).toContainText("Experimental");
    await expect(
      page.locator("#game-profile-select optgroup[label='Games (A–Z)'] option[value='battlefield-6']"),
    ).toHaveText("Battlefield 6 (experimental)");
    await expect(page.locator("#game-profile-status")).toHaveClass(/profile-status-experimental/);
    const details = page.locator("#setup-game-profile details");
    await details.locator("summary").click();
    await expect(details).toContainText("Battlefield 2042 and earlier");
  });
});

test.describe("current settings become a physical equivalent, before any calibration", () => {
  const cases: [string, string, string, string?][] = [
    ["overwatch-2", "5", "34.6"],
    ["rainbow-six-siege", "24", "8.3"],
    ["marvel-rivals", "3.5", "18.7"],
    // PUBG's hip-fire scales with the FOV, so its case sets one; see the
    // dedicated FOV test below for the default.
    ["pubg-battlegrounds", "25", "20.6", "80"],
    ["the-finals", "40", "28.6"],
    ["battlefield-6", "12", "38.0"],
  ];
  for (const [id, value, cm, fov] of cases) {
    test(`${id}: ${value} at 800 DPI is ${cm} cm/360${fov ? ` at FOV ${fov}` : ""}`, async ({ page }) => {
      await openSetup(page);
      await enterCurrent(page, id, value);
      if (fov) {
        await page.fill("#game-fov", fov);
        await page.locator("#game-fov").blur();
      }
      const equivalent = page.locator("#game-physical-equivalent");
      await expect(equivalent).toBeVisible();
      await expect(equivalent).toContainText(cm);
    });
  }

  test("PUBG's physical equivalent follows its FOV slider", async ({ page }) => {
    await openSetup(page);
    await enterCurrent(page, "pubg-battlegrounds", "25");
    // At the game's default FOV of 90 — not the 80 the constant is stated at.
    await expect(page.locator("#game-physical-equivalent")).toContainText("18.3");
    await page.fill("#game-fov", "80");
    await page.locator("#game-fov").blur();
    await expect(page.locator("#game-physical-equivalent")).toContainText("20.6");
    await page.fill("#game-fov", "103");
    await page.locator("#game-fov").blur();
    await expect(page.locator("#game-physical-equivalent")).toContainText("16.0");
  });

  test("every new profile's version and source are one click away", async ({ page }) => {
    await openSetup(page);
    for (const id of NEW_IDS) {
      await page.selectOption("#game-profile-select", id);
      const details = page.locator("#setup-game-profile details");
      await details.locator("summary").click();
      await expect(details).toContainText("Conversion definition");
      await expect(details).toContainText("v1");
      await expect(details).toContainText("2026-09-08");
      await expect(details).toContainText("https://");
    }
  });
});

test.describe("a converted recommendation, per new game", () => {
  test("Overwatch 2: 5.00 becomes 6.00 and each hero keeps its own relative zoom line", async ({ page }) => {
    await bootWithGame(page, "overwatch-2", "5");
    const card = gameCard(page, "Overwatch 2");
    await expect(card).toContainText("6.00");
    await expect(card).toContainText("Widowmaker — Relative Aim Sensitivity While Zoomed");
    await expect(card).toContainText("Ana — Relative Aim Sensitivity While Zoomed");
    await expect(card).toContainText("Ashe — Relative Aim Sensitivity While Zoomed");
    await expect(card).toContainText("30.00%");
    await expect(card).toContainText("20.0% faster");
  });

  test("Overwatch 2 with FOV-relative matching shows 37.89% for Widowmaker", async ({ page }) => {
    await bootWithGame(page, "overwatch-2", "5", async () => {
      await page.selectOption("#game-matching-select", "1");
    });
    const card = gameCard(page, "Overwatch 2");
    await expect(card).toContainText("37.89%");
    await expect(card).toContainText("51.47%");
    await expect(card).toContainText("Match what you see");
  });

  test("Rainbow Six Siege: both axes as whole numbers, exact versus entered, eight optic lines at 50", async ({ page }) => {
    // 24 × 1.2 = 28.8 → the game takes 29.
    await bootWithGame(page, "rainbow-six-siege", "24");
    const card = gameCard(page, "Rainbow Six Siege");
    await expect(card).toContainText("29");
    await expect(page.locator("#game-exact-vs-entered")).toContainText("28.80");
    const keys = card.locator("dl.kv").first().locator("dt");
    await expect(keys).toHaveCount(10);
    await expect(card).toContainText("ADS sensitivity 12.0×");
    await expect(card).toContainText("Partly verified");
  });

  test("PUBG: the recommendation carries the experimental warning and the FOV it is for", async ({ page }) => {
    await bootWithGame(page, "pubg-battlegrounds", "25");
    const card = gameCard(page, "PUBG: Battlegrounds");
    await expect(card).toContainText("30");
    await expect(card).toContainText("Experimental profile");
    await expect(card).toContainText("experimental");
    await expect(card).toContainText("90°");
    const keys = card.locator("dl.kv").first().locator("dt");
    await expect(keys).toHaveCount(1);
  });

  test("The Finals: a whole number and the zoom left at the game's own 100%", async ({ page }) => {
    await bootWithGame(page, "the-finals", "40");
    const card = gameCard(page, "The Finals");
    await expect(card).toContainText("48");
    await expect(card).toContainText("Mouse zoom sensitivity multiplier");
    await expect(card).toContainText("100%");
    await expect(card).toContainText("focal-length");
  });

  test("Battlefield 6: the ADS answer is the Uniform Soldier Aiming coefficient", async ({ page }) => {
    await bootWithGame(page, "battlefield-6", "12");
    const card = gameCard(page, "Battlefield 6");
    await expect(card).toContainText("14.4");
    await expect(card).toContainText("Uniform Soldier Aiming coefficient");
    // Pass 4: the game's own default is 133.3%. 177.8% is the full-width
    // match on 16:9, which is a different philosophy and a different answer.
    await expect(card).toContainText("133.3%");
    await expect(card).toContainText("Experimental profile");
  });

  test("the result section follows the selected game", async ({ page }) => {
    await bootWithGame(page, "marvel-rivals", "3.5");
    await expect(gameCard(page, "Marvel Rivals")).toContainText("4.20");
    await expect(page.locator("#view-results")).not.toContainText("Recommended for Overwatch 2");
  });
});
