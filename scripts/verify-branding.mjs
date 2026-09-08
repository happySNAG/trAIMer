/**
 * RELEASE GATE — the shipped product presents only "trAIMer".
 *
 * rc.6 was already being called trAIMer in release material while the
 * installer, the installed executable, the Start Menu shortcut, the window
 * title, the sidebar wordmark and the Apps & Features entry all still said
 * "Aldo Aim Lab". This gate makes that class of drift a build failure instead
 * of something a human has to notice.
 *
 * Three kinds of surface, three rules:
 *
 *   HARD    — zero occurrences of the legacy names, anywhere in the file.
 *             Shipped UI, the built bundle, package/installer metadata,
 *             player-facing docs, release artifact names.
 *   COMMENT — occurrences allowed ONLY inside comments. Source files legitimately
 *             narrate what rc.6 did and why; what they must never do is put the
 *             old name into a string, an identifier, or a value.
 *   ALLOWED — named exceptions with a written reason, checked exactly. Each one
 *             is a place where renaming would DESTROY user data or make the
 *             Windows upgrade worse; see the reasons inline.
 *
 * Historical engineering reports (PASS-*.md, UI-PASS-*.md, docs/PASS6-*.md)
 * are out of scope entirely: they accurately record what the product was
 * called at the time, and rewriting them would damage provenance.
 *
 * Usage:
 *   node scripts/verify-branding.mjs                       # sources + docs
 *   node scripts/verify-branding.mjs --bundle dist-app     # built frontend
 *   node scripts/verify-branding.mjs --installed-app DIR   # installed layout
 *   node scripts/verify-branding.mjs --installer FILE      # installer filename
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename, extname, relative } from "node:path";

/** The names that must not appear on a current, user-facing surface. */
export const LEGACY_PRODUCT_PATTERNS = [
  "Aldo Aim Lab",
  "AldoAimLab",
  "Aldo-Aim-Lab",
  "aldo_capture_helper",
  "start-aldo-lab",
  "stop-aldo-lab",
  // Two shipped UI strings named the helper after the working title until
  // 1.0.0 ("the local Aldo capture helper"); the full-name patterns above
  // never matched them.
  "Aldo capture helper",
  "Aldo helper",
];

export const PRODUCT_NAME = "trAIMer";
export const PRODUCT_TAGLINE = "Train. Measure. Tune.";

/**
 * Deliberate, documented survivals. Each entry names the file and the exact
 * text, and says what breaks if it is renamed. Anything NOT on this list is a
 * failure — the list is the audit trail.
 */
export const ALLOWED = [
  {
    file: "app/src/idb.ts",
    text: "aldo-aim-lab",
    reason:
      "IndexedDB database name. IndexedDB is keyed by (origin, name) and has no rename operation: opening a new name would present every existing player with an empty history while their real data sat unreachable under the old one. Invisible to players.",
  },
  {
    file: "app/src/state.ts",
    text: "aldo-aim-lab-settings",
    reason:
      "Legacy localStorage key, read as a fallback so an upgraded install keeps the player's name, DPI, sensitivity, seed and break settings.",
  },
  {
    file: "app/src/main.ts",
    text: "aldo-session-token",
    reason:
      "Legacy localStorage key for the helper session token, read as a fallback on upgrade.",
  },
  {
    file: "desktop/config.ts",
    text: "AldoAimLab",
    reason:
      "LEGACY_APP_DIR_NAME — the %APPDATA% directory holding every pre-rename player's training history. The shell migrates it on first launch; the constant is how it finds it.",
  },
  {
    file: "desktop/main.ts",
    text: "com.aldoaimlab.desktop",
    reason:
      "AppUserModelId, paired with the electron-builder appId. Never displayed; changing it would split taskbar identity across the upgrade.",
  },
  {
    file: "electron-builder.yml",
    text: "com.aldoaimlab.desktop",
    reason:
      "appId. electron-builder derives the NSIS uninstall registry key from it, so keeping it makes rc.7 an in-place upgrade of rc.6 instead of leaving a second, stale 'Aldo Aim Lab' entry in Apps & Features. Never displayed.",
  },
  {
    file: "electron-builder.yml",
    text: "Aldo Aim Lab",
    reason:
      "Comment explaining the appId decision above.",
  },
  {
    file: "build/installer.nsh",
    text: "AldoAimLab",
    reason:
      "The uninstaller's 'delete my data' branch clears the pre-rename %APPDATA% directory too, so a machine that installed rc.7 but never launched it does not keep the player's history after they explicitly asked for it to go.",
  },
  {
    file: "src/version.ts",
    text: "aldo-aim-lab",
    reason:
      "LEGACY_APP_NAME — the machine name embedded in artifacts written by rc.6 and earlier.",
  },
  {
    file: "docs/INSTALL-WINDOWS.md",
    text: "Upgrading from *Aldo Aim Lab*",
    reason:
      "Player-facing upgrade note. A player holding an rc.6 install needs to be told, by name, that this is the same product and that their history comes with them.",
  },
  {
    file: "docs/INSTALL-WINDOWS.md",
    text: "`%APPDATA%\\AldoAimLab` to `%APPDATA%\\trAIMer`",
    reason: "Names the exact directory move so a player can verify it happened.",
  },
  {
    file: "docs/INSTALL-WINDOWS.md",
    text: "moved automatically from `%APPDATA%\\AldoAimLab`",
    reason: "Same: where the player's data used to live and where it is now.",
  },
  {
    file: "docs/DESKTOP-SHELL.md",
    text: "migrated from `%APPDATA%\\AldoAimLab` on first launch",
    reason: "Architecture table documenting the user-data migration.",
  },
];

