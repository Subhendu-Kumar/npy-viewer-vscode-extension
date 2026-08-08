import type {
  ArrayMeta,
  Detection,
  StatsBundle,
  NumericStats,
} from "../common/types";
import * as assert from "assert";
import { buildInsights, formatBytes } from "../core/insights";

/**
 * The observations shown above the statistics are the most opinionated part of
 * the extension — plain-language claims about the data that a user will take at
 * face value. Each rule is checked here both for firing when it should and, more
 * importantly, for staying quiet when it should not.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function meta(over: Partial<ArrayMeta> = {}): ArrayMeta {
  return {
    dtype: "float64",
    descr: "<f8",
    kind: "float",
    itemsize: 8,
    littleEndian: true,
    shape: [100, 100],
    ndim: 2,
    size: 10_000,
    dataBytes: 80_000,
    fortranOrder: false,
    npyVersion: "1.0",
    headerBytes: 128,
    fileBytes: 80_128,
    ...over,
  };
}

function detection(over: Partial<Detection> = {}): Detection {
  return {
    primary: "heatmap",
    available: ["heatmap", "table"],
    layout: null,
    alternateLayout: null,
    reason: "test",
    semantic: "Matrix",
    displayRange: null,
    isImageLike: false,
    ...over,
  };
}

/** A clean, unremarkable set of statistics to perturb one field at a time. */
function stats(over: Partial<NumericStats> = {}): NumericStats {
  return {
    approximate: false,
    sampleSize: 10_000,
    total: 10_000,
    finite: 10_000,
    nan: 0,
    posInf: 0,
    negInf: 0,
    zeros: 0,
    negatives: 5_000,
    positives: 5_000,
    min: -3,
    max: 3,
    range: 6,
    sum: 0,
    mean: 0.5,
    variance: 4,
    std: 2,
    sem: 0.02,
    skewness: 0,
    kurtosis: 0,
    cv: null,
    median: 0.5,
    percentiles: { "25": -1, "50": 0.5, "75": 2 },
    iqr: 3,
    madMedian: 1,
    l1: 5_000,
    l2: 200,
    sparsity: 0,
    lowerFence: -5.5,
    upperFence: 6.5,
    outliers: 0,
    uniqueCount: 9_000,
    uniqueExact: true,
    topValues: null,
    histogram: null,
    integral: false,
    unitRange: false,
    ...over,
  };
}

function bundle(over: Partial<NumericStats> | null): StatsBundle {
  return {
    overall: over === null ? null : stats(over),
    channels: null,
    columns: null,
    insights: [],
    elapsedMs: 1,
  };
}

const titles = (items: { title: string }[]): string[] =>
  items.map((i) => i.title);
const has = (items: { title: string }[], fragment: string): boolean =>
  items.some((i) => i.title.toLowerCase().includes(fragment.toLowerCase()));

// ---------------------------------------------------------------------------

suite("insights: byte formatting", () => {
  test("scales through the units", () => {
    assert.strictEqual(formatBytes(999), "999 B");
    assert.strictEqual(formatBytes(1024), "1.00 KB");
    assert.strictEqual(formatBytes(1024 * 1024 * 5), "5.00 MB");
    assert.ok(formatBytes(1024 ** 3 * 20).endsWith("GB"));
  });
});

