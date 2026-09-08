#!/usr/bin/env node
/**
 * RELEASE GATE — the core shooting test can actually be started.
 *
 * rc.3 passed every gate in this pipeline and still could not run a single
 * trial on Aldo's Windows PC: the arena overlay swallowed the "click to lock
 * in" click, and pointer-lock events were listened for on the canvas instead
 * of the document. Nothing here noticed, because the automated session suite
 * runs with ?e2e=1 — which grants the lock virtually and starts the session
 * without any click at all.
 *
 * This gate drives the REAL shell the way a player does: launch, configure a
 * session, click the arena, and require that the app leaves the preparing
 * state. Either outcome is acceptable —
 *
 *   - the mouse is captured and the session goes live, or
 *   - capture is refused and a diagnostic with working exits is shown
 *
 * — because the release-blocking failure is neither of those: sitting on
 * "Click to lock in" forever with dead controls.
 *
 * Usage:
 *   node scripts/verify-arena-entry.mjs                 # dev tree (electron .)
 *   node scripts/verify-arena-entry.mjs --exe "<path>"  # an installed build
 */
// Imported from the direct devDependency (@playwright/test re-exports the
// Electron driver) so this gate never depends on a transitive install.
import { _electron as electron } from "@playwright/test";
import process from "node:process";

const argv = process.argv.slice(2);
const exeIndex = argv.indexOf("--exe");
const executablePath = exeIndex >= 0 ? argv[exeIndex + 1] : null;

const failures = [];
const notes = [];
function check(ok, label, detail = "") {
  if (ok) {
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    failures.push(label);
  }
}

const launchOptions = executablePath
  ? { executablePath, args: [] }
  : { args: ["."], cwd: process.cwd() };

console.log(
  `arena entry gate: ${executablePath ? `installed app at ${executablePath}` : "development tree"}`,
);

