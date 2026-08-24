import { expect, test } from "@playwright/test";

/**
 * Security round three (Pass 7, requirement O): the final integrated
 * presentation layer must stay inert under hostile text and hostile stored
 * settings. No XSS, no script execution, no layout-breaking data paths.
 */

test.describe("security round three", () => {
  test("hostile display name renders as inert text everywhere", async ({ page }) => {
    await page.goto("/");
    // Inject the hostile name through the normal settings path.
    const hostile = `<img src=x onerror=window.__pwned=1><script>window.__xss=1</` + `script>É́\u202Ereversed`;
    await page.click('#tabs button[data-tab="setup"]');
    await page.locator("#setup-name").fill(hostile);
    await page.locator("#view-setup button[type=submit]").click();
    // Session screen opens; go back home (name shows in greeting).
    await page.evaluate(() => window.history.replaceState({}, "", "/"));
    await page.reload();
    // The name renders as inert TEXT (no <img>/<script> ELEMENT exists)
    // and no injected handler ever executed.
    const hostileElement = await page.evaluate(() =>
      document.querySelector("img[src='x']") !== null,
    );
    expect(hostileElement).toBe(false);
    // No injected script executed.
    const pwned = await page.evaluate(() => ({
      pwned: (window as unknown as { __pwned?: number }).__pwned,
      xss: (window as unknown as { __xss?: number }).__xss,
    }));
    expect(pwned.pwned).toBeUndefined();
    expect(pwned.xss).toBeUndefined();
  });

  test("oversized name is capped and harmless", async ({ page }) => {
    await page.goto("/");
    await page.click('#tabs button[data-tab="setup"]');
    await page.locator("#setup-name").fill("A".repeat(50_000));
    await page.locator("#view-setup button[type=submit]").click();
    await page.evaluate(() => window.history.replaceState({}, "", "/"));
    await page.reload();
    const greeting = await page.locator(".page-title").first().innerText();
    expect(greeting.length).toBeLessThan(200);
  });

  test("corrupt/hostile stored settings cannot poison the app", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "aldo-aim-lab-settings",
        JSON.stringify({
          dpi: -99999,
          sensX: Number.POSITIVE_INFINITY,
          sensY: "not-a-number",
          rounds: 99,
          repsPerCandidate: -5,
          warmupTrials: null,
          experimentSeed: Number.NaN,
          playerName: { evil: true },
          yExploration: "yes",
          __proto__: { polluted: true },
        }),
      );
    });
    await page.goto("/");
    const sane = await page.evaluate(() =>
      localStorage.getItem("aldo-aim-lab-settings"),
    );
    // Nothing was written back by merely loading; but loading itself must
    // not crash and settings must sanitize on use.
    await page.click('#tabs button[data-tab="setup"]');
    const dpiValue = Number(await page.locator("#setup-dpi").inputValue());
    const sensX = Number(await page.locator("#setup-sensx").inputValue());
    expect(dpiValue).toBeGreaterThanOrEqual(50); // PREFLIGHT_THRESHOLDS.minPlausibleDpi
    expect(sensX).toBeGreaterThanOrEqual(1); // DEFAULT_SAFE_RANGE.minSensX
    const pollution = await page.evaluate(
      () => ({} as Record<string, unknown>).polluted,
    );
    expect(pollution).toBeUndefined();
    void sane;
  });

  test("malformed numeric input stays clamped at submit", async ({ page }) => {
    await page.goto("/");
    await page.click('#tabs button[data-tab="setup"]');
    await page.locator("#setup-dpi").fill("1e9");
    await page.locator("#setup-sensx").fill("-40");
    await page.locator("#view-setup button[type=submit]").click();
    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("aldo-aim-lab-settings") ?? "{}"),
    );
    expect(stored.dpi).toBeLessThanOrEqual(26000);
    expect(stored.sensX).toBeGreaterThanOrEqual(1);
  });
});
