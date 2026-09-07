#!/usr/bin/env node
/**
 * RELEASE GATE — the built helper binary reports the version, protocol and
 * architecture this build expects.
 *
 * rc.1 shipped a "helper.exe" that was the C source file, so this gate RUNS
 * the freshly built artifact rather than inspecting it. The expected values
 * come from `src/version.ts` — the single source of truth — so the gate can
 * never fail because a literal somewhere drifted from the constant.
 *
 * This used to be inline PowerShell in the workflow. Escaping a JavaScript
 * regex through YAML into a PowerShell double-quoted string into `node -e`
 * broke on `[^\"]`, which PowerShell parses as a type literal: the gate failed
 * with "Missing type name after '['" and never ran the helper at all.
 *
 *   node scripts/verify-helper-version.mjs [path-to-helper.exe]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const exe = process.argv[2] ?? "native/windows/traimer_capture_helper.exe";

function expectedFromSource(name) {
  const source = readFileSync(new URL("../src/version.ts", import.meta.url), "utf8");
  const match = new RegExp(`${name} = "([^"]+)"`).exec(source);
  if (!match) throw new Error(`${name} not found in src/version.ts`);
  return match[1];
}

function expectedNumberFromSource(name) {
  const source = readFileSync(new URL("../src/version.ts", import.meta.url), "utf8");
  const match = new RegExp(`${name} = (\\d+)`).exec(source);
  if (!match) throw new Error(`${name} not found in src/version.ts`);
  return match[1];
}

const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

if (!existsSync(exe)) {
  console.error(`FAIL: helper not found at ${exe}`);
  process.exit(1);
}

const expectedHelper = expectedFromSource("EXPECTED_HELPER_VERSION");
const expectedProtocol = expectedNumberFromSource("NATIVE_PROTOCOL_VERSION");

let out;
try {
  out = execFileSync(exe, ["--version"], { encoding: "utf8" }).trim();
} catch (err) {
  console.error(`FAIL: helper --version did not run: ${String(err?.message ?? err)}`);
  process.exit(1);
}
console.log(`helper --version -> ${out}`);
console.log(`expected          -> version=${expectedHelper} protocol=${expectedProtocol} arch=x64`);

check(
  "helper version matches src/version.ts",
  out.includes(`version=${expectedHelper}`),
  out,
);
check(
  "wire protocol version matches src/version.ts",
  out.includes(`protocol=${expectedProtocol}`),
  out,
);
check("helper is the x64 build", out.includes("arch=x64"), out);

if (failures.length > 0) {
  console.error(`\nhelper version gate: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nhelper version gate: all checks passed");
