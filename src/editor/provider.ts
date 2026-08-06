import * as path from "node:path";
import * as vscode from "vscode";
import type {
  ArrayMeta,
  BackendInfo,
  Detection,
  HostMessage,
  InitPayload,
  Layout,
  StatsBundle,
  ViewerConfig,
  WebviewMessage,
} from "../common/types";
import { buildInsights } from "../core/insights";
import { detectLayout, refineDetection } from "../core/layout";
import { NpyFile } from "../core/npyFile";
import { computeStats } from "../core/stats";
import type { PythonBackend } from "../python/backend";
import { renderWebviewHtml } from "./html";

/** Thumbnails fetched up front for the grid view. */
const INITIAL_THUMBNAILS = 64;
const THUMBNAIL_SIDE = 128;

export class NpyDocument implements vscode.CustomDocument {
  file: NpyFile | null = null;

  constructor(readonly uri: vscode.Uri) {}

  async dispose(): Promise<void> {
    await this.file?.close();
    this.file = null;
  }
}

/**
 * Read-only custom editor for `.npy` files.
 *
 * Opening a file runs one analysis pass (statistics via NumPy when available,
 * otherwise the built-in streaming pass) and ships a bounded preview to the
 * webview. Everything after that — frame navigation, table paging — is served
 * on demand from the still-open file handle.
 */
