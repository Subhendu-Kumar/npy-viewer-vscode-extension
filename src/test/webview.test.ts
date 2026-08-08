import {
  fmt,
  fmtTick,
  fmtBytes,
  fmtCount,
  fmtShape,
  fmtPercent,
  fmtDuration,
} from "../webview/format";
import {
  normalise,
  DIVERGING,
  gradientCss,
  lookupTable,
  renderPlane,
  sampleColor,
  COLORMAP_NAMES,
} from "../webview/colormap";
import * as assert from "assert";
import { decodeBlock } from "../webview/decode";
import type { Block, NumericStats } from "../common/types";
import { hasMeaningfulFrequencies } from "../webview/views/stats";

/**
 * The webview is bundled for the browser, but none of the modules exercised
 * here touch the DOM — they are the pure transforms between what the extension
 * host sends and what gets painted, so they run under plain Node.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function block(
  values: number[],
  shape: [number, number, number, number],
  encoding: "u8" | "f32",
): Block {
  const bytes =
    encoding === "u8"
      ? Buffer.from(Uint8Array.from(values))
      : Buffer.from(Float32Array.from(values).buffer);

  return {
    encoding,
    data: bytes.toString("base64"),
    shape,
    frames: [0],
    step: [1, 1],
    downsampled: false,
    blockMin: Math.min(...values),
    blockMax: Math.max(...values),
  };
}

/** The RGBA quad for pixel `i`. */
function pixel(target: Uint8ClampedArray, i: number): number[] {
  return [...target.slice(i * 4, i * 4 + 4)];
}

// ---------------------------------------------------------------------------

suite("webview: block decoding", () => {
  test("decodes uint8 blocks without copying wrongly", () => {
    const decoded = decodeBlock(block([0, 64, 128, 255], [1, 2, 2, 1], "u8"));

    assert.ok(decoded.values instanceof Uint8Array);
    assert.deepStrictEqual([...decoded.values], [0, 64, 128, 255]);
    assert.strictEqual(decoded.height, 2);
    assert.strictEqual(decoded.width, 2);
    assert.strictEqual(decoded.channels, 1);
    assert.strictEqual(decoded.frameStride, 4);
  });

  test("decodes float32 blocks, preserving NaN", () => {
    const decoded = decodeBlock(
      block([1.5, -2.5, Number.NaN, 0], [1, 1, 4, 1], "f32"),
    );

    assert.ok(decoded.values instanceof Float32Array);
    assert.strictEqual(decoded.values[0], 1.5);
    assert.strictEqual(decoded.values[1], -2.5);
    assert.ok(Number.isNaN(decoded.values[2]));
    assert.strictEqual(decoded.values[3], 0);
  });

  /**
   * `Buffer.from(text, 'base64')` returns a view into Node's shared pool, so a
   * decoder that reads `.buffer` without honouring `.byteOffset` silently
   * returns unrelated memory. This has bitten once already.
   */
  test("is unaffected by pooled buffer offsets", () => {
    // Decode several blocks in a row; a pooled-offset bug shows up on the
    // second and later ones, never the first.
    for (let i = 0; i < 8; i += 1) {
      const values = [i, i + 1, i + 2, i + 3];
      const decoded = decodeBlock(block(values, [1, 2, 2, 1], "f32"));
      assert.deepStrictEqual([...decoded.values], values, `iteration ${i}`);
    }
  });

  test("carries frame and decimation metadata through", () => {
    const raw = block([1, 2], [1, 1, 2, 1], "f32");
    raw.frames = [7];
    raw.step = [4, 2];
    raw.downsampled = true;

    const decoded = decodeBlock(raw);
    assert.deepStrictEqual(decoded.sourceFrames, [7]);
    assert.deepStrictEqual(decoded.step, [4, 2]);
    assert.strictEqual(decoded.downsampled, true);
  });

  test("computes the frame stride across multi-frame blocks", () => {
    const decoded = decodeBlock(
      block([1, 2, 3, 4, 5, 6, 7, 8], [2, 2, 2, 1], "u8"),
    );
    assert.strictEqual(decoded.frames, 2);
    assert.strictEqual(decoded.frameStride, 4);
  });
});

