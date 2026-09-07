import type { Page } from "@playwright/test";

/**
 * A synthetic player that ACTUALLY AIMS.
 *
 * The previous driver swept in a fixed direction and clicked blindly. Two
 * consequences, both of which hid real defects:
 *
 *   1. it never hit anything, so no drill ever exercised the hit path;
 *   2. it moved ~160 px/ms (40 samples of 8 px inside one microtask burst),
 *      which the engine's validator correctly rejects as impossible movement —
 *      so EVERY trial it produced was fatally invalid, and the suite only
 *      appeared to reach a recommendation because rc.6 persisted one whether
 *      the evidence supported it or not.
 *
 * This driver reads the arena snapshot, moves toward the live target at a
 * plausible ~1 px/ms, and clicks when it is inside the hit radius — EXCEPT in
 * a tracking drill, where it follows the target and never clicks, exactly as
 * the on-screen instruction tells a real player to.
 */

export interface DriveOptions {
  /** Milliseconds of input to inject in this call. */
  budgetMs?: number;
  /** Shoot even during a tracking drill (used by the tracking-UX specs). */
  clickDuringTracking?: boolean;
  /** Never click at all (used to prove tracking completes without a click). */
  neverClick?: boolean;
  /** Deliberately aim off-target (used to prove off-target feedback). */
  aimOff?: boolean;
}

export async function drivePlayer(page: Page, options: DriveOptions = {}): Promise<void> {
  await page.evaluate(async (opts) => {
    const hooks = window.__ALDO_TEST_HOOKS__;
    if (!hooks) throw new Error("test hooks missing");
    await hooks.grantLock();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const STEP_MS = 5;
    // 6 px per 5 ms = 1.2 px/ms, well inside the validator's 60 px/ms ceiling.
    const MAX_STEP_PX = 6;
    const deadline = performance.now() + (opts.budgetMs ?? 400);
    let lastClickAt = 0;
    while (performance.now() < deadline) {
      const snap = await hooks.arenaSnapshot();
      if (!snap || !snap.reticle) {
        await sleep(STEP_MS);
        continue;
      }
      const target = snap.targets[0];
      if (!target) {
        // Nothing live: keep the sample stream going so the validator never
        // sees a silent gap.
        await hooks.injectPointerSample(1, 0);
        await sleep(STEP_MS);
        continue;
      }
      const aimX = opts.aimOff ? target.x + target.radius * 6 : target.x;
      const aimY = opts.aimOff ? target.y + target.radius * 6 : target.y;
      let dx = aimX - snap.reticle.x;
      let dy = aimY - snap.reticle.y;
      const dist = Math.hypot(dx, dy);
      if (dist > MAX_STEP_PX) {
        dx = (dx / dist) * MAX_STEP_PX;
        dy = (dy / dist) * MAX_STEP_PX;
      }
      await hooks.injectPointerSample(dx, dy);
      const tracking = snap.mode === "track";
      const mayClick =
        !opts.neverClick && (tracking ? opts.clickDuringTracking === true : true);
      // Inside the hit radius and clear of the duplicate-click window.
      if (mayClick && dist <= target.radius * 0.6 && performance.now() - lastClickAt > 120) {
        lastClickAt = performance.now();
        await hooks.injectClick();
      }
      await sleep(STEP_MS);
    }
  }, options);
}

export function sessionState(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector(".run-screen")?.getAttribute("data-session-state") ?? "",
  );
}

/** Drives a whole session to its natural end (or the deadline). */
export async function runSessionToEnd(
  page: Page,
  deadlineMs = 240_000,
  options: DriveOptions = {},
): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  let state = "";
  while (Date.now() < deadline) {
    state = await sessionState(page);
    if (state === "analyzing" || state === "complete" || state === "aborted") break;
    if (state === "awaiting-lock") {
      await page.click("#run-canvas");
      await page.waitForTimeout(120);
    }
    await drivePlayer(page, options);
  }
  return state;
}

/** Fills the setup form and starts a session with the given plan size. */
export async function startConfiguredSession(
  page: Page,
  opts: { seed: string; rounds: string; reps: string; warmups: string; player?: string },
): Promise<void> {
  await page.click(`#tabs button[data-tab="setup"]`);
  await page.locator("#view-setup input[type=text]").first().fill(opts.player ?? "E2EPlayer");
  await page.click("#view-setup details.details summary");
  await page.locator("#setup-seed").fill(opts.seed);
  await page.locator("#setup-rounds").fill(opts.rounds);
  await page.locator("#setup-reps").fill(opts.reps);
  await page.locator("#setup-warmups").fill(opts.warmups);
  await page.locator("#setup-ycheck").uncheck();
  await page.click(`#view-setup button[type=submit]`);
}
