import type {
  HostMessage,
  InitPayload,
  Layout,
  TableWindow,
  ViewerConfig,
  WebviewCommand,
  WebviewMessage,
} from "../common/types";
import type { ViewContext } from "./context";
import { decodeBlock, type DecodedBlock } from "./decode";
import { button, clear, el } from "./dom";
import { fmtBytes, fmtCount, fmtShape } from "./format";
import { DataView } from "./views/data";
import { MetaView } from "./views/meta";
import { StatsView } from "./views/stats";
import { VisualView } from "./views/visual";

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

interface Pending {
  resolve: (value: never) => void;
  reject: (error: Error) => void;
}

interface Tab {
  id: string;
  label: string;
  render: (host: HTMLElement) => void;
}

class App implements ViewContext {
  readonly init: InitPayload;
  config: ViewerConfig;

  private tabs: Tab[] = [];
  private activeTab = "";
  private readonly pending = new Map<number, Pending>();
  private nextRequestId = 1;
  private body: HTMLElement | null = null;
  private tabStrip: HTMLElement | null = null;

  private readonly visual: VisualView;
  private readonly stats: StatsView;
  private readonly data: DataView;
  private readonly meta: MetaView;

  constructor(payload: InitPayload) {
    this.init = payload;
    this.config = payload.config;
    this.visual = new VisualView(this);
    this.stats = new StatsView(this);
    this.data = new DataView(this);
    this.meta = new MetaView(this);
  }

  // -- ViewContext -----------------------------------------------------------

  layout(alternate: boolean): Layout | null {
    const { detection } = this.init;
    return alternate && detection.alternateLayout
      ? detection.alternateLayout
      : detection.layout;
  }

  requestBlock(
    frames: number[],
    maxSide: number,
    alternate: boolean,
  ): Promise<DecodedBlock> {
    return this.request<DecodedBlock>((requestId) => ({
      type: "requestBlock",
      requestId,
      frames,
      maxSide,
      useAlternateLayout: alternate,
    }));
  }

  requestTable(
    frame: number,
    rowStart: number,
    colStart: number,
    rowCount: number,
    colCount: number,
    alternate: boolean,
  ): Promise<TableWindow> {
    return this.request<TableWindow>((requestId) => ({
      type: "requestTable",
      requestId,
      frame,
      rowStart,
      colStart,
      rowCount,
      colCount,
      useAlternateLayout: alternate,
    }));
  }

  command(name: WebviewCommand, payload?: unknown): void {
    vscode.postMessage({ type: "command", name, payload });
  }

  openTab(id: string): void {
    this.activeTab = id;
    this.renderTabs();
    this.renderBody();
  }

  // -- Messaging -------------------------------------------------------------

