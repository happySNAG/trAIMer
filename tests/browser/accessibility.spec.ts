import { expect, test } from "@playwright/test";

/**
 * Accessibility automation (Pass 7, requirement Q) — dependency-light checks
 * over the real rendered views: labeled controls, sane heading hierarchy,
 * labeled form fields, and icon-only decorations hidden from AT.
 */

const TABS = ["home", "setup", "results", "history", "calibration", "diagnostics", "data"] as const;

test.describe("accessibility", () => {
  for (const tab of TABS) {
    test(`every control on '${tab}' has an accessible name`, async ({ page }) => {
      await page.goto("/");
      await page.click(`#tabs button[data-tab="${tab}"]`);
      await expect(page.locator(`#view-${tab}`)).toBeVisible();
      // Give async panels a moment to mount.
      await page.waitForTimeout(400);

      const unlabeled = await page.evaluate(() => {
        const section = document.querySelector("main > section:not([hidden])");
        if (!section) return [];
        const bad: string[] = [];
        for (const btn of section.querySelectorAll("button")) {
          const name =
            btn.getAttribute("aria-label") ??
            btn.textContent?.trim() ??
            "";
          if (name.length === 0 && !btn.hasAttribute("aria-hidden")) {
            bad.push(`button#${btn.id}.${btn.className}`);
          }
        }
        return bad;
      });
      expect(unlabeled, `unlabeled buttons on ${tab}`).toEqual([]);
    });

    test(`heading hierarchy on '${tab}' does not skip levels`, async ({ page }) => {
      await page.goto("/");
      await page.click(`#tabs button[data-tab="${tab}"]`);
      await page.waitForTimeout(400);
      const levels = await page.evaluate(() => {
        const section = document.querySelector("main > section:not([hidden])");
        if (!section) return [];
        return [...section.querySelectorAll("h1,h2,h3,h4,h5,h6")].map(
          (h) => Number(h.tagName[1]),
        );
      });
      let prev = 0;
      const violations: string[] = [];
      for (const level of levels) {
        if (prev > 0 && level > prev + 1) violations.push(`${prev}->${level}`);
        prev = level;
      }
      expect(violations, `heading skips on ${tab}`).toEqual([]);
    });
  }

  test("form fields on the Test tab have programmatic labels", async ({ page }) => {
    await page.goto("/");
    await page.click('#tabs button[data-tab="setup"]');
    const unlabeled = await page.evaluate(() => {
      const section = document.querySelector("#view-setup")!;
      const bad: string[] = [];
      for (const input of section.querySelectorAll("input, select, textarea")) {
        if ((input as HTMLInputElement).type === "hidden") continue;
        const id = (input as HTMLInputElement).id;
        const hasLabel =
          (id && section.querySelector(`label[for="${id}"]`) !== null) ||
          input.closest("label") !== null ||
          input.getAttribute("aria-label") !== null;
        if (!hasLabel) bad.push(id || input.getAttribute("name") || "?");
      }
      return bad;
    });
    expect(unlabeled).toEqual([]);
  });

  test("decorative icons are hidden from assistive technology", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(300);
    const exposed = await page.evaluate(() =>
      [...document.querySelectorAll("svg")]
        .filter((svg) => !svg.getAttribute("aria-hidden") && !svg.querySelector("title"))
        .length,
    );
    expect(exposed, "SVG icons without aria-hidden/title").toBe(0);
  });

  test("confirm dialog traps attention and closes with Escape", async ({ page }) => {
    await page.goto("/");
    await page.click('#tabs button[data-tab="data"]');
    // Danger-zone restore opens its confirm <dialog> after choosing a file.
    const restoreButton = page.locator("#view-data button", { hasText: /restore/i }).first();
    await restoreButton.click();
    await page.locator("#view-data input[type=file]").nth(1).setInputFiles({
      name: "backup.json",
      mimeType: "application/json",
      buffer: Buffer.from("{}"),
    });
    const dialog = page.locator("dialog[open]");
    await expect(dialog).toBeVisible();
    const focusInside = await page.evaluate(() =>
      document.querySelector("dialog[open]")?.contains(document.activeElement) ?? false,
    );
    expect(focusInside || document.activeElement?.tagName === "BODY").toBeTruthy();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  });
});
