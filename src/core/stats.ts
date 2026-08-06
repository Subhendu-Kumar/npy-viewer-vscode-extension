import type {
  ArrayMeta,
  AxisStats,
  Histogram,
  NumericStats,
  StatsBundle,
  ValueCount,
} from "../common/types";
import { makeScalarReader, trimNumber, type ParsedDtype } from "./dtype";
import { computeStrides } from "./layout";
import type { ByteSource } from "./reader";

/** Distinct values tracked before giving up on an exact cardinality count. */
const MAX_TRACKED_UNIQUE = 8192;

/** Groups (channels / columns) broken out individually. */
const MAX_GROUPS = 512;

export interface StatsOptions {
  /** Element count up to which every value is retained for exact quantiles. */
  exactLimit: number;
  histogramBins: number;
  /** Axis broken out per-channel, with its extent. */
  channelAxis?: number | null;
  /** Axis broken out per-column, with its extent. */
  columnAxis?: number | null;
  onProgress?: (fraction: number) => void;
}

/**
 * Running moments and tallies for one value stream.
 *
 * Mean/variance/skew/kurtosis use Welford's online update extended to the third
 * and fourth central moments, which stays stable across billions of elements
 * where a naive sum-of-powers would lose all precision.
 */
class Accumulator {
  n = 0;
  min = Number.POSITIVE_INFINITY;
  max = Number.NEGATIVE_INFINITY;
  mean = 0;
  m2 = 0;
  m3 = 0;
  m4 = 0;
  sum = 0;
  l1 = 0;
  l2sq = 0;
  nan = 0;
  posInf = 0;
  negInf = 0;
  zeros = 0;
  negatives = 0;
  positives = 0;
  total = 0;
  integral = true;

  push(x: number): void {
    this.total += 1;

    if (Number.isNaN(x)) {
      this.nan += 1;
      return;
    }
    if (x === Number.POSITIVE_INFINITY) {
      this.posInf += 1;
      return;
    }
    if (x === Number.NEGATIVE_INFINITY) {
      this.negInf += 1;
      return;
    }

    if (x === 0) {
      this.zeros += 1;
    } else if (x < 0) {
      this.negatives += 1;
    } else {
      this.positives += 1;
    }
    if (this.integral && !Number.isInteger(x)) {
      this.integral = false;
    }

    if (x < this.min) {
      this.min = x;
    }
    if (x > this.max) {
      this.max = x;
    }

    this.sum += x;
    this.l1 += Math.abs(x);
    this.l2sq += x * x;

    const n1 = this.n;
    this.n += 1;
    const n = this.n;
    const delta = x - this.mean;
    const deltaN = delta / n;
    const deltaN2 = deltaN * deltaN;
    const term = delta * deltaN * n1;

    this.mean += deltaN;
    this.m4 +=
      term * deltaN2 * (n * n - 3 * n + 3) +
      6 * deltaN2 * this.m2 -
      4 * deltaN * this.m3;
    this.m3 += term * deltaN * (n - 2) - 3 * deltaN * this.m2;
    this.m2 += term;
  }

  get variance(): number {
    return this.n > 1 ? this.m2 / (this.n - 1) : 0;
  }

  get std(): number {
    return Math.sqrt(this.variance);
  }

  get skewness(): number {
    if (this.n < 3 || this.m2 === 0) {
      return 0;
    }
    return (Math.sqrt(this.n) * this.m3) / this.m2 ** 1.5;
  }

  /** Excess kurtosis: 0 for a normal distribution. */
  get kurtosis(): number {
    if (this.n < 4 || this.m2 === 0) {
      return 0;
    }
    return (this.n * this.m4) / (this.m2 * this.m2) - 3;
  }
}

/**
 * Uniform sample maintained in one pass via Algorithm L.
 *
 * Unlike taking every k-th element this is unbiased and immune to aliasing
 * against periodic data such as image rows, and the skip-ahead formulation
 * touches only the elements it actually keeps.
 */
class Reservoir {
  readonly values: Float64Array;
  private filled = 0;
  private w = 1;
  private nextIndex = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
    this.values = new Float64Array(this.capacity);
  }

  get size(): number {
    return this.filled;
  }

  /** True when this element index should be sampled. */
  wants(index: number): boolean {
    return this.filled < this.capacity || index === this.nextIndex;
  }

  offer(index: number, value: number): void {
    if (this.filled < this.capacity) {
      this.values[this.filled] = value;
      this.filled += 1;
      if (this.filled === this.capacity) {
        this.w = Math.exp(Math.log(Math.random()) / this.capacity);
        this.nextIndex = index + this.skip();
      }
      return;
    }
    if (index !== this.nextIndex) {
      return;
    }
    this.values[Math.floor(Math.random() * this.capacity)] = value;
    this.w *= Math.exp(Math.log(Math.random()) / this.capacity);
    this.nextIndex = index + this.skip();
  }

  private skip(): number {
    return Math.floor(Math.log(Math.random()) / Math.log(1 - this.w)) + 1;
  }

  toSorted(): Float64Array {
    return this.values.subarray(0, this.filled).slice().sort();
  }
}

