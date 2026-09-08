#!/usr/bin/env node
/**
 * Captures the documentation screenshots in docs/screenshots/ (Pass 5,
 * requirement 4).
 *
 * What these pictures are, exactly: the real frontend — the same bundle the
 * Windows installer ships — served by the Vite dev server and rendered in
 * Chromium at 1440×900, driven through a complete Quick calibration by the
 * scripted player the browser suite uses (Pointer Lock is virtual under
 * `?e2e=1`; capture, recorder, validator, optimizer, results, conversion and
 * persistence are the production paths). The numbers on the results screens
 * are therefore the engine's real output for that scripted session, not a
 * mock-up — and they are also not a human's aim. docs/SCREENSHOTS.md says
 * which frames still want a human capture from the installed Windows app.
 *
 * Nothing is drawn or composited by this script: every file is a plain
 * `page.screenshot()` of what was on screen.
 *
 * Usage (from a tree with `npm run app` available):
 *   node scripts/capture-screenshots.mjs            # starts Vite itself
 *   node scripts/capture-screenshots.mjs --no-serve # Vite already running on :5173
 */
/* global window, document, performance, fetch */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const OUT_DIR = "docs/screenshots";
const BASE = "http://127.0.0.1:5173";
const GAME_ID = "valorant";
const GAME_CURRENT = "0.4";
const DPI = "800";
const noServe = process.argv.includes("--no-serve");

mkdirSync(OUT_DIR, { recursive: true });

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`dev server did not answer at ${url}`);
}

let server = null;
if (!noServe) {
  server = spawn("npm", ["run", "app", "--", "--host", "127.0.0.1"], {
    stdio: "ignore",
    detached: false,
  });
}
await waitForServer(BASE, 60_000);

const captured = [];
async function shot(page, name, options = {}) {
  const file = join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: options.fullPage ?? false });
  captured.push(file);
  console.log(`  captured ${file}`);
}

function sessionState(page) {
  return page.evaluate(
    () => document.querySelector(".run-screen")?.getAttribute("data-session-state") ?? "",
  );
}

async function arenaMode(page) {
  return page.evaluate(async () => {
    const snap = await window.__ALDO_TEST_HOOKS__?.arenaSnapshot();
    return snap?.mode ?? null;
  });
}

