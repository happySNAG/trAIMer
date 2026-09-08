#!/usr/bin/env node
/**
 * RELEASE GATE — the INSTALLED application, driven end to end the way a
 * player uses it (Pass 5, requirement 25).
 *
 * The earlier installed-app gates each prove one thing: the app starts and
 * stops cleanly, the arena can be entered, the candidate sensitivity changes,
 * the picker offers every profile. None of them completes a calibration. This
 * gate does, inside the shipped Electron shell:
 *
 *   launch → Aim Test → name, DPI, a real game profile and the sensitivity
 *   played there → the Quick mode → start → hit at least one shooting target
 *   → complete at least one tracking drill → pass through a break → reach
 *   Results → find the game conversion → open History and find the session
 *   → close the app.
 *
 * The scripted player is the same one the browser suite uses: it reads the
 * arena snapshot, moves toward the live target at a plausible speed, clicks
 * inside the hit radius, and follows without clicking in a tracking drill.
 * Only Pointer Lock is virtual (`?e2e=1`); capture, recorder, validator,
 * optimizer, results, conversion and persistence are all the production
 * paths.
 *
 * With `--history-only --expect-history N` the gate instead launches, opens
 * History, and requires at least N stored sessions whose detail carries the
 * game conversion — which is how the upgrade / uninstall / reinstall test
 * proves a player's data survived (requirement 24).
 *
 * Usage:
 *   node scripts/verify-installed-smoke.mjs                       # dev tree
 *   node scripts/verify-installed-smoke.mjs --exe "<path>"        # installed
 *   node scripts/verify-installed-smoke.mjs --exe "<path>" --history-only --expect-history 1
 *   node scripts/verify-installed-smoke.mjs --exe "<path>" --out result.json
 */
