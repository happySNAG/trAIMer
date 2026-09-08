#!/usr/bin/env node
/**
 * RELEASE GATE — the INSTALLED application's game picker (Game Profile
 * Campaign, Pass 3, requirement 10).
 *
 * Pass 2 proved the five profiles were in the bundle the installer carried,
 * but nothing drove the picker inside the installed Windows application. A
 * profile can be in the bundle and still be unreachable — a registry that
 * refuses to load, a picker that filters it out, a field that never renders.
 * This gate opens the shipped shell, walks to the Aim Test screen, and works
 * the real picker the way a player would.
 *
 * What it checks, per public profile the ENGINE declares (read back through
 * the e2e hook, never from a hand-written list):
 *
 *   - the profile is offered, and every profile the pass requires is there;
 *   - selecting it renders exactly the fields its declaration calls for
 *     (vertical, field of view, scoped-matching choice) and nothing else;
 *   - typing a value inside its own range produces a physical equivalent;
 *   - its definition version is reachable in the profile details.
 *
 * Plus, once: Generic / Raw still converts, a selection and its value survive
 * a reload, the filter box narrows the list, no fixture profile appears, and
 * no legacy product name appears anywhere on the screen.
 *
 * Usage:
 *   node scripts/verify-game-picker.mjs                 # dev tree
 *   node scripts/verify-game-picker.mjs --exe "<path>"  # an installed build
 */
