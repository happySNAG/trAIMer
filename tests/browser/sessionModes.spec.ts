import { test, expect } from "@playwright/test";

/**
 * Choosing how long a calibration should be (Pass 14, requirement 15).
 *
 * The rc.7 setup screen offered "Search rounds" and "Measured reps per
 * candidate per round" inside an Advanced disclosure, and defaulted to the
 * combination that produces 100 drills. A player had no way to ask for a
 * shorter session without understanding the protocol.
 */

test.describe("calibration length", () => {
  test("offers three modes with drills, time and the evidence each buys", async ({ page }) => {
    await page.goto("/?e2e=1&nostart=1");
    await page.click(`#tabs button[data-tab="setup"]`);
    const modes = page.locator("#setup-modes");
    await expect(modes).toBeVisible();
    await expect(modes.locator(".mode-card")).toHaveCount(3);

    await expect(modes).toContainText("Quick");
    await expect(modes).toContainText("Standard");
    await expect(modes).toContainText("Recommended");
    await expect(modes).toContainText("Precision");

    // Each card states drills, an estimated duration, and the evidence target.
    await expect(modes).toContainText("30 drills");
    await expect(modes).toContainText("50 drills");
    await expect(modes).toContainText("100 drills");
    await expect(modes.locator(".mode-fact")).toContainText([/drills/, /min/]);
    await expect(modes).toContainText("usable drills on each of the 5 sensitivities");

    // And NO card promises a confidence percentage in advance.
    const text = (await modes.innerText()) ?? "";
    expect(text).not.toMatch(/\d+\s*%\s*confiden/i);
  });

  test("Standard is the default and drives the advanced plan numbers", async ({ page }) => {
    await page.goto("/?e2e=1&nostart=1");
    await page.click(`#tabs button[data-tab="setup"]`);
    await expect(
      page.locator('.mode-card[data-mode="standard"]'),
    ).toHaveAttribute("aria-pressed", "true");
    await page.click("#view-setup details.details summary");
    await expect(page.locator("#setup-rounds")).toHaveValue("1");
    await expect(page.locator("#setup-reps")).toHaveValue("8");
    await expect(page.locator("#setup-warmups")).toHaveValue("2");
  });

  test("selecting a mode rewrites the plan, and the plan rewrites the mode", async ({ page }) => {
    await page.goto("/?e2e=1&nostart=1");
    await page.click(`#tabs button[data-tab="setup"]`);
    await page.click('.mode-card[data-mode="quick"]');
    await expect(page.locator('.mode-card[data-mode="quick"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.click("#view-setup details.details summary");
    await expect(page.locator("#setup-rounds")).toHaveValue("1");
    await expect(page.locator("#setup-reps")).toHaveValue("5");
    await expect(page.locator("#setup-warmups")).toHaveValue("1");

    await page.click('.mode-card[data-mode="precision"]');
    await expect(page.locator("#setup-rounds")).toHaveValue("2");
    await expect(page.locator("#setup-reps")).toHaveValue("8");

    // Editing a plan number by hand is a deliberate move off the named modes,
    // and the screen says so instead of keeping a label that is now a lie.
    await page.locator("#setup-reps").fill("11");
    await page.locator("#setup-reps").dispatchEvent("input");
    await expect(page.locator('.mode-card[data-mode="precision"]')).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(page.locator("#setup-mode-custom")).toBeVisible();
  });

  test("the selected mode survives a reload", async ({ page }) => {
    await page.goto("/?e2e=1&nostart=1");
    await page.click(`#tabs button[data-tab="setup"]`);
    await page.click('.mode-card[data-mode="quick"]');
    await page.click("#view-setup button[type=submit]");
    // Leaving the arena immediately; the settings were saved on submit.
    await page.reload();
    await page.click(`#tabs button[data-tab="setup"]`);
    await expect(page.locator('.mode-card[data-mode="quick"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.click("#view-setup details.details summary");
    await expect(page.locator("#setup-reps")).toHaveValue("5");
  });

  test("the setup screen says what capture path a session would be measured on", async ({ page }) => {
    await page.goto("/?e2e=1&nostart=1");
    await page.click(`#tabs button[data-tab="setup"]`);
    const capture = page.locator("#setup-capture");
    await expect(capture).toContainText("browser capture");
    // It explains the consequence rather than demanding a setup step…
    await expect(capture).toContainText("plausible range");
    // …and outside the desktop shell there is nothing to offer, so it does
    // not send the player to Diagnostics for no reason.
    await expect(capture.locator("button")).toHaveCount(0);
  });
});
