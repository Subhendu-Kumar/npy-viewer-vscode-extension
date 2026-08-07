import { clear, el } from "../dom";
import type { ViewContext } from "../context";
import { fmtBytes, fmtCount, fmtShape } from "../format";

/** File header, dtype details and which backend read the array. */
export class MetaView {
  constructor(private readonly ctx: ViewContext) {}

  render(host: HTMLElement): void {
    clear(host);
    const { meta, detection, backend, filePath } = this.ctx.init;
    const layout = detection.layout;

    host.append(
      section("Array", [
        kv([
          ["Shape", fmtShape(meta.shape)],
          ["Dimensions", String(meta.ndim)],
          ["Elements", fmtCount(meta.size)],
          ["dtype", meta.dtype],
          [
            "Item size",
            `${meta.itemsize} byte${meta.itemsize === 1 ? "" : "s"}`,
          ],
          ["Data size", fmtBytes(meta.size * meta.itemsize)],
          ["Byte order", meta.littleEndian ? "little-endian" : "big-endian"],
          [
            "Memory order",
            meta.fortranOrder ? "Fortran (column-major)" : "C (row-major)",
          ],
        ]),
      ]),

      section("Interpretation", [
        kv([
          ["Detected as", detection.semantic],
          ["Why", detection.reason],
          ...(layout
            ? ([
                [
                  "Plane axes",
                  `rows = axis ${layout.rowAxis}, columns = axis ${layout.colAxis}`,
                ],
                [
                  "Channel axis",
                  layout.channelAxis === null
                    ? "none"
                    : `axis ${layout.channelAxis} (${layout.channels} channel${layout.channels === 1 ? "" : "s"})`,
                ],
                [
                  "Frames",
                  layout.frameCount > 1
                    ? `${fmtCount(layout.frameCount)} over ${layout.frameAxes.length === 0 ? "no" : `axes ${layout.frameAxes.join(", ")}`}`
                    : "single frame",
                ],
                [
                  "Plane size",
                  `${fmtCount(layout.height)} x ${fmtCount(layout.width)}`,
                ],
              ] as Array<[string, string]>)
            : []),
        ]),
      ]),

      section("File", [
        kv([
          ["Path", filePath],
          ["NPY format version", meta.npyVersion],
          ["Header size", `${meta.headerBytes} bytes`],
          ["File size", fmtBytes(meta.fileBytes)],
          ["Raw descr", meta.descr || "—"],
        ]),
      ]),

      section("Parsing backend", [
        kv([
          ["Backend", backend.label],
          ["Detail", backend.detail],
          ...(backend.pythonPath
            ? ([["Interpreter", backend.pythonPath]] as Array<[string, string]>)
            : []),
          ...(backend.fallbackReason
            ? ([["Python unavailable", backend.fallbackReason]] as Array<
                [string, string]
              >)
            : []),
        ]),
      ]),
    );

    if (meta.fields && meta.fields.length > 0) {
      host.append(
        section("Record fields", [
          el("div", { class: "table-scroll" }, [
            el("table", { class: "data-table" }, [
              el("thead", {}, [
                el("tr", {}, [
                  el("th", { text: "Field" }),
                  el("th", { text: "dtype" }),
                  el("th", { text: "Offset" }),
                  el("th", { text: "Size" }),
                  el("th", { text: "Shape" }),
                ]),
              ]),
              el(
                "tbody",
                {},
                meta.fields.map((field) =>
                  el("tr", {}, [
                    el("th", {
                      class: "row-head",
                      scope: "row",
                      text: field.name,
                    }),
                    el("td", { text: field.dtype }),
                    el("td", { text: String(field.offset) }),
                    el("td", { text: `${field.itemsize} B` }),
                    el("td", {
                      text: field.shape.length
                        ? fmtShape(field.shape)
                        : "scalar",
                    }),
                  ]),
                ),
              ),
            ]),
          ]),
        ]),
      );
    }
  }
}

function section(title: string, children: HTMLElement[]): HTMLElement {
  return el("section", { class: "section" }, [
    el("h3", { class: "section-title", text: title }),
    ...children,
  ]);
}

function kv(rows: Array<[string, string]>): HTMLElement {
  return el(
    "div",
    { class: "kv-grid" },
    rows.flatMap(([key, value]) => [
      el("span", { class: "kv-key", text: key }),
      el("span", { class: "kv-value selectable", text: value }),
    ]),
  );
}
