import {
  DIVERGING,
  gradientCss,
  renderPlane,
  COLORMAP_NAMES,
  type ScaleMode,
} from "../colormap";
import { drawLine } from "../charts";
import { fmt, fmtTick } from "../format";
import type { ViewContext } from "../context";
import { decodeBlock, type DecodedBlock } from "../decode";
import { button, checkbox, clear, el, select } from "../dom";
import type { Detection, Layout, NumericStats } from "../../common/types";

type Mode = "image" | "heatmap" | "grid" | "line";
type Normalisation = "auto" | "dtype" | "robust";

/** Accepted values, used to validate anything restored from a previous session. */
const MODES = new Set<Mode>(["image", "heatmap", "grid", "line"]);
const SCALES = new Set<ScaleMode>(["linear", "log", "symlog"]);
const NORMALISATIONS = new Set<Normalisation>(["auto", "dtype", "robust"]);

/** Thumbnails requested per page in the grid view. */
const GRID_PAGE = 64;
const GRID_TILE = 128;

interface State {
  mode: Mode;
  frame: number;
  colormap: string;
  scale: ScaleMode;
  normalisation: Normalisation;
  alternate: boolean;
  rgb: boolean;
  zoom: number;
  fit: boolean;
}

/**
 * The picture of the array: a single plane as an image or heatmap, a contact
 * sheet of frames, or a line when the plane is one-dimensional.
 *
 * All four modes read the same decoded block, so switching between them never
 * needs another round trip to the extension host.
 */
export class VisualView {
  private state: State;
  private block: DecodedBlock | null;
  private thumbnails: DecodedBlock | null;
  private host: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private readonly stats: NumericStats | null;
  private loading = false;
  private gridLoaded: number;

  constructor(private readonly ctx: ViewContext) {
    const { detection, config, preview, thumbnails, stats } = ctx.init;
    this.stats = stats.overall;
    this.block = preview ? decodeBlock(preview) : null;
    this.thumbnails = thumbnails ? decodeBlock(thumbnails) : null;
    this.gridLoaded = this.thumbnails?.frames ?? 0;

    const layout = detection.layout;
    const straddlesZero = Boolean(
      this.stats &&
      this.stats.min < 0 &&
      this.stats.max > 0 &&
      !detection.isImageLike,
    );

    const defaults: State = {
      mode: initialMode(detection.primary, layout),
      frame: 0,
      // Signed data reads far better on a diverging ramp centred at zero.
      colormap: straddlesZero ? "coolwarm" : config.colormap,
      scale: "linear",
      normalisation: config.autoNormalize ? "auto" : "dtype",
      alternate: false,
      rgb: (layout?.channels ?? 1) >= 3,
      zoom: 1,
      fit: true,
    };

    // Everything restored is validated against this file rather than trusted:
    // a remembered frame index or colormap may be meaningless here.
    const saved = ctx.restored;
    const frameCount = layout?.frameCount ?? 1;

    this.state = {
      ...defaults,
      mode: isModeAvailable(saved.mode, detection, layout)
        ? (saved.mode as Mode)
        : defaults.mode,
      frame:
        typeof saved.frame === "number" &&
        Number.isInteger(saved.frame) &&
        saved.frame >= 0 &&
        saved.frame < frameCount
          ? saved.frame
          : defaults.frame,
      colormap: COLORMAP_NAMES.includes(saved.colormap ?? "")
        ? (saved.colormap as string)
        : defaults.colormap,
      scale: SCALES.has(saved.scale as ScaleMode)
        ? (saved.scale as ScaleMode)
        : defaults.scale,
      normalisation: NORMALISATIONS.has(saved.normalisation as Normalisation)
        ? (saved.normalisation as Normalisation)
        : defaults.normalisation,
      // Only meaningful when this array actually has a second reading.
      alternate: Boolean(saved.alternate) && Boolean(detection.alternateLayout),
      rgb: typeof saved.rgb === "boolean" ? saved.rgb : defaults.rgb,
    };
  }

