#!/usr/bin/env node
/**
 * Marks the compiled Electron main-process output as CommonJS.
 *
 * The repository root is an ESM package ("type": "module"), but the Electron
 * main process and its sandboxed preload are compiled to CommonJS. Node
 * resolves module format from the NEAREST package.json, so dropping this
 * two-line file into dist-desktop/ keeps both worlds working without
 * bundlers.
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const outDir = "dist-desktop";
if (!existsSync(join(outDir, "main.js"))) {
  console.error(`✗ ${outDir}/main.js missing — run \`tsc -p desktop/tsconfig.json\` first`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, "package.json"),
  `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`,
);
console.log("✓ dist-desktop/package.json written (type: commonjs)");