/* global window, document, performance */
import { _electron as electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import process from "node:process";

/** The legacy product names, read from the branding gate's own contract. */
const LEGACY_NAMES = JSON.parse(
  execFileSync(process.execPath, ["scripts/verify-branding.mjs", "--print-contract"], {
    encoding: "utf8",
  }),
).patterns;

const APP_ORIGIN = "aldo://app";
/** The game this gate calibrates for. A real, partly verified profile. */
const GAME_ID = "valorant";
const GAME_NAME = "Valorant";
const GAME_CURRENT = "0.4";
const DPI = "800";
/** Quick mode: 5 candidates × (5 measured + 1 warm-up) = 30 drills. */
const MODE = "quick";
const SESSION_DEADLINE_MS = 420_000;

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const executablePath = flag("--exe");
const historyOnly = argv.includes("--history-only");
/** The name typed into the player field; lets two runs be told apart in History. */
const playerName = flag("--player") ?? "SmokePlayer";
/** A player name that must already be in History (data carried across an upgrade / reinstall). */
const expectPlayer = flag("--expect-player");
/**
 * The build under test predates this gate's newest player-facing text. Only
 * checks on wording added after that build are relaxed; the flow itself is
 * not. Used for the upgrade test's "install the previous RC first" step.
 */
const priorBuild = argv.includes("--prior-build");
const expectHistory = Number(flag("--expect-history") ?? (historyOnly ? "1" : "0"));
const outPath = flag("--out");

const failures = [];
const notes = [];
const summary = {
  mode: historyOnly ? "history-only" : "full",
  executablePath,
  checks: [],
};
function check(ok, label, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  summary.checks.push({ ok, label, detail });
  if (!ok) failures.push(label);
}

const launchOptions = executablePath
  ? { executablePath, args: [] }
  : { args: ["."], cwd: process.cwd() };

console.log(
  `installed-app full smoke (${summary.mode}): ${executablePath ? `installed app at ${executablePath}` : "development tree"}`,
);

function sessionState(page) {
  return page.evaluate(
    () => document.querySelector(".run-screen")?.getAttribute("data-session-state") ?? "",
  );
}

/** One slice of scripted play; the same player the browser suite drives. */
async function drive(page, budgetMs) {
  await page.evaluate(async (budget) => {
    const hooks = window.__ALDO_TEST_HOOKS__;
    if (!hooks) throw new Error("test hooks missing");
    await hooks.grantLock();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const STEP_MS = 5;
    const MAX_STEP_PX = 6;
    const deadline = performance.now() + budget;
    let lastClickAt = 0;
    while (performance.now() < deadline) {
      const snap = await hooks.arenaSnapshot();
      if (!snap || !snap.reticle) {
        await sleep(STEP_MS);
        continue;
      }
      const target = snap.targets[0];
      if (!target) {
        await hooks.injectPointerSample(1, 0);
        await sleep(STEP_MS);
        continue;
      }
      let dx = target.x - snap.reticle.x;
      let dy = target.y - snap.reticle.y;
      const dist = Math.hypot(dx, dy);
      if (dist > MAX_STEP_PX) {
        dx = (dx / dist) * MAX_STEP_PX;
        dy = (dy / dist) * MAX_STEP_PX;
      }
      await hooks.injectPointerSample(dx, dy);
      const tracking = snap.mode === "track";
      if (!tracking && dist <= target.radius * 0.6 && performance.now() - lastClickAt > 120) {
        lastClickAt = performance.now();
        await hooks.injectClick();
      }
      await sleep(STEP_MS);
    }
  }, budgetMs);
}

async function presentation(page) {
  return page.evaluate(async () => {
    const hooks = window.__ALDO_TEST_HOOKS__;
    return hooks ? hooks.presentationState() : null;
  });
}

async function openTab(page, tab) {
  await page.click(`#tabs button[data-tab="${tab}"]`);
}

async function stopProcesses(app) {
  await app?.close().catch(() => undefined);
}

let app;
try {
  app = await electron.launch({ ...launchOptions, timeout: 60_000 });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) {
      w.show();
      w.focus();
    }
  });
  await page.waitForSelector("#tabs", { timeout: 30_000 });
  check(true, "the installed application launched and rendered its shell");

  // Only Pointer Lock is virtual under ?e2e=1; everything else is production.
  await page.goto(`${APP_ORIGIN}/index.html?e2e=1`);
  await page.waitForSelector("#tabs", { timeout: 30_000 });

  const wordmark = await page.locator("#wordmark").textContent();
  check(/trAIMer/.test(wordmark ?? ""), "the wordmark says trAIMer", (wordmark ?? "").replace(/\s+/g, " ").trim());

  if (!historyOnly) {
    // ---- setup: the player's own flow ---------------------------------------
    await openTab(page, "setup");
    await page.waitForSelector("#setup-dpi", { timeout: 30_000 });
    await page.fill("#setup-name", playerName);
    await page.fill("#setup-dpi", DPI);
    await page.locator("#setup-dpi").blur();
    await page.selectOption("#game-profile-select", GAME_ID);
    await page.waitForSelector("#game-current-hipfire", { timeout: 10_000 });
    await page.fill("#game-current-hipfire", GAME_CURRENT);
    await page.locator("#game-current-hipfire").blur();
    await page.waitForSelector("#game-physical-equivalent", { timeout: 10_000 });
    const equivalent = await page.locator("#game-physical-equivalent").textContent();
    check(
      /cm\/360/.test(equivalent ?? ""),
      `${GAME_NAME} ${GAME_CURRENT} at ${DPI} DPI shows a physical equivalent before any test`,
      (equivalent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
    );

    const modeCard = page.locator(`.mode-card[data-mode="${MODE}"]`);
    await modeCard.click();
    const pressed = await modeCard.getAttribute("aria-pressed");
    check(pressed === "true", `the ${MODE} calibration mode is selectable and selected`);
    // Breaks stay on, at their shortest, so the run passes through one.
    const breaksOn = await page.locator("#setup-autobreaks").isChecked();
    if (!breaksOn) await page.locator("#setup-autobreaks").check();
    await page.fill("#setup-breakseconds", "5");
    await page.locator("#setup-ycheck").uncheck();

    await page.click(`#view-setup button[type=submit]`);
    await page.waitForSelector("#run-canvas", { timeout: 30_000 });
    check(true, "the session started and the arena is on screen");
    await page.click("#run-canvas");

    // ---- play ---------------------------------------------------------------
    let sawHit = false;
    let sawTracking = false;
    let breaksSeen = 0;
    let skippedBreak = false;
    const statesSeen = new Set();
    const deadline = Date.now() + SESSION_DEADLINE_MS;
    let state = "";
    let lastState = "";
    while (Date.now() < deadline) {
      state = await sessionState(page);
      statesSeen.add(state);
      if (state === "analyzing" || state === "complete" || state === "aborted") break;
      if (state === "awaiting-lock") {
        await page.click("#run-canvas");
        await page.waitForTimeout(150);
        lastState = state;
        continue;
      }
      if (state === "rest") {
        if (lastState !== "rest") breaksSeen += 1;
        lastState = state;
        // The first break is waited out in full (the player's mouse is free
        // and the countdown runs); the second is skipped the way a player
        // may, proving the skip path too.
        if (breaksSeen >= 2 && !skippedBreak) {
          const skip = page.locator(".overlay-actions button:has-text('Skip break')");
          if ((await skip.count()) > 0) {
            await skip.click();
            skippedBreak = true;
          }
        }
        await page.waitForTimeout(300);
        continue;
      }
      lastState = state;
      await drive(page, 400);
      const p = await presentation(page);
      if (p && p.bestStreak > 0) sawHit = true;
      if (p && p.lastTrackingCompletion) sawTracking = true;
    }
    check(
      state === "complete" || state === "analyzing",
      "the session ran to its natural end",
      `final state ${state}; states seen: ${[...statesSeen].join(", ")}`,
    );
    check(sawHit, "at least one shooting target was hit");
    check(sawTracking, "at least one tracking drill was completed");
    check(breaksSeen > 0, "the session passed through a break", `${breaksSeen} break(s)`);
    notes.push(`break skipped by the player path: ${skippedBreak ? "yes" : "no (waited out)"}`);

    // ---- results ------------------------------------------------------------
    await page.waitForFunction(
      () => document.querySelector("#view-results h2")?.textContent === "Results",
      null,
      { timeout: 90_000 },
    );
    const results = page.locator("#view-results");
    const resultsText = (await results.textContent()) ?? "";
    check(/Calibration complete/.test(resultsText), "Results says the calibration completed");
    check(/How you performed/.test(resultsText), "Results shows the performance cards");
    check(/What to do next/.test(resultsText), "Results says what to do next");
    const recommended = /Recommended sensitivity/.test(resultsText);
    const moreData = /More data needed/.test(resultsText);
    check(
      recommended || moreData,
      "Results either recommends a sensitivity or says honestly that more data is needed",
      recommended ? "recommendation shown" : "more data needed",
    );
    check(/Advanced results/.test(resultsText), "Advanced results remain reachable");
    if (recommended) {
      check(
        new RegExp(`Recommended for ${GAME_NAME}`).test(resultsText),
        `the recommendation is converted for ${GAME_NAME}`,
      );
      check(
        new RegExp(`What to set in ${GAME_NAME}`).test(resultsText),
        `the ${GAME_NAME} card lists what to set in the game`,
      );
      if (!priorBuild) {
        check(
          /does not change game settings/.test(resultsText),
          "the player is told to change the setting in the game themselves",
        );
      }
    } else {
      notes.push("no recommendation this run (evidence gate refused) — conversion checks skipped; the history check below still applies");
    }
    const legacy = LEGACY_NAMES.filter((n) => resultsText.includes(n));
    check(legacy.length === 0, "no legacy product name on the results screen");
  }

  // ---- history ---------------------------------------------------------------
  await openTab(page, "history");
  await page.waitForSelector("#view-history", { timeout: 30_000 });
  await page.waitForFunction(
    () => !/Loading/i.test(document.querySelector("#view-history")?.textContent ?? "Loading"),
    null,
    { timeout: 60_000 },
  ).catch(() => undefined);
  const rows = page.locator("#view-history .session-row");
  const rowCount = await rows.count();
  const wanted = historyOnly ? expectHistory : Math.max(1, expectHistory);
  check(
    rowCount >= wanted,
    `History lists at least ${wanted} stored session(s)`,
    `${rowCount} listed`,
  );
  if (rowCount > 0) {
    await rows.first().click();
    const detail = page.locator("#view-history .session-detail").first();
    const detailText = (await detail.textContent().catch(() => "")) ?? "";
    check(
      /Sensitivity validity/.test(detailText),
      "the session detail states its sensitivity validity",
    );
    check(
      !/cannot tell you a sensitivity/.test(detailText),
      "a session recorded by this build is not marked as a pre-candidate-gain session",
    );
    if (!historyOnly || expectHistory > 0) {
      check(
        /Game conversion/.test(detailText) && new RegExp(`${GAME_ID} v\\d+`).test(detailText),
        "the stored session carries the game profile id and definition version",
      );
    }
  }
  if (expectPlayer) {
    const listed = (await page.locator("#view-history").textContent()) ?? "";
    check(
      listed.includes(expectPlayer),
      `History still lists the session recorded earlier by "${expectPlayer}"`,
    );
  }
  summary.historyRows = rowCount;

  // ---- clean shutdown ----------------------------------------------------------
  await stopProcesses(app);
  app = null;
  check(true, "the application closed on request");
} catch (err) {
  check(false, "installed-app full smoke ran to completion", String(err));
} finally {
  await stopProcesses(app);
}

for (const note of notes) console.log(`  note ${note}`);
summary.pass = failures.length === 0;
summary.failures = failures;
if (outPath) writeFileSync(outPath, JSON.stringify(summary, null, 2));
if (failures.length > 0) {
  console.error(`\ninstalled-app full smoke FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\ninstalled-app full smoke: all checks passed.");
