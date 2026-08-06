/**
 * Types shared between the extension host and the webview.
 *
 * This module must stay free of `vscode` and Node imports: it is bundled into
 * the browser-side webview as well as the extension.
 */

export type DtypeKind =
  | "bool"
  | "int"
  | "uint"
  | "float"
  | "complex"
  | "bytes"
  | "str"
  | "datetime"
  | "timedelta"
  | "object"
  | "struct";

export interface StructField {
  name: string;
  descr: string;
  dtype: string;
  kind: DtypeKind;
  offset: number;
  itemsize: number;
  shape: number[];
}

/** Everything derivable from the `.npy` header, plus a little file context. */
export interface ArrayMeta {
  /** Canonical NumPy name, e.g. `float32`, `uint8`, `<U12`. */
  dtype: string;
  /** Raw `descr` field from the header, e.g. `<f4`. */
  descr: string;
  kind: DtypeKind;
  itemsize: number;
  littleEndian: boolean;
  shape: number[];
  ndim: number;
  /** Total element count (product of `shape`; 1 for a 0-d array). */
  size: number;
  /** Bytes of array data, excluding the header. */
  dataBytes: number;
  fortranOrder: boolean;
  npyVersion: string;
  headerBytes: number;
  fileBytes: number;
  fields?: StructField[];
  /** Set for `datetime64`/`timedelta64`, e.g. `ns`, `D`. */
  timeUnit?: string;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export interface Histogram {
  binEdges: number[];
  counts: number[];
  /** Bins were computed over finite values only. */
  excludedNonFinite: number;
}

export interface ValueCount {
  value: number;
  count: number;
  label: string;
}

export interface NumericStats {
  /** Percentiles/median/unique came from a sample rather than every element. */
  approximate: boolean;
  sampleSize: number;

  total: number;
  /** Finite values that took part in min/max/mean/std. */
  finite: number;
  nan: number;
  posInf: number;
  negInf: number;
  zeros: number;
  negatives: number;
  positives: number;

  min: number;
  max: number;
  range: number;
  sum: number;
  mean: number;
  variance: number;
  std: number;
  /** Standard error of the mean. */
  sem: number;
  skewness: number;
  kurtosis: number;
  /** Coefficient of variation, `std / |mean|`; null when the mean is ~0. */
  cv: number | null;

  median: number;
  percentiles: Record<string, number>;
  iqr: number;
  madMedian: number;

  l1: number;
  l2: number;
  sparsity: number;

  lowerFence: number;
  upperFence: number;
  outliers: number;

  uniqueCount: number | null;
  uniqueExact: boolean;
  topValues: ValueCount[] | null;

  histogram: Histogram | null;

