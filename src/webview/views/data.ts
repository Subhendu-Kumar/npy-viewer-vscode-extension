import { fmtCount } from "../format";
import { sampleColor } from "../colormap";
import type { ViewContext } from "../context";
import { button, checkbox, clear, el } from "../dom";
import type { TableWindow } from "../../common/types";

const ROW_PAGE = 100;
const COL_PAGE = 40;

/**
 * Exact values, paged.
 *
 * The visual tabs work from a decimated preview; this one always reads the real
 * numbers straight from the file, so it is the place to check a specific
 * element rather than a trend.
 */
export class DataView {
  private frame = 0;
  private rowStart = 0;
  private colStart = 0;
  private shade = false;
  private window: TableWindow | null = null;
  private host: HTMLElement | null = null;
  private loading = false;

  constructor(private readonly ctx: ViewContext) {}

  render(host: HTMLElement): void {
    this.host = host;
    clear(host);

    const text = this.ctx.init.textPreview;
    if (text) {
      host.append(this.renderTextPreview());
      return;
    }

    const layout = this.ctx.layout(false);
    if (!layout) {
      host.append(
        el("div", { class: "empty" }, [
          el("p", { text: "No tabular view available." }),
        ]),
      );
      return;
    }

    host.append(this.toolbar(layout.frameCount, layout.height, layout.width));
    const body = el("div", { class: "table-host" });
    host.append(body);

    if (this.window) {
      body.append(this.table(this.window));
    } else {
      body.append(el("p", { class: "readout", text: "Loading values…" }));
      void this.fetch();
    }
  }

  private toolbar(frameCount: number, rows: number, cols: number): HTMLElement {
    const groups: HTMLElement[] = [];

    if (frameCount > 1) {
      const input = el("input", {
        class: "frame-input",
        type: "number",
        min: 0,
        max: frameCount - 1,
        value: this.frame,
      });
      input.addEventListener("change", () => {
        this.frame = clamp(
          Number.parseInt(input.value, 10) || 0,
          0,
          frameCount - 1,
        );
        this.rowStart = 0;
        void this.fetch();
      });
      groups.push(
        el("div", { class: "control" }, [
          el("span", { class: "control-label", text: "Frame" }),
          input,
          el("span", {
            class: "frame-total",
            text: `/ ${(frameCount - 1).toLocaleString()}`,
          }),
        ]),
      );
    }

    groups.push(
      this.pager("Rows", this.rowStart, ROW_PAGE, rows, (value) => {
        this.rowStart = value;
        void this.fetch();
      }),
    );

    if (cols > COL_PAGE) {
      groups.push(
        this.pager("Columns", this.colStart, COL_PAGE, cols, (value) => {
          this.colStart = value;
          void this.fetch();
        }),
      );
    }

    groups.push(
      el("div", { class: "control" }, [
        checkbox("Shade by value", this.shade, (value) => {
          this.shade = value;
          if (this.host) {
            this.render(this.host);
          }
        }),
      ]),
      button("Copy", () => this.copy()),
      button("Export CSV", () => this.exportCsv()),
    );

    return el("div", { class: "toolbar" }, groups);
  }

  private pager(
    label: string,
    start: number,
    page: number,
    total: number,
    onChange: (value: number) => void,
  ): HTMLElement {
    const end = Math.min(start + page, total);
    return el("div", { class: "control control-pager" }, [
      el("span", { class: "control-label", text: label }),
      button("◀", () => onChange(Math.max(0, start - page)), {
        title: `Previous ${label}`,
      }),
      el("span", {
        class: "pager-range",
        text: `${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}`,
      }),
      button("▶", () => onChange(start + page < total ? start + page : start), {
        title: `Next ${label}`,
      }),
    ]);
  }

