import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { drivePlayer } from "./arenaPlayer.ts";

/** The suite's shared aiming player (see arenaPlayer.ts). */
async function driveTrial(page: Page): Promise<void> {
  await drivePlayer(page);
}

/**
 * Full-session automation using the ?e2e=1 test adapter. The adapter grants
 * pointer lock virtually and injects scripted CaptureEvents through the
 * production capture path — no production code is forked.
 */
function sessionState(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector(".run-screen")?.getAttribute("data-session-state") ?? "",
  );
}

test("complete session flows to results with a persisted recommendation", async ({ page }) => {
  // 5 candidates x 6 reps = 30 measured drills, comfortably above the engine's
  // documented floor of 4 VALID measured trials per candidate. Below that
  // floor the session correctly refuses to recommend anything (see the
  // "More data needed" spec in calibrationJourney.spec.ts), so a spec that
  // wants to exercise the RECOMMENDATION path has to fund it.
  test.setTimeout(300_000);
  await page.goto("/?e2e=1");
  await page.click(`#tabs button[data-tab="setup"]`);

  await page.locator("#view-setup input[type=text]").first().fill("E2EPlayer");
  // Advanced parameters live behind a collapsed details element.
  await page.click("#view-setup details.details summary");
  await page.locator("#setup-seed").fill("1234");
  await page.locator("#setup-rounds").fill("1");
  await page.locator("#setup-reps").fill("6");
  await page.locator("#setup-warmups").fill("0");
  await page.locator("#setup-ycheck").uncheck();

  await page.click(`#view-setup button[type=submit]`);
  await expect(page.locator("#run-canvas")).toBeVisible();
  // The run screen exposes the raw engine session state for automation.
  await expect(page.locator(".run-screen")).toHaveAttribute("data-session-state", /.+/, {
    timeout: 20_000,
  });
  // Grant lock via the adapter by clicking the canvas (pendingStart).
  await page.click("#run-canvas");

  // Drive until the engine is done. Time-based, not iteration-based: the
  // scripted player rarely resolves a drill on its first pass, so a trial can
  // take its whole window (6 s for tracking) and an iteration cap silently
  // becomes "give up early" whenever drill budgets change.
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const state = await sessionState(page);
    if (state === "analyzing" || state === "complete" || state === "aborted") break;
    if (state === "awaiting-lock") {
      await page.click("#run-canvas");
      await page.waitForTimeout(150);
    }
    await driveTrial(page);
    // Short, so the injected stream has no gaps the validator would flag.
    // Rests between candidate blocks are real sleeps in the runner.
    await page.waitForTimeout(60);
  }

  // The runner auto-navigates to results when finished.
  await expect(page.locator("#view-results h2").first()).toHaveText("Results", { timeout: 60_000 });
  await expect(page.locator("#view-results")).toContainText("Recommended sensitivity", {
    timeout: 15_000,
  });
});

test("pointer-lock loss mid-trial invalidates the trial and ends the session visibly", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/?e2e=1");
  await page.click(`#tabs button[data-tab="setup"]`);
  await page.locator("#view-setup input[type=text]").first().fill("E2EPlayer");
  await page.click("#view-setup details.details summary");
  await page.locator("#setup-seed").fill("99");
  await page.locator("#setup-rounds").fill("1");
  await page.locator("#setup-reps").fill("3");
  await page.locator("#setup-warmups").fill("0");
  await page.locator("#setup-ycheck").uncheck();
  await page.click(`#view-setup button[type=submit]`);
  await page.click("#run-canvas");

  // Wait until a real trial is live, then drop pointer lock mid-trial.
  await expect
    .poll(() => sessionState(page), { timeout: 30_000 })
    .toMatch(/trial-active|warmup|inter-trial|candidate-transition/);
  const sawLiveTrial = ["trial-active", "warmup"].includes(await sessionState(page));
  if (!sawLiveTrial) {
    // Between-trial window: drive into a trial first.
    await page.evaluate(async () => {
      await window.__ALDO_TEST_HOOKS__!.grantLock();
      await window.__ALDO_TEST_HOOKS__!.injectPointerSample(5, 2);
    });
    await expect.poll(() => sessionState(page), { timeout: 20_000 }).toBe("trial-active");
  }
  await page.evaluate(() => window.__ALDO_TEST_HOOKS__!.simulateLockLoss());

  // The engine must treat the compromise as fatal — never continue silently,
  // never mix post-loss input into the measurement.
  await expect(page.locator(".run-screen")).toHaveAttribute(
    "data-session-state",
    /aborted|awaiting-lock|paused/,
    { timeout: 20_000 },
  );
  await expect(page.locator(".overlay-message")).toBeVisible();
  // The player is TOLD what happened. rc.6 showed "Session ended · partial
  // data was saved" for this and for a normal finish alike.
  await expect(page.locator(".overlay-title")).toHaveText(
    /Calibration stopped early|Paused|lock|capture your mouse/i,
  );
});
