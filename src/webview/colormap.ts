/**
 * Perceptual colour ramps for magnitude.
 *
 * Each map is stored as evenly spaced anchor colours and expanded to a 256-entry
 * lookup table on first use. The defaults (viridis, magma, inferno, plasma,
 * cividis) are perceptually uniform and colour-vision-deficiency safe by
 * construction; `coolwarm` is the diverging pair used when data straddles zero.
 */

const RAMPS: Record<string, string[]> = {
  viridis: [
    "#440154",
    "#482878",
    "#3e4a89",
    "#31688e",
    "#26828e",
    "#1f9e89",
    "#35b779",
    "#6dcd59",
    "#fde725",
  ],
  magma: [
    "#000004",
    "#180f3d",
    "#440f76",
    "#721f81",
    "#9e2f7f",
    "#cd4071",
    "#f1605d",
    "#fd9668",
    "#fcfdbf",
  ],
  inferno: [
    "#000004",
    "#1b0c41",
    "#4a0c6b",
    "#781c6d",
    "#a52c60",
    "#cf4446",
    "#ed6925",
    "#fca50a",
    "#fcffa4",
  ],
  plasma: [
    "#0d0887",
    "#46039f",
    "#7201a8",
    "#9c179e",
    "#bd3786",
    "#d8576b",
    "#ed7953",
    "#fa9e3b",
    "#f0f921",
  ],
  cividis: [
    "#00224e",
    "#123570",
    "#3b496c",
    "#575d6d",
    "#707173",
    "#8a8678",
    "#a59c74",
    "#c3b369",
    "#fdea45",
  ],
  // A rainbow ramp: not perceptually uniform, but a long-standing convention
  // for depth and attention maps, so it stays available as an explicit choice.
  turbo: [
    "#30123b",
    "#4145ab",
    "#4675ed",
    "#39a2fc",
    "#1bcfd4",
    "#24eca6",
    "#61fc6c",
    "#a4fc3b",
    "#d1e834",
    "#f3c53a",
    "#fe9b2d",
    "#ec5f21",
    "#7a0403",
  ],
  gray: ["#000000", "#ffffff"],
  // Diverging: two poles through a neutral midpoint, for signed data.
  coolwarm: ["#3b4cc0", "#7b9ff9", "#dddddd", "#f49a7b", "#b40426"],
};

export const COLORMAP_NAMES = Object.keys(RAMPS);

/** Maps that read as diverging and should be centred on zero. */
export const DIVERGING = new Set(["coolwarm"]);

const cache = new Map<string, Uint8ClampedArray>();

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** 256-entry RGB lookup table, linearly interpolated between anchors. */
export function lookupTable(name: string): Uint8ClampedArray {
  const cached = cache.get(name);
  if (cached) {
    return cached;
  }

  const anchors = (RAMPS[name] ?? RAMPS.viridis).map(hexToRgb);
  const table = new Uint8ClampedArray(256 * 3);
  const segments = anchors.length - 1;

  for (let i = 0; i < 256; i += 1) {
    const position = (i / 255) * segments;
    const index = Math.min(Math.floor(position), segments - 1);
    const t = position - index;
    const from = anchors[index];
    const to = anchors[index + 1];
    table[i * 3] = from[0] + (to[0] - from[0]) * t;
    table[i * 3 + 1] = from[1] + (to[1] - from[1]) * t;
    table[i * 3 + 2] = from[2] + (to[2] - from[2]) * t;
  }

  cache.set(name, table);
  return table;
}

export function sampleColor(name: string, t: number): string {
  const table = lookupTable(name);
  const index = Math.max(0, Math.min(255, Math.round(t * 255))) * 3;
  return `rgb(${table[index]}, ${table[index + 1]}, ${table[index + 2]})`;
}

/** CSS gradient string for legends and colour-bar swatches. */
export function gradientCss(name: string, steps = 16): string {
  const stops: string[] = [];
  for (let i = 0; i < steps; i += 1) {
    stops.push(sampleColor(name, i / (steps - 1)));
  }
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

export type ScaleMode = "linear" | "log" | "symlog";

/** Dynamic range a log scale covers when the data reaches zero: four decades. */
const LOG_DECADES = 1e4;

export interface RenderOptions {
  min: number;
  max: number;
  colormap: string;
  scale: ScaleMode;
  /** Draw channel data as colour rather than through the ramp. */
  rgb: boolean;
}

/**
 * Normalises one value into `[0, 1]`.
 *
 * Log scaling compresses a wide positive dynamic range; symlog does the same
 * for signed data by working on magnitude around zero.
 */
export function normalise(
  value: number,
  min: number,
  max: number,
  scale: ScaleMode,
): number {
  if (scale === "log") {
    const hi = Math.max(max, Number.MIN_VALUE);
    // Data that reaches zero has no logarithm, so the floor has to come from
    // somewhere. Flooring at a tiny epsilon spans dozens of decades and pushes
    // every real value into the top of the ramp — the picture goes flat. Cap
    // the range at four decades below the maximum instead, which is what a log
    // colour scale is normally understood to mean.
    const lo = min > 0 ? min : hi / LOG_DECADES;
    const span = Math.log(hi) - Math.log(lo);
    if (!(span > 0)) {
      return 0.5;
    }
    const clamped = Math.max(value, lo);
    return (Math.log(clamped) - Math.log(lo)) / span;
  }

  if (scale === "symlog") {
    const bound = Math.max(Math.abs(min), Math.abs(max), 1e-12);
    const scaled =
      Math.sign(value) * (Math.log1p(Math.abs(value)) / Math.log1p(bound));
    return (scaled + 1) / 2;
  }

  const span = max - min;
  return span === 0 ? 0.5 : (value - min) / span;
}

/**
 * Paints one plane of `width x height x channels` values into RGBA pixels.
 *
 * NaN and infinite values are left transparent so gaps in the data read as gaps
 * on screen rather than as a legitimate colour.
 */
export function renderPlane(
  values: Float32Array | Uint8Array,
  offset: number,
  width: number,
  height: number,
  channels: number,
  options: RenderOptions,
  target: Uint8ClampedArray,
): void {
  const { min, max, scale } = options;
  const table = lookupTable(options.colormap);
  const pixels = width * height;

  if (options.rgb && channels >= 3) {
    for (let i = 0; i < pixels; i += 1) {
      const source = offset + i * channels;
      const r = normalise(values[source], min, max, scale);
      const g = normalise(values[source + 1], min, max, scale);
      const b = normalise(values[source + 2], min, max, scale);
      const alpha =
        channels >= 4 ? normalise(values[source + 3], min, max, scale) : 1;
      const finite =
        Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b);

      target[i * 4] = clamp255(r * 255);
      target[i * 4 + 1] = clamp255(g * 255);
      target[i * 4 + 2] = clamp255(b * 255);
      target[i * 4 + 3] = finite ? clamp255(alpha * 255) : 0;
    }
    return;
  }

  for (let i = 0; i < pixels; i += 1) {
    const value = values[offset + i * channels];
    if (!Number.isFinite(value)) {
      target[i * 4 + 3] = 0;
      continue;
    }
    const t = normalise(value, min, max, scale);
    const index = Math.max(0, Math.min(255, Math.round(t * 255))) * 3;
    target[i * 4] = table[index];
    target[i * 4 + 1] = table[index + 1];
    target[i * 4 + 2] = table[index + 2];
    target[i * 4 + 3] = 255;
  }
}

function clamp255(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}
