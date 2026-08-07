import { clear, el } from "../dom";
import type { ViewContext } from "../context";
import { drawBoxPlot, drawHistogram, drawValueCounts } from "../charts";
import type { AxisStats, Insight, NumericStats } from "../../common/types";
import { fmt, fmtBytes, fmtCount, fmtDuration, fmtPercent } from "../format";

/** Descriptive statistics and the observations that follow from them. */
export class StatsView {
  constructor(private readonly ctx: ViewContext) {}

  render(host: HTMLElement): void {
    clear(host);
    const { stats, meta, backend } = this.ctx.init;

    host.append(this.insights(stats.insights));

    if (!stats.overall) {
      host.append(
        el("div", { class: "empty" }, [
          el("p", {
            text: stats.unsupported ?? "No numeric statistics are available.",
          }),
        ]),
      );
      return;
    }

    const s = stats.overall;

    host.append(
      this.tiles(s),
      this.distribution(s),
      this.section("Position and spread", [this.percentileTable(s)]),
      this.section("Value composition", [this.compositionTable(s, meta.size)]),
      this.section("Shape of the distribution", [this.momentTable(s)]),
    );

    if (hasMeaningfulFrequencies(s)) {
      const body = el("div");
      drawValueCounts(body, s.topValues ?? [], Math.min(s.sampleSize, s.total));
      host.append(
        this.section(
          `Most frequent values (of ${(s.uniqueCount ?? 0).toLocaleString()} distinct)`,
          [body],
        ),
      );
    }

    if (stats.channels && stats.channels.length > 0) {
      host.append(
        this.section("Per-channel breakdown", [this.axisTable(stats.channels)]),
      );
    }
    if (stats.columns && stats.columns.length > 0) {
      host.append(
        this.section(`Per-column breakdown (${stats.columns.length} columns)`, [
          this.axisTable(stats.columns),
        ]),
      );
    }

    host.append(
      el("p", {
        class: "footnote",
        text:
          `Computed by ${backend.label} in ${fmtDuration(stats.elapsedMs)}` +
          (s.approximate
            ? ` · quantiles from a ${s.sampleSize.toLocaleString()}-value sample`
            : " · exact over every element"),
      }),
    );
  }

  private insights(items: Insight[]): HTMLElement {
    if (items.length === 0) {
      return el("div");
    }
    return el(
      "div",
      { class: "insights" },
      items.map((item) =>
        el("div", { class: `insight insight-${item.level}` }, [
          el("span", {
            class: "insight-icon",
            "aria-hidden": "true",
            text: iconFor(item.level),
          }),
          el("div", { class: "insight-body" }, [
            el("strong", { class: "insight-title", text: item.title }),
            el("span", { class: "insight-detail", text: item.detail }),
          ]),
        ]),
      ),
    );
  }

  /** The six numbers worth reading before anything else. */
  private tiles(s: NumericStats): HTMLElement {
    const entries: Array<[string, string, string?]> = [
      ["Mean", fmt(s.mean), `± ${fmt(s.sem)} standard error`],
      [
        "Std. deviation",
        fmt(s.std),
        s.cv !== null ? `CV ${fmt(s.cv)}` : undefined,
      ],
      ["Median", fmt(s.median), `IQR ${fmt(s.iqr)}`],
      ["Minimum", fmt(s.min)],
      ["Maximum", fmt(s.max)],
      ["Finite values", fmtCount(s.finite), `of ${fmtCount(s.total)}`],
    ];

    return el(
      "div",
      { class: "tiles" },
      entries.map(([label, value, sub]) =>
        el("div", { class: "tile-stat" }, [
          el("span", { class: "tile-label", text: label }),
          el("span", { class: "tile-value", text: value }),
          sub ? el("span", { class: "tile-sub", text: sub }) : null,
        ]),
      ),
    );
  }

  private distribution(s: NumericStats): HTMLElement {
    const children: HTMLElement[] = [];

    if (s.histogram) {
      const body = el("div");
      drawHistogram(body, s.histogram, s.finite);
      children.push(
        el("div", { class: "panel" }, [
          el("h3", { class: "panel-title", text: "Distribution of values" }),
          body,
          s.histogram.excludedNonFinite > 0
            ? el("p", {
                class: "panel-note",
                text: `${fmtCount(s.histogram.excludedNonFinite)} non-finite values are excluded.`,
              })
            : null,
        ]) as HTMLElement,
      );
    }

    if (Number.isFinite(s.median)) {
      const body = el("div");
      drawBoxPlot(body, s);
      children.push(
        el("div", { class: "panel" }, [
          el("h3", { class: "panel-title", text: "Spread and outliers" }),
          body,
          el("p", {
            class: "panel-note",
            text: `${fmtCount(s.outliers)} values (${fmtPercent(s.outliers, s.total)}) lie outside the Tukey fences.`,
          }),
        ]) as HTMLElement,
      );
    }

    return el("div", { class: "panels" }, children);
  }