  /** True when every finite value is an exact integer. */
  integral: boolean;
  /** Values in `[0, 1]` — a hint that the data is normalised imagery/probabilities. */
  unitRange: boolean;
}

export interface AxisStats {
  label: string;
  index: number;
  count: number;
  min: number;
  max: number;
  mean: number;
  std: number;
  nan: number;
  zeros: number;
}

export interface StatsBundle {
  overall: NumericStats | null;
  /** Per-channel breakdown for image-like arrays. */
  channels: AxisStats[] | null;
  /** Per-column breakdown for tabular 2-D arrays. */
  columns: AxisStats[] | null;
  /** Human-readable observations, e.g. "looks like one-hot labels". */
  insights: Insight[];
  /** Milliseconds spent computing. */
  elapsedMs: number;
  /** Data was too exotic for numeric statistics (object/str dtypes). */
  unsupported?: string;
}

export interface Insight {
  level: "info" | "good" | "warn";
  title: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// Layout / view detection
// ---------------------------------------------------------------------------

export type ViewKind =
  | "image"
  | "grid"
  | "heatmap"
  | "line"
  | "scalar"
  | "table"
  | "text";

export type ChannelOrder = "channel-last" | "channel-first" | "none";

/**
 * Canonical reading of an N-d array as a stack of `frameCount` 2-D planes of
 * `height x width x channels`. Every visual renderer consumes this one shape,
 * so image / grid / heatmap / slice-navigation all share a single read path.
 */
export interface Layout {
  rowAxis: number;
  colAxis: number;
  channelAxis: number | null;
  /** Axes iterated over to enumerate frames, outermost first. */
  frameAxes: number[];
  frameShape: number[];
  frameCount: number;
  height: number;
  width: number;
  channels: number;
  order: ChannelOrder;
}

export interface Detection {
  primary: ViewKind;
  available: ViewKind[];
  layout: Layout | null;
  /** Alternative channel interpretation the user can flip to, when ambiguous. */
  alternateLayout: Layout | null;
  /** Short sentence explaining why this view was chosen. */
  reason: string;
  /** Semantic label, e.g. `RGB image`, `image batch`, `feature matrix`. */
  semantic: string;
  /** Suggested display range for imagery, `null` to auto-scale. */
  displayRange: [number, number] | null;
  isImageLike: boolean;
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export type PreviewEncoding = "u8" | "f32";

/** A decimated block of numbers, base64-encoded for transport. */
export interface Block {
  encoding: PreviewEncoding;
  data: string;
  /** `[frames, height, width, channels]` of the decoded block. */
  shape: [number, number, number, number];
  /** Source frame indices, parallel to the frame axis of `shape`. */
  frames: number[];
  /** Decimation factor applied to rows and columns. */
  step: [number, number];
  downsampled: boolean;
  /** Min/max of this block, useful for local contrast stretching. */
  blockMin: number;
  blockMax: number;
}

export interface BackendInfo {
  kind: "python" | "typescript";
  label: string;
  detail: string;
  pythonPath?: string;
  pythonVersion?: string;
  numpyVersion?: string;
  /** Present when Python was wanted but unusable. */
  fallbackReason?: string;
  showInstallHint: boolean;
}

export interface ViewerConfig {
  colormap: string;
  autoNormalize: boolean;
  imageMaxSide: number;
  histogramBins: number;
}

export interface InitPayload {
  fileName: string;
  filePath: string;
  meta: ArrayMeta;
  detection: Detection;
  backend: BackendInfo;
  config: ViewerConfig;
  /** Absent when the dtype has no numeric interpretation. */
  stats: StatsBundle;
  /** First frames, ready to draw. Null for non-visual dtypes. */
  preview: Block | null;
  /** Small thumbnails covering the frame stack, for the grid view. */
  thumbnails: Block | null;
  /** Rendered representation for text/object/struct dtypes. */
  textPreview: TextPreview | null;
  warnings: string[];
}

export interface TextPreview {
  columns: string[];
  rows: string[][];
  totalRows: number;
}

export interface TableWindow {
  /** Fixed leading indices identifying the plane. */
  frame: number;
  rowStart: number;
  colStart: number;
  rowCount: number;
  colCount: number;
  totalRows: number;
  totalCols: number;
  /** `rowCount` arrays of `colCount` formatted values. */
  cells: string[][];
  /** Parallel numeric values for conditional shading; NaN where not numeric. */
  values: number[][];
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type HostMessage =
  | { type: "init"; payload: InitPayload }
  | { type: "block"; requestId: number; payload: Block }
  | { type: "table"; requestId: number; payload: TableWindow }
  | { type: "config"; payload: ViewerConfig }
  | { type: "status"; message: string; busy: boolean }
  | { type: "error"; requestId?: number; message: string; detail?: string };

export type WebviewMessage =
  | { type: "ready" }
  | {
      type: "requestBlock";
      requestId: number;
      frames: number[];
      maxSide: number;
      useAlternateLayout: boolean;
    }
  | {
      type: "requestTable";
      requestId: number;
      frame: number;
      rowStart: number;
      colStart: number;
      rowCount: number;
      colCount: number;
      useAlternateLayout: boolean;
    }
  | { type: "command"; name: WebviewCommand; payload?: unknown };

export type WebviewCommand =
  | "installPython"
  | "selectPython"
  | "dismissPythonHint"
  | "reload"
  | "copyText"
  | "saveImage"
  | "exportCsv"
  | "openSettings";