  /** The subset of view state worth carrying across a reload. */
  private save(): void {
    this.ctx.persist({
      mode: this.state.mode,
      frame: this.state.frame,
      colormap: this.state.colormap,
      scale: this.state.scale,
      normalisation: this.state.normalisation,
      alternate: this.state.alternate,
      rgb: this.state.rgb,
    });
  }

  /** Blocks arrive pre-decoded from the shell; adopt them as they land. */
  setBlock(block: DecodedBlock): void {
    this.block = block;
    this.paint();
  }

  render(host: HTMLElement): void {
    this.host = host;
    clear(host);

    const layout = this.ctx.layout(this.state.alternate);
    if (!layout || !this.block) {
      host.append(
        el("div", { class: "empty" }, [
          el("p", { text: "This array has no visual representation." }),
          el("p", {
            class: "empty-sub",
            text: this.ctx.init.detection.reason,
          }),
        ]),
      );
      return;
    }

    host.append(this.toolbar(layout));

    const stage = el("div", { class: "stage" });
    host.append(stage);

    this.stageHost = stage;
    this.paint();
  }

  private stageHost: HTMLElement | null = null;

  // -------------------------------------------------------------------------
  // Toolbar
  // -------------------------------------------------------------------------

  private toolbar(layout: Layout): HTMLElement {
    const detection = this.ctx.init.detection;
    const modes: Array<[Mode, string]> = [];
    if (detection.available.includes("image")) {
      modes.push(["image", "Image"]);
    }
    if (detection.available.includes("heatmap")) {
      modes.push(["heatmap", "Heatmap"]);
    }
    if (layout.frameCount > 1) {
      modes.push(["grid", `Grid (${layout.frameCount.toLocaleString()})`]);
    }
    if (layout.height === 1 || layout.width === 1) {
      modes.push(["line", "Line"]);
    }

    const groups: HTMLElement[] = [];

    if (modes.length > 1) {
      const switcher = el("div", { class: "segmented" });
      for (const [mode, label] of modes) {
        switcher.append(
          el("button", {
            class: `segment${this.state.mode === mode ? " active" : ""}`,
            text: label,
            onclick: () => this.update({ mode }),
          }),
        );
      }
      groups.push(switcher);
    }

    if (layout.frameCount > 1 && this.state.mode !== "grid") {
      groups.push(this.frameControls(layout));
    }

    if (
      !(this.state.rgb && layout.channels >= 3) &&
      this.state.mode !== "line"
    ) {
      groups.push(
        el("div", { class: "control" }, [
          el("span", { class: "control-label", text: "Colormap" }),
          select(
            COLORMAP_NAMES.map((name) => [name, name]),
            this.state.colormap,
            (value) => this.update({ colormap: value }),
          ),
        ]),
      );
    }

    if (this.state.mode !== "line") {
      groups.push(
        el("div", { class: "control" }, [
          el("span", { class: "control-label", text: "Range" }),
          select(
            [
              ["auto", "Full range"],
              ["robust", "Robust (2–98%)"],
              ["dtype", "Native range"],
            ],
            this.state.normalisation,
            (value) => this.update({ normalisation: value as Normalisation }),
          ),
        ]),
        el("div", { class: "control" }, [
          el("span", { class: "control-label", text: "Scale" }),
          select(
            [
              ["linear", "Linear"],
              ["log", "Log"],
              ["symlog", "Symlog"],
            ],
            this.state.scale,
            (value) => this.update({ scale: value as ScaleMode }),
          ),
        ]),
      );
    }

    if (layout.channels >= 3) {
      groups.push(
        el("div", { class: "control" }, [
          checkbox("Render as colour", this.state.rgb, (rgb) =>
            this.update({ rgb }),
          ),
        ]),
      );
    }

    if (this.ctx.init.detection.alternateLayout) {
      const alt = this.ctx.init.detection.alternateLayout;
      groups.push(
        el("div", { class: "control" }, [
          checkbox(
            `Read as ${alt.order === "channel-first" ? "CHW" : "HWC"}`,
            this.state.alternate,
            (alternate) => this.switchLayout(alternate),
          ),
        ]),
      );
    }

    if (this.state.mode !== "grid" && this.state.mode !== "line") {
      groups.push(
        el("div", { class: "control control-zoom" }, [
          button("−", () => this.zoomBy(1 / 1.4), { title: "Zoom out" }),
          el("span", {
            class: "zoom-label",
            text: this.state.fit
              ? "Fit"
              : `${Math.round(this.state.zoom * 100)}%`,
          }),
          button("+", () => this.zoomBy(1.4), { title: "Zoom in" }),
          button("Fit", () => this.update({ fit: true, zoom: 1 })),
          button("1:1", () => this.update({ fit: false, zoom: 1 })),
        ]),
      );
      groups.push(button("Save PNG", () => this.savePng()));
    }

    return el("div", { class: "toolbar" }, groups);
  }

