import type { Histogram, NumericStats, ValueCount } from "../common/types";
import { el, sizeCanvas, themeColor } from "./dom";
import { fmt, fmtCount, fmtPercent, fmtTick } from "./format";

interface Palette {
  series: string;
  seriesSoft: string;
  accent: string;
  grid: string;
  axis: string;
  label: string;
  muted: string;
  surface: string;
}

/**
 * VS Code owns the theme, so the chart palette is read from its tokens rather
 * than hard-coded. That keeps every chart correct in light, dark and
 * high-contrast themes without a per-mode palette of our own.
 */
function palette(): Palette {
  return {
    series: themeColor("--vscode-charts-blue", "#4f8fd4"),
    seriesSoft: themeColor("--vscode-charts-blue", "#4f8fd4"),
    accent: themeColor("--vscode-charts-orange", "#d98a3c"),
    grid: themeColor("--vscode-editorWidget-border", "rgba(128,128,128,0.25)"),
    axis: themeColor("--vscode-editorWidget-border", "rgba(128,128,128,0.4)"),
    label: themeColor("--vscode-descriptionForeground", "#8c8c8c"),
    muted: themeColor("--vscode-descriptionForeground", "#8c8c8c"),
    surface: themeColor("--vscode-editor-background", "#1e1e1e"),
  };
}

interface Frame {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  plotWidth: number;
  plotHeight: number;
  colors: Palette;
}

const MARGIN = { left: 58, top: 14, right: 16, bottom: 30 };

/**
 * Wires a canvas into `host`, redrawing whenever the element resizes, and
 * returns the tooltip element the caller positions on hover.
 */
function mount(
  host: HTMLElement,
  height: number,
  draw: (frame: Frame) => void,
): { canvas: HTMLCanvasElement; tooltip: HTMLElement; redraw: () => void } {
  const canvas = el("canvas", { class: "chart-canvas" });
  const tooltip = el("div", { class: "chart-tooltip", role: "status" });
  const wrapper = el("div", { class: "chart-wrapper" }, [canvas, tooltip]);
  host.append(wrapper);

  const redraw = (): void => {
    const width = Math.max(240, wrapper.clientWidth || host.clientWidth || 480);
    const ctx = sizeCanvas(canvas, width, height);
    ctx.clearRect(0, 0, width, height);
    draw({
      ctx,
      width,
      height,
      left: MARGIN.left,
      top: MARGIN.top,
      right: width - MARGIN.right,
      bottom: height - MARGIN.bottom,
      plotWidth: width - MARGIN.left - MARGIN.right,
      plotHeight: height - MARGIN.top - MARGIN.bottom,
      colors: palette(),
    });
  };

  redraw();
  new ResizeObserver(() => redraw()).observe(wrapper);
  return { canvas, tooltip, redraw };
}

function showTooltip(
  tooltip: HTMLElement,
  x: number,
  y: number,
  html: string,
): void {
  tooltip.innerHTML = html;
  tooltip.classList.add("visible");
  const parent = tooltip.parentElement;
  const maxLeft = (parent?.clientWidth ?? 0) - tooltip.offsetWidth - 8;
  tooltip.style.left = `${Math.max(4, Math.min(x + 12, maxLeft))}px`;
  tooltip.style.top = `${Math.max(4, y - tooltip.offsetHeight - 10)}px`;
}

function hideTooltip(tooltip: HTMLElement): void {
  tooltip.classList.remove("visible");
}

/** Recessive horizontal grid plus y-axis tick labels. */
function drawAxes(frame: Frame, yMax: number, ticks = 4): void {
  const { ctx, colors, left, right, top, bottom } = frame;

  ctx.strokeStyle = colors.grid;
  ctx.fillStyle = colors.label;
  ctx.lineWidth = 1;
  ctx.font = "10px var(--vscode-font-family, sans-serif)";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (let i = 0; i <= ticks; i += 1) {
    const value = (yMax / ticks) * i;
    const y = Math.round(bottom - (frame.plotHeight / ticks) * i) + 0.5;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.fillText(fmtTick(value), left - 8, y);
  }

  ctx.strokeStyle = colors.axis;
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left, bottom);
  ctx.stroke();
}

