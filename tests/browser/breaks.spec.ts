import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * Skippable breaks in the real run screen (Pass 11). Uses the ?e2e=1 adapter
 * for the trials themselves, with a long rest (?rest=20000) so the break UI
 * can be observed and skipped rather than raced.
 */

async function driveTrial(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const hooks = window.__ALDO_TEST_HOOKS__;
    if (!hooks) throw new Error("test hooks missing");
    await hooks.grantLock();
    for (let i = 0; i < 40; i++) await hooks.injectPointerSample(8, i % 2 === 0 ? 2 : -2);
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

async function startShortSession(page: Page): Promise<void> {
  await page.goto("/?e2e=1&rest=20000");
  await page.click(`#tabs button[data-tab="setup"]`);
  await page.locator("#view-setup input[type=text]").first().fill("BreakTester");
  await page.click("#view-setup details.details summary");
  await page.locator("#setup-seed").fill("77");
  await page.locator("#setup-rounds").fill("1");
  await page.locator("#setup-reps").fill("3");
  await page.locator("#setup-warmups").fill("0");
  await page.locator("#setup-ycheck").uncheck();
  await page.click(`#view-setup button[type=submit]`);
  await expect(page.locator("#run-canvas")).toBeVisible();
  await expect(page.locator(".run-screen")).toHaveAttribute("data-session-state", /.+/, { timeout: 20_000 });
}

/** Plays trials until the engine reaches its first break. */
async function reachFirstBreak(page: Page): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const state = await sessionState(page);
    if (state === "rest") return;
    if (state === "analyzing" || state === "complete" || state === "aborted") break;
    await driveTrial(page);
    await page.waitForTimeout(150);
  }
  throw new Error(`never reached a break; state=${await sessionState(page)}`);
}

test.describe("skippable breaks", () => {
  test("a break shows a countdown and a Skip break action, and the button ends it", async ({ page }) => {
    await startShortSession(page);
    await reachFirstBreak(page);
    const overlay = page.locator(".overlay-message");
    await expect(overlay).toBeVisible();
    await expect(page.locator(".overlay-title")).toHaveText("Break");
    await expect(page.locator(".overlay-body")).toContainText(/\d+s/);
    await expect(page.locator(".overlay-body")).toContainText("Space or Enter");
    const skip = page.locator(".overlay-actions button:has-text('Skip break')");
    await expect(skip).toBeVisible();
    const before = Date.now();
    await skip.click();
    await expect(page.locator(".run-screen")).not.toHaveAttribute("data-session-state", "rest", { timeout: 5_000 });
    // 20 s planned; we left in well under 5.
    expect(Date.now() - before).toBeLessThan(5_000);
  });

  test("Space ends a break", async ({ page }) => {
    await startShortSession(page);
    await reachFirstBreak(page);
    await page.keyboard.press("Space");
    await expect(page.locator(".run-screen")).not.toHaveAttribute("data-session-state", "rest", { timeout: 5_000 });
  });

  test("Enter ends a break", async ({ page }) => {
    await startShortSession(page);
    await reachFirstBreak(page);
    await page.keyboard.press("Enter");
    await expect(page.locator(".run-screen")).not.toHaveAttribute("data-session-state", "rest", { timeout: 5_000 });
  });

  test("the setup screen exposes automatic-break and break-length controls", async ({ page }) => {
    await page.goto("/");
    await page.click(`#tabs button[data-tab="setup"]`);
    const auto = page.locator("#setup-autobreaks");
    const length = page.locator("#setup-breakseconds");
    await expect(auto).toBeChecked();
    await expect(length).toHaveValue("10");
    await auto.uncheck();
    await expect(length).toBeDisabled();
    await auto.check();
    await expect(length).toBeEnabled();
  });
});