  private frameControls(layout: Layout): HTMLElement {
    const input = el("input", {
      class: "frame-input",
      type: "number",
      min: 0,
      max: layout.frameCount - 1,
      value: this.state.frame,
    });
    input.addEventListener("change", () => {
      const value = Number.parseInt(input.value, 10);
      if (Number.isFinite(value)) {
        void this.gotoFrame(clampIndex(value, layout.frameCount));
      }
    });

    const slider = el("input", {
      class: "frame-slider",
      type: "range",
      min: 0,
      max: layout.frameCount - 1,
      value: this.state.frame,
    });
    slider.addEventListener("input", () => {
      void this.gotoFrame(Number.parseInt(slider.value, 10));
    });

    return el("div", { class: "control control-frame" }, [
      el("span", { class: "control-label", text: "Frame" }),
      button("◀", () => void this.gotoFrame(this.state.frame - 1), {
        title: "Previous frame",
      }),
      input,
      el("span", {
        class: "frame-total",
        text: `/ ${(layout.frameCount - 1).toLocaleString()}`,
      }),
      button("▶", () => void this.gotoFrame(this.state.frame + 1), {
        title: "Next frame",
      }),
      slider,
    ]);
  }

  // -------------------------------------------------------------------------
  // State transitions
  // -------------------------------------------------------------------------

  private update(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    this.save();
    if (this.host) {
      this.render(this.host);
    }
  }

  private zoomBy(factor: number): void {
    this.update({
      zoom: Math.max(0.05, Math.min(40, this.state.zoom * factor)),
      fit: false,
    });
  }

  private async gotoFrame(frame: number): Promise<void> {
    const layout = this.ctx.layout(this.state.alternate);
    if (!layout || this.loading) {
      return;
    }
    const target = clampIndex(frame, layout.frameCount);
    if (target === this.state.frame && this.block?.sourceFrames[0] === target) {
      return;
    }

    this.loading = true;
    this.state.frame = target;
    this.save();
    try {
      this.block = await this.ctx.requestBlock(
        [target],
        this.ctx.config.imageMaxSide,
        this.state.alternate,
      );
    } finally {
      this.loading = false;
    }
    if (this.host) {
      this.render(this.host);
    }
  }

  private async switchLayout(alternate: boolean): Promise<void> {
    const layout = this.ctx.layout(alternate);
    if (!layout) {
      return;
    }
    this.state.alternate = alternate;
    this.state.frame = 0;
    this.state.rgb = layout.channels >= 3;
    this.save();
    this.block = await this.ctx.requestBlock(
      [0],
      this.ctx.config.imageMaxSide,
      alternate,
    );
    this.thumbnails = null;
    this.gridLoaded = 0;
    if (this.host) {
      this.render(this.host);
    }
  }

  // -------------------------------------------------------------------------
  // Painting
  // -------------------------------------------------------------------------