  private async fetch(): Promise<void> {
    if (this.loading) {
      return;
    }
    this.loading = true;
    try {
      this.window = await this.ctx.requestTable(
        this.frame,
        this.rowStart,
        this.colStart,
        ROW_PAGE,
        COL_PAGE,
        false,
      );
    } finally {
      this.loading = false;
    }
    if (this.host) {
      this.render(this.host);
    }
  }

  private table(window: TableWindow): HTMLElement {
    const values = window.values
      .flat()
      .filter((value) => Number.isFinite(value));
    const min = values.length ? Math.min(...values) : 0;
    const max = values.length ? Math.max(...values) : 1;
    const span = max - min || 1;

    const head = el("tr", {}, [
      el("th", { class: "corner", text: "" }),
      ...Array.from({ length: window.colCount }, (_, c) =>
        el("th", { text: String(window.colStart + c) }),
      ),
    ]);

    const rows = window.cells.map((cells, r) =>
      el("tr", {}, [
        el("th", {
          class: "row-head",
          scope: "row",
          text: String(window.rowStart + r),
        }),
        ...cells.map((cell, c) => {
          const node = el("td", { class: "cell", text: cell });
          const value = window.values[r][c];
          if (this.shade && Number.isFinite(value)) {
            const t = (value - min) / span;
            node.style.background = sampleColor("viridis", t);
            // Keep the text readable against whichever end of the ramp it lands on.
            node.style.color = t > 0.55 ? "#101010" : "#f4f4f4";
          }
          return node;
        }),
      ]),
    );

    return el("div", {}, [
      el("div", { class: "table-scroll" }, [
        el("table", { class: "data-table numeric" }, [
          el("thead", {}, [head]),
          el("tbody", {}, rows),
        ]),
      ]),
      el("p", {
        class: "readout",
        text: `Showing rows ${fmtCount(window.rowStart)}–${fmtCount(window.rowStart + window.rowCount - 1)} and columns ${fmtCount(window.colStart)}–${fmtCount(window.colStart + window.colCount - 1)} of a ${fmtCount(window.totalRows)} x ${fmtCount(window.totalCols)} plane. Values are exact.`,
      }),
    ]);
  }

  private renderTextPreview(): HTMLElement {
    const preview = this.ctx.init.textPreview;
    if (!preview) {
      return el("div");
    }

    const head = el(
      "tr",
      {},
      preview.columns.map((column) => el("th", { text: column })),
    );
    const rows = preview.rows.map((cells) =>
      el(
        "tr",
        {},
        cells.map((cell, i) =>
          i === 0
            ? el("th", { class: "row-head", scope: "row", text: cell })
            : el("td", { class: "cell", text: cell }),
        ),
      ),
    );

    return el("div", {}, [
      el("div", { class: "table-scroll" }, [
        el("table", { class: "data-table" }, [
          el("thead", {}, [head]),
          el("tbody", {}, rows),
        ]),
      ]),
      el("p", {
        class: "readout",
        text: `Showing ${preview.rows.length.toLocaleString()} of ${preview.totalRows.toLocaleString()} rows.`,
      }),
    ]);
  }

  private currentCsv(): string {
    const preview = this.ctx.init.textPreview;
    if (preview) {
      return [preview.columns, ...preview.rows]
        .map((row) => row.map(csvCell).join(","))
        .join("\n");
    }
    if (!this.window) {
      return "";
    }
    const header = [
      "",
      ...Array.from({ length: this.window.colCount }, (_, c) =>
        String(this.window!.colStart + c),
      ),
    ];
    const body = this.window.cells.map((cells, r) => [
      String(this.window!.rowStart + r),
      ...cells,
    ]);
    return [header, ...body]
      .map((row) => row.map(csvCell).join(","))
      .join("\n");
  }

  private copy(): void {
    this.ctx.command("copyText", this.currentCsv());
  }

  private exportCsv(): void {
    const base = this.ctx.init.fileName.replace(/\.npy$/i, "");
    this.ctx.command("exportCsv", {
      text: this.currentCsv(),
      suggestedName: `${base}.csv`,
    });
  }
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
