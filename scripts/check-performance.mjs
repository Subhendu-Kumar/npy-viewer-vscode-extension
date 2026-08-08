#!/usr/bin/env node
/**
 * Guards the memory and time budget of the statistics pass.
 *
 * This exists because a change once pushed peak usage to 1.9 GB inside the
 * extension host — which is shared with every other extension the user has
 * installed — and it was caught by chance rather than by a check. The failure
 * mode is silent: the numbers stay correct, so no test goes red.
 *
 *   node scripts/check-performance.mjs [array.npy]
 *
 * With no argument it writes its own fixture, deliberately larger than the
 * default exact-quantile limit so that the sampling path is the one measured.
 * Running against a small array would prove nothing: below that limit the
 * retained sample is the whole array and stays small whatever the code does.
 *
 * Scope: this catches order-of-magnitude regressions — an allocation that scales
 * with the array instead of with the sample. It is not a microbenchmark and will
 * not notice a 20% slowdown.
 */

import { build } from "esbuild";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORK = join(ROOT, ".test-build");

/** Elements in the generated fixture — five times the exact limit below. */
const FIXTURE_ELEMENTS = 25_000_000;

/** The shipped default, so the measurement reflects what users get. */
const EXACT_LIMIT = 5_000_000;

/**
 * Ceilings, not targets. The measured baseline for this fixture is around
 * 330 MB, so there is roughly 1.8x of headroom: ordinary refactoring will not
 * trip this, but losing the bounded-sample design will.
 */
const BUDGET = {
  peakBytes: 600 * 1024 * 1024,
  seconds: 120,
};

/** Writes a minimal NPY v1.0 file; enough for the reader under test. */
async function writeFixture(path, elements) {
  const values = new Float32Array(elements);
  // A deterministic non-degenerate spread. A constant array would let a
  // regression hide behind trivially compressible data.
  let seed = 12345;
  for (let i = 0; i < elements; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    values[i] = (seed / 0x7fffffff) * 1000;
  }

  const dict = `{'descr': '<f4', 'fortran_order': False, 'shape': (${elements},), }`;
  const unpadded = 10 + dict.length + 1;
  const padding = (64 - (unpadded % 64)) % 64;
  const header = `${dict}${" ".repeat(padding)}\n`;

  const prefix = Buffer.alloc(10);
  Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]).copy(prefix, 0);
  prefix.writeUInt8(1, 6);
  prefix.writeUInt8(0, 7);
  prefix.writeUInt16LE(header.length, 8);

  await writeFile(
    path,
    Buffer.concat([
      prefix,
      Buffer.from(header, "latin1"),
      Buffer.from(values.buffer, values.byteOffset, values.byteLength),
    ]),
  );
}

await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });

let target = process.argv[2];
let generated = false;
if (!target) {
  target = join(WORK, "perf-fixture.npy");
  await writeFixture(target, FIXTURE_ELEMENTS);
  generated = true;
} else if (!existsSync(target)) {
  console.error(`Missing ${target}`);
  process.exit(2);
}

const entry = join(WORK, "perf-entry.mjs");
await build({
  stdin: {
    contents: `
      export { NpyFile } from "./src/core/npyFile";
      export { computeStats } from "./src/core/stats";
      export { detectLayout } from "./src/core/layout";
    `,
    resolveDir: ROOT,
    loader: "ts",
  },
  outfile: entry,
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
});

const { NpyFile, computeStats, detectLayout } = await import(
  pathToFileURL(entry).href
);

let peak = 0;
const sample = () => {
  const usage = process.memoryUsage();
  // Typed arrays live outside the JS heap, so rss alone understates the cost of
  // a large retained sample; arrayBuffers is where that shows up.
  peak = Math.max(peak, usage.rss + usage.arrayBuffers);
};

const file = await NpyFile.open(target);
const detection = detectLayout(file.meta, file.dtype);
sample();

const started = Date.now();
const bundle = await computeStats(
  file.source,
  file.meta,
  file.dtype,
  file.dataOffset,
  {
    exactLimit: EXACT_LIMIT,
    histogramBins: 64,
    channelAxis: detection.layout?.channelAxis ?? null,
    columnAxis: null,
    onProgress: sample,
  },
);
sample();

const elapsed = (Date.now() - started) / 1000;
const stats = bundle.overall;
await file.close();
await rm(WORK, { recursive: true, force: true });

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(0);
const problems = [];

if (peak > BUDGET.peakBytes) {
  problems.push(
    `peak memory ${mb(peak)} MB exceeds ${mb(BUDGET.peakBytes)} MB`,
  );
}
if (elapsed > BUDGET.seconds) {
  problems.push(`elapsed ${elapsed.toFixed(1)}s exceeds ${BUDGET.seconds}s`);
}
// The whole point of the limit is that quantiles get sampled above it. If this
// came back exact, the measurement did not exercise the path being guarded.
if (stats && stats.approximate !== true) {
  problems.push(
    "quantiles were exact, so the sampling path was not measured — " +
      "is the fixture smaller than the exact limit?",
  );
}

console.log(
  `array    : ${generated ? `generated, ${FIXTURE_ELEMENTS.toLocaleString()} float32` : target}`,
);
console.log(`limit    : ${EXACT_LIMIT.toLocaleString()} elements retained`);
console.log(`sampled  : ${stats?.approximate === true ? "yes" : "no"}`);
console.log(`peak     : ${mb(peak)} MB   (budget ${mb(BUDGET.peakBytes)} MB)`);
console.log(`elapsed  : ${elapsed.toFixed(1)}s   (budget ${BUDGET.seconds}s)`);
console.log(`mean     : ${stats?.mean.toPrecision(8)}`);

if (problems.length > 0) {
  console.error("\nOver budget:");
  for (const line of problems) {
    console.error(`  ${line}`);
  }
  console.error(
    "\nStatistics are meant to run in one streaming pass holding a bounded\n" +
      "sample. An allocation proportional to the array size is the usual cause.",
  );
  process.exit(1);
}

console.log("\nWithin budget.");
