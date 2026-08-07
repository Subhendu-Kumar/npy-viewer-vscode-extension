import * as os from "node:os";
import * as assert from "assert";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import {
  parseDescr,
  trimNumber,
  readFloat16,
  formatScalar,
} from "../core/dtype";
import {
  detectLayout,
  computeStrides,
  frameToIndices,
  refineDetection,
} from "../core/layout";
import { NpyFile } from "../core/npyFile";
import { computeStats } from "../core/stats";
import { parseHeader, parsePythonLiteral } from "../core/npyHeader";

// ---------------------------------------------------------------------------
// Fixture construction
// ---------------------------------------------------------------------------

/** Builds a valid `.npy` buffer, mirroring what `numpy.save` writes. */
function makeNpy(
  descr: string,
  shape: number[],
  data: Buffer,
  options: { fortran?: boolean; version?: [number, number] } = {},
): Buffer {
  const [major, minor] = options.version ?? [1, 0];
  const shapeText =
    shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(", ")})`;
  const dict = `{'descr': '${descr}', 'fortran_order': ${options.fortran ? "True" : "False"}, 'shape': ${shapeText}, }`;

  const prefixLength = major === 1 ? 10 : 12;
  // NumPy pads the header so the data starts on a 64-byte boundary.
  const unpadded = prefixLength + dict.length + 1;
  const padding = (64 - (unpadded % 64)) % 64;
  const header = `${dict}${" ".repeat(padding)}\n`;

  const prefix = Buffer.alloc(prefixLength);
  Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]).copy(prefix, 0);
  prefix.writeUInt8(major, 6);
  prefix.writeUInt8(minor, 7);
  if (major === 1) {
    prefix.writeUInt16LE(header.length, 8);
  } else {
    prefix.writeUInt32LE(header.length, 8);
  }

  return Buffer.concat([prefix, Buffer.from(header, "latin1"), data]);
}

function float64Buffer(values: number[]): Buffer {
  const buffer = Buffer.alloc(values.length * 8);
  values.forEach((value, i) => buffer.writeDoubleLE(value, i * 8));
  return buffer;
}

/**
 * Decodes a base64 block into float32 values.
 *
 * `Buffer.from(text, 'base64')` hands back a view into Node's shared pool, so
 * the byte offset and length must be carried through — reading `.buffer` alone
 * would decode unrelated memory.
 */
function decodeFloat32(base64: string): Float32Array {
  const bytes = Buffer.from(base64, "base64");
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

async function withTempFile<T>(
  buffer: Buffer,
  run: (filePath: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "npy-viewer-test-"));
  const filePath = path.join(dir, "array.npy");
  await fs.writeFile(filePath, buffer);
  try {
    return await run(filePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

suite("Python literal parsing", () => {
  test("reads a NumPy header dict", () => {
    const parsed = parsePythonLiteral(
      "{'descr': '<f8', 'fortran_order': False, 'shape': (3, 4), }",
    ) as Record<string, unknown>;

    assert.strictEqual(parsed.descr, "<f8");
    assert.strictEqual(parsed.fortran_order, false);
    assert.deepStrictEqual(parsed.shape, [3, 4]);
  });

  test("reads 0-d and 1-d shapes", () => {
    const zero = parsePythonLiteral("{'shape': ()}") as Record<string, unknown>;
    assert.deepStrictEqual(zero.shape, []);
    const one = parsePythonLiteral("{'shape': (7,)}") as Record<
      string,
      unknown
    >;
    assert.deepStrictEqual(one.shape, [7]);
  });

  test("reads a structured descr list", () => {
    const parsed = parsePythonLiteral(
      "{'descr': [('a', '<i4'), ('b', '|u1', (3,))], 'shape': (2,)}",
    ) as Record<string, unknown>;
    assert.deepStrictEqual(parsed.descr, [
      ["a", "<i4"],
      ["b", "|u1", [3]],
    ]);
  });
});

suite("dtype descriptors", () => {
  test("parses the common scalar types", () => {
    assert.strictEqual(parseDescr("<f4").name, "float32");
    assert.strictEqual(parseDescr("<f8").itemsize, 8);
    assert.strictEqual(parseDescr("|u1").kind, "uint");
    assert.strictEqual(parseDescr("<i8").name, "int64");
    assert.strictEqual(parseDescr("|b1").name, "bool");
    assert.strictEqual(parseDescr("<c16").name, "complex128");
  });

  test("marks big-endian descriptors", () => {
    assert.strictEqual(parseDescr(">f8").littleEndian, false);
    assert.strictEqual(parseDescr("<f8").littleEndian, true);
  });

  test("sizes unicode as four bytes per character", () => {
    assert.strictEqual(parseDescr("<U12").itemsize, 48);
    assert.strictEqual(parseDescr("|S12").itemsize, 12);
  });

  test("carries the datetime unit", () => {
    const dtype = parseDescr("<M8[ns]");
    assert.strictEqual(dtype.kind, "datetime");
    assert.strictEqual(dtype.timeUnit, "ns");
  });

  test("flags object arrays as unreadable without NumPy", () => {
    const dtype = parseDescr("|O");
    assert.strictEqual(dtype.readable, false);
    assert.strictEqual(dtype.numeric, false);
  });

  test("rejects nonsense", () => {
    assert.throws(() => parseDescr("not-a-dtype"));
  });
});

suite("half-precision floats", () => {
  test("decodes representative values", () => {
    const cases: Array<[number, number]> = [
      [0x0000, 0],
      [0x3c00, 1],
      [0xc000, -2],
      [0x3555, 0.333251953125],
      [0x7c00, Number.POSITIVE_INFINITY],
      [0xfc00, Number.NEGATIVE_INFINITY],
    ];

    for (const [bits, expected] of cases) {
      const view = new DataView(new ArrayBuffer(2));
      view.setUint16(0, bits, true);
      assert.strictEqual(
        readFloat16(view, 0, true),
        expected,
        `bits 0x${bits.toString(16)}`,
      );
    }

    const nan = new DataView(new ArrayBuffer(2));
    nan.setUint16(0, 0x7e00, true);
    assert.ok(Number.isNaN(readFloat16(nan, 0, true)));
  });
});

suite("header parsing", () => {
  test("reads a v1.0 header", () => {
    const buffer = makeNpy("<f8", [2, 3], float64Buffer([1, 2, 3, 4, 5, 6]));
    const { meta, dataOffset } = parseHeader(buffer, buffer.length);

    assert.deepStrictEqual(meta.shape, [2, 3]);
    assert.strictEqual(meta.dtype, "float64");
    assert.strictEqual(meta.size, 6);
    assert.strictEqual(meta.fortranOrder, false);
    assert.strictEqual(meta.npyVersion, "1.0");
    assert.strictEqual(dataOffset % 64, 0, "data should start 64-byte aligned");
  });

  test("reads a v2.0 header with a 4-byte length", () => {
    const buffer = makeNpy("<f8", [2], float64Buffer([1, 2]), {
      version: [2, 0],
    });
    const { meta } = parseHeader(buffer, buffer.length);
    assert.strictEqual(meta.npyVersion, "2.0");
    assert.deepStrictEqual(meta.shape, [2]);
  });

  test("rejects a file without the magic string", () => {
    assert.throws(() => parseHeader(Buffer.alloc(128), 128), /NUMPY/);
  });

  test("rejects an unsupported format version", () => {
    const buffer = makeNpy("<f8", [1], float64Buffer([1]));
    buffer.writeUInt8(9, 6);
    assert.throws(() => parseHeader(buffer, buffer.length), /version/i);
  });
});

suite("strides and frame indexing", () => {
  test("computes C and Fortran strides", () => {
    assert.deepStrictEqual(computeStrides([2, 3, 4], false), [12, 4, 1]);
    assert.deepStrictEqual(computeStrides([2, 3, 4], true), [1, 2, 6]);
  });

  test("expands a flat frame number across frame axes", () => {
    // No axis here is 1, 3 or 4, so nothing is mistaken for colour channels
    // and both leading axes index frames.
    const meta = parseHeader(
      makeNpy("<f8", [2, 7, 5, 6], Buffer.alloc(0)),
      0,
    ).meta;
    const layout = detectLayout(meta, parseDescr("<f8")).layout;
    assert.ok(layout);
    assert.deepStrictEqual(layout.frameShape, [2, 7]);
    assert.strictEqual(layout.frameCount, 14);
    assert.deepStrictEqual(frameToIndices(layout, 0), [0, 0]);
    assert.deepStrictEqual(frameToIndices(layout, 4), [0, 4]);
    assert.deepStrictEqual(frameToIndices(layout, 7), [1, 0]);
    assert.deepStrictEqual(frameToIndices(layout, 13), [1, 6]);
  });
});

suite("view detection", () => {
  const detectFor = (descr: string, shape: number[]) => {
    const meta = parseHeader(makeNpy(descr, shape, Buffer.alloc(0)), 0).meta;
    return detectLayout(meta, parseDescr(descr));
  };

  test("reads a trailing 3 as RGB channels", () => {
    const detection = detectFor("|u1", [96, 128, 3]);
    assert.strictEqual(detection.primary, "image");
    assert.strictEqual(detection.layout?.channelAxis, 2);
    assert.strictEqual(detection.layout?.channels, 3);
    assert.strictEqual(detection.layout?.order, "channel-last");
  });

  test("reads a leading 3 as PyTorch channel-first", () => {
    const detection = detectFor("<f4", [3, 80, 100]);
    assert.strictEqual(detection.layout?.channelAxis, 0);
    assert.strictEqual(detection.layout?.order, "channel-first");
    assert.strictEqual(detection.layout?.height, 80);
  });

  test("treats a leading axis as frames for an image stack", () => {
    const detection = detectFor("|u1", [40, 28, 28]);
    assert.strictEqual(detection.primary, "grid");
    assert.strictEqual(detection.layout?.frameCount, 40);
    assert.strictEqual(detection.layout?.height, 28);
  });

  test("separates NHWC from NCHW batches", () => {
    const nhwc = detectFor("|u1", [24, 32, 32, 3]);
    assert.strictEqual(nhwc.layout?.channelAxis, 3);
    assert.strictEqual(nhwc.layout?.frameCount, 24);

    const nchw = detectFor("<f4", [16, 3, 24, 24]);
    assert.strictEqual(nchw.layout?.channelAxis, 1);
    assert.strictEqual(nchw.layout?.frameCount, 16);
  });

  test("reads a much smaller trailing axis as bands, not a plane edge", () => {
    const bands = detectFor("<f4", [512, 512, 16]);
    assert.strictEqual(bands.layout?.height, 512);
    assert.strictEqual(bands.layout?.width, 512);
    assert.strictEqual(bands.layout?.frameCount, 16);

    // The comparable stack shape must keep the conventional reading.
    const stack = detectFor("|u1", [40, 28, 28]);
    assert.strictEqual(stack.layout?.frameCount, 40);
  });

  test("presents a vector as a 1 x N plane", () => {
    const detection = detectFor("<f8", [500]);
    assert.strictEqual(detection.primary, "line");
    assert.strictEqual(detection.layout?.height, 1);
    assert.strictEqual(detection.layout?.width, 500);
    assert.strictEqual(detection.layout?.frameCount, 1);
  });

  test("prefers a table for a small matrix", () => {
    assert.strictEqual(detectFor("<i8", [12, 8]).primary, "table");
  });

  test("has no visual for object arrays", () => {
    const detection = detectFor("|O", [10]);
    assert.strictEqual(detection.primary, "text");
    assert.strictEqual(detection.layout, null);
  });
});

suite("statistics", () => {
  const run = async (values: number[], shape?: number[]) =>
    withTempFile(
      makeNpy("<f8", shape ?? [values.length], float64Buffer(values)),
      async (filePath) => {
        const file = await NpyFile.open(filePath);
        const bundle = await computeStats(
          file.source,
          file.meta,
          file.dtype,
          file.dataOffset,
          {
            exactLimit: 1_000_000,
            histogramBins: 16,
            channelAxis: null,
            columnAxis: null,
          },
        );
        await file.close();
        return bundle;
      },
    );

  test("matches hand-computed moments", async () => {
    const { overall } = await run([2, 4, 4, 4, 5, 5, 7, 9]);
    assert.ok(overall);
    assert.strictEqual(overall.total, 8);
    assert.strictEqual(overall.finite, 8);
    assert.strictEqual(overall.mean, 5);
    assert.strictEqual(overall.min, 2);
    assert.strictEqual(overall.max, 9);
    assert.strictEqual(overall.sum, 40);
    assert.strictEqual(overall.median, 4.5);
    // Sample standard deviation (ddof = 1) of the classic worked example.
    assert.ok(Math.abs(overall.std - 2.13809) < 1e-4, `std was ${overall.std}`);
    assert.strictEqual(overall.integral, true);
    assert.strictEqual(overall.approximate, false);
  });

  test("counts NaN and infinities without letting them into the moments", async () => {
    const { overall } = await run([
      1,
      2,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      3,
    ]);
    assert.ok(overall);
    assert.strictEqual(overall.total, 6);
    assert.strictEqual(overall.finite, 3);
    assert.strictEqual(overall.nan, 1);
    assert.strictEqual(overall.posInf, 1);
    assert.strictEqual(overall.negInf, 1);
    assert.strictEqual(overall.mean, 2);
    assert.strictEqual(overall.max, 3);
    // Non-finite values are reported separately, never as distinct values.
    assert.strictEqual(overall.uniqueCount, 3);
  });

  test("reports zeros, signs and sparsity", async () => {
    const { overall } = await run([0, 0, 0, -1, 2]);
    assert.ok(overall);
    assert.strictEqual(overall.zeros, 3);
    assert.strictEqual(overall.negatives, 1);
    assert.strictEqual(overall.positives, 1);
    assert.strictEqual(overall.sparsity, 0.6);
  });

  test("computes the median absolute deviation", async () => {
    // |x - 4| over [1,2,3,4,5,6,7] is [3,2,1,0,1,2,3]; its median is 2.
    assert.strictEqual(
      (await run([1, 2, 3, 4, 5, 6, 7])).overall?.madMedian,
      2,
    );
    // Even count: median of [1,2,3,4] is 2.5, deviations [1.5,0.5,0.5,1.5] -> 1.
    assert.strictEqual((await run([1, 2, 3, 4])).overall?.madMedian, 1);
    // A single value has no spread at all.
    assert.strictEqual((await run([9])).overall?.madMedian, 0);
  });

  test("keeps quantiles clear of NaN and infinities", async () => {
    // The finite values are 1..5, so every quantile must come from those alone
    // even though the sample also holds NaN and both infinities.
    const { overall } = await run([
      3,
      Number.NaN,
      1,
      Number.POSITIVE_INFINITY,
      5,
      Number.NEGATIVE_INFINITY,
      2,
      4,
    ]);
    assert.ok(overall);
    assert.strictEqual(overall.median, 3);
    assert.strictEqual(overall.percentiles["25"], 2);
    assert.strictEqual(overall.percentiles["75"], 4);
    assert.strictEqual(overall.madMedian, 1);
    assert.strictEqual(overall.min, 1);
    assert.strictEqual(overall.max, 5);
  });

  test("withholds the coefficient of variation for signed data", async () => {
    assert.strictEqual((await run([-5, 0, 5])).overall?.cv, null);
    const positive = (await run([2, 4, 6])).overall;
    assert.ok(positive?.cv !== null && positive?.cv !== undefined);
  });

  test("histogram counts every finite value exactly once", async () => {
    const values = Array.from({ length: 1000 }, (_, i) => Math.sin(i));
    const { overall } = await run(values);
    const total = overall?.histogram?.counts.reduce((a, b) => a + b, 0);
    assert.strictEqual(total, 1000);
  });

  test("gives integer data one bin per value", async () => {
    const { overall } = await run([1, 2, 3, 4, 5, 5, 5]);
    assert.strictEqual(overall?.histogram?.counts.length, 5);
  });

  test("bins huge constant values instead of dropping them", async () => {
    // At 6e23 one ulp is 6.7e7, so padding the range by 0.5 leaves it empty and
    // every value lands in a NaN bin. The count must survive regardless.
    const huge = await run([6.02214076e23, 6.02214076e23, 6.02214076e23]);
    const counts = huge.overall?.histogram?.counts ?? [];
    assert.strictEqual(
      counts.reduce((a, b) => a + b, 0),
      3,
    );

    const ordinary = await run([7, 7, 7, 7]);
    assert.strictEqual(
      (ordinary.overall?.histogram?.counts ?? []).reduce((a, b) => a + b, 0),
      4,
    );
  });

  test("summarises a constant array without dividing by zero", async () => {
    const { overall } = await run([7, 7, 7, 7]);
    assert.ok(overall);
    assert.strictEqual(overall.std, 0);
    assert.strictEqual(overall.skewness, 0);
    assert.strictEqual(overall.kurtosis, 0);
    assert.strictEqual(overall.min, overall.max);
  });

  test("reports empty arrays as unsupported rather than as NaNs", async () => {
    const bundle = await run([], [0, 5]);
    assert.strictEqual(bundle.overall, null);
    assert.ok(bundle.unsupported);
  });
});

suite("reading array data", () => {
  test("reads a decimated block with the right values", async () => {
    // 4 x 4 counting up, so decimation is easy to reason about.
    const values = Array.from({ length: 16 }, (_, i) => i);
    await withTempFile(
      makeNpy("<f8", [4, 4], float64Buffer(values)),
      async (filePath) => {
        const file = await NpyFile.open(filePath);
        const layout = detectLayout(file.meta, file.dtype).layout;
        assert.ok(layout);

        const full = await file.readBlock(layout, [0], 16, 1000);
        assert.deepStrictEqual(full.shape, [1, 4, 4, 1]);

        // maxSide 2 takes every other row and column: 0, 2, 8, 10.
        const half = await file.readBlock(layout, [0], 2, 1000);
        assert.deepStrictEqual(half.shape, [1, 2, 2, 1]);
        assert.deepStrictEqual(half.step, [2, 2]);
        assert.deepStrictEqual([...decodeFloat32(half.data)], [0, 2, 8, 10]);

        await file.close();
      },
    );
  });

  test("addresses frames in a 3-D stack", async () => {
    // Frame f is filled with the value f. The plane is 5 x 6 rather than
    // 3 x 3 so the trailing axis is not mistaken for colour channels.
    const values: number[] = [];
    for (let f = 0; f < 5; f += 1) {
      for (let i = 0; i < 30; i += 1) {
        values.push(f);
      }
    }
    await withTempFile(
      makeNpy("<f8", [5, 5, 6], float64Buffer(values)),
      async (filePath) => {
        const file = await NpyFile.open(filePath);
        const layout = detectLayout(file.meta, file.dtype).layout;
        assert.ok(layout);
        assert.strictEqual(layout.frameCount, 5);

        for (const frame of [0, 2, 4]) {
          const block = await file.readBlock(layout, [frame], 8, 1000);
          assert.strictEqual(block.blockMin, frame);
          assert.strictEqual(block.blockMax, frame);
        }
        await file.close();
      },
    );
  });

  test("honours Fortran ordering", async () => {
    // Column-major [[1, 3], [2, 4]] is stored as 1, 2, 3, 4.
    await withTempFile(
      makeNpy("<f8", [2, 2], float64Buffer([1, 2, 3, 4]), { fortran: true }),
      async (filePath) => {
        const file = await NpyFile.open(filePath);
        assert.strictEqual(file.meta.fortranOrder, true);
        const layout = detectLayout(file.meta, file.dtype).layout;
        assert.ok(layout);

        const table = await file.readTable(layout, 0, 0, 0, 2, 2);
        assert.deepStrictEqual(table.cells, [
          ["1", "3"],
          ["2", "4"],
        ]);
        await file.close();
      },
    );
  });

  test("reads big-endian data", async () => {
    const buffer = Buffer.alloc(24);
    [1.5, -2.5, 3.5].forEach((value, i) => buffer.writeDoubleBE(value, i * 8));
    await withTempFile(makeNpy(">f8", [3], buffer), async (filePath) => {
      const file = await NpyFile.open(filePath);
      assert.strictEqual(file.meta.littleEndian, false);
      const layout = detectLayout(file.meta, file.dtype).layout;
      assert.ok(layout);
      const table = await file.readTable(layout, 0, 0, 0, 1, 3);
      assert.deepStrictEqual(table.cells[0], ["1.5", "-2.5", "3.5"]);
      await file.close();
    });
  });

  test("keeps 64-bit integers exact past 2^53", async () => {
    const buffer = Buffer.alloc(8);
    buffer.writeBigInt64LE(9007199254740993n, 0);
    await withTempFile(makeNpy("<i8", [1], buffer), async (filePath) => {
      const file = await NpyFile.open(filePath);
      const layout = detectLayout(file.meta, file.dtype).layout;
      assert.ok(layout);
      const table = await file.readTable(layout, 0, 0, 0, 1, 1);
      assert.strictEqual(table.cells[0][0], "9007199254740993");
      await file.close();
    });
  });

  test("reports a truncated file instead of failing", async () => {
    const complete = makeNpy("<f8", [10], float64Buffer(Array(10).fill(1)));
    await withTempFile(
      complete.subarray(0, complete.length - 24),
      async (filePath) => {
        const file = await NpyFile.open(filePath);
        assert.strictEqual(file.truncated, true);
        assert.deepStrictEqual(file.meta.shape, [10]);
        await file.close();
      },
    );
  });
});

suite("value formatting", () => {
  test("renders bools, strings and complex numbers", () => {
    const boolView = new DataView(Uint8Array.from([1]).buffer);
    assert.strictEqual(formatScalar(boolView, 0, parseDescr("|b1")), "True");

    const bytes = Buffer.alloc(6);
    bytes.write("hi", 0, "latin1");
    assert.strictEqual(
      formatScalar(
        new DataView(bytes.buffer, bytes.byteOffset, 6),
        0,
        parseDescr("|S6"),
      ),
      "hi",
    );

    const complex = Buffer.alloc(16);
    complex.writeDoubleLE(1.5, 0);
    complex.writeDoubleLE(-2.5, 8);
    assert.strictEqual(
      formatScalar(
        new DataView(complex.buffer, complex.byteOffset, 16),
        0,
        parseDescr("<c16"),
      ),
      "1.5-2.5j",
    );
  });

  test("keeps numbers short without losing meaning", () => {
    assert.strictEqual(trimNumber(42), "42");
    assert.strictEqual(trimNumber(Number.NaN), "NaN");
    assert.strictEqual(trimNumber(Number.POSITIVE_INFINITY), "inf");
    assert.ok(trimNumber(1e-9).includes("e-9"));
  });
});

suite("detection refinement", () => {
  test("moves signed fields off the image reading", async () => {
    const values = Array.from({ length: 1024 }, (_, i) => (i % 2 ? -50 : 50));
    await withTempFile(
      makeNpy("<f8", [32, 32], float64Buffer(values)),
      async (filePath) => {
        const file = await NpyFile.open(filePath);
        const initial = detectLayout(file.meta, file.dtype);
        assert.strictEqual(initial.primary, "image");

        const bundle = await computeStats(
          file.source,
          file.meta,
          file.dtype,
          file.dataOffset,
          {
            exactLimit: 100_000,
            histogramBins: 16,
            channelAxis: null,
            columnAxis: null,
          },
        );
        const refined = refineDetection(initial, file.meta, bundle.overall);
        assert.strictEqual(refined.primary, "heatmap");
        assert.strictEqual(refined.isImageLike, false);
        await file.close();
      },
    );
  });

  test("labels an integer class vector but not a float or datetime one", async () => {
    const labels = Buffer.alloc(600);
    for (let i = 0; i < 75; i += 1) {
      labels.writeBigInt64LE(BigInt(i % 3), i * 8);
    }
    await withTempFile(makeNpy("<i8", [75], labels), async (filePath) => {
      const file = await NpyFile.open(filePath);
      const bundle = await computeStats(
        file.source,
        file.meta,
        file.dtype,
        file.dataOffset,
        {
          exactLimit: 100_000,
          histogramBins: 16,
          channelAxis: null,
          columnAxis: null,
        },
      );
      const refined = refineDetection(
        detectLayout(file.meta, file.dtype),
        file.meta,
        bundle.overall,
      );
      assert.ok(refined.semantic.includes("Label vector"), refined.semantic);
      await file.close();
    });

    // The same whole numbers stored as float64 are not class labels.
    await withTempFile(
      makeNpy(
        "<f8",
        [75],
        float64Buffer(Array.from({ length: 75 }, (_, i) => i % 3)),
      ),
      async (filePath) => {
        const file = await NpyFile.open(filePath);
        const bundle = await computeStats(
          file.source,
          file.meta,
          file.dtype,
          file.dataOffset,
          {
            exactLimit: 100_000,
            histogramBins: 16,
            channelAxis: null,
            columnAxis: null,
          },
        );
        const refined = refineDetection(
          detectLayout(file.meta, file.dtype),
          file.meta,
          bundle.overall,
        );
        assert.ok(!refined.semantic.includes("Label vector"), refined.semantic);
        await file.close();
      },
    );
  });
});