export class NpyEditorProvider implements vscode.CustomReadonlyEditorProvider<NpyDocument> {
  static readonly viewType = "npyViewer.arrayEditor";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly python: PythonBackend,
    private readonly log: vscode.OutputChannel,
  ) {}

  openCustomDocument(uri: vscode.Uri): NpyDocument {
    return new NpyDocument(uri);
  }

  async resolveCustomEditor(
    document: NpyDocument,
    panel: vscode.WebviewPanel,
    token: vscode.CancellationToken,
  ): Promise<void> {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
      ],
    };

    const fileName = path.basename(document.uri.fsPath);
    panel.webview.html = renderWebviewHtml(
      panel.webview,
      this.context.extensionUri,
      fileName,
    );

    const disposables: vscode.Disposable[] = [];
    let session: Session | null = null;

    const post = (message: HostMessage): void => {
      void panel.webview.postMessage(message);
    };

    disposables.push(
      panel.webview.onDidReceiveMessage(async (raw: WebviewMessage) => {
        try {
          if (raw.type === "ready") {
            session = await this.load(document, post, token);
            return;
          }
          if (!session) {
            return;
          }
          await this.handle(raw, session, post);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log.appendLine(`[error] ${message}`);
          post({
            type: "error",
            requestId: "requestId" in raw ? raw.requestId : undefined,
            message,
          });
        }
      }),
    );

    // Re-analysing on every keystroke of a settings change would be wasteful,
    // but the view options are cheap to push straight through.
    disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("npyViewer")) {
          post({ type: "config", payload: readViewerConfig() });
        }
      }),
    );

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        vscode.Uri.file(path.dirname(document.uri.fsPath)),
        path.basename(document.uri.fsPath),
      ),
    );
    disposables.push(
      watcher,
      watcher.onDidChange(async () => {
        await document.dispose();
        session = await this.load(document, post, token);
      }),
    );

    panel.onDidDispose(() => {
      for (const item of disposables) {
        item.dispose();
      }
      void document.dispose();
    });
  }

  private async load(
    document: NpyDocument,
    post: (message: HostMessage) => void,
    token: vscode.CancellationToken,
  ): Promise<Session | null> {
    const filePath = document.uri.fsPath;
    const fileName = path.basename(filePath);
    const config = readViewerConfig();
    const settings = vscode.workspace.getConfiguration("npyViewer");
    const maxElements = settings.get<number>("preview.maxElements", 2_000_000);
    const exactLimit = settings.get<number>(
      "stats.exactPercentileLimit",
      20_000_000,
    );
    const showInstallHint = settings.get<boolean>(
      "python.showInstallHint",
      true,
    );
    const warnings: string[] = [];

    post({ type: "status", message: "Reading header…", busy: true });

    let file: NpyFile;
    try {
      file = await NpyFile.open(filePath);
    } catch (err) {
      // A header the built-in parser cannot read (nested records, unusual
      // dtypes) is exactly the case NumPy handles, so try that before failing.
      const recovered = await this.loadViaPythonOnly(
        filePath,
        fileName,
        err,
        post,
      );
      if (recovered) {
        return null;
      }
      throw err;
    }
    document.file = file;

    const { meta, dtype } = file;
    let detection = detectLayout(meta, dtype);
    const columnAxis = pickColumnAxis(meta, detection);

    post({ type: "status", message: "Computing statistics…", busy: true });

    const { bundle, backend } = await this.computeStatistics(
      filePath,
      file,
      detection,
      {
        exactLimit,
        histogramBins: config.histogramBins,
        columnAxis,
        showInstallHint,
      },
    );

    if (token.isCancellationRequested) {
      return null;
    }

    detection = refineDetection(detection, meta, bundle.overall);
    bundle.insights = buildInsights(meta, detection, bundle, {
      truncated: file.truncated,
    });

    if (file.truncated) {
      warnings.push(
        "The file is shorter than its header declares; missing values read as NaN.",
      );
    }
    if (!dtype.readable && !bundle.overall) {
      warnings.push(
        "This array holds pickled Python objects. Only a text preview is available.",
      );
    }

    post({ type: "status", message: "Rendering…", busy: true });

    const layout = detection.layout;
    const preview =
      layout && dtype.numeric
        ? await file.readBlock(layout, [0], config.imageMaxSide, maxElements)
        : null;

    const thumbnails =
      layout && dtype.numeric && layout.frameCount > 1
        ? await file.readBlock(
            layout,
            range(Math.min(layout.frameCount, INITIAL_THUMBNAILS)),
            THUMBNAIL_SIDE,
            maxElements,
          )
        : null;

    let textPreview = null;
    if (!dtype.numeric || !dtype.readable) {
      textPreview = dtype.readable ? await file.readTextPreview() : null;
    }
    if (detection.primary === "scalar") {
      textPreview = {
        columns: ["value"],
        rows: [[await file.readScalar()]],
        totalRows: 1,
      };
    }

    const payload: InitPayload = {
      fileName,
      filePath,
      meta,
      detection,
      backend,
      config,
      stats: bundle,
      preview,
      thumbnails,
      textPreview,
      warnings,
    };

    post({ type: "init", payload });
    post({ type: "status", message: "", busy: false });

    return { file, detection, maxElements };
  }

  /**
   * Statistics from NumPy when an interpreter is available, otherwise the
   * built-in streaming pass. Either way the returned bundle has the same shape,
   * and `backend` records which path ran so the UI can say so.
   */
  private async computeStatistics(
    filePath: string,
    file: NpyFile,
    detection: Detection,
    options: {
      exactLimit: number;
      histogramBins: number;
      columnAxis: number | null;
      showInstallHint: boolean;
    },
  ): Promise<{ bundle: StatsBundle; backend: BackendInfo }> {
    const { meta, dtype } = file;
    const channelAxis = detection.layout?.channelAxis ?? null;
    const probe = await this.python.probe();

    if (probe) {
      try {
        const started = Date.now();
        const result = await this.python.analyze(filePath, {
          exactLimit: options.exactLimit,
          histogramBins: options.histogramBins,
          channelAxis,
          columnAxis: options.columnAxis,
        });
        if (result) {
          return {
            bundle: {
              overall: result.stats,
              channels: result.channels,
              columns: result.columns,
              insights: [],
              elapsedMs: Date.now() - started,
              unsupported: result.stats
                ? undefined
                : `Descriptive statistics do not apply to ${meta.dtype} data.`,
            },
            backend: {
              kind: "python",
              label: `NumPy ${probe.numpyVersion}`,
              detail: `Python ${probe.pythonVersion} — ${probe.origin}`,
              pythonPath: probe.command,
              pythonVersion: probe.pythonVersion,
              numpyVersion: probe.numpyVersion,
              showInstallHint: false,
            },
          };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.appendLine(
          `[python] analysis failed, falling back — ${message}`,
        );
      }
    }

    const bundle = await computeStats(
      file.source,
      meta,
      dtype,
      file.dataOffset,
      {
        exactLimit: options.exactLimit,
        histogramBins: options.histogramBins,
        channelAxis,
        columnAxis: options.columnAxis,
      },
    );

    return {
      bundle,
      backend: {
        kind: "typescript",
        label: "Built-in parser",
        detail:
          "Reading the array directly in TypeScript — no Python needed. A NumPy backend " +
          "additionally reads pickled object arrays and computes exact quantiles on arrays " +
          "far larger than this parser can hold in memory.",
        fallbackReason: this.python.failureReason,
        showInstallHint: options.showInstallHint,
      },
    };
  }

  /** Last resort for headers only NumPy can read. */
  private async loadViaPythonOnly(
    filePath: string,
    fileName: string,
    originalError: unknown,
    post: (message: HostMessage) => void,
  ): Promise<boolean> {
    const probe = await this.python.probe();
    if (!probe) {
      return false;
    }

    try {
      const result = await this.python.analyze(filePath, {
        exactLimit: 1_000_000,
        histogramBins: 64,
        channelAxis: null,
        columnAxis: null,
      });
      if (!result?.text) {
        return false;
      }

      const meta: ArrayMeta = {
        dtype: "unknown",
        descr: "",
        kind: "object",
        itemsize: 0,
        littleEndian: true,
        shape: [result.text.totalRows],
        ndim: 1,
        size: result.text.totalRows,
        dataBytes: 0,
        fortranOrder: false,
        npyVersion: "1.0",
        headerBytes: 0,
        fileBytes: 0,
      };

      const detection: Detection = {
        primary: "text",
        available: ["text"],
        layout: null,
        alternateLayout: null,
        reason:
          "The built-in parser could not read this header, so NumPy read it instead.",
        semantic: "Object array",
        displayRange: null,
        isImageLike: false,
      };

      post({
        type: "init",
        payload: {
          fileName,
          filePath,
          meta,
          detection,
          backend: {
            kind: "python",
            label: `NumPy ${probe.numpyVersion}`,
            detail: `Python ${probe.pythonVersion} — ${probe.origin}`,
            showInstallHint: false,
          },
          config: readViewerConfig(),
          stats: {
            overall: result.stats,
            channels: null,
            columns: null,
            insights: [],
            elapsedMs: 0,
            unsupported: result.stats
              ? undefined
              : "This array holds pickled Python objects.",
          },
          preview: null,
          thumbnails: null,
          textPreview: result.text,
          warnings: [
            `Built-in parser: ${originalError instanceof Error ? originalError.message : String(originalError)}`,
          ],
        },
      });
      post({ type: "status", message: "", busy: false });
      return true;
    } catch {
      return false;
    }
  }

  private async handle(
    message: WebviewMessage,
    session: Session,
    post: (message: HostMessage) => void,
  ): Promise<void> {
    const { file, detection, maxElements } = session;

    switch (message.type) {
      case "requestBlock": {
        const layout = chooseLayout(detection, message.useAlternateLayout);
        if (!layout) {
          return;
        }
        const block = await file.readBlock(
          layout,
          message.frames,
          message.maxSide,
          maxElements,
        );
        post({ type: "block", requestId: message.requestId, payload: block });
        return;
      }

      case "requestTable": {
        const layout = chooseLayout(detection, message.useAlternateLayout);
        if (!layout) {
          return;
        }
        const window = await file.readTable(
          layout,
          message.frame,
          message.rowStart,
          message.colStart,
          message.rowCount,
          message.colCount,
        );
        post({ type: "table", requestId: message.requestId, payload: window });
        return;
      }

      case "command":
        await this.runCommand(message.name, message.payload);
        return;

      default:
        return;
    }
  }

  private async runCommand(name: string, payload: unknown): Promise<void> {
    switch (name) {
      case "installPython":
        await vscode.env.openExternal(
          vscode.Uri.parse("https://www.python.org/downloads/"),
        );
        void vscode.window.showInformationMessage(
          'After installing Python, run "pip install numpy", then reopen the file.',
        );
        return;

      case "selectPython":
        await vscode.commands.executeCommand("npy-viewer.selectPython");
        return;

      case "dismissPythonHint":
        await vscode.workspace
          .getConfiguration("npyViewer")
          .update(
            "python.showInstallHint",
            false,
            vscode.ConfigurationTarget.Global,
          );
        return;

      case "openSettings":
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "npyViewer",
        );
        return;

      case "copyText":
        if (typeof payload === "string") {
          await vscode.env.clipboard.writeText(payload);
          void vscode.window.setStatusBarMessage("Copied to clipboard", 2000);
        }
        return;

      case "saveImage": {
        const data = payload as
          | { base64?: string; suggestedName?: string }
          | undefined;
        if (!data?.base64) {
          return;
        }
        const target = await vscode.window.showSaveDialog({
          filters: { "PNG image": ["png"] },
          saveLabel: "Save image",
          defaultUri: vscode.Uri.file(data.suggestedName ?? "array.png"),
        });
        if (target) {
          await vscode.workspace.fs.writeFile(
            target,
            Buffer.from(data.base64, "base64"),
          );
          void vscode.window.showInformationMessage(
            `Saved ${path.basename(target.fsPath)}`,
          );
        }
        return;
      }

      case "exportCsv": {
        const data = payload as
          | { text?: string; suggestedName?: string }
          | undefined;
        if (!data?.text) {
          return;
        }
        const target = await vscode.window.showSaveDialog({
          filters: { CSV: ["csv"] },
          saveLabel: "Export CSV",
          defaultUri: vscode.Uri.file(data.suggestedName ?? "array.csv"),
        });
        if (target) {
          await vscode.workspace.fs.writeFile(
            target,
            Buffer.from(data.text, "utf8"),
          );
          void vscode.window.showInformationMessage(
            `Exported ${path.basename(target.fsPath)}`,
          );
        }
        return;
      }

      default:
        return;
    }
  }
}

interface Session {
  file: NpyFile;
  detection: Detection;
  maxElements: number;
}

function chooseLayout(detection: Detection, alternate: boolean): Layout | null {
  if (alternate && detection.alternateLayout) {
    return detection.alternateLayout;
  }
  return detection.layout;
}

/** Per-column statistics only make sense for genuinely tabular 2-D data. */
function pickColumnAxis(meta: ArrayMeta, detection: Detection): number | null {
  if (meta.ndim !== 2 || detection.isImageLike) {
    return null;
  }
  return meta.shape[1] <= 512 ? 1 : null;
}

function readViewerConfig(): ViewerConfig {
  const config = vscode.workspace.getConfiguration("npyViewer");
  return {
    colormap: config.get<string>("view.colormap", "viridis"),
    autoNormalize: config.get<boolean>("view.autoNormalize", true),
    imageMaxSide: config.get<number>("preview.imageMaxSide", 1600),
    histogramBins: config.get<number>("stats.histogramBins", 64),
  };
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i);
}