/** A bar with rounded top corners, anchored flat to the baseline. */
function barPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, Math.max(0, height));
  ctx.beginPath();
  ctx.moveTo(x, y + height);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Histogram
// ---------------------------------------------------------------------------

export function drawHistogram(
  host: HTMLElement,
  histogram: Histogram,
  total: number,
): void {
  const counts = histogram.counts;
  const edges = histogram.binEdges;
  const yMax = Math.max(...counts, 1);
  let hovered = -1;

  const { canvas, tooltip, redraw } = mount(host, 220, (frame) => {
    const { ctx, colors, left, bottom, plotWidth, plotHeight } = frame;
    drawAxes(frame, yMax);

    const slot = plotWidth / counts.length;
    // A 2px surface gap keeps adjacent bars from reading as one mass.
    const barWidth = Math.max(1, slot - 2);

    for (let i = 0; i < counts.length; i += 1) {
      const height = (counts[i] / yMax) * plotHeight;
      const x = left + i * slot + 1;
      const y = bottom - height;
      ctx.fillStyle = i === hovered ? colors.accent : colors.series;
      barPath(ctx, x, y, barWidth, height, 4);
      ctx.fill();
    }

    ctx.fillStyle = colors.label;
    ctx.font = "10px var(--vscode-font-family, sans-serif)";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText(fmtTick(edges[0]), left, bottom + 8);
    ctx.textAlign = "right";
    ctx.fillText(fmtTick(edges[edges.length - 1]), frame.right, bottom + 8);
  });

  canvas.addEventListener("mousemove", (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const plotWidth = rect.width - MARGIN.left - MARGIN.right;
    const index = Math.floor(((x - MARGIN.left) / plotWidth) * counts.length);

    if (index < 0 || index >= counts.length) {
      hovered = -1;
      hideTooltip(tooltip);
      redraw();
      return;
    }

    hovered = index;
    redraw();
    showTooltip(
      tooltip,
      x,
      event.clientY - rect.top,
      `<strong>${fmtCount(counts[index])}</strong> values` +
        `<span class="tip-sub">[${fmtTick(edges[index])}, ${fmtTick(edges[index + 1])})</span>` +
        `<span class="tip-sub">${fmtPercent(counts[index], total)} of finite values</span>`,
    );
  });

  canvas.addEventListener("mouseleave", () => {
    hovered = -1;
    hideTooltip(tooltip);
    redraw();
  });
}

// ---------------------------------------------------------------------------
// Line chart
// ---------------------------------------------------------------------------

export interface LineOptions {
  /** Index of the first value, for tooltip labels. */
  startIndex?: number;
  /** Spacing between consecutive samples in source index units. */
  step?: number;
  height?: number;
}

/**
 * Plots a 1-D series.
 *
 * When there are more samples than pixels the series is drawn as a per-column
 * min/max envelope, so spikes survive downsampling instead of being skipped.
 */