let app;
try {
  app = await electron.launch({ ...launchOptions, timeout: 60_000 });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForLoadState("domcontentloaded");
  // The shell shows the window itself once the frontend is ready; focus it so
  // the click below carries real user activation.
  await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) {
      w.show();
      w.focus();
    }
  });
  await page.waitForSelector("#tabs", { timeout: 30_000 });

  // ---- configure a short session -----------------------------------------
  await page.click(`#tabs button[data-tab="setup"]`);
  await page.locator("#view-setup input[type=text]").first().fill("ArenaEntryGate");
  await page.click("#view-setup details.details summary");
  await page.locator("#setup-seed").fill("9001");
  await page.locator("#setup-rounds").fill("1");
  await page.locator("#setup-reps").fill("3");
  await page.locator("#setup-warmups").fill("0");
  await page.click(`#view-setup button[type=submit]`);
  await page.waitForSelector("#run-canvas", { timeout: 30_000 });
  // The arena invites a click only once the capture source exists.
  await page
    .locator(".overlay-title")
    .filter({ hasText: "Click to lock in" })
    .waitFor({ timeout: 30_000 });

  // ---- the overlay must not shield the arena or the controls -------------
  const hitTest = await page.evaluate(() => {
    const canvas = document.querySelector("#run-canvas");
    const r = canvas.getBoundingClientRect();
    const centre = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const controls = [...document.querySelectorAll(".run-controls button")].map((btn) => {
      const b = btn.getBoundingClientRect();
      const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return { label: (btn.textContent ?? "").trim(), reachable: btn === top || btn.contains(top) };
    });
    return {
      centreId: centre ? centre.id || centre.tagName : "(nothing)",
      overlayPointerEvents: getComputedStyle(document.querySelector(".overlay-message"))
        .pointerEvents,
      controls,
      captureNote: (document.querySelector(".run-capture-note")?.textContent ?? "").trim(),
      captureNoteDetail:
        document.querySelector(".run-capture-note")?.getAttribute("title") ?? "",
    };
  });
  check(hitTest.centreId === "run-canvas", "arena centre receives clicks", hitTest.centreId);
  check(
    hitTest.overlayPointerEvents === "none",
    "overlay does not take pointer events",
    hitTest.overlayPointerEvents,
  );
  for (const c of hitTest.controls) {
    check(c.reachable, `control is clickable: ${c.label}`);
  }
  check(
    hitTest.controls.length >= 2,
    "Pause and End session are present",
    `${hitTest.controls.length} controls`,
  );
  check(
    hitTest.captureNote.length > 0 && hitTest.captureNoteDetail.length > 0,
    "capture path is reported",
    `${hitTest.captureNote} :: ${hitTest.captureNoteDetail}`,
  );

  // ---- End session must work while the arena is still preparing ---------
  // (This is the state rc.3 trapped players in: the mouse is NOT captured, so
  // the bottom-bar controls are reachable and must actually do something.)
  await page.click(".run-controls button:has-text('End session')");
  await page.click("dialog.dialog button:has-text('End session')");
  const leftWhilePreparing = await page
    .waitForFunction(() => document.querySelector("#view-setup")?.hidden === false, undefined, {
      timeout: 20_000,
    })
    .then(() => true)
    .catch(() => false);
  check(leftWhilePreparing, "End session works while the arena is preparing");

  // ---- the click that starts the test ------------------------------------
  await page.click(`#view-setup button[type=submit]`);
  await page.waitForSelector("#run-canvas", { timeout: 30_000 });
  await page
    .locator(".overlay-title")
    .filter({ hasText: "Click to lock in" })
    .waitFor({ timeout: 30_000 });

  const box = await page.locator("#run-canvas").boundingBox();
  const startedAt = Date.now();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  const LIVE_STATES = [
    "candidate-transition",
    "warmup",
    "trial-ready",
    "trial-active",
    "inter-trial",
  ];
  const RESOLVE_MS = 15_000;
  let outcome = { state: "", overlay: "", locked: false, actions: [] };
  let wentLive = false;
  let diagnosed = false;
  while (Date.now() - startedAt < RESOLVE_MS) {
    outcome = await page.evaluate(() => ({
      state: document.querySelector(".run-screen")?.getAttribute("data-session-state") ?? "",
      overlay: (document.querySelector(".overlay-title")?.textContent ?? "").trim(),
      locked: document.pointerLockElement !== null,
      actions: [...document.querySelectorAll(".overlay-actions button")].map((b) =>
        (b.textContent ?? "").trim(),
      ),
    }));
    // "Live" means the ENGINE advanced, not merely that the lock landed: the
    // release-blocking symptom was a granted-or-not click that never moved the
    // session state at all.
    wentLive = LIVE_STATES.includes(outcome.state);
    diagnosed = outcome.overlay === "Could not capture your mouse";
    if (wentLive || diagnosed) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const elapsed = Date.now() - startedAt;

  check(
    wentLive || diagnosed,
    "the arena click resolves instead of hanging",
    `state="${outcome.state}" overlay="${outcome.overlay}" locked=${outcome.locked} after ${elapsed} ms`,
  );

  if (wentLive) {
    notes.push(
      `capture GRANTED — the session went live in ${elapsed} ms (state=${outcome.state}, pointerLock=${outcome.locked})`,
    );
    // While the pointer is locked the arena owns the cursor, so the bottom-bar
    // controls are deliberately unreachable by mouse. Esc is the documented
    // exit, and losing the lock must end the session visibly rather than
    // strand the player in an arena that can no longer see the mouse.
    //
    // Chromium's "Esc exits pointer lock" is handled below the page, and a
    // synthesised key event does not trigger it. So: press Esc, and if the
    // lock is still held, unlock the same way Esc does. What is under test is
    // the APP's response to losing the lock, not Chromium's key handling.
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 500));
    const stillLocked = await page.evaluate(() => document.pointerLockElement !== null);
    if (stillLocked) {
      notes.push("synthetic Esc did not reach Chromium's unlock; unlocking directly instead");
      await page.evaluate(() => document.exitPointerLock());
    }
    const ended = await page
      .waitForFunction(
        () =>
          document.querySelector("#view-run")?.hidden === true ||
          ["aborted", "analyzing", "complete"].includes(
            document.querySelector(".run-screen")?.getAttribute("data-session-state") ?? "",
          ),
        undefined,
        { timeout: 30_000 },
      )
      .then(() => true)
      .catch(() => false);
    check(ended, "losing the pointer lock ends the session visibly");
  } else if (diagnosed) {
    notes.push(
      `capture REFUSED on this host — diagnostic shown in ${elapsed} ms with exits: ${outcome.actions.join(", ")}`,
    );
    check(outcome.actions.length >= 2, "the refusal offers a way out", outcome.actions.join(", "));
    await page.click(".overlay-actions button:has-text('Back to setup')");
    const left = await page
      .waitForFunction(() => document.querySelector("#view-setup")?.hidden === false, undefined, {
        timeout: 20_000,
      })
      .then(() => true)
      .catch(() => false);
    check(left, "the capture diagnostic returns to setup");
  }
} catch (err) {
  check(false, "arena entry gate ran to completion", String(err));
} finally {
  await app?.close().catch(() => undefined);
}

for (const note of notes) console.log(`  note ${note}`);
if (failures.length > 0) {
  console.error(`\narena entry gate FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\narena entry gate: all checks passed.");