/* global window, document */
import { _electron as electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import process from "node:process";

const APP_ORIGIN = "aldo://app";

/** Every public profile this pass ships. Missing one is a failed release. */
const REQUIRED_PROFILE_IDS = [
  "apex-legends",
  "battlefield-6",
  "call-of-duty-warzone",
  "counter-strike-2",
  "fortnite",
  "marvel-rivals",
  "overwatch-2",
  "pubg-battlegrounds",
  "rainbow-six-siege",
  "the-finals",
  "valorant",
  "generic-raw",
];

/**
 * The legacy product names, read from the branding gate's own contract so
 * there is exactly one list of them in the tree (and none in this file).
 */
const LEGACY_NAMES = JSON.parse(
  execFileSync(process.execPath, ["scripts/verify-branding.mjs", "--print-contract"], {
    encoding: "utf8",
  }),
).patterns;

const argv = process.argv.slice(2);
const exeIndex = argv.indexOf("--exe");
const executablePath = exeIndex >= 0 ? argv[exeIndex + 1] : null;

const failures = [];
function check(ok, label, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

const launchOptions = executablePath
  ? { executablePath, args: [] }
  : { args: ["."], cwd: process.cwd() };

console.log(
  `game-picker gate: ${executablePath ? `installed app at ${executablePath}` : "development tree"}`,
);

async function openSetup(page) {
  await page.waitForSelector("#tabs", { timeout: 30_000 });
  await page.click(`#tabs button[data-tab="setup"]`);
  await page.waitForSelector("#game-profile-select", { timeout: 30_000 });
}

async function readOptions(page) {
  return page.evaluate(() => {
    const select = document.querySelector("#game-profile-select");
    if (!select) return [];
    return [...select.querySelectorAll("option")].map((o) => ({
      value: o.value,
      text: o.textContent ?? "",
      group: o.parentElement?.tagName === "OPTGROUP" ? o.parentElement.getAttribute("label") : null,
    }));
  });
}

async function count(page, selector) {
  return page.locator(selector).count();
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
  // The e2e adapter only exposes the read-only registry hook; the picker,
  // the settings store and the conversion path are the production ones.
  await page.goto(`${APP_ORIGIN}/index.html?e2e=1`);
  await openSetup(page);

  const declared = await page.evaluate(() =>
    window.__ALDO_GAME_PROFILES_FOR_TESTING__?.() ?? null,
  );
  check(Array.isArray(declared) && declared.length > 0, "the registry loaded inside the shipped shell", `${declared?.length ?? 0} selectable profiles`);
  if (!Array.isArray(declared)) throw new Error("no registry hook");

  // ---- the list itself -----------------------------------------------------
  const options = await readOptions(page);
  const offeredIds = options.map((o) => o.value).filter((v) => v !== "");
  const distinctIds = [...new Set(offeredIds)];
  const missing = REQUIRED_PROFILE_IDS.filter((id) => !distinctIds.includes(id));
  check(missing.length === 0, "every public profile this pass ships is offered", missing.length ? `missing: ${missing.join(", ")}` : `${distinctIds.length} offered`);
  const undeclared = distinctIds.filter((id) => !declared.some((d) => d.id === id));
  check(undeclared.length === 0, "the picker offers nothing the registry does not declare", undeclared.join(", "));
  check(
    !options.some((o) => /fixture/i.test(o.text) || /^fixture-/.test(o.value)),
    "no fixture profile appears",
  );
  check(
    declared.every((d) => d.visibility === "public"),
    "every offered profile is public",
  );
  const games = options.filter((o) => o.group === "Games (A–Z)").map((o) => o.text);
  const sorted = [...games].sort((a, b) => a.localeCompare(b));
  check(games.length > 0 && games.join("|") === sorted.join("|"), "the named games are listed alphabetically", games.join(", "));
  const other = options.filter((o) => o.group === "Other").map((o) => o.value);
  check(other.length === 1 && other[0] === "generic-raw", "Generic / Raw sits on its own at the end");

  // ---- each profile renders what it declares ------------------------------
  for (const d of declared) {
    await page.selectOption("#game-profile-select", d.id);
    await page.waitForSelector("#game-current-hipfire", { timeout: 10_000 });
    const vertical = await count(page, "#game-current-vertical");
    const fov = await count(page, "#game-fov");
    const matching = await count(page, "#game-matching-select");
    const fieldsRight =
      vertical === (d.hasVerticalField ? 1 : 0) &&
      fov === (d.showsFovInput ? 1 : 0) &&
      matching === (d.matchingChoices > 1 ? 1 : 0);
    check(
      fieldsRight,
      `${d.displayName}: renders its own fields and no others`,
      `vertical=${vertical} fov=${fov} matching=${matching} (declared ${d.hasVerticalField ? 1 : 0}/${d.showsFovInput ? 1 : 0}/${d.matchingChoices > 1 ? 1 : 0})`,
    );

    await page.fill("#game-current-hipfire", String(d.sampleHipfire));
    await page.locator("#game-current-hipfire").blur();
    await page.waitForSelector("#game-physical-equivalent", { timeout: 10_000 });
    const equivalent = await page.locator("#game-physical-equivalent").textContent();
    check(
      /cm\/360/.test(equivalent ?? "") && /\d/.test(equivalent ?? ""),
      `${d.displayName}: ${d.sampleHipfire} converts to a physical equivalent`,
      (equivalent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
    );

    const details = await page.locator("#setup-game-profile details").first().textContent();
    check(
      (details ?? "").includes(`v${d.profileVersion}`) && /Last verified/.test(details ?? ""),
      `${d.displayName}: definition version and provenance are reachable`,
      `v${d.profileVersion}`,
    );
    // Pass 4, requirement 23: a player must be able to reach WHERE a number
    // came from and HOW far it is trusted, not just that it has a version.
    const provenanceComplete =
      /Source/.test(details ?? "") &&
      /Confidence/.test(details ?? "") &&
      /Checked against/.test(details ?? "") &&
      /What this profile does not cover/.test(details ?? "");
    check(
      provenanceComplete,
      `${d.displayName}: source, confidence, game version and limitations are all reachable`,
    );
    if (d.status !== "verified") {
      const badge = await count(page, "#game-profile-status");
      check(badge === 1, `${d.displayName}: its ${d.status} status is shown where it is chosen`);
      // Pass 4, requirement 22: the badge has to say what it means FOR THIS
      // GAME. A bare "Partly verified" is a label, not an answer.
      const statusText = await page.locator("#game-profile-status").textContent();
      check(
        /What it does not cover:/.test(statusText ?? "") &&
          (statusText ?? "").replace(/\s+/g, " ").trim().length > 60,
        `${d.displayName}: its status names its own limitation, not a generic one`,
        (statusText ?? "").replace(/\s+/g, " ").trim().slice(0, 90),
      );
    }
  }

  // ---- the filter narrows the list ---------------------------------------
  const filterCount = await count(page, "#game-profile-filter");
  check(filterCount === 1, "a filter box is offered for a list this long");
  if (filterCount === 1) {
    await page.fill("#game-profile-filter", "val");
    const filtered = await readOptions(page);
    const values = filtered.map((o) => o.value).filter((v) => v !== "");
    check(
      values.includes("valorant") && !values.includes("fortnite"),
      "typing part of a name narrows the list",
      values.join(", "),
    );
    await page.fill("#game-profile-filter", "");
  }

  // ---- persistence: a selection and its value survive a reload ------------
  await page.selectOption("#game-profile-select", "valorant");
  await page.fill("#game-current-hipfire", "0.4");
  await page.locator("#game-current-hipfire").blur();
  await page.waitForSelector("#game-physical-equivalent", { timeout: 10_000 });
  await page.reload();
  await openSetup(page);
  const restoredId = await page.locator("#game-profile-select").inputValue();
  const restoredValue = await page.locator("#game-current-hipfire").inputValue().catch(() => "");
  check(
    restoredId === "valorant" && restoredValue === "0.4",
    "a game selection and its entered value survive a reload",
    `restored ${restoredId} / ${restoredValue}`,
  );
  const recentGroup = (await readOptions(page)).some((o) => o.group === "Recently used" && o.value === "valorant");
  check(recentGroup, "the last game chosen is listed under Recently used");

  // ---- Generic / Raw still works ------------------------------------------
  await page.selectOption("#game-profile-select", "generic-raw");
  await page.fill("#game-current-hipfire", "1");
  await page.locator("#game-current-hipfire").blur();
  await page.waitForSelector("#game-physical-equivalent", { timeout: 10_000 });
  const generic = await page.locator("#game-physical-equivalent").textContent();
  check(/cm\/360/.test(generic ?? ""), "Generic / Raw still converts a current value", (generic ?? "").replace(/\s+/g, " ").trim().slice(0, 60));

  // ---- branding --------------------------------------------------------------
  const text = await page.evaluate(() => document.body.innerText);
  const legacy = LEGACY_NAMES.filter((n) => text.includes(n));
  check(legacy.length === 0, "no legacy product name appears on the screen", legacy.join(", "));
  check(text.includes("trAIMer"), "the product name on screen is trAIMer");
} catch (err) {
  check(false, "game-picker gate ran to completion", String(err));
} finally {
  await app?.close().catch(() => undefined);
}

if (failures.length > 0) {
  console.error(`\ngame-picker gate FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\ngame-picker gate: all checks passed.");
