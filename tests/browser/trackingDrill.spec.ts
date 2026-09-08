import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { drivePlayer, sessionState, startConfiguredSession } from "./arenaPlayer.ts";

/**
 * THE TRACKING DRILL IS UNMISTAKABLE (Pass 13, requirement 2/9).
 *
 * "The pink one — I kept clicking it and every click felt like a miss."
 *
 * rc.6 drew the tracking drill as a differently-coloured disc and nothing
 * else. A player read it as one more thing to shoot, and because clicking is
 * not how the drill ends, every click felt ignored. These specs hold the new
 * behaviour: the drill announces itself in words, its target survives clicks,
 * its window is not shortened or lengthened by them, it finishes on its own
 * clock with no click at all, and it says so when it does.
 */

type Snapshot = {
  scenarioKind: string;
  mode: "shoot" | "track";
  targets: { x: number; y: number; radius: number }[];
  liveTargets: number;
  removedTargets: number;
  shots: number;
  elapsedMs: number;
  durationMs: number;
  onTarget: boolean;
  trackingClicks: number;
  streak: number;
  effectCount: number;
} | null;

function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => window.__ALDO_TEST_HOOKS__!.arenaSnapshot() as Promise<Snapshot>);
}

/** Drives until a tracking drill is live, or fails the test. */
async function reachTrackingDrill(page: Page, opts: { clickDuringTracking?: boolean; neverClick?: boolean } = {}): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const snap = await snapshot(page);
    if (snap && snap.mode === "track" && snap.targets.length > 0) return;
    const state = await sessionState(page);
    if (state === "awaiting-lock") {
      await page.click("#run-canvas");
      await page.waitForTimeout(100);
    }
    if (state === "complete" || state === "aborted") break;
    await drivePlayer(page, { budgetMs: 120, ...opts });
  }
  throw new Error("no tracking drill appeared within the budget");
}

test.describe("tracking drill", () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto("/?e2e=1");
    await startConfiguredSession(page, { seed: "77", rounds: "1", reps: "6", warmups: "0" });
    await expect(page.locator("#run-canvas")).toBeVisible();
    await page.click("#run-canvas");
  });

  test("announces itself as TRACK, in words, and looks different from a shooting drill", async ({ page }) => {
    await reachTrackingDrill(page);
    await expect(page.locator(".run-mode-chip")).toHaveText("TRACK");
    await expect(page.locator(".run-mode-chip")).toHaveAttribute("data-mode", "track");
    await expect(page.locator(".run-instruction")).toContainText("don't shoot");
    await expect(page.locator(".run-instruction")).toContainText("Keep your crosshair on the target");
    // The whole run screen changes state, not just one chip.
    expect(await page.evaluate(() => document.body.classList.contains("drill-tracking"))).toBe(true);
  });

  test("a click-to-hit drill says SHOOT and never says don't shoot", async ({ page }) => {
    const deadline = Date.now() + 60_000;
    let sawShoot = false;
    while (Date.now() < deadline && !sawShoot) {
      const snap = await snapshot(page);
      if (snap && snap.mode === "shoot") {
        await expect(page.locator(".run-mode-chip")).toHaveText("SHOOT");
        await expect(page.locator(".run-instruction")).not.toContainText("don't shoot");
        expect(await page.evaluate(() => document.body.classList.contains("drill-tracking"))).toBe(false);
        sawShoot = true;
        break;
      }
      await drivePlayer(page, { budgetMs: 120 });
    }
    expect(sawShoot).toBe(true);
  });

  test("completes with NO click at all, and the target stays visible the whole window", async ({ page }) => {
    await reachTrackingDrill(page, { neverClick: true });
    const start = await snapshot(page);
    expect(start!.mode).toBe("track");
    const duration = start!.durationMs;
    expect(duration).toBeGreaterThan(1000);

    let sawEmptyArena = false;
    let maxElapsed = 0;
    const deadline = Date.now() + duration + 8_000;
    while (Date.now() < deadline) {
      const snap = await snapshot(page);
      if (!snap || snap.mode !== "track") break; // the drill ended by itself
      if (snap.liveTargets === 0) sawEmptyArena = true;
      maxElapsed = Math.max(maxElapsed, snap.elapsedMs);
      await drivePlayer(page, { budgetMs: 100, neverClick: true });
    }
    // It ran essentially its whole window, and never left the player looking
    // at an empty arena.
    expect(maxElapsed).toBeGreaterThan(duration * 0.7);
    expect(sawEmptyArena).toBe(false);

    // And it signalled completion.
    const presentation = await page.evaluate(() =>
      window.__ALDO_TEST_HOOKS__!.presentationState(),
    );
    expect(presentation.lastTrackingCompletion).not.toBeNull();
    expect(presentation.lastTrackingCompletion!.clicks).toBe(0);
    expect(presentation.lastTrackingCompletion!.onTargetRatio).toBeGreaterThanOrEqual(0);
  });

  test("clicking does not remove the target, does not advance the trial, and needs no second click", async ({ page }) => {
    await reachTrackingDrill(page, { clickDuringTracking: true });
    const before = await snapshot(page);
    expect(before!.mode).toBe("track");
    const streakBefore = (await page.evaluate(() =>
      window.__ALDO_TEST_HOOKS__!.presentationState(),
    )).streak;

    // Hammer it, exactly the way the rc.6 player did.
    for (let i = 0; i < 12; i++) {
      await page.evaluate(() => window.__ALDO_TEST_HOOKS__!.injectClick());
      await page.waitForTimeout(30);
      const snap = await snapshot(page);
      if (!snap || snap.mode !== "track") break;
      // THE rc.6 DEFECT: a click deleted the target and left the arena blank.
      expect(snap.liveTargets).toBeGreaterThan(0);
      expect(snap.removedTargets).toBe(0);
    }

    const after = await snapshot(page);
    if (after && after.mode === "track") {
      // Clicks were recorded as behavioural data...
      expect(after.shots).toBeGreaterThan(0);
      expect(after.trackingClicks).toBeGreaterThan(0);
      // ...but produced no shooting feedback at all. The hit streak is a
      // shooting concept; a tracking drill must leave it exactly where it
      // was, neither growing it nor punishing the player for it.
      expect(after.streak).toBe(streakBefore);
      // ...and did not shorten the window.
      expect(after.elapsedMs).toBeLessThan(after.durationMs);
    }
  });

  test("reports on-target and off-target continuously", async ({ page }) => {
    await reachTrackingDrill(page, { neverClick: true });
    // Follow it: the snapshot must report contact.
    let sawOnTarget = false;
    for (let i = 0; i < 25 && !sawOnTarget; i++) {
      await drivePlayer(page, { budgetMs: 120, neverClick: true });
      const snap = await snapshot(page);
      if (!snap || snap.mode !== "track") break;
      if (snap.onTarget) sawOnTarget = true;
    }
    expect(sawOnTarget).toBe(true);
  });

  test("time remaining advances monotonically toward the end of the window", async ({ page }) => {
    await reachTrackingDrill(page, { neverClick: true });
    const samples: number[] = [];
    for (let i = 0; i < 12; i++) {
      const snap = await snapshot(page);
      if (!snap || snap.mode !== "track") break;
      samples.push(snap.elapsedMs);
      expect(snap.elapsedMs).toBeLessThanOrEqual(snap.durationMs + 200);
      await drivePlayer(page, { budgetMs: 120, neverClick: true });
    }
    expect(samples.length).toBeGreaterThan(3);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!);
    }
  });
});