suite("insights: missing and degenerate data", () => {
  test("reports NaN with a share of the whole", () => {
    const items = buildInsights(
      meta(),
      detection(),
      bundle({ nan: 500, finite: 9_500 }),
    );
    assert.ok(has(items, "NaN"), titles(items).join(" | "));
    const nanItem = items.find((i) => i.title.includes("NaN"));
    assert.strictEqual(nanItem?.level, "warn");
    assert.ok(nanItem?.detail.includes("5"), "should quote the percentage");
  });

  test("reports infinities separately from NaN", () => {
    const items = buildInsights(
      meta(),
      detection(),
      bundle({ posInf: 3, negInf: 2, finite: 9_995 }),
    );
    assert.ok(has(items, "infinite"));
  });

  test("says so when nothing is finite, and stops there", () => {
    const items = buildInsights(
      meta(),
      detection(),
      bundle({ finite: 0, nan: 10_000, min: Number.NaN, max: Number.NaN }),
    );
    assert.ok(has(items, "No finite values"));
    // Nothing downstream can be computed, so no distribution claims follow.
    assert.ok(!has(items, "skew"));
    assert.ok(!has(items, "No missing values"));
  });

  test("flags a constant array", () => {
    const items = buildInsights(
      meta(),
      detection(),
      bundle({ min: 4, max: 4, range: 0 }),
    );
    assert.ok(has(items, "Constant"));
  });

  test("confirms clean data when there is nothing wrong", () => {
    const items = buildInsights(meta(), detection(), bundle({}));
    assert.ok(has(items, "No missing values"));
  });

  test("does not claim clean data when values are missing", () => {
    const items = buildInsights(
      meta(),
      detection(),
      bundle({ nan: 1, finite: 9_999 }),
    );
    assert.ok(!has(items, "No missing values"));
  });
});

suite("insights: recognising preprocessing", () => {
  test("spots z-score standardisation", () => {
    const items = buildInsights(
      meta(),
      detection(),
      bundle({ mean: 0.01, std: 1.02, integral: false }),
    );
    assert.ok(has(items, "standardised"));
  });

  test("spots [0, 1] normalisation", () => {
    const items = buildInsights(
      meta(),
      detection(),
      bundle({
        min: 0,
        max: 1,
        mean: 0.5,
        std: 0.3,
        unitRange: true,
        negatives: 0,
      }),
    );
    assert.ok(has(items, "Normalised"));
  });

  test("recognises 8-bit image data", () => {
    const items = buildInsights(
      meta({ kind: "uint", itemsize: 1, dtype: "uint8" }),
      detection({ isImageLike: true }),
      bundle({ min: 0, max: 255, mean: 120, integral: true, negatives: 0 }),
    );
    assert.ok(has(items, "8-bit"));
  });
});

suite("insights: distribution shape", () => {
  test("calls out skew in the right direction", () => {
    const right = buildInsights(meta(), detection(), bundle({ skewness: 2.5 }));
    assert.ok(has(right, "Right-skewed"));

    const left = buildInsights(meta(), detection(), bundle({ skewness: -2.5 }));
    assert.ok(has(left, "Left-skewed"));
  });

  test("stays quiet about mild skew", () => {
    const items = buildInsights(meta(), detection(), bundle({ skewness: 0.3 }));
    assert.ok(!has(items, "skewed"));
  });

  test("calls out heavy tails", () => {
    assert.ok(
      has(
        buildInsights(meta(), detection(), bundle({ kurtosis: 6 })),
        "Heavy tails",
      ),
    );
    assert.ok(
      !has(
        buildInsights(meta(), detection(), bundle({ kurtosis: 0.5 })),
        "Heavy tails",
      ),
    );
  });

  test("reports outliers only when there are enough to matter", () => {
    assert.ok(
      has(
        buildInsights(meta(), detection(), bundle({ outliers: 500 })),
        "outlier",
      ),
    );
    // A handful in ten thousand is noise, not a finding.
    assert.ok(
      !has(
        buildInsights(meta(), detection(), bundle({ outliers: 5 })),
        "outlier",
      ),
    );
  });

  test("suggests a log scale for a wide positive range", () => {
    const items = buildInsights(
      meta(),
      detection(),
      bundle({ min: 0.5, max: 50_000, negatives: 0, positives: 10_000 }),
    );
    assert.ok(has(items, "dynamic range"));
  });

  test("does not suggest a log scale for signed data", () => {
    // max/min would be a meaningless ratio once the data crosses zero.
    const items = buildInsights(
      meta(),
      detection(),
      bundle({ min: -1000, max: 50_000 }),
    );
    assert.ok(!has(items, "dynamic range"));
  });
});