/** Files whose every line must be free of the legacy names. */
const HARD_FILES = [
  "package.json",
  "app/index.html",
  "README.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "PRIVACY.md",
  "docs/INSTALL-WINDOWS.md",
  "docs/RELEASE.md",
  "docs/RELEASE-NOTES.md",
  "docs/SUPPORT-MATRIX.md",
  "docs/CODE-SIGNING.md",
  "docs/PROFILE-PROPOSAL-TEMPLATE.md",
  "docs/SCREENSHOTS.md",
  "docs/PUBLIC-SHARE-CHECKLIST.md",
  "docs/GITHUB-LANDING-PAGE.md",
  "docs/DESKTOP-SHELL.md",
  "docs/PACKAGING-WINDOWS.md",
  "docs/MANUAL-TEST.md",
  ".github/workflows/ci.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/profile_correction.yml",
  ".github/ISSUE_TEMPLATE/profile_request.yml",
  ".github/ISSUE_TEMPLATE/installation_problem.yml",
  ".github/ISSUE_TEMPLATE/measurement_problem.yml",
  "scripts/release/windows/FIRST-RUN.md",
  "scripts/release/windows/start-traimer.ps1",
  "scripts/release/windows/stop-traimer.ps1",
];
// CHANGELOG.md is deliberately NOT a hard file: its rc.7 entry records the
// rename by name, which is history, not branding drift. The pass reports are
// excluded for the same reason (see EXCLUDED).

/**
 * Directories scanned with the comment-tolerant rule.
 *
 * `tests/` is deliberately absent: the regression suites for this very rename
 * have to name the old strings in order to assert on them (the migration
 * tests check `%APPDATA%\\AldoAimLab`, the gate's own tests feed it a
 * legacy-named installer). Tests ship to nobody, so they are not a
 * user-facing surface; the surfaces that ship are covered exhaustively below
 * and by --bundle / --installed-app / --installer.
 */
const SOURCE_DIRS = ["app/src", "src", "desktop", "scripts", "build"];
const SOURCE_EXTS = new Set([".ts", ".mjs", ".js", ".css", ".html", ".nsh", ".yml", ".c", ".ps1"]);

/** Historical records — never scanned. */
const EXCLUDED = [
  // The gate itself necessarily contains every pattern it looks for.
  /^scripts\/verify-branding\.mjs$/,
  /^PASS-\d+-REPORT\.md$/,
  /^UI-PASS-\d+-REPORT\.md$/,
  /^docs\/PASS6-/,
  /^node_modules\//,
  /^release\//,
  /^dist-desktop\//,
  /^test-results\//,
];

function isExcluded(rel) {
  return EXCLUDED.some((re) => re.test(rel));
}

