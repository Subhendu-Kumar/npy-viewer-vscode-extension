import type {
  Layout,
  ViewKind,
  ArrayMeta,
  Detection,
  NumericStats,
} from "../common/types";
import type { ParsedDtype } from "./dtype";

/** Trailing/leading sizes that unambiguously read as colour channels. */
const COLOUR_CHANNELS = new Set([3, 4]);

/** Below this, a 2-D array is more readable as numbers than as a picture. */
const TABLE_PREFERRED_ELEMENTS = 400;

/** Element strides (in items, not bytes) for the array's memory order. */
export function computeStrides(
  shape: number[],
  fortranOrder: boolean,
): number[] {
  const strides = new Array<number>(shape.length).fill(0);
  if (fortranOrder) {
    let acc = 1;
    for (let i = 0; i < shape.length; i += 1) {
      strides[i] = acc;
      acc *= shape[i];
    }
  } else {
    let acc = 1;
    for (let i = shape.length - 1; i >= 0; i -= 1) {
      strides[i] = acc;
      acc *= shape[i];
    }
  }
  return strides;
}

function makeLayout(
  shape: number[],
  rowAxis: number,
  colAxis: number,
  channelAxis: number | null,
  order: Layout["order"],
): Layout {
  const used = new Set<number>([rowAxis, colAxis]);
  if (channelAxis !== null) {
    used.add(channelAxis);
  }
  const frameAxes = shape.map((_, i) => i).filter((i) => !used.has(i));
  const frameShape = frameAxes.map((i) => shape[i]);

  return {
    rowAxis,
    colAxis,
    channelAxis,
    frameAxes,
    frameShape,
    frameCount: frameShape.reduce((a, b) => a * b, 1),
    height: shape[rowAxis],
    width: shape[colAxis],
    channels: channelAxis === null ? 1 : shape[channelAxis],
    order,
  };
}

/** Expands a flat frame number into indices along the layout's frame axes. */
export function frameToIndices(layout: Layout, frame: number): number[] {
  const indices = new Array<number>(layout.frameShape.length).fill(0);
  let remaining = frame;
  for (let i = layout.frameShape.length - 1; i >= 0; i -= 1) {
    const extent = layout.frameShape[i] || 1;
    indices[i] = remaining % extent;
    remaining = Math.floor(remaining / extent);
  }
  return indices;
}

/** Human-readable frame label, e.g. `[2, 0, :, :]`. */
export function describeFrame(
  meta: ArrayMeta,
  layout: Layout,
  frame: number,
): string {
  const indices = frameToIndices(layout, frame);
  const parts = new Array<string>(meta.ndim).fill(":");
  layout.frameAxes.forEach((axis, i) => {
    parts[axis] = String(indices[i]);
  });
  return `[${parts.join(", ")}]`;
}

/**
 * Chooses how to present an array, based purely on its shape and dtype.
 *
 * The result names one canonical 2-D reading (`layout`) that every visual
 * renderer consumes, plus — when channel-first and channel-last are both
 * plausible — the competing reading so the user can flip between them.
 */
