import { spawn } from "node:child_process";
import * as vscode from "vscode";
import type { AxisStats, NumericStats, TextPreview } from "../common/types";

/** Probe/analysis timeouts. The first run pays for importing NumPy. */
const PROBE_TIMEOUT_MS = 15_000;
const ANALYZE_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface Interpreter {
  command: string;
  args: string[];
  /** How this interpreter was found, for the backend info panel. */
  origin: string;
}

export interface PythonProbe extends Interpreter {
  pythonVersion: string;
  numpyVersion: string;
}

export interface AnalyzeResult {
  stats: NumericStats | null;
  channels: AxisStats[] | null;
  columns: AxisStats[] | null;
  text: TextPreview | null;
  pickled: boolean;
  interpretation: string;
}

export interface AnalyzeOptions {
  exactLimit: number;
  histogramBins: number;
  channelAxis: number | null;
  columnAxis: number | null;
}

interface ScriptError {
  ok: false;
  error: string;
  code: string;
}

/**
 * Runs the NumPy analysis helper in a short-lived subprocess.
 *
 * Discovery is cached for the session: once we know there is no usable
 * interpreter, opening a file never pays the spawn cost again.
 */
export class PythonBackend {
  private cached: PythonProbe | null | undefined;
  private probing: Promise<PythonProbe | null> | undefined;
  private lastFailure: string | undefined;

  constructor(
    private readonly scriptPath: string,
    private readonly log: vscode.OutputChannel,
  ) {}

  get failureReason(): string | undefined {
    return this.lastFailure;
  }

  /** Forgets the cached interpreter so the next call re-detects. */
  reset(): void {
    this.cached = undefined;
    this.probing = undefined;
    this.lastFailure = undefined;
  }

  async probe(): Promise<PythonProbe | null> {
    if (this.cached !== undefined) {
      return this.cached;
    }
    if (!this.probing) {
      this.probing = this.runProbe().finally(() => {
        this.probing = undefined;
      });
    }
    return this.probing;
  }

  private async runProbe(): Promise<PythonProbe | null> {
    const config = vscode.workspace.getConfiguration("npyViewer");
    if (!config.get<boolean>("python.enabled", true)) {
      this.lastFailure = "Python parsing is turned off in settings.";
      this.cached = null;
      return null;
    }

    const candidates = await this.candidates();
    const problems: string[] = [];

    for (const candidate of candidates) {
      try {
        const result = await this.run<{ python: string; numpy: string }>(
          candidate,
          ["--mode", "probe"],
          PROBE_TIMEOUT_MS,
        );
        const probe: PythonProbe = {
          ...candidate,
          pythonVersion: result.python,
          numpyVersion: result.numpy,
        };
        this.log.appendLine(
          `[python] using ${candidate.command} (${candidate.origin}) — Python ${result.python}, NumPy ${result.numpy}`,
        );
        this.cached = probe;
        this.lastFailure = undefined;
        return probe;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        problems.push(`${candidate.command}: ${message}`);
        this.log.appendLine(
          `[python] ${candidate.command} unusable — ${message}`,
        );
      }
    }

    this.lastFailure = candidates.length
      ? problems[0]
      : "No Python interpreter was found on PATH.";
    this.cached = null;
    return null;
  }

  /** Candidate interpreters, best first. */
  private async candidates(): Promise<Interpreter[]> {
    const out: Interpreter[] = [];
    const seen = new Set<string>();

    const add = (command: string, args: string[], origin: string): void => {
      const key = `${command} ${args.join(" ")}`;
      if (command && !seen.has(key)) {
        seen.add(key);
        out.push({ command, args, origin });
      }
    };

    const configured = vscode.workspace
      .getConfiguration("npyViewer")
      .get<string>("python.path", "")
      .trim();
    if (configured) {
      add(configured, [], "npyViewer.python.path setting");
    }

    const fromPythonExtension = await this.interpreterFromPythonExtension();
    if (fromPythonExtension) {
      add(fromPythonExtension, [], "Python extension interpreter");
    }

    if (process.platform === "win32") {
      add("python", [], "PATH");
      add("py", ["-3"], "Windows launcher");
      add("python3", [], "PATH");
    } else {
      add("python3", [], "PATH");
      add("python", [], "PATH");
    }

    return out;
  }

  /** Reuses whichever environment the user already selected in VS Code. */
  private async interpreterFromPythonExtension(): Promise<string | undefined> {
    try {
      const extension = vscode.extensions.getExtension("ms-python.python");
      if (!extension) {
        return undefined;
      }
      if (!extension.isActive) {
        await extension.activate();
      }

      const api = extension.exports as {
        environments?: {
          getActiveEnvironmentPath?: () => { path?: string } | undefined;
          resolveEnvironment?: (
            path: unknown,
          ) => Promise<
            | { executable?: { uri?: vscode.Uri; sysPrefix?: string } }
            | undefined
          >;
        };
        settings?: { getExecutionDetails?: () => { execCommand?: string[] } };
      };

      const active = api.environments?.getActiveEnvironmentPath?.();
      if (active?.path) {
        const resolved = await api.environments?.resolveEnvironment?.(active);
        const uri = resolved?.executable?.uri;
        return uri ? uri.fsPath : active.path;
      }

      const legacy = api.settings?.getExecutionDetails?.().execCommand;
      return legacy?.[0];
    } catch {
      return undefined;
    }
  }

