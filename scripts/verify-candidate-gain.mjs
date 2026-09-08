#!/usr/bin/env node
/**
 * RELEASE GATE — the INSTALLED application really changes sensitivity between
 * blinded candidates (Pass 15, requirement K).
 *
 * ## What went wrong that this exists to stop
 *
 * Up to and including rc.8 the arena moved the crosshair one logical pixel per
 * mouse count for every candidate it was comparing. Every automated suite was
 * green: the candidate reached the trial record, the optimizer, the results
 * page and the simulator's player model. It reached everything except the
 * player's hand. A human sitting at the machine felt one sensitivity for the
 * whole calibration, so the recommendation the session produced was not a
 * measurement of sensitivity at all.
 *
 * A unit test could not have caught it, because the arithmetic was correct
 * everywhere it existed; the defect was that the arena never called it. So
 * this gate measures the OUTCOME, in the shipped Electron shell, the way a
 * player experiences it: inject a known mouse movement, watch how far the
 * crosshair actually travels, and require that the answer changes when the
 * blinded candidate does.
 *
 * ## Blinding is untouched
 *
 * The probe reads only the reticle position — already on screen for anyone
 * playing — and injects only mouse movement. Nothing reports which candidate
 * is active, its sensitivity, or its gain. The gate learns exactly what a
 * player's hand would learn, and nothing more.
 *
 * Usage:
 *   node scripts/verify-candidate-gain.mjs                 # dev tree
 *   node scripts/verify-candidate-gain.mjs --exe "<path>"  # an installed build
 */
import { _electron as electron } from "@playwright/test";
import process from "node:process";

const APP_ORIGIN = "aldo://app";
/** Raw mouse counts per probe. Large enough to measure, small enough to undo. */
const PROBE_COUNTS = 40;
/**
 * The narrowest arm of the default candidate ladder is ±15 %, so two adjacent
 * rungs differ by ~13 % at worst. Anything under this is not a candidate
 * change.
 */
const MIN_LADDER_SPREAD = 1.1;

const argv = process.argv.slice(2);
const exeIndex = argv.indexOf("--exe");
const executablePath = exeIndex >= 0 ? argv[exeIndex + 1] : null;

const failures = [];
const notes = [];
function check(ok, label, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

const launchOptions = executablePath
  ? { executablePath, args: [] }
  : { args: ["."], cwd: process.cwd() };

console.log(
  `candidate-gain gate: ${executablePath ? `installed app at ${executablePath}` : "development tree"}`,
);

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

  // The shell cannot grant Pointer Lock to a headless CI runner reliably, and
  // a real mouse cannot be driven into it at all. `?e2e=1` swaps the LOCK for
  // a virtual grant and lets scripted movement in — through the production
  // capture source, the production reticle and the production run controller.
  // Nothing about the gain path is stubbed; only the lock is.
  await page.goto(`${APP_ORIGIN}/index.html?e2e=1`);
  await page.waitForSelector("#tabs", { timeout: 30_000 });

  // ---- a short session -----------------------------------------------------
  await page.click(`#tabs button[data-tab="setup"]`);
  await page.locator("#view-setup input[type=text]").first().fill("CandidateGainGate");
  await page.click("#view-setup details.details summary");
  await page.locator("#setup-seed").fill("515");
  await page.locator("#setup-rounds").fill("1");
  await page.locator("#setup-reps").fill("3");
  await page.locator("#setup-warmups").fill("0");
  await page.locator("#setup-ycheck").uncheck();
  await page.click(`#view-setup button[type=submit]`);
  await page.waitForSelector("#run-canvas", { timeout: 30_000 });
  await page.click("#run-canvas");

  const gains = [];
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(
      () => document.querySelector(".run-screen")?.getAttribute("data-session-state") ?? "",
    );
    if (["analyzing", "complete", "aborted"].includes(state)) break;
    if (state === "awaiting-lock") {
      await page.click("#run-canvas");
      await new Promise((r) => setTimeout(r, 150));
    }

    const gain = await page.evaluate(async (counts) => {
      const hooks = window.__ALDO_TEST_HOOKS__;
      if (!hooks) return null;
      await hooks.grantLock();
      const before = await hooks.arenaSnapshot();
      if (!before?.reticle) return null;
      // Probe away from the nearer wall so clamping cannot eat the movement.
      const dx = before.reticle.x > 640 ? -counts : counts;
      await hooks.injectPointerSample(dx, 0);
      const after = await hooks.arenaSnapshot();
      if (!after?.reticle) return null;
      const moved = after.reticle.x - before.reticle.x;
      await hooks.injectPointerSample(-dx, 0);
      return moved / dx;
    }, PROBE_COUNTS);
    if (typeof gain === "number" && Number.isFinite(gain) && gain > 0) gains.push(gain);

    // Advance the session toward the next blinded candidate block.
    await page.evaluate(async () => {
      const hooks = window.__ALDO_TEST_HOOKS__;
      if (!hooks) return;
      await hooks.grantLock();
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const end = performance.now() + 600;
      let lastClick = 0;
      while (performance.now() < end) {
        const snap = await hooks.arenaSnapshot();
        if (!snap?.reticle) {
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
        if (
          snap.mode !== "track" &&
          dist <= target.radius * 0.6 &&
          performance.now() - lastClick > 120
        ) {
          lastClick = performance.now();
          await hooks.injectClick();
        }
        await sleep(5);
      }
    });

    const distinctSoFar = new Set(gains.map((g) => g.toFixed(4)));
    if (distinctSoFar.size >= 2) break;
  }

  check(
    gains.length > 2,
    "the shipped bundle's arena answered the probe",
    `${gains.length} probes`,
  );

  const distinct = [...new Set(gains.map((g) => Number(g.toFixed(4))))].sort((a, b) => a - b);
  check(
    distinct.length >= 2,
    "two blinded candidates move the crosshair by different amounts",
    `gains observed: ${distinct.join(", ")}`,
  );

  if (distinct.length >= 2) {
    const spread = distinct[distinct.length - 1] / distinct[0];
    check(
      spread > MIN_LADDER_SPREAD,
      "the difference is at least one ladder step",
      `spread ${spread.toFixed(4)}x`,
    );
  }

  // The rc.8 signature, named explicitly so a regression report says what
  // happened rather than only that a number was wrong.
  check(
    !distinct.every((g) => Math.abs(g - 1) < 1e-6),
    "the arena has NOT reverted to 1 px/count regardless of candidate",
    `gains observed: ${distinct.join(", ")}`,
  );

  notes.push(
    `measured reticle gains (logical px per mouse count): ${distinct.map((g) => g.toFixed(4)).join(", ")}`,
  );
} catch (err) {
  check(false, "candidate-gain gate ran to completion", String(err));
} finally {
  await app?.close().catch(() => undefined);
}

for (const note of notes) console.log(`  note ${note}`);
if (failures.length > 0) {
  console.error(`\ncandidate-gain gate FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\ncandidate-gain gate: all checks passed.");
