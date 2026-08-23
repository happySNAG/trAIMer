import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * Full-session automation using the ?e2e=1 test adapter. The adapter grants
 * pointer lock virtually and injects scripted CaptureEvents through the
 * production capture path — no production code is forked.
 */
async function driveTrial(page: Page): Promise<void> {
  // Move the reticle toward the target then click repeatedly; the director
  // resolves the trial on hit or timeout either way.
  await page.evaluate(async () => {
    const hooks = window.__ALDO_TEST_HOOKS__;
    if (!hooks) throw new Error("test hooks missing");
    await hooks.grantLock();
    for (let i = 0; i < 40; i++) {
      await hooks.injectPointerSample(8, i % 2 === 0 ? 2 : -2);
    }
    for (let click = 0; click < 6; click++) {
      await hooks.injectPointerSample(3, 1);
      await hooks.injectClick();
      await new Promise((r) => setTimeout(r, 60));
    }
  });
}

function sessionState(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector(".run-screen")?.getAttribute("data-session-state") ?? "",
  );
}

test("complete session flows to results with a persisted recommendation", async ({ page }) => {
  await page.goto("/?e2e=1");
  await page.click(`#tabs button[data-tab="setup"]`);

  // Minimal-but-valid settings: 5 candidates × (1 warmup + 3 reps) × 1 round.
  await page.locator("#view-setup input[type=text]").first().fill("E2EPlayer");
  // Advanced parameters live behind a collapsed details element.
  await page.click("#view-setup details.details summary");
  const numbers = page.locator('#view-setup input[type="number"]');
  // Order: dpi(0) sensX(1) sensY(2) seed(3) rounds(4) reps(5) warmups(6)
  await numbers.nth(3).fill("1234"); // seed
  await numbers.nth(4).fill("1"); // rounds
  await numbers.nth(5).fill("3"); // reps per candidate
  await numbers.nth(6).fill("0"); // warmups
  await page.locator('#view-setup input[type="checkbox"]').uncheck();

  await page.click(`#view-setup button[type=submit]`);
  await expect(page.locator("#run-canvas")).toBeVisible();
  // The run screen exposes the raw engine session state for automation.
  await expect(page.locator(".run-screen")).toHaveAttribute("data-session-state", /.+/, {
    timeout: 20_000,
  });
  // Grant lock via the adapter by clicking the canvas (pendingStart).
  await page.click("#run-canvas");

  for (let trial = 0; trial < 25; trial++) {
    const state = await sessionState(page);
    if (state === "analyzing" || state === "complete") break;
    if (state === "awaiting-lock") {
      await page.click("#run-canvas");
      await page.waitForTimeout(150);
    }
    await driveTrial(page);
    // Rests between candidate blocks are real sleeps in the runner.
    await page.waitForTimeout(400);
  }

  // The runner auto-navigates to results when finished.
  await expect(page.locator("#view-results h2").first()).toHaveText("Results", { timeout: 60_000 });
  await expect(page.locator("#view-results")).toContainText("Recommended sensitivity", {
    timeout: 15_000,
  });
});