  private percentileTable(s: NumericStats): HTMLElement {
    const keys = [
      "0.1",
      "1",
      "5",
      "10",
      "25",
      "50",
      "75",
      "90",
      "95",
      "99",
      "99.9",
    ];
    const rows: Array<[string, string]> = keys
      .filter((key) => s.percentiles[key] !== undefined)
      .map((key) => [
        // Written as a percentage rather than an ordinal, which avoids the
        // "0.1th"/"99.9th" awkwardness for fractional percentiles.
        `${key}% percentile${key === "50" ? " (median)" : ""}`,
        fmt(s.percentiles[key]),
      ]);

    rows.push(
      ["Interquartile range", fmt(s.iqr)],
      ["Median absolute deviation", fmt(s.madMedian)],
      ["Range", fmt(s.range)],
      ["Lower Tukey fence", fmt(s.lowerFence)],
      ["Upper Tukey fence", fmt(s.upperFence)],
    );

    return keyValueTable(rows);
  }

  private compositionTable(s: NumericStats, size: number): HTMLElement {
    const rows: Array<[string, string]> = [
      ["Total elements", fmtCount(s.total)],
      ["Finite", `${fmtCount(s.finite)} (${fmtPercent(s.finite, s.total)})`],
      ["NaN", `${fmtCount(s.nan)} (${fmtPercent(s.nan, s.total)})`],
      ["+Infinity", fmtCount(s.posInf)],
      ["-Infinity", fmtCount(s.negInf)],
      ["Zeros", `${fmtCount(s.zeros)} (${fmtPercent(s.zeros, s.total)})`],
      [
        "Negative",
        `${fmtCount(s.negatives)} (${fmtPercent(s.negatives, s.total)})`,
      ],
      [
        "Positive",
        `${fmtCount(s.positives)} (${fmtPercent(s.positives, s.total)})`,
      ],
      [
        "Distinct values",
        s.uniqueCount === null
          ? `more than 8,192${s.approximate ? " (in sample)" : ""}`
          : `${fmtCount(s.uniqueCount)}${s.approximate ? " (in sample)" : ""}`,
      ],
      ["Sparsity", fmtPercent(s.zeros, s.total)],
      ["Sum", fmt(s.sum)],
      ["L1 norm", fmt(s.l1)],
      ["L2 norm", fmt(s.l2)],
      ["Memory", fmtBytes(size * this.ctx.init.meta.itemsize)],
    ];
    return keyValueTable(rows);
  }

  private momentTable(s: NumericStats): HTMLElement {
    return keyValueTable([
      ["Variance", fmt(s.variance)],
      ["Standard deviation", fmt(s.std)],
      ["Standard error of the mean", fmt(s.sem)],
      [
        "Skewness",
        `${fmt(s.skewness)} — ${Math.abs(s.skewness) < 0.5 ? "roughly symmetric" : s.skewness > 0 ? "right tail" : "left tail"}`,
      ],
      [
        "Excess kurtosis",
        `${fmt(s.kurtosis)} — ${s.kurtosis > 1 ? "heavier tails than normal" : s.kurtosis < -1 ? "lighter tails than normal" : "near-normal tails"}`,
      ],
      [
        "Coefficient of variation",
        s.cv === null
          ? "not meaningful — values are not strictly positive"
          : fmt(s.cv),
      ],
      ["All values integral", s.integral ? "yes" : "no"],
      ["Within [0, 1]", s.unitRange ? "yes" : "no"],
    ]);
  }

  private axisTable(rows: AxisStats[]): HTMLElement {
    const head = el("tr", {}, [
      el("th", { text: "" }),
      el("th", { text: "Count" }),
      el("th", { text: "Mean" }),
      el("th", { text: "Std" }),
      el("th", { text: "Min" }),
      el("th", { text: "Max" }),
      el("th", { text: "NaN" }),
      el("th", { text: "Zeros" }),
    ]);

    const body = el(
      "tbody",
      {},
      rows.map((row) =>
        el("tr", {}, [
          el("th", { class: "row-head", scope: "row", text: row.label }),
          el("td", { text: fmtCount(row.count) }),
          el("td", { text: fmt(row.mean) }),
          el("td", { text: fmt(row.std) }),
          el("td", { text: fmt(row.min) }),
          el("td", { text: fmt(row.max) }),
          el("td", { text: fmtCount(row.nan) }),
          el("td", { text: fmtCount(row.zeros) }),
        ]),
      ),
    );

    return el("div", { class: "table-scroll" }, [
      el("table", { class: "data-table" }, [el("thead", {}, [head]), body]),
    ]);
  }

  private section(title: string, children: HTMLElement[]): HTMLElement {
    return el("section", { class: "section" }, [
      el("h3", { class: "section-title", text: title }),
      ...children,
    ]);
  }
}

/**
 * Whether a frequency breakdown would tell the reader anything.
 *
 * On continuous data every value is distinct, so the chart degenerates into a
 * dozen identical bars each labelled "1" — the distinct count in the value
 * composition table already says everything there is to say. The breakdown only
 * earns its space once values genuinely repeat, which in practice means each
 * one occurring at least twice on average.
 */
function hasMeaningfulFrequencies(s: NumericStats): boolean {
  const top = s.topValues?.[0];
  if (!top || s.uniqueCount === null || s.uniqueCount < 2) {
    return false;
  }
  return top.count > 1 && s.uniqueCount * 2 <= s.finite;
}

function keyValueTable(rows: Array<[string, string]>): HTMLElement {
  return el("div", { class: "kv-grid" }, [
    ...rows.flatMap(([key, value]) => [
      el("span", { class: "kv-key", text: key }),
      el("span", { class: "kv-value", text: value }),
    ]),
  ]);
}

function iconFor(level: Insight["level"]): string {
  switch (level) {
    case "warn":
      return "!";
    case "good":
      return "✓";
    default:
      return "i";
  }
}
