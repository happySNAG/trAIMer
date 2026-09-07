import { expect, test } from "@playwright/test";
import { runSessionToEnd, sessionState, startConfiguredSession } from "./arenaPlayer.ts";

/**
 * THE CALIBRATION JOURNEY, END TO END (Pass 13, requirements 1/4/5/10).
 *
 * "It went back to the main screen and said one session completed, with no
 *  recommendation."
 *
 * The results screen must ALWAYS explain what happened. When the evidence is
 * thin it must say "More data needed", say why, say how much more, and offer
 * to continue the same calibration — never a number invented to fill the
 * space.
 */

test.describe("calibration journey", () => {
  test("shows truthful progress against the real plan while playing", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/?e2e=1");
    await startConfiguredSession(page, { seed: "313", rounds: "2", reps: "4", warmups: "0" });
    await expect(page.locator("#run-canvas")).toBeVisible();
    await page.click("#run-canvas");

    // Starts honestly at zero, against a plan that is actually planned.
    await expect(page.locator(".run-calibration-label")).toHaveText("Calibration 0%");

    // ...and advances as drills complete, without ever exceeding 100%.
    const deadline = Date.now() + 60_000;
    let sawProgress = false;
    while (Date.now() < deadline && !sawProgress) {
      const label = await page.locator(".run-calibration-label").textContent();
      const percent = Number(/(\d+)/.exec(label ?? "0")?.[1] ?? "0");
      expect(percent).toBeLessThanOrEqual(100);
      if (percent > 0) sawProgress = true;
      else await runSessionToEnd(page, 4_000);
    }
    expect(sawProgress).toBe(true);
    // Round/block structure is shown, not just a bare number.
    await expect(page.locator(".run-progress-label")).toContainText("Round 1/2");
    await expect(page.locator(".run-progress-label")).toContainText("block");
  });

  test("a session with too little evidence says More data needed, and never invents a recommendation", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/?e2e=1");
    // 3 reps per candidate is BELOW the engine's floor of 4 valid measured
    // drills per candidate — exactly the shape of Aldo's aborted session.
    await startConfiguredSession(page, { seed: "515", rounds: "1", reps: "3", warmups: "0" });
    await expect(page.locator("#run-canvas")).toBeVisible();
    await page.click("#run-canvas");
    await runSessionToEnd(page, 150_000);

    await expect(page.locator("#view-results h2").first()).toHaveText("Results", { timeout: 60_000 });
    const results = page.locator("#view-results");

    // WHAT HAPPENED — always, before anything else.
    await expect(results).toContainText("Calibration complete");
    await expect(results).toContainText("Calibration 100%");
    await expect(results).toContainText("Drills completed");

    // WHAT THE EVIDENCE IS — shown even without a recommendation.
    await expect(results).toContainText("The evidence so far");
    await expect(results).toContainText("Valid for scoring");
    await expect(results).toContainText("Hit accuracy");
    await expect(results).toContainText("Reaction time");
    await expect(results).toContainText("Tracking on target");

    // WHAT IS MISSING — named, quantified, actionable.
    await expect(results).toContainText("More data needed");
    await expect(results).toContainText("will not guess a sensitivity for you");
    await expect(results).toContainText("Why this is not enough yet");
    await expect(results).toContainText("How much more testing");
    await expect(results).toContainText("Measured drills still needed");
    await expect(results).toContainText("What to do next");

    // And NO fabricated recommendation anywhere on the screen.
    await expect(results).not.toContainText("Recommended sensitivity");
    await expect(results).not.toContainText("Apply the recommended change");

    // The one action that actually helps.
    await expect(results.locator("button:has-text('Continue calibration')")).toBeVisible();
  });

  test("Continue calibration resumes the same calibration rather than starting over", async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto("/?e2e=1");
    await startConfiguredSession(page, { seed: "616", rounds: "1", reps: "3", warmups: "0" });
    await expect(page.locator("#run-canvas")).toBeVisible();
    await page.click("#run-canvas");
    await runSessionToEnd(page, 150_000);
    await expect(page.locator("#view-results")).toContainText("More data needed", { timeout: 60_000 });

    const drillsBefore = await page
      .locator("#view-results")
      .textContent()
      .then((t) => Number(/Drills completed(\d+)/.exec(t ?? "")?.[1] ?? "0"));
    expect(drillsBefore).toBeGreaterThan(0);

    await page.click("#view-results button:has-text('Continue calibration')");

    // It goes straight back into the arena rather than to setup.
    await expect(page.locator("#run-canvas")).toBeVisible({ timeout: 20_000 });
    // Wait for the CONTINUED session to actually be under way before driving
    // it: for a few milliseconds after the click the previous run screen is
    // still mounted, and its "complete" state would end the drive loop
    // immediately.
    await expect
      .poll(() => sessionState(page), { timeout: 30_000 })
      .toMatch(/awaiting-lock|warmup|trial-ready|trial-active|candidate-transition|inter-trial/);
    await runSessionToEnd(page, 200_000);
    // The results screen is rendered a beat after the session ends; wait for
    // the CONTINUED result rather than reading the previous one.
    await expect(page.locator("#view-results")).toContainText("Recommended sensitivity", {
      timeout: 60_000,
    });

    // THE DISCRIMINATOR: continuing ACCUMULATES onto the same calibration.
    // Starting over would land on the same drill count it had before.
    const drillsAfter = await page
      .locator("#view-results")
      .textContent()
      .then((t) => Number(/Drills completed(\d+)/.exec(t ?? "")?.[1] ?? "0"));
    expect(drillsAfter).toBeGreaterThan(drillsBefore);
  });

  test("ending a session early explains why, and still shows the evidence", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/?e2e=1");
    await startConfiguredSession(page, { seed: "717", rounds: "2", reps: "6", warmups: "0" });
    await expect(page.locator("#run-canvas")).toBeVisible();
    await page.click("#run-canvas");
    // Play a few drills so there IS partial evidence, then end the session.
    await runSessionToEnd(page, 25_000);
    await page.click(".run-controls button:has-text('End session')");
    await page.click(".dialog button:has-text('End session')");

    await expect(page.locator("#view-results h2").first()).toHaveText("Results", { timeout: 60_000 });
    const results = page.locator("#view-results");
    // The exact reason, not a generic "session ended".
    await expect(results).toContainText("You ended this calibration early");
    await expect(results).toContainText("You ended the session from the arena controls");
    // Said ONCE. The reason must not be echoed after the ending's own wording.
    const reasonText = (await results.textContent()) ?? "";
    expect(
      reasonText.split("You ended the session from the arena controls").length - 1,
    ).toBe(1);
    // Progress is honest: it did NOT finish.
    await expect(results).not.toContainText("Calibration 100%");
    await expect(results).toContainText("Every drill you finished was saved the moment it finished");
    await expect(results).toContainText("The evidence so far");
    await expect(results).toContainText("More data needed");
  });
});