export function detectLayout(meta: ArrayMeta, dtype: ParsedDtype): Detection {
  const { shape, ndim } = meta;

  if (!dtype.readable) {
    return {
      primary: "text",
      available: ["text"],
      layout: null,
      alternateLayout: null,
      reason: `${meta.dtype} arrays are stored as pickled Python objects.`,
      semantic: "Object array",
      displayRange: null,
      isImageLike: false,
    };
  }

  if (!dtype.numeric) {
    const semantic =
      dtype.kind === "struct"
        ? "Structured record array"
        : `${meta.dtype} array`;
    return {
      primary: "text",
      available: ["text", "table"],
      layout: null,
      alternateLayout: null,
      reason: "Non-numeric data is shown as a table of values.",
      semantic,
      displayRange: null,
      isImageLike: false,
    };
  }

  if (shape.some((d) => d === 0)) {
    return {
      primary: "text",
      available: ["text"],
      layout: null,
      alternateLayout: null,
      reason: "The array is empty — one of its dimensions is zero.",
      semantic: "Empty array",
      displayRange: null,
      isImageLike: false,
    };
  }

  if (ndim === 0) {
    return {
      primary: "scalar",
      available: ["scalar"],
      layout: null,
      alternateLayout: null,
      reason: "A 0-dimensional array holds a single value.",
      semantic: "Scalar",
      displayRange: null,
      isImageLike: false,
    };
  }

  if (ndim === 1) {
    // A vector reads as a 1 x N plane so the heatmap path still works.
    const layout = makeLayout([1, shape[0]], 0, 1, null, "none");
    layout.frameAxes = [];
    layout.frameShape = [];
    layout.frameCount = 1;
    return {
      primary: "line",
      available: ["line", "heatmap", "table"],
      layout,
      alternateLayout: null,
      reason: `A 1-D vector of ${shape[0].toLocaleString()} values.`,
      semantic: guessVectorSemantic(meta),
      displayRange: null,
      isImageLike: false,
    };
  }

  const { layout, alternate, semantic, reason, imageLike } = planAxes(
    shape,
    ndim,
    meta,
  );

  const available: ViewKind[] = [];
  if (layout.frameCount > 1) {
    available.push("grid");
  }
  available.push("image", "heatmap");
  if (layout.height === 1 || layout.width === 1) {
    available.push("line");
  }
  available.push("table");

  let primary: ViewKind;
  if (imageLike) {
    primary = layout.frameCount > 1 ? "grid" : "image";
  } else if (
    layout.frameCount === 1 &&
    layout.height * layout.width <= TABLE_PREFERRED_ELEMENTS
  ) {
    primary = "table";
  } else if (layout.height === 1 || layout.width === 1) {
    primary = "line";
  } else {
    primary = layout.frameCount > 1 ? "grid" : "heatmap";
  }

  return {
    primary,
    available: dedupe(available),
    layout,
    alternateLayout: alternate,
    reason,
    semantic,
    displayRange: null,
    isImageLike: imageLike,
  };
}

interface AxisPlan {
  layout: Layout;
  alternate: Layout | null;
  semantic: string;
  reason: string;
  imageLike: boolean;
}