suite("insights: composition", () => {
  test("reports sparsity past a majority of zeros", () => {
    const items = buildInsights(
      meta(),
      detection(),
      bundle({
        zeros: 8_000,
        sparsity: 0.8,
        negatives: 1_000,
        positives: 1_000,
      }),
    );
    assert.ok(has(items, "zeros"));
  });

  test("stays quiet about a few zeros", () => {
    const items = buildInsights(
      meta(),
      detection(),
      bundle({ zeros: 100, sparsity: 0.01 }),
    );
    assert.ok(!has(items, "% zeros"));
  });

  test("names binary data", () => {
    const items = buildInsights(
      meta({ kind: "uint", itemsize: 1 }),
      detection(),
      bundle({
        min: 0,
        max: 1,
        integral: true,
        uniqueCount: 2,
        negatives: 0,
        zeros: 5_000,
        positives: 5_000,
        topValues: [
          { value: 0, count: 5_000, label: "0" },
          { value: 1, count: 5_000, label: "1" },
        ],
      }),
    );
    assert.ok(has(items, "Binary"));
  });

  test("warns when a categorical distribution is heavily imbalanced", () => {
    const items = buildInsights(
      meta({ kind: "int" }),
      detection(),
      bundle({
        min: 0,
        max: 9,
        integral: true,
        uniqueCount: 10,
        negatives: 0,
        topValues: [{ value: 0, count: 8_500, label: "0" }],
      }),
    );
    const item = items.find((i) => i.title.includes("Categorical"));
    assert.ok(item, titles(items).join(" | "));
    assert.strictEqual(
      item?.level,
      "warn",
      "an 85% majority class is a warning",
    );
    assert.ok(item?.detail.includes("imbalanced"));
  });

  test("treats a balanced categorical distribution as information, not a warning", () => {
    const items = buildInsights(
      meta({ kind: "int" }),
      detection(),
      bundle({
        min: 0,
        max: 9,
        integral: true,
        uniqueCount: 10,
        negatives: 0,
        topValues: [{ value: 3, count: 1_100, label: "3" }],
      }),
    );
    const item = items.find((i) => i.title.includes("Categorical"));
    assert.strictEqual(item?.level, "info");
  });
});

suite("insights: file and method caveats", () => {
  test("warns loudly about a truncated file", () => {
    const items = buildInsights(meta(), detection(), bundle({}), {
      truncated: true,
    });
    const item = items.find((i) => i.title.includes("truncated"));
    assert.strictEqual(item?.level, "warn");
  });

  test("discloses that quantiles are sampled", () => {
    const items = buildInsights(
      meta(),
      detection(),
      bundle({ approximate: true, sampleSize: 5_000, total: 50_000_000 }),
    );
    assert.ok(has(items, "estimated"));
  });

  test("says nothing about sampling when the pass was exact", () => {
    const items = buildInsights(
      meta(),
      detection(),
      bundle({ approximate: false }),
    );
    assert.ok(!has(items, "estimated"));
  });

  test("mentions Fortran ordering, which changes nothing but explains itself", () => {
    const items = buildInsights(
      meta({ fortranOrder: true }),
      detection(),
      bundle({}),
    );
    assert.ok(has(items, "Fortran"));
  });

  test("explains itself when there are no numeric statistics at all", () => {
    const items = buildInsights(
      meta({ kind: "object", dtype: "object" }),
      detection(),
      {
        overall: null,
        channels: null,
        columns: null,
        insights: [],
        elapsedMs: 0,
        unsupported: "pickled objects",
      },
    );
    assert.strictEqual(items.length, 1);
    assert.ok(items[0].detail.includes("pickled"));
  });
});
