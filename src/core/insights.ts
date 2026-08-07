import type {
  Insight,
  ArrayMeta,
  Detection,
  StatsBundle,
} from "../common/types";
import { trimNumber } from "./dtype";

const pct = (part: number, whole: number): string =>
  whole > 0
    ? `${((part / whole) * 100).toFixed(part / whole < 0.001 ? 3 : 2)}%`
    : "0%";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Turns the numbers into the observations an analyst would actually make first:
 * missing values, degenerate ranges, skew, imbalance, and whether the data has
 * already been normalised.
 */
export function buildInsights(
  meta: ArrayMeta,
  detection: Detection,
  bundle: StatsBundle,
  extra: { truncated: boolean } = { truncated: false },
): Insight[] {
  const out: Insight[] = [];
  const s = bundle.overall;

  if (extra.truncated) {
    out.push({
      level: "warn",
      title: "File is truncated",
      detail:
        `The header declares ${formatBytes(meta.size * meta.itemsize)} of data but the file ` +
        `holds only ${formatBytes(meta.dataBytes)}. Values past the cut are shown as NaN.`,
    });
  }

  if (!s) {
    if (bundle.unsupported) {
      out.push({
        level: "info",
        title: "No numeric statistics",
        detail: bundle.unsupported,
      });
    }
    return out;
  }

  const missing = s.nan + s.posInf + s.negInf;
  if (s.nan > 0) {
    out.push({
      level: "warn",
      title: `${s.nan.toLocaleString()} NaN value${s.nan === 1 ? "" : "s"}`,
      detail:
        `${pct(s.nan, s.total)} of the array is NaN. These are excluded from every ` +
        "statistic below and drawn as gaps in the visuals.",
    });
  }
  if (s.posInf + s.negInf > 0) {
    out.push({
      level: "warn",
      title: `${(s.posInf + s.negInf).toLocaleString()} infinite values`,
      detail: `${s.posInf.toLocaleString()} +inf and ${s.negInf.toLocaleString()} -inf, ${pct(s.posInf + s.negInf, s.total)} of the array.`,
    });
  }

  if (s.finite === 0) {
    out.push({
      level: "warn",
      title: "No finite values",
      detail:
        "Every element is NaN or infinite, so there is nothing to summarise.",
    });
    return out;
  }

  if (s.min === s.max) {
    out.push({
      level: "warn",
      title: "Constant array",
      detail: `Every finite element equals ${trimNumber(s.min)}. There is no variation to visualise.`,
    });
  }

  if (s.sparsity > 0.5) {
    out.push({
      level: "info",
      title: `${(s.sparsity * 100).toFixed(1)}% zeros`,
      detail:
        `${s.zeros.toLocaleString()} of ${s.total.toLocaleString()} elements are exactly zero — ` +
        "this array is sparse, and dense statistics may be dominated by the zeros.",
    });
  }

  // Recognising the two common preprocessing conventions saves a lot of squinting.
  if (Math.abs(s.mean) < 0.15 && Math.abs(s.std - 1) < 0.2 && !s.integral) {
    out.push({
      level: "good",
      title: "Looks standardised",
      detail: `Mean ${trimNumber(s.mean)} and standard deviation ${trimNumber(s.std)} are close to 0 and 1, the signature of z-score normalisation.`,
    });
  } else if (s.unitRange) {
    out.push({
      level: "good",
      title: "Normalised to [0, 1]",
      detail: `All values fall in [${trimNumber(s.min)}, ${trimNumber(s.max)}], the usual range for scaled features or float imagery.`,
    });
  } else if (
    detection.isImageLike &&
    meta.kind === "uint" &&
    meta.itemsize === 1
  ) {
    out.push({
      level: "good",
      title: "Standard 8-bit image data",
      detail:
        "uint8 values in [0, 255] render directly, with no scaling applied.",
    });
  }

  if (
    s.integral &&
    s.uniqueCount !== null &&
    s.uniqueCount <= 2 &&
    s.min >= 0 &&
    s.max <= 1
  ) {
    out.push({
      level: "info",
      title: "Binary data",
      detail: `Only ${s.uniqueCount} distinct value${s.uniqueCount === 1 ? "" : "s"} — this reads as a mask or one-hot encoding.`,
    });
  } else if (
    s.integral &&
    s.uniqueCount !== null &&
    s.uniqueCount <= 64 &&
    s.total > s.uniqueCount * 4
  ) {
    const top = s.topValues?.[0];
    const share = top ? top.count / Math.min(s.sampleSize, s.total) : 0;
    out.push({
      level: share > 0.6 ? "warn" : "info",
      title: `Categorical — ${s.uniqueCount} distinct values`,
      detail: top
        ? `Most common is ${top.label}, covering ${(share * 100).toFixed(1)}% of the data.` +
          (share > 0.6 ? " The distribution is heavily imbalanced." : "")
        : "Low cardinality integer data.",
    });
  }

  if (Math.abs(s.skewness) > 1) {
    out.push({
      level: "info",
      title: `${s.skewness > 0 ? "Right" : "Left"}-skewed distribution`,
      detail:
        `Skewness ${trimNumber(s.skewness)} — the ${s.skewness > 0 ? "upper" : "lower"} tail is long. ` +
        `The mean (${trimNumber(s.mean)}) sits ${s.mean > s.median ? "above" : "below"} the median (${trimNumber(s.median)}).`,
    });
  }

  if (s.kurtosis > 3) {
    out.push({
      level: "info",
      title: "Heavy tails",
      detail: `Excess kurtosis ${trimNumber(s.kurtosis)} — far more extreme values than a normal distribution would produce.`,
    });
  }

  if (s.outliers > 0 && s.outliers / s.total > 0.01) {
    out.push({
      level: "info",
      title: `${s.outliers.toLocaleString()} outliers`,
      detail:
        `${pct(s.outliers, s.total)} of values fall outside the Tukey fences ` +
        `[${trimNumber(s.lowerFence)}, ${trimNumber(s.upperFence)}].`,
    });
  }

  // A wide positive dynamic range is exactly when a linear colour ramp fails.
  if (s.min > 0 && s.max / s.min > 1000) {
    out.push({
      level: "info",
      title: "Wide dynamic range",
      detail: `Values span ${trimNumber(s.min)} to ${trimNumber(s.max)}, a factor of ${trimNumber(s.max / s.min)}. A logarithmic colour scale will show far more detail.`,
    });
  }

  if (bundle.channels && bundle.channels.length > 1) {
    const means = bundle.channels
      .map((c) => c.mean)
      .filter((m) => Number.isFinite(m));
    if (means.length > 1) {
      const spread = Math.max(...means) - Math.min(...means);
      if (spread > Math.abs(s.mean) * 0.25 && spread > 0) {
        out.push({
          level: "info",
          title: "Channels differ noticeably",
          detail:
            `Per-channel means range from ${trimNumber(Math.min(...means))} to ` +
            `${trimNumber(Math.max(...means))}. See the channel breakdown for the full picture.`,
        });
      }
    }
  }

  if (meta.fortranOrder) {
    out.push({
      level: "info",
      title: "Fortran (column-major) order",
      detail:
        "The array was saved column-major. Indexing is handled transparently here.",
    });
  }

  if (s.approximate) {
    out.push({
      level: "info",
      title: "Quantiles are estimated",
      detail:
        `Counts, extrema, mean and standard deviation are exact over all ${s.total.toLocaleString()} ` +
        `elements. The median, percentiles and histogram come from a uniform random sample of ` +
        `${s.sampleSize.toLocaleString()} values — raise "Exact percentile limit" in settings to widen it.`,
    });
  }

  if (missing === 0 && s.min !== s.max) {
    out.push({
      level: "good",
      title: "No missing values",
      detail: `All ${s.total.toLocaleString()} elements are finite.`,
    });
  }

  return out;
}
