/** Compact number rendering shared by tiles, axes and tooltips. */
export function fmt(value: number, precision = 6): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "NaN";
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? "∞" : "-∞";
  }
  if (value === 0) {
    return "0";
  }
  if (Number.isInteger(value) && Math.abs(value) < 1e15) {
    return value.toLocaleString();
  }
  const magnitude = Math.abs(value);
  if (magnitude < 1e-4 || magnitude >= 1e9) {
    return value.toExponential(3);
  }
  return Number(value.toPrecision(precision)).toLocaleString(undefined, {
    maximumFractionDigits: 6,
  });
}

/** Axis-tick rendering: shorter than {@link fmt}, and never exponential twice. */
export function fmtTick(value: number): string {
  if (!Number.isFinite(value)) {
    return "";
  }
  const magnitude = Math.abs(value);
  if (magnitude === 0) {
    return "0";
  }
  if (magnitude < 1e-3 || magnitude >= 1e6) {
    return value.toExponential(1).replace("e+", "e");
  }
  if (Number.isInteger(value)) {
    return value.toLocaleString();
  }
  return Number(value.toPrecision(4)).toString();
}

export function fmtCount(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString() : "—";
}

export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) {
    return "—";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ${units[unit]}`;
}

export function fmtPercent(part: number, whole: number): string {
  if (!whole) {
    return "0%";
  }
  const ratio = part / whole;
  if (ratio === 0) {
    return "0%";
  }
  if (ratio < 0.0001) {
    return "<0.01%";
  }
  return `${(ratio * 100).toFixed(ratio < 0.01 ? 3 : 2)}%`;
}

export function fmtShape(shape: number[]): string {
  if (shape.length === 0) {
    return "()";
  }
  return `(${shape.map((d) => d.toLocaleString()).join(", ")}${shape.length === 1 ? "," : ""})`;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  return `${(ms / 1000).toFixed(2)} s`;
}
