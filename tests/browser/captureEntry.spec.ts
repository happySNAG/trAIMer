import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * Test-entry regression suite in a real browser (Pass 10).
 *
 * rc.3 reached Aldo's Windows PC with an arena that could not be started:
 * `.overlay-message` sits at `inset: 0` over the canvas, and with the default
 * `pointer-events: auto` it consumed every "click to lock in" click. The state
 * chip stayed on "Preparing", no targets ever spawned, and Pause / End session
 * were inert because the controller forwarded them to a runner that did not
 * exist yet.
 *
 * Everything here runs WITHOUT ?e2e=1: the point is to exercise the real click
 * path that the virtual-lock adapter skips.
 *
 * Headless Chromium refuses Pointer Lock, which makes it the ideal host for
 * the refusal half of this contract: a refusal must produce a diagnostic and
 * two working ways out, fast, and never a hang.
 */

const AWAITING_TITLE = "Click to lock in";

async function openArena(page: Page): Promise<void> {
  await page.goto("/");
  await page.click(`#tabs button[data-tab="setup"]`);
  await page.locator("#view-setup input[type=text]").first().fill("HardwareProbe");
  await page.click("#view-setup details.details summary");
  const numbers = page.locator('#view-setup input[type="number"]');
  await numbers.nth(3).fill("4242"); // seed
  await numbers.nth(4).fill("1"); // rounds
  await numbers.nth(5).fill("3"); // reps
  await numbers.nth(6).fill("0"); // warmups
  await page.click(`#view-setup button[type=submit]`);
  await expect(page.locator("#run-canvas")).toBeVisible();
  // The arena only invites a click once the capture source exists; clicking
  // before that could not carry user activation into requestPointerLock().
  await expect(page.locator(".overlay-title")).toHaveText(AWAITING_TITLE);
}

/** What the browser would actually deliver a click at the arena centre to. */
async function hitTargetAtArenaCentre(page: Page): Promise<string> {
  return page.evaluate(() => {
    const c = document.querySelector("#run-canvas") as HTMLCanvasElement;
    const r = c.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return el ? el.id || el.tagName : "(nothing)";
  });
}

async function clickArenaCentre(page: Page): Promise<void> {
  const box = await page.locator("#run-canvas").boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
}