suite("webview: colour ramps", () => {
  test("builds a full 256-entry table", () => {
    const table = lookupTable("viridis");
    assert.strictEqual(table.length, 256 * 3);
    // Viridis runs dark purple to bright yellow-green.
    assert.ok(table[0] < 80 && table[2] > 60, "dark blue-purple at the bottom");
    assert.ok(
      table[255 * 3] > 200 && table[255 * 3 + 1] > 200,
      "bright at the top",
    );
  });

  test("caches tables rather than rebuilding them", () => {
    assert.strictEqual(lookupTable("magma"), lookupTable("magma"));
  });

  test("falls back to viridis for an unknown name", () => {
    assert.deepStrictEqual(
      [...lookupTable("no-such-map")],
      [...lookupTable("viridis")],
    );
  });

  test("every advertised colormap builds", () => {
    assert.ok(COLORMAP_NAMES.length >= 8);
    for (const name of COLORMAP_NAMES) {
      assert.strictEqual(lookupTable(name).length, 768, name);
    }
  });

  test("clamps sampled positions outside [0, 1]", () => {
    assert.strictEqual(sampleColor("viridis", -5), sampleColor("viridis", 0));
    assert.strictEqual(sampleColor("viridis", 5), sampleColor("viridis", 1));
    assert.match(sampleColor("viridis", 0.5), /^rgb\(\d+, \d+, \d+\)$/);
  });

  test("produces a gradient with the requested number of stops", () => {
    const css = gradientCss("plasma", 5);
    assert.ok(css.startsWith("linear-gradient(to right, "));
    assert.strictEqual(css.match(/rgb\(/g)?.length, 5);
  });

  test("marks coolwarm as diverging so it can be centred on zero", () => {
    assert.ok(DIVERGING.has("coolwarm"));
    assert.ok(!DIVERGING.has("viridis"));
  });
});

suite("webview: value normalisation", () => {
  test("maps a linear range onto [0, 1]", () => {
    assert.strictEqual(normalise(0, 0, 10, "linear"), 0);
    assert.strictEqual(normalise(10, 0, 10, "linear"), 1);
    assert.strictEqual(normalise(5, 0, 10, "linear"), 0.5);
  });

  test("puts a degenerate range in the middle rather than dividing by zero", () => {
    assert.strictEqual(normalise(7, 7, 7, "linear"), 0.5);
    assert.strictEqual(normalise(7, 7, 7, "log"), 0.5);
  });

  /**
   * The regression this guards: flooring the log range at a tiny epsilon made
   * the scale span dozens of decades, so every real value landed at the top of
   * the ramp and a heightmap rendered almost uniformly yellow.
   */
  test("keeps a usable log range when the data reaches zero", () => {
    const max = 2400;
    const mid = normalise(max / 100, 0, max, "log");

    assert.ok(
      mid > 0.35 && mid < 0.65,
      `two decades down should sit mid-ramp, got ${mid}`,
    );
    assert.strictEqual(normalise(max, 0, max, "log"), 1);
    // Anything at or below the floor pins to the bottom rather than going NaN.
    assert.strictEqual(normalise(0, 0, max, "log"), 0);
  });

  test("uses the real minimum for a log range that stays positive", () => {
    // With min > 0 the floor is the data's own minimum, not a derived one.
    assert.strictEqual(normalise(1, 1, 1000, "log"), 0);
    assert.strictEqual(normalise(1000, 1, 1000, "log"), 1);
    const middle = normalise(Math.sqrt(1000), 1, 1000, "log");
    assert.ok(Math.abs(middle - 0.5) < 1e-9, `got ${middle}`);
  });

  test("centres symlog on zero for signed data", () => {
    assert.strictEqual(normalise(0, -100, 100, "symlog"), 0.5);
    assert.ok(normalise(100, -100, 100, "symlog") > 0.9);
    assert.ok(normalise(-100, -100, 100, "symlog") < 0.1);
  });
});

suite("webview: plane rendering", () => {
  const options = {
    min: 0,
    max: 1,
    colormap: "viridis",
    scale: "linear" as const,
    rgb: false,
  };

  test("paints one opaque pixel per value", () => {
    const target = new Uint8ClampedArray(4 * 4);
    renderPlane(
      Float32Array.from([0, 0.5, 1, 0.25]),
      0,
      4,
      1,
      1,
      options,
      target,
    );

    for (let i = 0; i < 4; i += 1) {
      assert.strictEqual(
        pixel(target, i)[3],
        255,
        `pixel ${i} should be opaque`,
      );
    }
    // The ramp is not constant, so the ends must differ.
    assert.notDeepStrictEqual(pixel(target, 0), pixel(target, 2));
  });

  test("leaves non-finite values transparent", () => {
    const target = new Uint8ClampedArray(3 * 4);
    renderPlane(
      Float32Array.from([Number.NaN, Number.POSITIVE_INFINITY, 0.5]),
      0,
      3,
      1,
      1,
      options,
      target,
    );

    assert.strictEqual(pixel(target, 0)[3], 0, "NaN must be a gap");
    assert.strictEqual(pixel(target, 1)[3], 0, "infinity must be a gap");
    assert.strictEqual(pixel(target, 2)[3], 255);
  });

  test("renders three channels as colour when asked", () => {
    const target = new Uint8ClampedArray(4);
    renderPlane(
      Float32Array.from([1, 0, 0]),
      0,
      1,
      1,
      3,
      { ...options, min: 0, max: 1, rgb: true },
      target,
    );
    assert.deepStrictEqual(pixel(target, 0), [255, 0, 0, 255]);
  });

  test("uses a fourth channel as alpha", () => {
    const target = new Uint8ClampedArray(4);
    renderPlane(
      Float32Array.from([0, 1, 0, 0.5]),
      0,
      1,
      1,
      4,
      { ...options, rgb: true },
      target,
    );
    const [r, g, b, a] = pixel(target, 0);
    assert.strictEqual(r, 0);
    assert.strictEqual(g, 255);
    assert.strictEqual(b, 0);
    assert.ok(
      Math.abs(a - 128) <= 1,
      `alpha should track the 4th channel, got ${a}`,
    );
  });

  test("reads from the given frame offset", () => {
    // Two frames of one pixel; rendering the second must skip the first.
    const values = Float32Array.from([0, 1]);
    const first = new Uint8ClampedArray(4);
    const second = new Uint8ClampedArray(4);

    renderPlane(values, 0, 1, 1, 1, options, first);
    renderPlane(values, 1, 1, 1, 1, options, second);

    assert.notDeepStrictEqual(pixel(first, 0), pixel(second, 0));
  });
});

suite("webview: formatting", () => {
  test("renders ordinary numbers readably", () => {
    assert.strictEqual(fmt(0), "0");
    assert.strictEqual(fmt(1000), (1000).toLocaleString());
    assert.strictEqual(fmt(Number.NaN), "NaN");
    assert.strictEqual(fmt(Number.POSITIVE_INFINITY), "∞");
    assert.strictEqual(fmt(Number.NEGATIVE_INFINITY), "-∞");
  });

  test("switches to exponential only at the extremes", () => {
    assert.ok(fmt(1e-9).includes("e"), "tiny values are unreadable in full");
    assert.ok(
      fmt(1234567890.5).includes("e"),
      "huge fractional values go exponential",
    );
    assert.ok(!fmt(1234.5).includes("e"), "ordinary values stay decimal");
  });

  test("keeps whole numbers legible instead of exponential", () => {
    // Element counts and integer data are far easier to read with separators
    // than as 1.000e+12, so integers stay in full up to 10^15.
    assert.strictEqual(fmt(1e12), (1e12).toLocaleString());
    assert.ok(!fmt(1e12).includes("e"));
  });

  test("formats axis ticks without thousands separators running wild", () => {
    assert.strictEqual(fmtTick(0), "0");
    assert.ok(fmtTick(1e7).includes("e"));
    assert.strictEqual(fmtTick(Number.NaN), "");
  });

  test("counts and byte sizes", () => {
    assert.strictEqual(fmtCount(1234), (1234).toLocaleString());
    assert.strictEqual(fmtCount(Number.NaN), "—");

    assert.strictEqual(fmtBytes(512), "512 B");
    assert.strictEqual(fmtBytes(1024), "1.00 KB");
    assert.strictEqual(fmtBytes(1024 * 1024), "1.00 MB");
    assert.ok(fmtBytes(1024 ** 4).endsWith("TB"));
  });

  test("percentages, including the vanishing case", () => {
    assert.strictEqual(fmtPercent(0, 100), "0%");
    assert.strictEqual(fmtPercent(1, 0), "0%");
    assert.strictEqual(fmtPercent(1, 1_000_000), "<0.01%");
    assert.strictEqual(fmtPercent(50, 100), "50.00%");
  });

  test("shapes use NumPy's tuple spelling", () => {
    assert.strictEqual(fmtShape([]), "()");
    assert.strictEqual(fmtShape([7]), "(7,)");
    assert.strictEqual(fmtShape([2, 3]), "(2, 3)");
  });

  test("durations switch unit at a second", () => {
    assert.strictEqual(fmtDuration(250), "250 ms");
    assert.strictEqual(fmtDuration(1500), "1.50 s");
  });
});

suite("webview: frequency breakdown predicate", () => {
  const stats = (over: Partial<NumericStats>): NumericStats =>
    ({
      finite: 1000,
      uniqueCount: 10,
      topValues: [{ value: 1, count: 400, label: "1" }],
      ...over,
    }) as NumericStats;

  test("shows the breakdown for repeating categorical data", () => {
    assert.strictEqual(hasMeaningfulFrequencies(stats({})), true);
  });

  test("hides it when every value is distinct", () => {
    // Continuous data: 1000 finite values, 1000 distinct, each seen once.
    assert.strictEqual(
      hasMeaningfulFrequencies(
        stats({
          uniqueCount: 1000,
          topValues: [{ value: 0.5, count: 1, label: "0.5" }],
        }),
      ),
      false,
    );
  });

  test("hides it when cardinality is too close to the element count", () => {
    // 600 distinct out of 1000 still averages under two per value.
    assert.strictEqual(
      hasMeaningfulFrequencies(
        stats({
          uniqueCount: 600,
          topValues: [{ value: 1, count: 2, label: "1" }],
        }),
      ),
      false,
    );
  });

  test("hides it when cardinality is unknown or degenerate", () => {
    assert.strictEqual(
      hasMeaningfulFrequencies(stats({ uniqueCount: null })),
      false,
    );
    assert.strictEqual(
      hasMeaningfulFrequencies(stats({ uniqueCount: 1 })),
      false,
    );
    assert.strictEqual(
      hasMeaningfulFrequencies(stats({ topValues: null })),
      false,
    );
    assert.strictEqual(
      hasMeaningfulFrequencies(stats({ topValues: [] })),
      false,
    );
  });
});
