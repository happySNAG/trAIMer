import { expect, test } from "@playwright/test";

test.describe("boot and navigation", () => {
  test("application boots with all nav items and version footer", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#tabs")).toBeVisible();
    for (const tab of ["Home", "Test", "Results", "History", "Calibration", "Diagnostics", "Data"]) {
      await expect(page.locator(`#tabs button[data-tab]`, { hasText: tab })).toBeVisible();
    }
    await expect(page.locator("#app-footer")).toContainText("local-only");
  });

  test("Home renders readiness, current setup, and the primary start action", async ({ page }) => {
    await page.goto("/");
    // First use (no history) greets without "back".
    await expect(page.locator("#view-home .page-title")).toContainText("Welcome");
    await expect(page.locator("#view-home button", { hasText: "Start Aim Test" })).toBeVisible();
    await expect(page.locator("#view-home")).toContainText("Mouse DPI");
    await expect(page.locator("#view-home")).toContainText("eDPI");
  });

  test("IndexedDB initializes and Data view renders", async ({ page }) => {
    await page.goto("/");
    await page.click(`#tabs button[data-tab="data"]`);
    await expect(page.locator("#view-data h2")).toHaveText("Data");
    await expect(page.locator("#view-data h3").first()).toBeVisible();
    await expect(page.locator("#view-data button", { hasText: "Back up all data" })).toBeVisible();
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

  test("Calibration view renders the guided manual workflow", async ({ page }) => {
    await page.goto("/");
    await page.click(`#tabs button[data-tab="calibration"]`);
    await expect(page.locator("#view-calibration")).toContainText("Guided procedure");
    await expect(page.locator("#view-calibration button", { hasText: "Start rep" })).toBeVisible();
    // Compute stays disabled until at least one rep is recorded.
    await expect(
      page.locator("#view-calibration button", { hasText: "Compute & save calibration" }),
    ).toBeDisabled();
  });

  test("Test tab shows the preflight readiness report", async ({ page }) => {
    await page.goto("/");
    await page.click(`#tabs button[data-tab="setup"]`);
    await expect(page.locator("#setup-preflight")).toContainText("System readiness", {
      timeout: 15_000,
    });
    // Category groups from the engine's checks.
    for (const group of ["Mouse", "Capture", "Storage"]) {
      await expect(page.locator("#setup-preflight .preflight-group-name", { hasText: group })).toBeVisible();
    }
  });

  test("Results tab renders an intentional empty state before any session", async ({ page }) => {
    await page.goto("/");
    await page.click(`#tabs button[data-tab="results"]`);
    await expect(page.locator("#view-results h2").first()).toHaveText("Results");
    await expect(page.locator("#view-results")).toContainText("No results yet", { timeout: 10_000 });
  });
});

test.describe("setup workflow and validation", () => {
  test("settings persist across reload", async ({ page }) => {
    await page.goto("/");
    await page.click(`#tabs button[data-tab="setup"]`);
    const name = page.locator("#view-setup input[type=text]").first();
    await name.fill("PlaywrightTester");
    await page.click(`#view-setup button[type=submit]`);
    // We are now on the distraction-free Run view; reload back to the app shell.
    await page.reload();
    await page.click(`#tabs button[data-tab="setup"]`);
    const reloadName = page.locator("#view-setup input[type=text]").first();
    await expect(reloadName).toHaveValue("PlaywrightTester");
  });

  test("form clamps out-of-range values instead of accepting them", async ({ page }) => {
    await page.goto("/");
    await page.click(`#tabs button[data-tab="setup"]`);
    // Advanced parameters live behind a collapsed details element.
    await page.click("#view-setup details.details summary");
    const reps = page.locator('#view-setup input[type="number"]').nth(5);
    await reps.fill("999");
    await page.click(`#view-setup button[type=submit]`);
    // Reload so the form re-renders from PERSISTED settings (clamped on save).
    await page.reload();
    await page.click(`#tabs button[data-tab="setup"]`);
    await page.click("#view-setup details.details summary");
    const reloaded = page.locator('#view-setup input[type="number"]').nth(5);
    const value = Number(await reloaded.inputValue());
    expect(value).toBeLessThanOrEqual(20);
    expect(value).toBeGreaterThanOrEqual(3);
  });
});
