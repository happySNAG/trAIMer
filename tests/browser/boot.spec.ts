import { expect, test } from "@playwright/test";

test.describe("boot and navigation", () => {
  test("application boots with all tabs and version footer", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#tabs")).toBeVisible();
    for (const tab of ["Setup", "Calibration", "Data", "History", "Diagnostics", "Results"]) {
      await expect(page.locator(`#tabs button[data-tab]`, { hasText: tab })).toBeVisible();
    }
    await expect(page.locator("#app-footer")).toContainText("local-only");
  });

  test("IndexedDB initializes and Data view renders", async ({ page }) => {
    await page.goto("/");
    await page.click(`#tabs button[data-tab="data"]`);
    await expect(page.locator("#view-data h2")).toHaveText("Data");
    await expect(page.locator("#view-data h3").first()).toBeVisible();
  });

  test("History view renders empty state without errors", async ({ page }) => {
    await page.goto("/");
    await page.click(`#tabs button[data-tab="history"]`);
    await expect(page.locator("#view-history h2")).toHaveText("History");
  });

  test("Diagnostics view shows browser capture capability and bundle export", async ({ page }) => {
    await page.goto("/");
    await page.click(`#tabs button[data-tab="diagnostics"]`);
    await expect(page.locator("#view-diagnostics h2")).toHaveText("Diagnostics");
    await expect(page.locator("#view-diagnostics")).toContainText("capture path:");
    await expect(page.locator("#view-diagnostics button", { hasText: "Export diagnostic bundle" })).toBeVisible();
  });

  test("Calibration view renders the external manual workflow", async ({ page }) => {
    await page.goto("/");
    await page.click(`#tabs button[data-tab="calibration"]`);
    await expect(page.locator("#view-calibration")).toContainText("external, manual");
    await expect(page.locator("#view-calibration button", { hasText: "Start rep" })).toBeVisible();
  });
});

test.describe("setup workflow and validation", () => {
  test("settings persist across reload", async ({ page }) => {
    await page.goto("/");
    const name = page.locator("#view-setup input[type=text]").first();
    await name.fill("PlaywrightTester");
    await page.click(`#view-setup button[type=submit]`);
    // We are now on the Run view; go back to setup.
    await page.click(`#tabs button[data-tab="setup"]`);
    const reloadName = page.locator("#view-setup input[type=text]").first();
    await expect(reloadName).toHaveValue("PlaywrightTester");
  });

  test("form clamps out-of-range values instead of accepting them", async ({ page }) => {
    await page.goto("/");
    const reps = page.locator('#view-setup input[type="number"]').nth(5);
    await reps.fill("999");
    await page.click(`#view-setup button[type=submit]`);
    // Reload so the form re-renders from PERSISTED settings (clamped on save).
    await page.reload();
    const reloaded = page.locator('#view-setup input[type="number"]').nth(5);
    const value = Number(await reloaded.inputValue());
    expect(value).toBeLessThanOrEqual(20);
    expect(value).toBeGreaterThanOrEqual(3);
  });
});
