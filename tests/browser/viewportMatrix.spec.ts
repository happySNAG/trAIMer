import { expect, test, type Page } from "@playwright/test";

/**
 * Screen-size torture matrix (Pass 7, requirement R).
 *
 * Representative resolutions from 1280×720 laptop through 4K: no horizontal
 * overflow, no clipped dialogs, and the primary action of each key view stays
 * on-screen and clickable.
 */

const SIZES = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3840, height: 2160 },
] as const;

test.describe("viewport matrix", () => {
  for (const size of SIZES) {
    test(`no overflow or lost primary actions at ${size.width}×${size.height}`, async ({ page }) => {
      await page.setViewportSize({ ...size });
      await page.goto("/");

      // Home.
      await expect(page.locator("#view-home")).toBeVisible();
      expect(await horizontalOverflowPx(page)).toBeLessThanOrEqual(1);

      for (const tab of ["setup", "results", "history", "calibration", "diagnostics", "data"]) {
        await page.click(`#tabs button[data-tab="${tab}"]`);
        await page.waitForTimeout(250);
        expect(await horizontalOverflowPx(page), `overflow on ${tab}`).toBeLessThanOrEqual(1);
      }

      // Primary action present and reachable (scrolling allowed — long
      // setup pages legitimately scroll; it must never be hidden/clipped).
      await page.click('#tabs button[data-tab="setup"]');
      const startBtn = page.locator('#view-setup button[type="submit"]');
      await expect(startBtn).toBeVisible();
      await startBtn.scrollIntoViewIfNeeded();
      const box = await startBtn.boundingBox();
      expect(box, "start button bounding box").not.toBeNull();
      expect(box!.y + box!.height).toBeLessThanOrEqual(size.height);
      expect(box!.width).toBeGreaterThanOrEqual(100);

      // History empty-state CTA visible (primary action present). The view
      // rebuilds on tab activation, so locate the CTA after switching.
      await page.click('#tabs button[data-tab="history"]');
      await page.waitForTimeout(250);
      const historyCta = page.locator("#view-history button", { hasText: /start an aim test/i });
      if (await historyCta.count()) {
        await expect(historyCta.first()).toBeVisible();
        await historyCta.first().scrollIntoViewIfNeeded();
        expect((await historyCta.first().boundingBox())!.width).toBeGreaterThan(50);
      }
    });

    test(`dialogs fit within the viewport at ${size.width}×${size.height}`, async ({ page }) => {
      await page.setViewportSize({ ...size });
      await page.goto("/");
      await page.click('#tabs button[data-tab="data"]');
      const restoreButton = page.locator("#view-data button", { hasText: /restore/i }).first();
      await restoreButton.click();
      await page.locator("#view-data input[type=file]").nth(1).setInputFiles({
        name: "backup.json",
        mimeType: "application/json",
        buffer: Buffer.from("{}"),
      });
      const dialog = page.locator("dialog[open]");
      await expect(dialog).toBeVisible();
      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(size.width);
      expect(box!.y + box!.height).toBeLessThanOrEqual(size.height);
    });
  }
});

function horizontalOverflowPx(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}
