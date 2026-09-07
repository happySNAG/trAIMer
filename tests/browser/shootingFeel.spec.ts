import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { drivePlayer, sessionState, startConfiguredSession } from "./arenaPlayer.ts";

/**
 * SHOOTING FEELS LIKE SHOOTING (Pass 13, requirement 3/11).
 *
 * "The circles look good. The shooting feels lame."
 *
 * Game feel was added on ONE condition: the shot is recorded first, and no
 * effect may change what was measured. These specs hold the runtime half of
 * that bargain — hit feedback only for real hits, miss feedback only for real
 * misses, target geometry untouched by any effect, and an effect layer that
 * stays bounded no matter how much the player clicks. The ordering guarantee
 * itself is enforced statically in tests/arenaPresentation.test.ts.
 */

type Snapshot = {
  scenarioKind: string;
  mode: "shoot" | "track";
  targets: { id: string; x: number; y: number; radius: number }[];
  liveTargets: number;
  removedTargets: number;
  shots: number;
  hits: number;
  elapsedMs: number;
  durationMs: number;
  onTarget: boolean;
  streak: number;
  trackingClicks: number;
  effectCount: number;
} | null;

function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => window.__ALDO_TEST_HOOKS__!.arenaSnapshot() as Promise<Snapshot>);
}

function presentation(page: Page) {
  return page.evaluate(() => window.__ALDO_TEST_HOOKS__!.presentationState());
}

/** Drives until a click-to-hit drill with a live target is on screen. */
async function reachShootingDrill(page: Page): Promise<NonNullable<Snapshot>> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const snap = await snapshot(page);
    if (snap && snap.mode === "shoot" && snap.targets.length > 0) return snap;
    const state = await sessionState(page);
    if (state === "awaiting-lock") {
      await page.click("#run-canvas");
      await page.waitForTimeout(100);
    }
    if (state === "complete" || state === "aborted") break;
    await drivePlayer(page, { budgetMs: 100, neverClick: true });
  }
  throw new Error("no click-to-hit drill appeared within the budget");
}

test.describe("shooting feel", () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/?e2e=1");
    await startConfiguredSession(page, { seed: "404", rounds: "1", reps: "6", warmups: "0" });
    await expect(page.locator("#run-canvas")).toBeVisible();
    await page.click("#run-canvas");
  });

  test("a hit registers as a hit and produces feedback; the effect layer stays bounded", async ({ page }) => {
    await reachShootingDrill(page);
    // Aim properly and shoot for a while.
    const deadline = Date.now() + 45_000;
    let anyHit = false;
    let maxEffects = 0;
    while (Date.now() < deadline && !anyHit) {
      await drivePlayer(page, { budgetMs: 250 });
      const snap = await snapshot(page);
      const state = await presentation(page);
      maxEffects = Math.max(maxEffects, state.effectCount);
      if ((snap && snap.hits > 0) || state.bestStreak > 0) anyHit = true;
      if (await sessionState(page) === "complete") break;
    }
    expect(anyHit).toBe(true);
    // Bounded: three effect pools, each capped at 24.
    expect(maxEffects).toBeLessThanOrEqual(72);
  });

  test("a shot that misses produces NO hit feedback and resets the streak", async ({ page }) => {
    const snap = await reachShootingDrill(page);
    const target = snap.targets[0]!;
    // Fire from wherever the reticle is, deliberately without aiming.
    const before = await presentation(page);
    await page.evaluate(() => window.__ALDO_TEST_HOOKS__!.injectClick());
    await page.waitForTimeout(60);
    const after = await snapshot(page);
    const afterState = await presentation(page);

    if (after && after.mode === "shoot" && after.shots > 0 && after.hits === 0) {
      // A miss must never grow the streak.
      expect(afterState.streak).toBe(0);
      expect(afterState.streak).toBeLessThanOrEqual(before.streak);
      // ...and must never remove a target.
      expect(after.removedTargets).toBe(0);
      // Geometry is untouched by the effect: same target, same radius.
      const still = after.targets[0];
      if (still) expect(still.radius).toBe(target.radius);
    }
  });

  test("effects do not leak: hundreds of shots leave the pool bounded and the session running", async ({ page }) => {
    await reachShootingDrill(page);
    for (let burst = 0; burst < 12; burst++) {
      await page.evaluate(async () => {
        const hooks = window.__ALDO_TEST_HOOKS__!;
        for (let i = 0; i < 20; i++) {
          await hooks.injectClick();
          await new Promise((r) => setTimeout(r, 2));
        }
      });
      const state = await presentation(page);
      expect(state.effectCount).toBeLessThanOrEqual(72);
      const engine = await sessionState(page);
      if (engine === "complete" || engine === "aborted") break;
    }
    // The session is still alive after all that.
    const engine = await sessionState(page);
    expect(["complete", "aborted"]).not.toContain(engine);
  });

  test("target geometry is identical before and after a shot's effects play out", async ({ page }) => {
    const snap = await reachShootingDrill(page);
    const target = snap.targets[0]!;
    const isStatic = snap.scenarioKind.startsWith("flick-static");
    await page.evaluate(() => window.__ALDO_TEST_HOOKS__!.injectClick());
    await page.waitForTimeout(120);
    const after = await snapshot(page);
    if (isStatic && after && after.mode === "shoot" && after.removedTargets === 0) {
      const same = after.targets.find((t) => t.id === target.id);
      if (same) {
        expect(same.x).toBeCloseTo(target.x, 5);
        expect(same.y).toBeCloseTo(target.y, 5);
        expect(same.radius).toBe(target.radius);
      }
    }
  });

  test("no shooting feedback is produced during a tracking drill", async ({ page }) => {
    // Reach a tracking drill and hammer it; streak must never move.
    const deadline = Date.now() + 90_000;
    let checked = false;
    while (Date.now() < deadline && !checked) {
      const snap = await snapshot(page);
      if (snap && snap.mode === "track" && snap.targets.length > 0) {
        const streakBefore = (await presentation(page)).streak;
        for (let i = 0; i < 10; i++) {
          await page.evaluate(() => window.__ALDO_TEST_HOOKS__!.injectClick());
          await page.waitForTimeout(25);
        }
        const state = await presentation(page);
        // Clicking a tracking target is neither a hit nor a miss: the streak
        // must not move in either direction.
        expect(state.streak).toBe(streakBefore);
        expect(state.trackingClicks).toBeGreaterThan(0);
        checked = true;
        break;
      }
      if (await sessionState(page) === "complete") break;
      await drivePlayer(page, { budgetMs: 120, neverClick: true });
    }
    expect(checked).toBe(true);
  });
});