/** The browser suite's scripted player, for one slice of play. */
async function drive(page, budgetMs) {
  await page.evaluate(async (budget) => {
    const hooks = window.__ALDO_TEST_HOOKS__;
    if (!hooks) throw new Error("test hooks missing");
    await hooks.grantLock();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const deadline = performance.now() + budget;
    let lastClickAt = 0;
    while (performance.now() < deadline) {
      const snap = await hooks.arenaSnapshot();
      if (!snap || !snap.reticle) {
        await sleep(5);
        continue;
      }
      const target = snap.targets[0];
      if (!target) {
        await hooks.injectPointerSample(1, 0);
        await sleep(5);
        continue;
      }
      let dx = target.x - snap.reticle.x;
      let dy = target.y - snap.reticle.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 6) {
        dx = (dx / dist) * 6;
        dy = (dy / dist) * 6;
      }
      await hooks.injectPointerSample(dx, dy);
      if (snap.mode !== "track" && dist <= target.radius * 0.6 && performance.now() - lastClickAt > 120) {
        lastClickAt = performance.now();
        await hooks.injectClick();
      }
      await sleep(5);
    }
  }, budgetMs);
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  colorScheme: "dark",
});
const page = await context.newPage();
try {
  await page.goto(`${BASE}/?e2e=1`);
  await page.waitForSelector("#tabs", { timeout: 30_000 });
  await page.waitForTimeout(800);
  await shot(page, "01-home");

  // ---- setup / game picker ------------------------------------------------
  await page.click(`#tabs button[data-tab="setup"]`);
  await page.waitForSelector("#setup-dpi", { timeout: 30_000 });
  await page.fill("#setup-name", "Player");
  await page.fill("#setup-dpi", DPI);
  await page.locator("#setup-dpi").blur();
  await page.selectOption("#game-profile-select", GAME_ID);
  await page.waitForSelector("#game-current-hipfire", { timeout: 10_000 });
  await page.fill("#game-current-hipfire", GAME_CURRENT);
  await page.locator("#game-current-hipfire").blur();
  await page.waitForSelector("#game-physical-equivalent", { timeout: 10_000 });
  await page.locator(`.mode-card[data-mode="quick"]`).click();
  await page.locator("#setup-ycheck").uncheck();
  await page.locator("#setup-game-profile").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot(page, "02-setup-game-picker");

  // An experimental profile, for the status treatment.
  await page.selectOption("#game-profile-select", "pubg-battlegrounds");
  await page.waitForSelector("#game-profile-status", { timeout: 10_000 });
  await page.locator("#setup-game-profile").evaluate((n) => n.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(200);
  await shot(page, "02c-setup-experimental-profile");
  await page.selectOption("#game-profile-select", GAME_ID);
  await page.waitForSelector("#game-current-hipfire", { timeout: 10_000 });
  await page.fill("#game-current-hipfire", GAME_CURRENT);
  await page.locator("#game-current-hipfire").blur();
  await page.waitForTimeout(200);

  // ---- arena --------------------------------------------------------------
  await page.click(`#view-setup button[type=submit]`);
  await page.waitForSelector("#run-canvas", { timeout: 30_000 });
  await page.click("#run-canvas");

  let shotArena = false;
  let shotTracking = false;
  let shotBreak = false;
  const deadline = Date.now() + 420_000;
  let state = "";
  while (Date.now() < deadline) {
    state = await sessionState(page);
    if (state === "analyzing" || state === "complete" || state === "aborted") break;
    if (state === "awaiting-lock") {
      await page.click("#run-canvas");
      await page.waitForTimeout(150);
      continue;
    }
    if (state === "rest") {
      if (!shotBreak) {
        await page.waitForTimeout(400);
        await shot(page, "05-break");
        shotBreak = true;
      }
      await page.waitForTimeout(300);
      continue;
    }
    const mode = await arenaMode(page);
    if (state === "trial-active" && mode && mode !== "track" && !shotArena) {
      await drive(page, 250);
      await shot(page, "03-arena-shooting-drill");
      shotArena = true;
    }
    if (state === "trial-active" && mode === "track" && !shotTracking) {
      await drive(page, 600);
      await shot(page, "04-arena-tracking-drill");
      shotTracking = true;
    }
    await drive(page, 400);
  }

  // ---- results ------------------------------------------------------------
  await page.waitForFunction(
    () => document.querySelector("#view-results h2")?.textContent === "Results",
    null,
    { timeout: 90_000 },
  );
  await page.waitForTimeout(600);
  await shot(page, "06-results-summary");
  const gameCard = page.locator("#view-results section.card").filter({ hasText: "Recommended for Valorant" }).first();
  if ((await gameCard.count()) > 0) {
    await gameCard.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await shot(page, "07-results-game-conversion");
  }
  const advanced = page.locator("#view-results section.card").filter({ hasText: "Advanced results" }).first();
  if ((await advanced.count()) > 0) {
    await advanced.evaluate((n) => n.scrollIntoView({ block: "start" }));
    // Open whatever disclosure the card keeps closed by default.
    const summaries = advanced.locator("details > summary");
    const n = await summaries.count();
    for (let i = 0; i < Math.min(n, 2); i++) await summaries.nth(i).click();
    await page.waitForTimeout(300);
    await shot(page, "08-results-advanced");
  }

  // ---- history ------------------------------------------------------------
  await page.click(`#tabs button[data-tab="history"]`);
  await page.waitForSelector("#view-history .session-row", { timeout: 30_000 });
  await page.locator("#view-history .session-row").first().click();
  await page.waitForTimeout(400);
  await shot(page, "09-history");

  writeFileSync(
    join(OUT_DIR, "MANIFEST.json"),
    JSON.stringify(
      {
        capturedAtIso: new Date().toISOString(),
        how: "Chromium 1440x900, Vite dev server, scripted player under ?e2e=1 (see scripts/capture-screenshots.mjs)",
        files: captured,
        sessionEndState: state,
      },
      null,
      2,
    ),
  );
  console.log(`\n${captured.length} screenshots written to ${OUT_DIR}/`);
} finally {
  await browser.close();
  if (server) server.kill();
}