  private request<T>(build: (requestId: number) => WebviewMessage): Promise<T> {
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: resolve as (value: never) => void,
        reject,
      });
      vscode.postMessage(build(requestId));
    });
  }

  settle(message: HostMessage): void {
    if (message.type === "block") {
      const entry = this.pending.get(message.requestId);
      this.pending.delete(message.requestId);
      entry?.resolve(decodeBlock(message.payload) as never);
      return;
    }
    if (message.type === "table") {
      const entry = this.pending.get(message.requestId);
      this.pending.delete(message.requestId);
      entry?.resolve(message.payload as never);
      return;
    }
    if (message.type === "error" && message.requestId !== undefined) {
      const entry = this.pending.get(message.requestId);
      this.pending.delete(message.requestId);
      entry?.reject(new Error(message.message));
    }
  }

  applyConfig(config: ViewerConfig): void {
    this.config = config;
  }

  // -- Rendering -------------------------------------------------------------

  mount(root: HTMLElement): void {
    clear(root);

    this.tabs = this.buildTabs();
    this.activeTab = this.tabs[0]?.id ?? "";

    const header = this.header();
    this.tabStrip = el("div", { class: "tabs", role: "tablist" });
    this.body = el("div", { class: "body" });

    root.append(header);
    if (
      this.init.backend.showInstallHint &&
      this.init.backend.kind === "typescript"
    ) {
      root.append(this.pythonHint());
    }
    for (const warning of this.init.warnings) {
      root.append(
        el("div", { class: "banner banner-warn" }, [
          el("span", { text: warning }),
        ]),
      );
    }
    root.append(this.tabStrip, this.body);

    this.renderTabs();
    this.renderBody();
  }

  private buildTabs(): Tab[] {
    const tabs: Tab[] = [];
    const { detection, textPreview, stats } = this.init;

    if (
      detection.layout &&
      detection.primary !== "text" &&
      detection.primary !== "scalar"
    ) {
      tabs.push({
        id: "visual",
        label: "Visual",
        render: (host) => this.visual.render(host),
      });
    }
    if (stats.overall || stats.insights.length > 0) {
      tabs.push({
        id: "stats",
        label: "Statistics",
        render: (host) => this.stats.render(host),
      });
    }
    if (detection.layout || textPreview) {
      tabs.push({
        id: "data",
        label: "Data",
        render: (host) => this.data.render(host),
      });
    }
    tabs.push({
      id: "meta",
      label: "Metadata",
      render: (host) => this.meta.render(host),
    });

    return tabs;
  }

  private renderTabs(): void {
    const strip = this.tabStrip;
    if (!strip) {
      return;
    }
    clear(strip);

    for (const tab of this.tabs) {
      strip.append(
        el("button", {
          class: `tab${tab.id === this.activeTab ? " active" : ""}`,
          role: "tab",
          "aria-selected": tab.id === this.activeTab,
          text: tab.label,
          onclick: () => this.openTab(tab.id),
        }),
      );
    }
  }

  private renderBody(): void {
    const body = this.body;
    if (!body) {
      return;
    }
    clear(body);
    const tab = this.tabs.find((entry) => entry.id === this.activeTab);
    tab?.render(body);
  }

  private header(): HTMLElement {
    const { meta, detection, backend, fileName } = this.init;

    const chips = [
      chip(fmtShape(meta.shape)),
      chip(meta.dtype),
      chip(fmtBytes(meta.size * meta.itemsize)),
      chip(`${fmtCount(meta.size)} elements`),
    ];

    return el("header", { class: "header" }, [
      el("div", { class: "header-main" }, [
        el("h1", { class: "title", text: fileName }),
        el("div", { class: "chips" }, chips),
      ]),
      el("div", { class: "header-sub" }, [
        el("span", { class: "semantic", text: detection.semantic }),
        el("span", {
          class: `backend backend-${backend.kind}`,
          title: backend.detail,
          text: backend.label,
        }),
      ]),
    ]);
  }

  private pythonHint(): HTMLElement {
    const banner = el("div", { class: "banner banner-hint" }, [
      el("div", { class: "banner-body" }, [
        el("strong", {
          text: "Add Python with NumPy to widen what this viewer can read.",
        }),
        el("span", {
          text:
            "The built-in parser read this file on its own. A NumPy backend adds two things it " +
            "cannot do: opening arrays of pickled Python objects, and computing exact medians " +
            "and percentiles on arrays too large to hold in memory.",
        }),
        this.init.backend.fallbackReason
          ? el("span", {
              class: "banner-detail",
              text: this.init.backend.fallbackReason,
            })
          : null,
      ]),
      el("div", { class: "banner-actions" }, [
        button("Install Python", () => this.command("installPython"), {
          primary: true,
        }),
        button("Select interpreter", () => this.command("selectPython")),
        button("Dismiss", () => {
          this.command("dismissPythonHint");
          banner.remove();
        }),
      ]),
    ]);
    return banner;
  }
}

function chip(text: string): HTMLElement {
  return el("span", { class: "chip", text });
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const root = document.getElementById("root");
let app: App | null = null;

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  if (!root) {
    return;
  }

  switch (message.type) {
    case "init":
      app = new App(message.payload);
      app.mount(root);
      return;

    case "status":
      if (!app && message.busy) {
        const text = root.querySelector(".boot-text");
        if (text) {
          text.textContent = message.message;
        }
      }
      return;

    case "config":
      app?.applyConfig(message.payload);
      return;

    case "error":
      if (message.requestId !== undefined) {
        app?.settle(message);
        return;
      }
      if (!app) {
        renderFatal(root, message.message, message.detail);
      }
      return;

    default:
      app?.settle(message);
  }
});

function renderFatal(
  host: HTMLElement,
  message: string,
  detail?: string,
): void {
  clear(host);
  host.append(
    el("div", { class: "fatal" }, [
      el("h2", { text: "Could not read this file" }),
      el("p", { class: "fatal-message", text: message }),
      detail ? el("pre", { class: "fatal-detail", text: detail }) : null,
    ]),
  );
}

vscode.postMessage({ type: "ready" });