/**
 * True when `line` is (or is inside) a comment for this file type. Source
 * files are allowed to explain the rename; they are not allowed to ship it.
 */
export function isCommentLine(line, ext) {
  const t = line.trim();
  if (ext === ".css") return t.startsWith("*") || t.startsWith("/*") || t.startsWith("//");
  if (ext === ".nsh" || ext === ".ps1" || ext === ".yml") return t.startsWith(";") || t.startsWith("#");
  if (ext === ".html") return t.startsWith("<!--") || t.startsWith("~~never~~");
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function allowedFor(rel, line) {
  return ALLOWED.some((a) => a.file === rel && line.includes(a.text));
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules") continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function scanFile(path, { commentTolerant }) {
  const rel = relative(process.cwd(), path).split("\\").join("/");
  if (isExcluded(rel)) return [];
  const ext = extname(path);
  const problems = [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const pattern of LEGACY_PRODUCT_PATTERNS) {
      if (!line.includes(pattern)) continue;
      if (allowedFor(rel, line)) continue;
      if (commentTolerant && isCommentLine(line, ext)) continue;
      problems.push(
        `${rel}:${i + 1}: legacy product name "${pattern}" on a current user-facing surface\n    ${line.trim().slice(0, 160)}`,
      );
    }
  });
  return problems;
}

function checkSources() {
  const problems = [];
  for (const file of HARD_FILES) {
    if (!existsSync(file)) {
      problems.push(`missing expected file: ${file}`);
      continue;
    }
    problems.push(...scanFile(file, { commentTolerant: false }));
  }
  for (const dir of SOURCE_DIRS) {
    for (const file of walk(dir)) {
      if (!SOURCE_EXTS.has(extname(file))) continue;
      problems.push(...scanFile(file, { commentTolerant: true }));
    }
  }
  // The product name and tagline must actually be PRESENT, not merely
  // un-contradicted: an empty brand passes a negative check trivially.
  const html = readFileSync("app/index.html", "utf8");
  if (!html.includes(`<title>${PRODUCT_NAME}</title>`)) {
    problems.push(`app/index.html: window title must be exactly "${PRODUCT_NAME}"`);
  }
  if (!html.includes(PRODUCT_TAGLINE)) {
    problems.push(`app/index.html: tagline "${PRODUCT_TAGLINE}" is missing from the wordmark`);
  }
  const builder = readFileSync("electron-builder.yml", "utf8");
  for (const required of [
    `productName: ${PRODUCT_NAME}`,
    `artifactName: ${PRODUCT_NAME}-Setup-\${version}.\${ext}`,
    `shortcutName: ${PRODUCT_NAME}`,
    `uninstallDisplayName: ${PRODUCT_NAME} \${version}`,
  ]) {
    if (!builder.includes(required)) {
      problems.push(`electron-builder.yml: missing "${required}"`);
    }
  }
  return problems;
}

/** The BUILT frontend: what the player's window actually renders. */
function checkBundle(dir) {
  const problems = [];
  if (!existsSync(dir)) return [`bundle directory not found: ${dir}`];
  for (const file of walk(dir)) {
    const ext = extname(file);
    if (![".js", ".css", ".html", ".json", ".map"].includes(ext)) continue;
    if (ext === ".map") continue;
    const text = readFileSync(file, "utf8");
    for (const pattern of LEGACY_PRODUCT_PATTERNS) {
      if (pattern === "aldo_capture_helper") continue; // never in the frontend
      if (text.includes(pattern)) {
        problems.push(`${file}: shipped bundle contains "${pattern}"`);
      }
    }
  }
  const index = join(dir, "index.html");
  if (existsSync(index)) {
    const html = readFileSync(index, "utf8");
    if (!html.includes(PRODUCT_NAME)) {
      problems.push(`${index}: shipped page does not mention "${PRODUCT_NAME}"`);
    }
  }
  return problems;
}