function planAxes(shape: number[], ndim: number, meta: ArrayMeta): AxisPlan {
  if (ndim === 2) {
    const [h, w] = shape;
    const layout = makeLayout(shape, 0, 1, null, "none");
    const imageLike = looksLikeGrayscaleImage(h, w, meta);
    // A matrix with a single row or column is a vector wearing a second axis.
    const degenerate = h === 1 || w === 1;
    return {
      layout,
      alternate: null,
      semantic: degenerate
        ? `${guessVectorSemantic(meta)} — shaped ${h.toLocaleString()} x ${w.toLocaleString()}`
        : imageLike
          ? "Single-channel image"
          : `Matrix — ${h.toLocaleString()} rows x ${w.toLocaleString()} columns`,
      reason: imageLike
        ? `${h} x ${w} ${meta.dtype} reads as a grayscale image.`
        : `A 2-D array is shown as a ${h.toLocaleString()} x ${w.toLocaleString()} matrix.`,
      imageLike,
    };
  }

  if (ndim === 3) {
    const [d0, d1, d2] = shape;

    if (COLOUR_CHANNELS.has(d2) && d1 >= 2 && d0 >= 2) {
      const alternate = COLOUR_CHANNELS.has(d0)
        ? makeLayout(shape, 1, 2, 0, "channel-first")
        : null;
      return {
        layout: makeLayout(shape, 0, 1, 2, "channel-last"),
        alternate,
        semantic: d2 === 3 ? "RGB image" : "RGBA image",
        reason: `Trailing axis of ${d2} reads as ${d2 === 3 ? "RGB" : "RGBA"} colour channels (HWC).`,
        imageLike: true,
      };
    }

    if (COLOUR_CHANNELS.has(d0) && d1 >= 2 && d2 >= 2) {
      return {
        layout: makeLayout(shape, 1, 2, 0, "channel-first"),
        alternate: makeLayout(shape, 0, 1, null, "none"),
        semantic:
          d0 === 3 ? "RGB image (channel-first)" : "RGBA image (channel-first)",
        reason: `Leading axis of ${d0} reads as colour channels (CHW), the PyTorch convention.`,
        imageLike: true,
      };
    }

    if (d2 === 1) {
      return {
        layout: makeLayout(shape, 0, 1, 2, "channel-last"),
        alternate: makeLayout(shape, 1, 2, null, "none"),
        semantic: "Single-channel image",
        reason: "A trailing axis of 1 is a single colour channel.",
        imageLike: looksLikeGrayscaleImage(d0, d1, meta),
      };
    }

    // A trailing axis far smaller than the other two is a band/feature axis,
    // not a plane edge — paging through it beats slicing the leading axis.
    if (isBandAxis(d2, d0, d1)) {
      return {
        layout: makeLayout(shape, 0, 1, null, "none"),
        alternate: makeLayout(shape, 1, 2, null, "none"),
        semantic: `${d2} bands of ${d0.toLocaleString()} x ${d1.toLocaleString()}`,
        reason: `The trailing axis of ${d2} is much smaller than the other two, so it reads as a band or feature index.`,
        imageLike: looksLikeGrayscaleImage(d0, d1, meta),
      };
    }

    // A stack of 2-D planes: image batch, volume, or time series of matrices.
    const stackIsImage = looksLikeGrayscaleImage(d1, d2, meta);
    return {
      layout: makeLayout(shape, 1, 2, null, "none"),
      alternate: null,
      semantic: stackIsImage
        ? `Stack of ${d0.toLocaleString()} grayscale images`
        : `Stack of ${d0.toLocaleString()} matrices`,
      reason: `Leading axis of ${d0.toLocaleString()} is treated as a frame index.`,
      imageLike: stackIsImage,
    };
  }

  if (ndim === 4) {
    const [n, a, b, c] = shape;
    const channelLast = COLOUR_CHANNELS.has(c) || c === 1;
    const channelFirst = COLOUR_CHANNELS.has(a) || a === 1;

    if (channelLast && !(channelFirst && !COLOUR_CHANNELS.has(c))) {
      return {
        layout: makeLayout(shape, 1, 2, 3, "channel-last"),
        alternate: channelFirst
          ? makeLayout(shape, 2, 3, 1, "channel-first")
          : null,
        semantic: `Batch of ${n.toLocaleString()} images (NHWC)`,
        reason: `Shape (N, H, W, C) with ${c} channel${c === 1 ? "" : "s"}.`,
        imageLike: true,
      };
    }

    if (channelFirst) {
      return {
        layout: makeLayout(shape, 2, 3, 1, "channel-first"),
        alternate: channelLast
          ? makeLayout(shape, 1, 2, 3, "channel-last")
          : null,
        semantic: `Batch of ${n.toLocaleString()} images (NCHW)`,
        reason: `Shape (N, C, H, W) with ${a} channel${a === 1 ? "" : "s"}, the PyTorch convention.`,
        imageLike: true,
      };
    }

    if (isBandAxis(c, a, b)) {
      return {
        layout: makeLayout(shape, 1, 2, null, "none"),
        alternate: makeLayout(shape, 2, 3, null, "none"),
        semantic: `${n.toLocaleString()} x ${c} planes of ${a} x ${b}`,
        reason: `The trailing axis of ${c} is much smaller than axes 1 and 2, so it reads as a band index.`,
        imageLike: looksLikeGrayscaleImage(a, b, meta),
      };
    }

    return {
      layout: makeLayout(shape, 2, 3, null, "none"),
      alternate: null,
      semantic: `${(n * a).toLocaleString()} planes of ${b} x ${c}`,
      reason: "The two trailing axes form the plane; the rest index frames.",
      imageLike: looksLikeGrayscaleImage(b, c, meta),
    };
  }

  // 5-D and beyond: last two axes are the plane, everything else indexes frames.
  const rowAxis = ndim - 2;
  const colAxis = ndim - 1;
  const layout = makeLayout(shape, rowAxis, colAxis, null, "none");
  return {
    layout,
    alternate: null,
    semantic: `${layout.frameCount.toLocaleString()} planes of ${shape[rowAxis]} x ${shape[colAxis]}`,
    reason: `${ndim}-D array: the two trailing axes form the plane, the leading ${ndim - 2} index frames.`,
    imageLike: false,
  };
}