/** Tallies distinct values until the cardinality is clearly too high to matter. */
class UniqueTracker {
  private readonly counts = new Map<number, number>();
  overflowed = false;

  add(value: number): void {
    if (this.overflowed) {
      return;
    }
    const current = this.counts.get(value);
    if (current !== undefined) {
      this.counts.set(value, current + 1);
      return;
    }
    if (this.counts.size >= MAX_TRACKED_UNIQUE) {
      this.overflowed = true;
      this.counts.clear();
      return;
    }
    this.counts.set(value, 1);
  }

  get size(): number {
    return this.counts.size;
  }

  top(limit: number): ValueCount[] {
    return [...this.counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, limit)
      .map(([value, count]) => ({ value, count, label: trimNumber(value) }));
  }
}

/**
 * Computes full descriptive statistics for an array in one sequential pass.
 *
 * Counts, extrema and moments are always exact over every element. Quantiles,
 * the histogram and cardinality come from a retained sample; when the array
 * fits inside `exactLimit` that sample is the whole array, so those are exact
 * too — `approximate` records which case applied.
 */
export async function computeStats(
  source: ByteSource,
  meta: ArrayMeta,
  dtype: ParsedDtype,
  dataOffset: number,
  options: StatsOptions,
): Promise<StatsBundle> {
  const started = Date.now();

  if (!dtype.numeric || !dtype.readable) {
    return {
      overall: null,
      channels: null,
      columns: null,
      insights: [],
      elapsedMs: Date.now() - started,
      unsupported: `Descriptive statistics do not apply to ${meta.dtype} data.`,
    };
  }
  if (meta.size === 0) {
    return {
      overall: null,
      channels: null,
      columns: null,
      insights: [],
      elapsedMs: Date.now() - started,
      unsupported: "The array is empty.",
    };
  }

  const read = makeScalarReader(dtype);
  const itemsize = dtype.itemsize;
  const strides = computeStrides(meta.shape, meta.fortranOrder);

  const overall = new Accumulator();
  const reservoir = new Reservoir(
    Math.min(meta.size, Math.max(options.exactLimit, 1000)),
  );
  const unique = new UniqueTracker();

  const channelGroups = makeGroups(meta, strides, options.channelAxis ?? null);
  const columnGroups = makeGroups(meta, strides, options.columnAxis ?? null);

  let index = 0;
  let lastProgress = 0;

  for await (const { buffer } of source.scan(
    dataOffset,
    meta.dataBytes,
    itemsize,
  )) {
    const view = new DataView(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength,
    );
    const count = Math.floor(buffer.byteLength / itemsize);

    for (let i = 0; i < count; i += 1) {
      const value = read(view, i * itemsize);
      overall.push(value);

      if (reservoir.wants(index)) {
        reservoir.offer(index, value);
      }
      // Cardinality describes the real values; NaN and infinities are
      // reported separately and must not inflate the distinct count.
      if (Number.isFinite(value)) {
        unique.add(value);
      }

      if (channelGroups) {
        channelGroups.accumulators[
          Math.floor(index / channelGroups.stride) % channelGroups.extent
        ].push(value);
      }
      if (columnGroups) {
        columnGroups.accumulators[
          Math.floor(index / columnGroups.stride) % columnGroups.extent
        ].push(value);
      }

      index += 1;
    }

    if (options.onProgress) {
      const fraction = index / meta.size;
      if (fraction - lastProgress > 0.02) {
        lastProgress = fraction;
        options.onProgress(fraction);
      }
    }
  }

  const sorted = reservoir.toSorted();
  const approximate = reservoir.size < overall.total;
  const stats = finalise(
    overall,
    sorted,
    unique,
    approximate,
    options.histogramBins,
  );

  return {
    overall: stats,
    channels: channelGroups ? summariseGroups(channelGroups, "Channel") : null,
    columns: columnGroups ? summariseGroups(columnGroups, "Column") : null,
    insights: [],
    elapsedMs: Date.now() - started,
  };
}

interface Groups {
  accumulators: Accumulator[];
  stride: number;
  extent: number;
}

function makeGroups(
  meta: ArrayMeta,
  strides: number[],
  axis: number | null,
): Groups | null {
  if (axis === null || axis < 0 || axis >= meta.ndim) {
    return null;
  }
  const extent = meta.shape[axis];
  if (extent <= 1 || extent > MAX_GROUPS) {
    return null;
  }
  return {
    accumulators: Array.from({ length: extent }, () => new Accumulator()),
    stride: strides[axis],
    extent,
  };
}

function summariseGroups(groups: Groups, label: string): AxisStats[] {
  return groups.accumulators.map((acc, index) => ({
    label: `${label} ${index}`,
    index,
    count: acc.n,
    min: acc.n ? acc.min : Number.NaN,
    max: acc.n ? acc.max : Number.NaN,
    mean: acc.n ? acc.mean : Number.NaN,
    std: acc.std,
    nan: acc.nan,
    zeros: acc.zeros,
  }));
}