/** The INSTALLED application: executable name, shortcut targets, resources. */
function checkInstalledApp(dir) {
  const problems = [];
  if (!existsSync(dir)) return [`installed app directory not found: ${dir}`];
  const expectedExe = `${PRODUCT_NAME}.exe`;
  if (!existsSync(join(dir, expectedExe))) {
    problems.push(`installed app is missing ${expectedExe}`);
  }
  for (const entry of readdirSync(dir)) {
    for (const pattern of LEGACY_PRODUCT_PATTERNS) {
      if (entry.includes(pattern)) {
        problems.push(`installed app contains a legacy-named file: ${entry}`);
      }
    }
  }
  const resources = join(dir, "resources");
  if (existsSync(resources)) {
    for (const entry of readdirSync(resources)) {
      if (entry.includes("aldo")) {
        problems.push(`installed resources contain a legacy-named file: resources/${entry}`);
      }
    }
  }
  return problems;
}

/** The installer artifact the player double-clicks. */
function checkInstaller(file) {
  const problems = [];
  const name = basename(file);
  if (!name.startsWith(`${PRODUCT_NAME}-Setup`)) {
    problems.push(`installer filename must start with "${PRODUCT_NAME}-Setup": ${name}`);
  }
  for (const pattern of LEGACY_PRODUCT_PATTERNS) {
    if (name.includes(pattern)) {
      problems.push(`installer filename contains "${pattern}": ${name}`);
    }
  }
  if (!existsSync(file)) problems.push(`installer not found: ${file}`);
  return problems;
}

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

/**
 * Machine-readable contract, so the test suite can assert on the allowlist and
 * the patterns WITHOUT importing this module.
 *
 * A `.ts` test importing a `.mjs` script resolved fine on Linux and macOS and
 * failed to parse at all on the Windows CI runners, which is a toolchain
 * problem the release gate has no business inheriting. Everything the tests
 * need now crosses a process boundary as JSON.
 */
function printContract() {
  console.log(
    JSON.stringify({
      productName: PRODUCT_NAME,
      tagline: PRODUCT_TAGLINE,
      patterns: LEGACY_PRODUCT_PATTERNS,
      allowed: ALLOWED,
    }),
  );
}

/** Classifies one line the way the comment-tolerant source rule does. */
function classifyLine(ext, line) {
  console.log(JSON.stringify({ comment: isCommentLine(line, ext) }));
}

function main() {
  if (process.argv.includes("--print-contract")) {
    printContract();
    return;
  }
  if (process.argv.includes("--classify")) {
    const ext = arg("--classify") ?? ".ts";
    const line = arg("--line") ?? "";
    classifyLine(ext, line);
    return;
  }
  const bundle = arg("--bundle");
  const installedApp = arg("--installed-app");
  const installer = arg("--installer");
  let problems = [];
  let scope = "sources + player-facing docs";
  if (bundle) {
    problems = checkBundle(bundle);
    scope = `built frontend bundle (${bundle})`;
  } else if (installedApp) {
    problems = checkInstalledApp(installedApp);
    scope = `installed application (${installedApp})`;
  } else if (installer) {
    problems = checkInstaller(installer);
    scope = `installer artifact (${installer})`;
  } else {
    problems = checkSources();
  }

  console.log(`branding gate — ${scope}`);
  if (problems.length > 0) {
    console.error(`\nFAIL: ${problems.length} branding problem(s)\n`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      `\nThe shipped Windows experience must present only "${PRODUCT_NAME}" — ${PRODUCT_TAGLINE}`,
    );
    console.error(
      "If an occurrence is genuinely required (user-data paths, upgrade identity),",
    );
    console.error("add it to ALLOWED in scripts/verify-branding.mjs WITH a reason.");
    process.exit(1);
  }
  console.log(`PASS: only "${PRODUCT_NAME}" on current user-facing surfaces`);
  console.log(`      ${ALLOWED.length} documented legacy survivals (user-data / upgrade identity)`);
}

/**
 * This module is only ever EXECUTED (`node scripts/verify-branding.mjs …`);
 * nothing imports it. It therefore runs unconditionally.
 *
 * It used to be guarded by `import.meta.url === \`file://${process.argv[1]}\``,
 * which is false on Windows — `import.meta.url` is `file:///D:/a/...` while
 * `process.argv[1]` is `D:\a\...`. The gate silently did nothing and exited
 * 0 on every Windows CI job: a release gate that passes by not running is
 * worse than no gate at all.
 */
main();
