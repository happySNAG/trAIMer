import { expect, test } from "@playwright/test";

/**
 * UI Design Pass 1 coverage: app shell, distraction-free run screen,
 * data-safety surfaces, and diagnostics presentation.
 */

test.describe("app shell", () => {
  test("sidebar navigation switches views and marks the active item", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#tabs button.active")).toHaveAttribute("data-tab", "home");
    await page.click(`#tabs button[data-tab="history"]`);
    await expect(page.locator("#tabs button.active")).toHaveAttribute("data-tab", "history");
    await expect(page.locator("#tabs button.active")).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#view-home")).toBeHidden();
    await expect(page.locator("#view-history")).toBeVisible();
  });

  test("wordmark and brand identity render", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".wordmark-name")).toHaveText("ALDO");
    await expect(page.locator(".wordmark-sub")).toHaveText("Aim Lab");
  });
});

test.describe("run screen", () => {
  test("starting a session enters distraction-free mode with session chrome", async ({ page }) => {
    await page.goto("/");
    await page.click(`#tabs button[data-tab="setup"]`);
    await page.click(`#view-setup button[type=submit]`);

    // Navigation chrome is stripped; run chrome is present.
    await expect(page.locator("#sidebar")).toBeHidden();
    await expect(page.locator(".run-topbar")).toBeVisible();
    await expect(page.locator("#run-canvas")).toBeVisible();
    await expect(page.locator(".run-bottombar")).toContainText("measured trials");
    // Capture-source transparency is always visible during a session.
    await expect(page.locator(".run-bottombar")).toContainText("browser capture");
    await expect(page.locator(".overlay-title")).toContainText("Click to lock in");

    // Ending the session asks for confirmation; cancel keeps the session.
    await page.click(".run-controls button:has-text('End session')");
    await expect(page.locator(".dialog")).toBeVisible();
    await page.click(".dialog button:has-text('Cancel')");
    await expect(page.locator(".dialog")).toHaveCount(0);
    await expect(page.locator("#run-canvas")).toBeVisible();
  });
});

test.describe("data safety surfaces", () => {
  test("whole-store backup downloads a checksummed file", async ({ page }) => {
    await page.goto("/");
    await page.click(`#tabs button[data-tab="data"]`);
    const downloadPromise = page.waitForEvent("download");
    await page.click("#view-data button:has-text('Back up all data')");
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain("aldo-aim-lab-backup");
    await expect(page.locator("#view-data")).toContainText("SHA-256");
  });

  test("restore lives in a danger zone behind an explicit confirmation", async ({ page }) => {
    await page.goto("/");
    await page.click(`#tabs button[data-tab="data"]`);
    await expect(page.locator("#view-data .danger-zone")).toBeVisible();
    await expect(page.locator("#view-data .danger-zone")).toContainText("Restore");
  });
});

test.describe("diagnostics presentation", () => {
  test("player-level status tiles render before any technical detail", async ({ page }) => {
    await page.goto("/");
    await page.click(`#tabs button[data-tab="diagnostics"]`);
    await expect(page.locator("#view-diagnostics .diag-tile").first()).toBeVisible();
    await expect(page.locator("#view-diagnostics")).toContainText("Mouse input");
    // Technical connection settings are collapsed by default.
    const details = page.locator("#view-diagnostics details", { hasText: "Connection settings" });
    await expect(details).not.toHaveAttribute("open", "");
  });
});
