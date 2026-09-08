import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { drivePlayer, sessionState } from "./arenaPlayer.ts";

/**
 * RELEASE GATE — two blinded candidates must move the crosshair by measurably
 * different amounts in the REAL arena (Pass 15, requirement K).
 *
 * ## Why this gate and not a unit test
 *
 * The unit suite proves the physical model and proves the capture source
 * applies it. Neither could have caught the rc.8 defect, because the defect
 * was that the run controller never asked for the gain at all. This gate runs
 * the shipped `BrowserRunController` in a real Chromium, through a real
 * session, and measures the thing a player would feel.
 *
 * ## How it measures without breaking blinding
 *
 * By observation only. It injects a fixed raw mouse delta and reads the
 * reticle position before and after — both of which are already visible on
 * screen to anyone playing. No hook reports the active candidate, its
 * sensitivity, or the gain; nothing about blinding changes for this to work.
 * That is also what makes the measurement honest: it is exactly the
 * displacement the player's hand would produce.
 *
 * The gate fails if every probe comes back at the same gain — the rc.8
 * signature — or if the arena reverts to 1.0 px/count for every candidate.
 */

/** Logical px the reticle moves for one raw mouse count, measured live. */
async function probeGain(page: Page): Promise<number | null> {
  return page.evaluate(async () => {
    const hooks = window.__ALDO_TEST_HOOKS__;
    if (!hooks) return null;
    const before = await hooks.arenaSnapshot();
    if (!before?.reticle) return null;
    // Probe away from whichever wall is nearer, so clamping cannot swallow
    // the movement and report a gain of zero.
    const COUNTS = 40;
    const dx = before.reticle.x > 640 ? -COUNTS : COUNTS;
    await hooks.injectPointerSample(dx, 0);
    const after = await hooks.arenaSnapshot();
    if (!after?.reticle) return null;
    const moved = after.reticle.x - before.reticle.x;
    // Put the reticle back so the probe does not bias the drill it borrowed.
    await hooks.injectPointerSample(-dx, 0);
    return moved / dx;
  });
}

test("blinded candidates produce measurably different reticle gain", async ({ page }) => {
  test.setTimeout(300_000);

  await page.goto("/?e2e=1");
  await page.click(`#tabs button[data-tab="setup"]`);
  await page.locator("#view-setup input[type=text]").first().fill("GainGate");
  await page.click("#view-setup details.details summary");
  await page.locator("#setup-seed").fill("515");
  await page.locator("#setup-rounds").fill("1");
  // The engine's minimum plan: the gate needs candidate BLOCKS to change,
  // not evidence to accumulate.
  await page.locator("#setup-reps").fill("3");
  await page.locator("#setup-warmups").fill("0");
  await page.locator("#setup-ycheck").uncheck();
  await page.click(`#view-setup button[type=submit]`);

  await expect(page.locator("#run-canvas")).toBeVisible();
  await expect(page.locator(".run-screen")).toHaveAttribute("data-session-state", /.+/, {
    timeout: 20_000,
  });
  await page.click("#run-canvas");

  const gains: number[] = [];
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const state = await sessionState(page);
    if (state === "analyzing" || state === "complete" || state === "aborted") break;
    if (state === "awaiting-lock") {
      await page.click("#run-canvas");
      await page.waitForTimeout(150);
    }
    const gain = await probeGain(page);
    if (gain !== null && Number.isFinite(gain) && gain > 0) gains.push(gain);
    // Keep the session moving so it reaches the next candidate block.
    await drivePlayer(page, { budgetMs: 600 });
    // Two distinct gains is the whole claim; stop as soon as it is proven so
    // the gate stays fast.
    if (new Set(gains.map((g) => g.toFixed(4))).size >= 2) break;
  }

  expect(gains.length, "the gate never managed to probe a live arena").toBeGreaterThan(2);

  const distinct = [...new Set(gains.map((g) => Number(g.toFixed(4))))].sort((a, b) => a - b);
  expect(
    distinct.length,
    `every probe measured the same gain (${distinct.join(", ")}) — the arena is ignoring the blinded candidate`,
  ).toBeGreaterThanOrEqual(2);

  // Not merely different: different by a ladder-sized amount. The narrowest
  // arm of the default ladder is ±15 %, so any real candidate change shows up
  // as at least ~13 % between two adjacent rungs.
  const spread = distinct[distinct.length - 1]! / distinct[0]!;
  expect(spread, `gain spread ${spread.toFixed(4)} is smaller than a ladder step`).toBeGreaterThan(
    1.1,
  );

  // ...and the rc.8 signature specifically: 1.0 px/count for everything.
  expect(distinct.every((g) => Math.abs(g - 1) < 1e-6)).toBe(false);
});

test("the arena never reveals which candidate is running", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/?e2e=1");
  await page.click(`#tabs button[data-tab="setup"]`);
  await page.locator("#view-setup input[type=text]").first().fill("BlindGate");
  await page.click("#view-setup details.details summary");
  await page.locator("#setup-seed").fill("515");
  await page.locator("#setup-rounds").fill("1");
  await page.locator("#setup-reps").fill("3");
  await page.locator("#setup-warmups").fill("0");
  await page.locator("#setup-ycheck").uncheck();
  await page.click(`#view-setup button[type=submit]`);
  await expect(page.locator("#run-canvas")).toBeVisible();
  await page.click("#run-canvas");

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const state = await sessionState(page);
    if (state === "analyzing" || state === "complete" || state === "aborted") break;
    const visible = await page.evaluate(
      () => document.querySelector("#view-run")?.textContent ?? "",
    );
    // Nothing on the run screen may name a candidate, a sensitivity value, a
    // gain, or a cm/360 — the player is comparing feel, not reading labels.
    expect(visible).not.toMatch(/cand-/);
    expect(visible.toLowerCase()).not.toContain("px/count");
    expect(visible.toLowerCase()).not.toContain("cm/360");
    expect(visible.toLowerCase()).not.toContain("sensitivity:");
    await drivePlayer(page, { budgetMs: 400 });
  }
});