/**
 * True when `band` is small enough, relative to the two axes forming the plane,
 * that it is better read as a band/feature index than as an edge of the plane.
 *
 * This is what separates `(1400, 1400, 16)` — a 16-band raster — from
 * `(40, 28, 28)`, where the leading axis is the frame index by convention.
 */
function isBandAxis(band: number, planeA: number, planeB: number): boolean {
  const smallestPlaneEdge = Math.min(planeA, planeB);
  return smallestPlaneEdge >= 16 && band * 4 < smallestPlaneEdge;
}

function looksLikeGrayscaleImage(
  h: number,
  w: number,
  meta: ArrayMeta,
): boolean {
  if (h < 8 || w < 8) {
    return false;
  }
  const aspect = Math.max(h, w) / Math.min(h, w);
  if (meta.kind === "uint" && meta.itemsize === 1) {
    return aspect <= 12;
  }
  return aspect <= 4 && h * w >= 256;
}

function guessVectorSemantic(meta: ArrayMeta): string {
  const n = meta.size;
  switch (meta.kind) {
    case "bool":
      return `Boolean mask of ${n.toLocaleString()} values`;
    case "int":
    case "uint":
      return `Integer vector of ${n.toLocaleString()} values`;
    case "datetime":
      return `Timestamp series of ${n.toLocaleString()} values`;
    case "timedelta":
      return `Duration series of ${n.toLocaleString()} values`;
    // Statistics and plots run over |z|, which is worth saying out loud.
    case "complex":
      return `Complex vector of ${n.toLocaleString()} values — summarised by magnitude`;
    default:
      return `Vector of ${n.toLocaleString()} values`;
  }
}

/**
 * Fills in the display range once statistics are known, and sharpens the
 * semantic label with what the values themselves reveal.
 */
export function refineDetection(
  detection: Detection,
  meta: ArrayMeta,
  stats: NumericStats | null,
): Detection {
  if (!stats || !detection.layout) {
    return detection;
  }

  let displayRange: [number, number] | null = null;
  if (meta.kind === "bool") {
    displayRange = [0, 1];
  } else if (meta.kind === "uint" && meta.itemsize === 1) {
    displayRange = [0, 255];
  } else if (stats.unitRange) {
    displayRange = [0, 1];
  } else if (
    detection.isImageLike &&
    stats.min >= -1.05 &&
    stats.max <= 1.05 &&
    stats.min < 0
  ) {
    // The [-1, 1] convention used by many generative models.
    displayRange = [-1, 1];
  }

  let semantic = detection.semantic;
  let isImageLike = detection.isImageLike;
  let primary = detection.primary;

  // Only genuine integer dtypes carry class labels — a float array that happens
  // to hold whole numbers, or datetime ticks, are something else entirely.
  const countable = meta.kind === "int" || meta.kind === "uint";

  if (
    meta.ndim === 1 &&
    countable &&
    stats.min >= 0 &&
    (stats.uniqueCount ?? Number.POSITIVE_INFINITY) <= 1000 &&
    (stats.uniqueCount ?? 0) >= 2 &&
    stats.total >= (stats.uniqueCount ?? 0) * 4
  ) {
    semantic = `Label vector — ${stats.uniqueCount} distinct class${stats.uniqueCount === 1 ? "" : "es"}`;
  } else if (
    meta.ndim === 2 &&
    countable &&
    stats.min >= 0 &&
    stats.max <= 1 &&
    meta.shape[1] <= 4096
  ) {
    semantic = `One-hot matrix — ${meta.shape[1]} classes`;
  }

  if (detection.isImageLike && stats.finite === 0) {
    isImageLike = false;
  }

  // Signed data outside the [-1, 1] convention is a field to be colour-mapped,
  // not a picture; the heatmap defaults suit it far better.
  if (
    isImageLike &&
    stats.negatives > 0 &&
    (stats.min < -1.05 || stats.max > 1.05)
  ) {
    isImageLike = false;
    if (primary === "image") {
      primary = "heatmap";
      semantic = `Signed field — ${meta.shape.map((d) => d.toLocaleString()).join(" x ")}`;
    }
  }

  return { ...detection, primary, displayRange, semantic, isImageLike };
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}
