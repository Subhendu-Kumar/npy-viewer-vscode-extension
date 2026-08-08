#!/usr/bin/env node
/**
 * Runs the suites that do not need a VS Code instance.
 *
 * `npm test` boots a real extension host, which is right for the manifest and
 * activation checks in `extension.test.ts` but costs a VS Code download and
 * tens of seconds. Everything under `src/core/` and `src/webview/` is pure —
 * no `vscode`, no DOM — so it runs here in about a second, which is what makes
 * it usable in a watch loop and cheap enough to measure coverage over.
 *
 *   node scripts/run-unit-tests.mjs [name-filter]
 */

import { build } from "esbuild";
import { dirname, join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Suites that need the extension host, and so are left to `npm test`. */
const HOST_ONLY = ["extension.test.ts"];

const SUITES = [
  "src/test/core.test.ts",
  "src/test/webview.test.ts",
  "src/test/insights.test.ts",
];

const filter = process.argv[2]?.toLowerCase();

/** Collected by the mocha-compatible globals below. */
const cases = [];
let currentSuite = "";

globalThis.suite = (name, fn) => {
  const previous = currentSuite;
  currentSuite = name;
  fn();
  currentSuite = previous;
};

globalThis.test = (name, fn) => {
  cases.push({ suite: currentSuite, name, fn });
};

async function main() {
  // Built inside the project rather than the system temp directory: coverage
  // maps bundled output back through the sourcemap using paths relative to the
  // outfile, and on Windows the temp directory is often on another drive, which
  // leaves no relative path to follow and reports nothing.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = join(root, ".test-build");
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  try {
    for (const entry of SUITES) {
      if (HOST_ONLY.some((name) => entry.endsWith(name))) {
        continue;
      }

      const outfile = join(outDir, `${entry.replace(/[\\/]/g, "-")}.mjs`);
      await build({
        entryPoints: [entry],
        outfile,
        bundle: true,
        platform: "node",
        format: "esm",
        // Inline maps let c8 attribute coverage back to the TypeScript sources
        // rather than to the bundle.
        sourcemap: "inline",
        sourcesContent: true,
        logLevel: "error",
      });

      await import(pathToFileURL(outfile).href);
    }

    let passed = 0;
    let skipped = 0;
    const failures = [];
    let lastSuite = "";

    for (const item of cases) {
      if (
        filter &&
        !`${item.suite} ${item.name}`.toLowerCase().includes(filter)
      ) {
        skipped += 1;
        continue;
      }
      if (item.suite !== lastSuite) {
        console.log(`\n  ${item.suite}`);
        lastSuite = item.suite;
      }
      try {
        await item.fn();
        passed += 1;
        console.log(`    ✓ ${item.name}`);
      } catch (error) {
        failures.push({ ...item, error });
        console.log(`    ✗ ${item.name}`);
      }
    }

    if (failures.length > 0) {
      console.log(`\n  ${failures.length} failing:\n`);
      for (const failure of failures) {
        console.log(`  ${failure.suite} > ${failure.name}`);
        const message = failure.error?.message ?? String(failure.error);
        console.log(`${message.replace(/^/gm, "      ")}\n`);
      }
    }

    const suffix = skipped > 0 ? `, ${skipped} filtered out` : "";
    console.log(`\n  ${passed} passing, ${failures.length} failing${suffix}\n`);

    if (failures.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

await main();
