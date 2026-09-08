#!/usr/bin/env node
/**
 * RELEASE GATE — the public documentation is current and consistent
 * (Pass 5, requirements 2, 6, 16 and 26).
 *
 * Three things a stranger meeting the repository would be misled by, made
 * into build failures:
 *
 *   1. A relative link in a public document that points at nothing.
 *   2. A player-facing document that names a version other than this
 *      build's — the README telling someone to download an installer that
 *      does not exist.
 *   3. The public support matrix disagreeing with the profile registry:
 *      every public profile must have a row whose status word and
 *      last-verified date are exactly what the shipped profile declares,
 *      and the matrix must not list a game the registry does not ship.
 *
 * The registry is read from the profile sources with the same regexes the
 * no-telemetry audit uses, so this script has no TypeScript dependency and
 * runs wherever Node runs.
 *
 * Usage: node scripts/verify-docs.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const failures = [];
const notes = [];
const fail = (msg) => failures.push(msg);

// ---- 1. links ---------------------------------------------------------------

/** Public documents whose relative links must resolve. */
const LINK_ROOTS = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "PRIVACY.md", "CHANGELOG.md", "docs", ".github"];

function markdownFiles(root, out = []) {
  if (!existsSync(root)) return out;
  const st = statSync(root);
  if (st.isFile()) {
    if (root.endsWith(".md")) out.push(root);
    return out;
  }
  for (const entry of readdirSync(root)) {
    if (entry === "pass6-data" || entry === "screenshots") continue;
    markdownFiles(join(root, entry), out);
  }
  return out;
}

const LINK_RE = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
let linkCount = 0;
for (const file of LINK_ROOTS.flatMap((r) => markdownFiles(r))) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(LINK_RE)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const [path] = target.split("#");
    if (path === "") continue;
    linkCount++;
    const abs = resolve(dirname(file), path);
    if (!existsSync(abs)) fail(`${file}: link target does not exist: ${target}`);
  }
}
notes.push(`${linkCount} relative links checked`);

// ---- 2. version currency -----------------------------------------------------

const versionTs = readFileSync("src/version.ts", "utf8");
const appVersion = /export const APP_VERSION = "([^"]+)"/.exec(versionTs)?.[1];
if (!appVersion) fail("src/version.ts: APP_VERSION not found");
const pkgVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
if (pkgVersion !== appVersion) fail(`package.json version ${pkgVersion} != APP_VERSION ${appVersion}`);
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
if (lock.version !== appVersion || lock.packages?.[""]?.version !== appVersion) {
  fail(`package-lock.json carries a stale version (${lock.version} / ${lock.packages?.[""]?.version}); expected ${appVersion}`);
}

/**
 * Player-facing documents that name the installer or the version. Every
 * `1.0.0-rc.N` (or `1.0.0`) they mention must be THIS build's, except in a
 * sentence that is explicitly historical. CHANGELOG.md and docs/RELEASE.md
 * are histories by nature and are checked differently: their newest entry
 * must be this version.
 */
const CURRENT_DOCS = ["README.md", "docs/INSTALL-WINDOWS.md", "docs/RELEASE-NOTES.md", "docs/SUPPORT-MATRIX.md", "docs/CODE-SIGNING.md"];
const VERSION_RE = /1\.0\.0(?:-rc\.\d+)?/g;
/** Versions a current document may legitimately name as history. */
const HISTORICAL_OK = new Set(["1.0.0-rc.6", "1.0.0-rc.7", "1.0.0-rc.9", "1.0.0-rc.12", "1.0.0-rc.13", "1.0.0"]);
for (const file of CURRENT_DOCS) {
  if (!existsSync(file)) {
    fail(`missing public document: ${file}`);
    continue;
  }
  const text = readFileSync(file, "utf8");
  const mentioned = new Set([...text.matchAll(VERSION_RE)].map((m) => m[0]));
  for (const v of mentioned) {
    if (v === appVersion) continue;
    if (HISTORICAL_OK.has(v)) continue;
    fail(`${file}: names version ${v}; this build is ${appVersion}`);
  }
}
const changelog = readFileSync("CHANGELOG.md", "utf8");
const firstEntry = /^## ([^\s—]+)/m.exec(changelog)?.[1];
if (firstEntry !== appVersion) fail(`CHANGELOG.md: newest entry is ${firstEntry}, expected ${appVersion}`);
const releaseNotes = readFileSync("docs/RELEASE-NOTES.md", "utf8");
if (!releaseNotes.split("\n")[0].includes(appVersion)) fail(`docs/RELEASE-NOTES.md: title does not name ${appVersion}`);