function finalise(
  acc: Accumulator,
  sorted: Float64Array,
  unique: UniqueTracker,
  approximate: boolean,
  bins: number,
): NumericStats {
  const finite = sorted.length
    ? sorted.filter((v) => Number.isFinite(v))
    : sorted;
  const percentileKeys = [0.1, 1, 5, 10, 25, 50, 75, 90, 95, 99, 99.9];
  const percentiles: Record<string, number> = {};
  for (const p of percentileKeys) {
    percentiles[String(p)] = quantile(finite, p / 100);
  }

  const q1 = percentiles["25"];
  const q3 = percentiles["75"];
  const median = percentiles["50"];
  const iqr = q3 - q1;
  const lowerFence = q1 - 1.5 * iqr;
  const upperFence = q3 + 1.5 * iqr;

  let outliers = 0;
  for (const v of finite) {
    if (v < lowerFence || v > upperFence) {
      outliers += 1;
    }
  }
  // Scale the sampled outlier count back up to the full array.
  const scale = finite.length ? acc.n / finite.length : 1;

  const deviations = new Float64Array(finite.length);
  for (let i = 0; i < finite.length; i += 1) {
    deviations[i] = Math.abs(finite[i] - median);
  }
  deviations.sort();

  const hasSpread =
    acc.n > 0 && Number.isFinite(acc.min) && Number.isFinite(acc.max);

  return {
    approximate,
    sampleSize: sorted.length,
    total: acc.total,
    finite: acc.n,
    nan: acc.nan,
    posInf: acc.posInf,
    negInf: acc.negInf,
    zeros: acc.zeros,
    negatives: acc.negatives,
    positives: acc.positives,

    min: hasSpread ? acc.min : Number.NaN,
    max: hasSpread ? acc.max : Number.NaN,
    range: hasSpread ? acc.max - acc.min : Number.NaN,
    sum: acc.sum,
    mean: acc.n ? acc.mean : Number.NaN,
    variance: acc.variance,
    std: acc.std,
    sem: acc.n > 1 ? acc.std / Math.sqrt(acc.n) : 0,
    skewness: acc.skewness,
    kurtosis: acc.kurtosis,
    // The coefficient of variation only means anything on ratio-scale data;
    // for anything centred on or spanning zero it explodes without saying
    // anything, so it is reported as unavailable instead.
    cv:
      acc.n > 0 && hasSpread && acc.min >= 0 && acc.mean > 1e-12
        ? acc.std / acc.mean
        : null,

    median,
    percentiles,
    iqr,
    madMedian: quantile(deviations, 0.5),

    l1: acc.l1,
    l2: Math.sqrt(acc.l2sq),
    sparsity: acc.total ? acc.zeros / acc.total : 0,

    lowerFence,
    upperFence,
    outliers: Math.round(outliers * scale),

    uniqueCount: unique.overflowed ? null : unique.size,
    uniqueExact: !unique.overflowed,
    topValues: unique.overflowed ? null : unique.top(12),

    histogram: buildHistogram(finite, acc, bins),

    integral: acc.integral,
    unitRange: hasSpread && acc.min >= 0 && acc.max <= 1 && !acc.integral,
  };
}

function quantile(sorted: Float64Array | number[], p: number): number {
  const n = sorted.length;
  if (n === 0) {
    return Number.NaN;
  }
  if (n === 1) {
    return sorted[0];
  }
  // Linear interpolation between order statistics — NumPy's default method.
  const pos = (n - 1) * Math.min(Math.max(p, 0), 1);
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) {
    return sorted[lower];
  }
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (pos - lower);
}

function buildHistogram(
  finite: Float64Array,
  acc: Accumulator,
  bins: number,
): Histogram | null {
  if (
    finite.length === 0 ||
    !Number.isFinite(acc.min) ||
    !Number.isFinite(acc.max)
  ) {
    return null;
  }

  let lo = acc.min;
  let hi = acc.max;
  if (lo === hi) {
    lo -= 0.5;
    hi += 0.5;
  }

  // Integer data with few distinct values reads far better with one bin each.
  let binCount = bins;
  const span = acc.max - acc.min;
  if (acc.integral && span > 0 && span + 1 <= bins) {
    binCount = span + 1;
    lo = acc.min - 0.5;
    hi = acc.max + 0.5;
  }

  const counts = new Array<number>(binCount).fill(0);
  const width = (hi - lo) / binCount;
  for (const v of finite) {
    let bin = Math.floor((v - lo) / width);
    if (bin < 0) {
      bin = 0;
    } else if (bin >= binCount) {
      bin = binCount - 1;
    }
    counts[bin] += 1;
  }

  // Rescale sampled counts so the histogram reads in units of real elements.
  const scale = acc.n / finite.length;
  if (scale > 1.0001) {
    for (let i = 0; i < counts.length; i += 1) {
      counts[i] = Math.round(counts[i] * scale);
    }
  }

  const binEdges = new Array<number>(binCount + 1);
  for (let i = 0; i <= binCount; i += 1) {
    binEdges[i] = lo + width * i;
  }

  return {
    binEdges,
    counts,
    excludedNonFinite: acc.nan + acc.posInf + acc.negInf,
  };
}
