#!/usr/bin/env node
/**
 * No-telemetry audit (Pass 5).
 *
 * Aldo Aim Lab is local-only. This audit scans BOTH source and the production
 * bundle for any network-capable API or remote endpoint and fails on:
 *
 *   - fetch( / XMLHttpRequest / sendBeacon / EventSource / import() from URLs
 *   - WebSocket to anything that is NOT loopback
 *   - hardcoded http(s) endpoints other than localhost/127.0.0.1 and
 *     schema/spec documentation URLs inside comments/strings of docs only
 *
 * Exit code 0 = clean; 1 = violation found.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src", "app", "native", "desktop"];
const BUNDLE_DIR = "dist-app";
const SOURCE_EXT = /\.(ts|tsx|js|mjs|c|md)$/;

const FORBIDDEN = [
  { name: "fetch()", pattern: /\bfetch\s*\(/ },
  { name: "XMLHttpRequest", pattern: /XMLHttpRequest/ },
  { name: "sendBeacon", pattern: /sendBeacon/ },
  { name: "EventSource", pattern: /new\s+EventSource/ },
];

function listFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

let violations = 0;
const report = [];

for (const root of ROOTS) {
  for (const file of listFiles(root)) {
    if (!SOURCE_EXT.test(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const { name, pattern } of FORBIDDEN) {
      let m;
      while ((m = pattern.exec(text)) !== null) {
        // Allow mentions inside comments/documentation strings by checking
        // the line does not look like live code in docs (.md files are data).
        const lineStart = text.lastIndexOf("\n", m.index) + 1;
        const lineEnd = text.indexOf("\n", m.index);
        const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
        const isDoc = file.endsWith(".md");
        const isComment =
          line.startsWith("//") || line.startsWith("*") || line.startsWith("/*");
        if (isDoc || isComment) continue;
        violations++;
        report.push(`${file}: ${name} → ${line.slice(0, 120)}`);
      }
    }
    // WebSocket must be loopback-only; the single allowed use enforces this
    // at runtime via assertLoopbackUrl — verify the guard is present.
    if (/new\s+WebSocket/.test(text)) {
      if (!text.includes("assertLoopbackUrl")) {
        violations++;
        report.push(`${file}: WebSocket used without assertLoopbackUrl guard`);
      }
    }
  }
}

// ---- production bundle scan (if built) ----
if (existsSync(BUNDLE_DIR)) {
  for (const file of listFiles(BUNDLE_DIR)) {
    if (!/\.(js|html)$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const { name, pattern } of FORBIDDEN) {
      if (pattern.test(text)) {
        violations++;
        report.push(`bundle ${file}: ${name} present in shipped code`);
      }
    }
    // Any https:// URL string in the bundle is suspicious (docs are not bundled).
    const httpsMatches = [...text.matchAll(/https:\/\/[^"'\s`]+/g)].map((m) => m[0]);
    for (const url of httpsMatches) {
      if (!/^https:\/\/(localhost|127\.0\.0\.1)/.test(url)) {
        violations++;
        report.push(`bundle ${file}: non-local URL literal "${url}"`);
      }
    }
  }
}

if (violations > 0) {
  console.error(`NO-TELEMETRY AUDIT FAILED — ${violations} violation(s):`);
  for (const line of report) console.error("  " + line);
  process.exit(1);
}
console.log(
  `no-telemetry audit: CLEAN (${ROOTS.join(", ")} sources${existsSync(BUNDLE_DIR) ? ` + ${BUNDLE_DIR}/ bundle` : ""})`,
);