  private paint(): void {
    const stage = this.stageHost;
    const layout = this.ctx.layout(this.state.alternate);
    if (!stage || !layout || !this.block) {
      return;
    }
    clear(stage);

    switch (this.state.mode) {
      case "grid":
        void this.paintGrid(stage, layout);
        return;
      case "line":
        this.paintLine(stage, layout);
        return;
      default:
        this.paintPlane(stage, layout);
    }
  }

  /** Value range the colour ramp is stretched across. */
  private displayRange(): [number, number] {
    const block = this.block;
    const stats = this.stats;
    const detection = this.ctx.init.detection;

    if (this.state.normalisation === "dtype") {
      if (detection.displayRange) {
        return detection.displayRange;
      }
      return stats ? [stats.min, stats.max] : [0, 1];
    }

    if (this.state.normalisation === "robust" && stats) {
      const lo = stats.percentiles["1"] ?? stats.min;
      const hi = stats.percentiles["99"] ?? stats.max;
      if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) {
        return [lo, hi];
      }
    }

    // "Full range" tracks the visible plane, which is what the eye expects
    // when stepping through frames of differing brightness.
    if (
      block &&
      Number.isFinite(block.blockMin) &&
      block.blockMax > block.blockMin
    ) {
      return [block.blockMin, block.blockMax];
    }
    if (stats && Number.isFinite(stats.min) && stats.max > stats.min) {
      return [stats.min, stats.max];
    }
    return [0, 1];
  }

  private paintPlane(stage: HTMLElement, layout: Layout): void {
    const block = this.block;
    if (!block) {
      return;
    }

    let [min, max] = this.displayRange();
    if (
      DIVERGING.has(this.state.colormap) &&
      !(this.state.rgb && block.channels >= 3)
    ) {
      // A diverging ramp is only honest when its midpoint sits at zero.
      const bound = Math.max(Math.abs(min), Math.abs(max));
      min = -bound;
      max = bound;
    }

    const canvas = el("canvas", { class: "plane-canvas" });
    canvas.width = block.width;
    canvas.height = block.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const image = ctx.createImageData(block.width, block.height);
    renderPlane(
      block.values,
      0,
      block.width,
      block.height,
      block.channels,
      {
        min,
        max,
        colormap: this.state.colormap,
        scale: this.state.scale,
        rgb: this.state.rgb && block.channels >= 3,
      },
      image.data,
    );
    ctx.putImageData(image, 0, 0);
    this.canvas = canvas;

    const viewport = el("div", {
      class: `viewport${this.state.fit ? " viewport-fit" : ""}`,
    });
    const holder = el("div", { class: "plane-holder" }, [canvas]);
    viewport.append(holder);

    // Nearest-neighbour keeps individual array elements visible when zoomed in.
    canvas.style.imageRendering = "pixelated";
    if (this.state.fit) {
      // Fit fills the stage in both directions, so a 28x28 thumbnail is
      // actually legible rather than being drawn 28 pixels wide.
      canvas.classList.add("fit");
    } else {
      canvas.style.width = `${block.width * this.state.zoom}px`;
      canvas.style.height = `${block.height * this.state.zoom}px`;
    }

    const readout = el("div", { class: "readout" });
    this.attachInspector(canvas, block, layout, readout);

    stage.append(viewport, this.legend(min, max, block, layout), readout);
  }

  /** Live value readout under the cursor, in source array coordinates. */
  private attachInspector(
    canvas: HTMLCanvasElement,
    block: DecodedBlock,
    layout: Layout,
    readout: HTMLElement,
  ): void {
    const idle = `${layout.height.toLocaleString()} x ${layout.width.toLocaleString()}${
      layout.channels > 1 ? ` x ${layout.channels}` : ""
    }${block.downsampled ? ` — displayed at 1/${block.step[0]} x 1/${block.step[1]} scale` : ""}`;
    readout.textContent = idle;

    canvas.addEventListener("mousemove", (event) => {
      const rect = canvas.getBoundingClientRect();
      const x = Math.floor(
        ((event.clientX - rect.left) / rect.width) * block.width,
      );
      const y = Math.floor(
        ((event.clientY - rect.top) / rect.height) * block.height,
      );
      if (x < 0 || y < 0 || x >= block.width || y >= block.height) {
        return;
      }

      const base = (y * block.width + x) * block.channels;
      const parts: string[] = [];
      for (let c = 0; c < block.channels; c += 1) {
        parts.push(fmt(block.values[base + c]));
      }

      const sourceRow = y * block.step[0];
      const sourceCol = x * block.step[1];
      readout.textContent = `[${sourceRow.toLocaleString()}, ${sourceCol.toLocaleString()}] = ${parts.join(", ")}`;
    });

    canvas.addEventListener("mouseleave", () => {
      readout.textContent = idle;
    });
  }

  private legend(
    min: number,
    max: number,
    block: DecodedBlock,
    layout: Layout,
  ): HTMLElement {
    // Only worth naming the frame when there is more than one to be on.
    const frameNote =
      layout.frameCount > 1
        ? ` · frame ${this.state.frame.toLocaleString()} of ${(layout.frameCount - 1).toLocaleString()}`
        : "";

    if (this.state.rgb && block.channels >= 3) {
      return el("div", { class: "legend" }, [
        el("span", {
          class: "legend-note",
          text: `${block.channels === 4 ? "RGBA" : "RGB"} channels rendered directly${frameNote}`,
        }),
      ]);
    }

    const bar = el("div", { class: "legend-bar" });
    bar.style.background = gradientCss(this.state.colormap);

    return el("div", { class: "legend" }, [
      el("span", { class: "legend-tick", text: fmtTick(min) }),
      bar,
      el("span", { class: "legend-tick", text: fmtTick(max) }),
      el("span", {
        class: "legend-note",
        text:
          (this.state.scale === "linear"
            ? this.state.colormap
            : `${this.state.colormap} · ${this.state.scale}`) + frameNote,
      }),
    ]);
  }

  private paintLine(stage: HTMLElement, layout: Layout): void {
    const block = this.block;
    if (!block) {
      return;
    }
    const host = el("div", { class: "chart-block" });
    stage.append(host);
    drawLine(host, block.values, {
      step: layout.height === 1 ? block.step[1] : block.step[0],
      height: 320,
    });
    stage.append(
      el("div", {
        class: "readout",
        text: `${(layout.height * layout.width).toLocaleString()} values${
          block.downsampled
            ? ` — plotted from every ${block.step[1]}th sample`
            : ""
        }`,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Contact sheet
  // -------------------------------------------------------------------------

  private async paintGrid(stage: HTMLElement, layout: Layout): Promise<void> {
    if (!this.thumbnails) {
      this.thumbnails = await this.ctx.requestBlock(
        rangeFrom(0, Math.min(layout.frameCount, GRID_PAGE)),
        GRID_TILE,
        this.state.alternate,
      );
      this.gridLoaded = this.thumbnails.frames;
    }

    const thumbnails = this.thumbnails;
    const grid = el("div", { class: "grid" });
    const [min, max] = this.displayRange();

    for (let i = 0; i < thumbnails.frames; i += 1) {
      const frame = thumbnails.sourceFrames[i] ?? i;
      grid.append(this.tile(thumbnails, i, frame, min, max));
    }

    stage.append(grid);

    if (this.gridLoaded < layout.frameCount) {
      stage.append(
        el("div", { class: "grid-more" }, [
          el("span", {
            class: "readout",
            text: `Showing ${this.gridLoaded.toLocaleString()} of ${layout.frameCount.toLocaleString()} frames`,
          }),
          button("Load more", () => void this.loadMoreThumbnails(layout), {
            primary: true,
          }),
        ]),
      );
    }
  }

  private tile(
    thumbnails: DecodedBlock,
    index: number,
    frame: number,
    min: number,
    max: number,
  ): HTMLElement {
    const canvas = el("canvas", { class: "tile-canvas" });
    canvas.width = thumbnails.width;
    canvas.height = thumbnails.height;
    const ctx = canvas.getContext("2d");

    if (ctx) {
      const image = ctx.createImageData(thumbnails.width, thumbnails.height);
      renderPlane(
        thumbnails.values,
        index * thumbnails.frameStride,
        thumbnails.width,
        thumbnails.height,
        thumbnails.channels,
        {
          min,
          max,
          colormap: this.state.colormap,
          scale: this.state.scale,
          rgb: this.state.rgb && thumbnails.channels >= 3,
        },
        image.data,
      );
      ctx.putImageData(image, 0, 0);
    }
    canvas.style.imageRendering = "pixelated";

    return el(
      "button",
      {
        class: "tile",
        title: `Frame ${frame} — click to open`,
        onclick: () => {
          this.state.mode = "image";
          void this.gotoFrame(frame);
        },
      },
      [canvas, el("span", { class: "tile-label", text: String(frame) })],
    );
  }

  private async loadMoreThumbnails(layout: Layout): Promise<void> {
    const start = this.gridLoaded;
    const count = Math.min(GRID_PAGE, layout.frameCount - start);
    if (count <= 0) {
      return;
    }

    const next = await this.ctx.requestBlock(
      rangeFrom(start, count),
      GRID_TILE,
      this.state.alternate,
    );

    // Concatenate onto the existing sheet so earlier tiles are not refetched.
    const merged = mergeBlocks(this.thumbnails, next);
    this.thumbnails = merged;
    this.gridLoaded = merged.frames;
    if (this.host) {
      this.render(this.host);
    }
  }

  // -------------------------------------------------------------------------

  private savePng(): void {
    const canvas = this.canvas;
    if (!canvas) {
      return;
    }
    const dataUrl = canvas.toDataURL("image/png");
    const base = this.ctx.init.fileName.replace(/\.npy$/i, "");
    this.ctx.command("saveImage", {
      base64: dataUrl.slice(dataUrl.indexOf(",") + 1),
      suggestedName: `${base}-frame${this.state.frame}.png`,
    });
  }
}

/**
 * Whether a remembered mode still applies to this array.
 *
 * Availability mirrors the toolbar exactly: restoring `grid` for a single-frame
 * array would select a button that is not there to un-select.
 */
function isModeAvailable(
  mode: string | undefined,
  detection: Detection,
  layout: Layout | null,
): boolean {
  if (!mode || !MODES.has(mode as Mode) || !layout) {
    return false;
  }
  switch (mode as Mode) {
    case "grid":
      return layout.frameCount > 1;
    case "line":
      return layout.height === 1 || layout.width === 1;
    default:
      return detection.available.includes(mode as "image" | "heatmap");
  }
}

function initialMode(primary: string, layout: Layout | null): Mode {
  if (primary === "grid" && layout && layout.frameCount > 1) {
    return "grid";
  }
  if (primary === "line") {
    return "line";
  }
  if (primary === "heatmap") {
    return "heatmap";
  }
  return "image";
}

function clampIndex(value: number, count: number): number {
  return Math.max(0, Math.min(count - 1, value));
}

function rangeFrom(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => start + i);
}

function mergeBlocks(
  first: DecodedBlock | null,
  second: DecodedBlock,
): DecodedBlock {
  if (
    !first ||
    first.width !== second.width ||
    first.height !== second.height
  ) {
    return second;
  }

  const values =
    first.values instanceof Uint8Array && second.values instanceof Uint8Array
      ? new Uint8Array(first.values.length + second.values.length)
      : new Float32Array(first.values.length + second.values.length);

  values.set(first.values as never, 0);
  values.set(second.values as never, first.values.length);

  return {
    ...first,
    values,
    frames: first.frames + second.frames,
    sourceFrames: [...first.sourceFrames, ...second.sourceFrames],
    blockMin: Math.min(first.blockMin, second.blockMin),
    blockMax: Math.max(first.blockMax, second.blockMax),
  };
}