// ---- 3. the support matrix matches the registry ---------------------------------

const PROFILE_DIR = "src/games/profiles";
const STATUS_LABEL = {
  verified: "Verified",
  "partially-verified": "Partially verified",
  experimental: "Experimental",
  deprecated: "Deprecated",
};
const registry = [];
for (const file of readdirSync(PROFILE_DIR)) {
  if (!file.endsWith(".ts") || file === "index.ts") continue;
  const src = readFileSync(join(PROFILE_DIR, file), "utf8");
  const displayName = /displayName:\s*"([^"]+)"/.exec(src)?.[1];
  const status = /^\s{2}status:\s*"([^"]+)"/m.exec(src)?.[1];
  const verified = /verifiedAtIso:\s*"([^"]+)"/.exec(src)?.[1];
  const visibility = /visibility:\s*"([^"]+)"/.exec(src)?.[1];
  if (!displayName || !status || !verified) {
    fail(`${file}: could not read displayName/status/verifiedAtIso`);
    continue;
  }
  if (visibility !== "public") continue;
  registry.push({ file, displayName, status, verified });
}
const matrix = readFileSync("docs/SUPPORT-MATRIX.md", "utf8");
const rows = matrix
  .split("\n")
  .filter((l) => l.startsWith("| ") && !l.startsWith("| Game") && !l.startsWith("| ---") && !l.startsWith("| Status") && !l.startsWith("| **"));
const matrixGames = [];
for (const row of rows) {
  const cells = row.split("|").map((c) => c.trim());
  if (cells.length < 10) continue;
  matrixGames.push({ game: cells[1], status: cells[2], verified: cells[8] });
}
for (const p of registry) {
  const row = matrixGames.find((r) => r.game === p.displayName);
  if (!row) {
    fail(`docs/SUPPORT-MATRIX.md: no row for ${p.displayName} (${p.file})`);
    continue;
  }
  const expected = STATUS_LABEL[p.status] ?? p.status;
  if (!row.status.startsWith(expected)) {
    fail(`docs/SUPPORT-MATRIX.md: ${p.displayName} is "${row.status}" but the profile declares ${p.status}`);
  }
  if (row.verified !== p.verified) {
    fail(`docs/SUPPORT-MATRIX.md: ${p.displayName} last verified "${row.verified}" but the profile declares ${p.verified}`);
  }
}
for (const r of matrixGames) {
  if (!registry.some((p) => p.displayName === r.game)) {
    fail(`docs/SUPPORT-MATRIX.md: lists "${r.game}", which no public profile declares`);
  }
}
notes.push(`${registry.length} public profiles cross-checked against the support matrix`);
if (!matrix.includes(appVersion)) fail(`docs/SUPPORT-MATRIX.md: does not say which version it describes (${appVersion})`);

// The README's short game table must agree on status too.
const readme = readFileSync("README.md", "utf8");
for (const p of registry) {
  const expected = STATUS_LABEL[p.status];
  const line = readme.split("\n").find((l) => l.startsWith(`| ${p.displayName}`) || l.startsWith(`| ${p.displayName} (`));
  if (!line) fail(`README.md: supported-games table has no row for ${p.displayName}`);
  else if (!line.includes(expected)) fail(`README.md: ${p.displayName} row does not say "${expected}"`);
}

// ---- 4. the documents a public repository must have -------------------------------

for (const required of [
  "LICENSE",
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "PRIVACY.md",
  "CHANGELOG.md",
  "docs/INSTALL-WINDOWS.md",
  "docs/SUPPORT-MATRIX.md",
  "docs/RELEASE-NOTES.md",
  "docs/CODE-SIGNING.md",
  "docs/PROFILE-PROPOSAL-TEMPLATE.md",
  "docs/SCREENSHOTS.md",
  "docs/PUBLIC-SHARE-CHECKLIST.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/profile_correction.yml",
  ".github/ISSUE_TEMPLATE/profile_request.yml",
  ".github/ISSUE_TEMPLATE/installation_problem.yml",
  ".github/ISSUE_TEMPLATE/measurement_problem.yml",
]) {
  if (!existsSync(required)) fail(`missing required public file: ${required}`);
}
if (!/^MIT License/m.test(readFileSync("LICENSE", "utf8"))) fail("LICENSE is not the MIT text the README claims");
if (!/\[MIT\]\(LICENSE\)/.test(readme)) fail("README.md does not link the license");

// ---- report ----------------------------------------------------------------------

console.log("docs gate — public documentation");
for (const n of notes) console.log(`  ${n}`);
if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} problem(s)\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`PASS: links resolve, ${appVersion} is current everywhere, support matrix matches the registry`);