  /** Full statistics for one file, or null when Python is unavailable. */
  async analyze(
    filePath: string,
    options: AnalyzeOptions,
  ): Promise<AnalyzeResult | null> {
    const probe = await this.probe();
    if (!probe) {
      return null;
    }

    const args = [
      "--mode",
      "analyze",
      "--path",
      filePath,
      "--exact-limit",
      String(Math.round(options.exactLimit)),
      "--hist-bins",
      String(Math.round(options.histogramBins)),
      "--channel-axis",
      String(options.channelAxis ?? -1),
      "--column-axis",
      String(options.columnAxis ?? -1),
    ];

    const result = await this.run<{
      stats: RawStats | null;
      channels: RawAxisStats[] | null;
      columns: RawAxisStats[] | null;
      text: TextPreview | null;
      pickled: boolean;
      interpretation: string;
    }>(probe, args, ANALYZE_TIMEOUT_MS);

    return {
      stats: result.stats ? coerceStats(result.stats) : null,
      channels: result.channels ? result.channels.map(coerceAxisStats) : null,
      columns: result.columns ? result.columns.map(coerceAxisStats) : null,
      text: result.text,
      pickled: result.pickled,
      interpretation: result.interpretation,
    };
  }

  private run<T>(
    interpreter: Interpreter,
    scriptArgs: string[],
    timeoutMs: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const child = spawn(
        interpreter.command,
        [...interpreter.args, this.scriptPath, ...scriptArgs],
        { windowsHide: true },
      );

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let size = 0;
      let settled = false;

      const finish = (err: Error | null, value?: T): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (err) {
          reject(err);
        } else {
          resolve(value as T);
        }
      };

      const timer = setTimeout(() => {
        child.kill();
        finish(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_OUTPUT_BYTES) {
          child.kill();
          finish(new Error("produced more output than expected"));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

      child.on("error", (err) => {
        finish(new Error(err.message));
      });

      child.on("close", (code) => {
        const out = Buffer.concat(stdout).toString("utf8").trim();
        const errText = Buffer.concat(stderr).toString("utf8").trim();

        if (code !== 0 && !out) {
          finish(new Error(errText || `exited with code ${code}`));
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(out);
        } catch {
          finish(new Error(errText || "produced unreadable output"));
          return;
        }

        const record = parsed as { ok?: boolean } & ScriptError;
        if (!record?.ok) {
          finish(new Error(record?.error ?? "unknown failure"));
          return;
        }
        finish(null, record as T);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// JSON coercion
// ---------------------------------------------------------------------------

type RawStats = Omit<
  NumericStats,
  "min" | "max" | "range" | "mean" | "median"
> &
  Record<string, unknown>;
type RawAxisStats = Record<string, unknown>;

/** JSON has no NaN, so the script sends `null`; restore it here. */
function num(value: unknown): number {
  return value === null || value === undefined ? Number.NaN : Number(value);
}

function coerceStats(raw: RawStats): NumericStats {
  const percentiles: Record<string, number> = {};
  const rawPercentiles = (raw.percentiles ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(rawPercentiles)) {
    percentiles[key] = num(value);
  }

  return {
    approximate: Boolean(raw.approximate),
    sampleSize: Number(raw.sampleSize ?? 0),
    total: Number(raw.total ?? 0),
    finite: Number(raw.finite ?? 0),
    nan: Number(raw.nan ?? 0),
    posInf: Number(raw.posInf ?? 0),
    negInf: Number(raw.negInf ?? 0),
    zeros: Number(raw.zeros ?? 0),
    negatives: Number(raw.negatives ?? 0),
    positives: Number(raw.positives ?? 0),
    min: num(raw.min),
    max: num(raw.max),
    range: num(raw.range),
    sum: num(raw.sum),
    mean: num(raw.mean),
    variance: num(raw.variance),
    std: num(raw.std),
    sem: num(raw.sem),
    skewness: num(raw.skewness),
    kurtosis: num(raw.kurtosis),
    cv: raw.cv === null || raw.cv === undefined ? null : Number(raw.cv),
    median: num(raw.median),
    percentiles,
    iqr: num(raw.iqr),
    madMedian: num(raw.madMedian),
    l1: num(raw.l1),
    l2: num(raw.l2),
    sparsity: Number(raw.sparsity ?? 0),
    lowerFence: num(raw.lowerFence),
    upperFence: num(raw.upperFence),
    outliers: Number(raw.outliers ?? 0),
    uniqueCount:
      raw.uniqueCount === null || raw.uniqueCount === undefined
        ? null
        : Number(raw.uniqueCount),
    uniqueExact: Boolean(raw.uniqueExact),
    topValues: (raw.topValues as NumericStats["topValues"]) ?? null,
    histogram: (raw.histogram as NumericStats["histogram"]) ?? null,
    integral: Boolean(raw.integral),
    unitRange: Boolean(raw.unitRange),
  };
}

function coerceAxisStats(raw: RawAxisStats): AxisStats {
  return {
    label: String(raw.label ?? ""),
    index: Number(raw.index ?? 0),
    count: Number(raw.count ?? 0),
    min: num(raw.min),
    max: num(raw.max),
    mean: num(raw.mean),
    std: num(raw.std),
    nan: Number(raw.nan ?? 0),
    zeros: Number(raw.zeros ?? 0),
  };
}
