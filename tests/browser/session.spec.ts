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

test("complete session flows to results with a persisted recommendation", async ({ page }) => {
  await page.goto("/?e2e=1");

  // Minimal-but-valid settings: 5 candidates × (1 warmup + 3 reps) × 1 round.
  await page.locator("#view-setup input[type=text]").first().fill("E2EPlayer");
  const numbers = page.locator('#view-setup input[type="number"]');
  // Order: dpi(0) sensX(1) sensY(2) seed(3) rounds(4) reps(5) warmups(6)
  await numbers.nth(3).fill("1234"); // seed
  await numbers.nth(4).fill("1"); // rounds
  await numbers.nth(5).fill("3"); // reps per candidate
  await numbers.nth(6).fill("0"); // warmups
  await page.locator('#view-setup input[type="checkbox"]').uncheck();

  await page.click(`#view-setup button[type=submit]`);
  await expect(page.locator("#run-canvas")).toBeVisible();
  // Grant lock via the adapter by clicking the canvas (pendingStart).
  await page.click("#run-canvas");

  // Drive every trial until the runner reaches analysis/complete.
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const hud = document.querySelector("#view-run .hud")?.textContent ?? "";
          return hud;
        }),
      { timeout: 20_000 },
    )
    .toBeTruthy();

  for (let trial = 0; trial < 25; trial++) {
    const state = await page.evaluate(() => {
      const hudLeft = document.querySelector("#view-run .hud div")?.textContent ?? "";
      return hudLeft;
    });
    if (state.includes("analyzing") || state.includes("complete")) break;
    if (state.includes("awaiting-lock")) {
      await page.click("#run-canvas");
      await page.waitForTimeout(150);
    }
    await driveTrial(page);
    // Rests between candidate blocks are real sleeps in the runner.
    await page.waitForTimeout(400);
  }

  // The runner auto-navigates to results when finished.
  await expect(page.locator("#view-results h2")).toHaveText("Results", { timeout: 60_000 });
});