test.describe("arena capture entry", () => {
  test("the overlay never intercepts the click that starts the test", async ({ page }) => {
    await openArena(page);
    // The regression in one assertion.
    expect(await hitTargetAtArenaCentre(page)).toBe("run-canvas");
    expect(
      await page.evaluate(
        () => getComputedStyle(document.querySelector(".overlay-message")!).pointerEvents,
      ),
    ).toBe("none");
  });

  test("the overlay never covers the Pause or End session controls", async ({ page }) => {
    await openArena(page);
    const covered = await page.evaluate(() => {
      const out: { label: string; topIsSelf: boolean }[] = [];
      for (const btn of document.querySelectorAll<HTMLElement>(".run-controls button")) {
        const r = btn.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        out.push({
          label: btn.textContent ?? "",
          topIsSelf: btn === top || btn.contains(top),
        });
      }
      return out;
    });
    expect(covered.length).toBeGreaterThanOrEqual(2);
    for (const c of covered) expect(c.topIsSelf, c.label).toBe(true);
  });

  /**
   * Whether a host grants Pointer Lock is not ours to control: the macOS
   * headless shell refuses, the Linux CI runner grants, and Aldo's Windows PC
   * grants. So the host-agnostic contract is that the click RESOLVES — the
   * release-blocking symptom was neither outcome, but neither ever arriving.
   */
  test("the arena click always resolves, one way or the other", async ({ page }) => {
    await openArena(page);
    const startedAt = Date.now();
    await clickArenaCentre(page);
    const resolved = await page
      .waitForFunction(
        () => {
          const live = [
            "candidate-transition",
            "warmup",
            "trial-ready",
            "trial-active",
            "inter-trial",
          ].includes(
            document.querySelector(".run-screen")?.getAttribute("data-session-state") ?? "",
          );
          const diagnosed =
            document.querySelector(".overlay-title")?.textContent ===
              "Could not capture your mouse" &&
            (document.querySelector(".overlay-message") as HTMLElement | null)?.hidden === false;
          return live || diagnosed;
        },
        undefined,
        { timeout: 15_000 },
      )
      .then(() => true)
      .catch(() => false);
    expect(resolved, "the arena neither started nor explained itself").toBe(true);
    // The source's own lock timeout is 5 s. Resolving well inside that proves
    // the outcome was OBSERVED rather than waited out.
    expect(Date.now() - startedAt).toBeLessThan(6000);
  });

  /**
   * A refusal is forced here rather than hoped for, so the diagnostic path is
   * exercised identically on every host. The override matches what Chromium
   * does when it refuses: a rejected promise and no lock event.
   */
  async function forceLockRefusal(page: Page): Promise<void> {
    await page.addInitScript(() => {
      Element.prototype.requestPointerLock = function requestPointerLock() {
        return Promise.reject(
          new DOMException("forced refusal (regression test)", "NotAllowedError"),
        );
      } as typeof Element.prototype.requestPointerLock;
    });
  }

  test("a refused pointer lock reports a diagnostic instead of hanging", async ({ page }) => {
    await forceLockRefusal(page);
    await openArena(page);
    const startedAt = Date.now();
    await clickArenaCentre(page);
    // Visibility matters: a hidden overlay keeps its previous text, so
    // asserting on text alone would pass against a blank arena.
    await expect(page.locator(".overlay-message")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".overlay-title")).toHaveText("Could not capture your mouse", {
      timeout: 15_000,
    });
    // Observed, not waited out: the source's own timeout is 5 s.
    expect(Date.now() - startedAt).toBeLessThan(4000);
    // A refusal is NOT a cancellation: it must be explained on the arena, not
    // quietly dropped back to setup as if the player had asked to leave.
    await expect(page.locator("#view-run")).toBeVisible();
    await expect(page.locator("#view-setup")).toBeHidden();

    await expect(page.locator(".run-state-chip")).toContainText("Capture failed");
    const body = await page.locator(".overlay-body").textContent();
    expect(body).toContain("Nothing was recorded");
    await expect(page.locator(".overlay-actions button")).toHaveCount(2);
  });

  /**
   * The rc.3 failure shape exactly: a request that is never answered. It must
   * end in a diagnostic at the timeout, never in an arena that waits forever.
   */
  test("a pointer lock that is never answered times out into a diagnostic", async ({ page }) => {
    await page.addInitScript(() => {
      Element.prototype.requestPointerLock = function requestPointerLock() {
        // Never settles, and no pointerlockchange/pointerlockerror is fired.
        return new Promise(() => undefined);
      } as typeof Element.prototype.requestPointerLock;
    });
    await openArena(page);
    await clickArenaCentre(page);
    await expect(page.locator(".overlay-message")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".overlay-title")).toHaveText("Could not capture your mouse", {
      timeout: 20_000,
    });
    await expect(page.locator(".overlay-actions button")).toHaveCount(2);
  });

  test("the diagnostic's way out actually works", async ({ page }) => {
    await forceLockRefusal(page);
    await openArena(page);
    await clickArenaCentre(page);
    await expect(page.locator(".overlay-message")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".overlay-title")).toHaveText("Could not capture your mouse", {
      timeout: 15_000,
    });
    await page.click(".overlay-actions button:has-text('Back to setup')");
    await expect(page.locator("#view-setup")).toBeVisible();
    await expect(page.locator("#view-run")).toBeHidden();
  });

  test("the diagnostic's retry starts a fresh attempt", async ({ page }) => {
    await forceLockRefusal(page);
    await openArena(page);
    await clickArenaCentre(page);
    await expect(page.locator(".overlay-message")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".overlay-title")).toHaveText("Could not capture your mouse", {
      timeout: 15_000,
    });
    await page.click(".overlay-actions button:has-text('Try again')");
    await expect(page.locator(".overlay-title")).toHaveText(AWAITING_TITLE, { timeout: 15_000 });
    expect(await hitTargetAtArenaCentre(page)).toBe("run-canvas");
  });

  test("End session works while the arena is still preparing", async ({ page }) => {
    await openArena(page);
    await page.click(".run-controls button:has-text('End session')");
    await page.click("dialog.dialog button:has-text('End session')");
    await expect(page.locator("#view-setup")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#view-run")).toBeHidden();
  });

  test("Pause responds while the arena is still preparing", async ({ page }) => {
    await openArena(page);
    await page.click(".run-controls button:has-text('Pause')");
    // The control must SAY something happened rather than sit dead.
    await expect(page.locator(".run-bottombar")).toContainText("Capture request withdrawn");
    // And the arena stays startable afterwards.
    expect(await hitTargetAtArenaCentre(page)).toBe("run-canvas");
  });

  test("Escape leaves the arena while capture has not been acquired", async ({ page }) => {
    await openArena(page);
    await page.keyboard.press("Escape");
    await expect(page.locator("#view-setup")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#view-run")).toBeHidden();
  });

  test("the capture caption reports the path actually in use", async ({ page }) => {
    await openArena(page);
    const note = page.locator(".run-capture-note").first();
    await expect(note).toContainText("browser capture");
    // The caption is derived, not hardcoded: outside the desktop shell it must
    // say WHY native high-rate capture is not carrying the session.
    await expect(note).toHaveAttribute("title", /desktop shell/);
  });
});