export function drawLine(
  host: HTMLElement,
  values: Float32Array | Uint8Array,
  options: LineOptions = {},
): void {
  const startIndex = options.startIndex ?? 0;
  const step = options.step ?? 1;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!Number.isFinite(value)) {
      continue;
    }
    if (value < min) {
      min = value;
    }
    if (value > max) {
      max = value;
    }
  }
  if (!Number.isFinite(min)) {
    min = 0;
    max = 1;
  }
  if (min === max) {
    min -= 0.5;
    max += 0.5;
  }

  let cursor = -1;

  const { canvas, tooltip, redraw } = mount(
    host,
    options.height ?? 240,
    (frame) => {
      const { ctx, colors, left, top, bottom, plotWidth, plotHeight } = frame;

      // Y axis is drawn against the value range, so labels come from min/max.
      ctx.strokeStyle = colors.grid;
      ctx.fillStyle = colors.label;
      ctx.lineWidth = 1;
      ctx.font = "10px var(--vscode-font-family, sans-serif)";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (let i = 0; i <= 4; i += 1) {
        const value = min + ((max - min) / 4) * i;
        const y = Math.round(bottom - (plotHeight / 4) * i) + 0.5;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(frame.right, y);
        ctx.stroke();
        ctx.fillText(fmtTick(value), left - 8, y);
      }
      ctx.strokeStyle = colors.axis;
      ctx.beginPath();
      ctx.moveTo(left, top);
      ctx.lineTo(left, bottom);
      ctx.stroke();

      const toY = (value: number): number =>
        bottom - ((value - min) / (max - min)) * plotHeight;
      const columns = Math.max(
        1,
        Math.min(Math.round(plotWidth), values.length),
      );
      const perColumn = values.length / columns;

      ctx.strokeStyle = colors.series;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();

      let started = false;
      for (let c = 0; c < columns; c += 1) {
        const from = Math.floor(c * perColumn);
        const to = Math.max(from + 1, Math.floor((c + 1) * perColumn));
        let lo = Number.POSITIVE_INFINITY;
        let hi = Number.NEGATIVE_INFINITY;
        for (let i = from; i < to && i < values.length; i += 1) {
          const value = values[i];
          if (!Number.isFinite(value)) {
            continue;
          }
          if (value < lo) {
            lo = value;
          }
          if (value > hi) {
            hi = value;
          }
        }
        if (!Number.isFinite(lo)) {
          started = false;
          continue;
        }
        const x = left + (c / Math.max(1, columns - 1)) * plotWidth;
        if (!started) {
          ctx.moveTo(x, toY(hi));
          started = true;
        }
        ctx.lineTo(x, toY(hi));
        if (lo !== hi) {
          ctx.lineTo(x, toY(lo));
        }
      }
      ctx.stroke();

      if (cursor >= 0 && cursor < values.length) {
        const x = left + (cursor / Math.max(1, values.length - 1)) * plotWidth;
        ctx.strokeStyle = colors.accent;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.stroke();
        ctx.setLineDash([]);

        const value = values[cursor];
        if (Number.isFinite(value)) {
          ctx.fillStyle = colors.accent;
          ctx.beginPath();
          ctx.arc(x, toY(value), 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = colors.surface;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    },
  );

  canvas.addEventListener("mousemove", (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const plotWidth = rect.width - MARGIN.left - MARGIN.right;
    const ratio = (x - MARGIN.left) / plotWidth;

    if (ratio < 0 || ratio > 1) {
      cursor = -1;
      hideTooltip(tooltip);
      redraw();
      return;
    }

    cursor = Math.round(ratio * (values.length - 1));
    redraw();
    showTooltip(
      tooltip,
      x,
      event.clientY - rect.top,
      `<strong>${fmt(values[cursor])}</strong>` +
        `<span class="tip-sub">index ${(startIndex + cursor * step).toLocaleString()}</span>`,
    );
  });

  canvas.addEventListener("mouseleave", () => {
    cursor = -1;
    hideTooltip(tooltip);
    redraw();
  });
}

// ---------------------------------------------------------------------------
// Box plot
// ---------------------------------------------------------------------------

/** Five-number summary with Tukey whiskers — the fastest read on spread. */
export function drawBoxPlot(host: HTMLElement, stats: NumericStats): void {
  const q1 = stats.percentiles["25"];
  const q3 = stats.percentiles["75"];
  const lo = Math.max(stats.min, stats.lowerFence);
  const hi = Math.min(stats.max, stats.upperFence);
  const domainMin = Math.min(stats.min, lo);
  const domainMax = Math.max(stats.max, hi);
  const span = domainMax - domainMin || 1;

  const marks: Array<[string, number]> = [
    ["Minimum", stats.min],
    ["Lower fence", lo],
    ["Q1 (25%)", q1],
    ["Median", stats.median],
    ["Q3 (75%)", q3],
    ["Upper fence", hi],
    ["Maximum", stats.max],
  ];

  const { canvas, tooltip, redraw } = mount(host, 120, (frame) => {
    const { ctx, colors, left, plotWidth } = frame;
    const toX = (value: number): number =>
      left + ((value - domainMin) / span) * plotWidth;
    const centre = frame.top + frame.plotHeight / 2;
    const boxHeight = 34;

    // Whiskers.
    ctx.strokeStyle = colors.muted;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(toX(lo), centre);
    ctx.lineTo(toX(q1), centre);
    ctx.moveTo(toX(q3), centre);
    ctx.lineTo(toX(hi), centre);
    ctx.stroke();

    for (const value of [lo, hi]) {
      ctx.beginPath();
      ctx.moveTo(toX(value), centre - 10);
      ctx.lineTo(toX(value), centre + 10);
      ctx.stroke();
    }

    // Interquartile box.
    const boxLeft = toX(q1);
    const boxWidth = Math.max(2, toX(q3) - boxLeft);
    ctx.fillStyle = colors.series;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(boxLeft, centre - boxHeight / 2, boxWidth, boxHeight);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = colors.series;
    ctx.strokeRect(boxLeft, centre - boxHeight / 2, boxWidth, boxHeight);

    // Median.
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(toX(stats.median), centre - boxHeight / 2);
    ctx.lineTo(toX(stats.median), centre + boxHeight / 2);
    ctx.stroke();

    // Values outside the fences, drawn as ticks rather than a cloud of dots.
    if (stats.min < lo || stats.max > hi) {
      ctx.strokeStyle = colors.muted;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.7;
      for (const value of [stats.min, stats.max]) {
        if (value < lo || value > hi) {
          ctx.beginPath();
          ctx.moveTo(toX(value), centre - 6);
          ctx.lineTo(toX(value), centre + 6);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = colors.label;
    ctx.font = "10px var(--vscode-font-family, sans-serif)";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText(fmtTick(domainMin), left, frame.bottom + 6);
    ctx.textAlign = "right";
    ctx.fillText(fmtTick(domainMax), frame.right, frame.bottom + 6);
  });

  canvas.addEventListener("mousemove", (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const plotWidth = rect.width - MARGIN.left - MARGIN.right;
    const value = domainMin + ((x - MARGIN.left) / plotWidth) * span;

    let closest = marks[0];
    let best = Number.POSITIVE_INFINITY;
    for (const mark of marks) {
      const distance = Math.abs(mark[1] - value);
      if (distance < best) {
        best = distance;
        closest = mark;
      }
    }

    showTooltip(
      tooltip,
      x,
      event.clientY - rect.top,
      `<strong>${fmt(closest[1])}</strong><span class="tip-sub">${closest[0]}</span>`,
    );
  });

  canvas.addEventListener("mouseleave", () => hideTooltip(tooltip));
  redraw();
}

// ---------------------------------------------------------------------------
// Value frequency bars
// ---------------------------------------------------------------------------

/** Horizontal bars for the most frequent values in low-cardinality data. */
export function drawValueCounts(
  host: HTMLElement,
  values: ValueCount[],
  total: number,
): void {
  const max = Math.max(...values.map((v) => v.count), 1);
  const list = el("div", { class: "freq-list" });

  for (const entry of values) {
    const share = entry.count / max;
    const bar = el("div", { class: "freq-bar" });
    bar.style.width = `${Math.max(2, share * 100)}%`;

    list.append(
      el(
        "div",
        {
          class: "freq-row",
          title: `${entry.label}: ${fmtCount(entry.count)}`,
        },
        [
          el("span", { class: "freq-label", text: entry.label }),
          el("div", { class: "freq-track" }, [bar]),
          el("span", { class: "freq-count", text: fmtCount(entry.count) }),
          el("span", {
            class: "freq-share",
            text: fmtPercent(entry.count, total),
          }),
        ],
      ),
    );
  }

  host.append(list);
}
