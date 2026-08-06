import type { DtypeKind, StructField } from "../common/types";

export interface ParsedDtype {
  descr: string;
  kind: DtypeKind;
  itemsize: number;
  littleEndian: boolean;
  /** Canonical NumPy name, e.g. `float32`, `datetime64[ns]`, `<U12`. */
  name: string;
  timeUnit?: string;
  fields?: StructField[];
  /** False for dtypes this build cannot decode without NumPy. */
  readable: boolean;
  /** Scalar values are naturally numbers (so statistics apply). */
  numeric: boolean;
}

const SIMPLE_NAMES: Record<string, string> = {
  b1: "bool",
  i1: "int8",
  i2: "int16",
  i4: "int32",
  i8: "int64",
  u1: "uint8",
  u2: "uint16",
  u4: "uint32",
  u8: "uint64",
  f2: "float16",
  f4: "float32",
  f8: "float64",
  f16: "float128",
  c8: "complex64",
  c16: "complex128",
};

/**
 * Interprets a NumPy `descr` string such as `<f4`, `|u1`, `>i8`, `<M8[ns]`,
 * `|S16` or `<U12`.
 */
export function parseDescr(descr: string): ParsedDtype {
  const match = /^([<>|=])?([biufcSUVOMm])(\d*)(\[[^\]]+\])?$/.exec(
    descr.trim(),
  );
  if (!match) {
    throw new Error(
      `Unrecognised NumPy dtype descriptor: ${JSON.stringify(descr)}`,
    );
  }

  const [, byteOrderRaw, typeChar, sizeRaw, unitRaw] = match;
  const byteOrder = byteOrderRaw ?? "|";
  const littleEndian = byteOrder !== ">";
  const size = sizeRaw ? Number.parseInt(sizeRaw, 10) : 0;
  const timeUnit = unitRaw ? unitRaw.slice(1, -1) : undefined;

  const base = (
    kind: DtypeKind,
    itemsize: number,
    name: string,
    opts?: Partial<ParsedDtype>,
  ): ParsedDtype => ({
    descr,
    kind,
    itemsize,
    littleEndian,
    name,
    timeUnit,
    readable: true,
    numeric: true,
    ...opts,
  });

  switch (typeChar) {
    case "b":
      return base("bool", 1, "bool");
    case "i":
    case "u": {
      const key = `${typeChar}${size}`;
      const name = SIMPLE_NAMES[key];
      if (!name) {
        throw new Error(`Unsupported integer width in dtype ${descr}`);
      }
      return base(typeChar === "i" ? "int" : "uint", size, name);
    }
    case "f": {
      const name = SIMPLE_NAMES[`f${size}`];
      if (!name) {
        throw new Error(`Unsupported float width in dtype ${descr}`);
      }
      // float128 is platform long-double; there is no JS equivalent.
      return base("float", size, name, {
        readable: size !== 16,
        numeric: size !== 16,
      });
    }
    case "c": {
      const name = SIMPLE_NAMES[`c${size}`];
      if (!name) {
        throw new Error(`Unsupported complex width in dtype ${descr}`);
      }
      // Statistics run over the magnitude of each complex value.
      return base("complex", size, name);
    }
    case "S":
      return base("bytes", size, `bytes${size}`, { numeric: false });
    case "U":
      // NumPy stores UTF-32 code points, four bytes per character.
      return base("str", size * 4, `str${size}`, { numeric: false });
    case "M":
      return base(
        "datetime",
        size || 8,
        `datetime64${timeUnit ? `[${timeUnit}]` : ""}`,
      );
    case "m":
      return base(
        "timedelta",
        size || 8,
        `timedelta64${timeUnit ? `[${timeUnit}]` : ""}`,
      );
    case "V":
      return base("struct", size, `void${size}`, { numeric: false });
    case "O":
      return base("object", 8, "object", { readable: false, numeric: false });
    default:
      throw new Error(`Unsupported NumPy dtype: ${descr}`);
  }
}

/**
 * Builds a dtype for a structured (record) array from the header's list form,
 * e.g. `[('x', '<f8'), ('rgb', '|u1', (3,))]`.
 */
export function parseStructuredDescr(entries: unknown[]): ParsedDtype {
  const fields: StructField[] = [];
  let offset = 0;

  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 2) {
      throw new Error("Malformed structured dtype entry in NPY header");
    }
    const name = String(entry[0]);
    const sub = entry[1];
    const shape = normaliseFieldShape(entry[2]);
    const repeat = shape.reduce((a, b) => a * b, 1);

    if (typeof sub !== "string") {
      // Nested records are rare; surface them without decoding.
      throw new Error(
        `Nested structured dtype in field "${name}" needs NumPy to read`,
      );
    }

    const parsed = parseDescr(sub);
    fields.push({
      name,
      descr: sub,
      dtype: parsed.name,
      kind: parsed.kind,
      offset,
      itemsize: parsed.itemsize,
      shape,
    });
    offset += parsed.itemsize * repeat;
  }

  return {
    descr: JSON.stringify(entries),
    kind: "struct",
    itemsize: offset,
    littleEndian: true,
    name: `record[${fields.length} fields]`,
    fields,
    readable: true,
    numeric: false,
  };
}

function normaliseFieldShape(raw: unknown): number[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (typeof raw === "number") {
    return [raw];
  }
  if (Array.isArray(raw)) {
    return raw.map((n) => Number(n));
  }
  return [];
}

// ---------------------------------------------------------------------------
// Scalar decoding
// ---------------------------------------------------------------------------

export type ScalarReader = (view: DataView, byteOffset: number) => number;

/** Decodes an IEEE 754 half-precision float, which `DataView` predates. */
export function readFloat16(
  view: DataView,
  byteOffset: number,
  littleEndian: boolean,
): number {
  const bits = view.getUint16(byteOffset, littleEndian);
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x03ff;

  if (exponent === 0) {
    return sign * 2 ** -14 * (fraction / 1024);
  }
  if (exponent === 0x1f) {
    return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  }
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/**
 * Returns a function that reads one element as a JS number.
 *
 * Complex values collapse to their magnitude and 64-bit integers lose precision
 * beyond 2^53 — both are fine for statistics and plotting. Exact values for the
 * data table go through {@link formatScalar} instead.
 */
export function makeScalarReader(dtype: ParsedDtype): ScalarReader {
  const le = dtype.littleEndian;

  switch (dtype.kind) {
    case "bool":
      return (v, o) => v.getUint8(o);
    case "int":
      switch (dtype.itemsize) {
        case 1:
          return (v, o) => v.getInt8(o);
        case 2:
          return (v, o) => v.getInt16(o, le);
        case 4:
          return (v, o) => v.getInt32(o, le);
        default:
          return (v, o) => Number(v.getBigInt64(o, le));
      }
    case "uint":
      switch (dtype.itemsize) {
        case 1:
          return (v, o) => v.getUint8(o);
        case 2:
          return (v, o) => v.getUint16(o, le);
        case 4:
          return (v, o) => v.getUint32(o, le);
        default:
          return (v, o) => Number(v.getBigUint64(o, le));
      }
    case "float":
      switch (dtype.itemsize) {
        case 2:
          return (v, o) => readFloat16(v, o, le);
        case 4:
          return (v, o) => v.getFloat32(o, le);
        default:
          return (v, o) => v.getFloat64(o, le);
      }
    case "complex":
      if (dtype.itemsize === 8) {
        return (v, o) =>
          Math.hypot(v.getFloat32(o, le), v.getFloat32(o + 4, le));
      }
      return (v, o) => Math.hypot(v.getFloat64(o, le), v.getFloat64(o + 8, le));
    case "datetime":
    case "timedelta":
      return (v, o) => {
        const raw = v.getBigInt64(o, le);
        // NumPy encodes NaT as INT64_MIN.
        return raw === -9223372036854775808n ? Number.NaN : Number(raw);
      };
    default:
      return () => Number.NaN;
  }
}

const TIME_UNIT_TO_MS: Record<string, number> = {
  Y: 365.2425 * 86400000,
  M: 30.436875 * 86400000,
  W: 7 * 86400000,
  D: 86400000,
  h: 3600000,
  m: 60000,
  s: 1000,
  ms: 1,
  us: 1e-3,
  ns: 1e-6,
  ps: 1e-9,
  fs: 1e-12,
  as: 1e-15,
};

/** Converts a raw `datetime64` tick count to a JS epoch-milliseconds value. */
export function datetimeToMs(
  raw: number,
  unit: string | undefined,
): number | null {
  const scale = unit ? TIME_UNIT_TO_MS[unit] : undefined;
  if (scale === undefined || !Number.isFinite(raw)) {
    return null;
  }
  return raw * scale;
}

/**
 * Renders one element exactly, as it would appear in a data table. Unlike
 * {@link makeScalarReader} this keeps full 64-bit integer precision and shows
 * complex numbers, strings and timestamps in their natural form.
 */
export function formatScalar(
  view: DataView,
  byteOffset: number,
  dtype: ParsedDtype,
): string {
  const le = dtype.littleEndian;

  switch (dtype.kind) {
    case "bool":
      return view.getUint8(byteOffset) ? "True" : "False";
    case "int":
      if (dtype.itemsize === 8) {
        return view.getBigInt64(byteOffset, le).toString();
      }
      break;
    case "uint":
      if (dtype.itemsize === 8) {
        return view.getBigUint64(byteOffset, le).toString();
      }
      break;
    case "complex": {
      const wide = dtype.itemsize === 16;
      const re = wide
        ? view.getFloat64(byteOffset, le)
        : view.getFloat32(byteOffset, le);
      const im = wide
        ? view.getFloat64(byteOffset + 8, le)
        : view.getFloat32(byteOffset + 4, le);
      const sign = im < 0 || Object.is(im, -0) ? "-" : "+";
      return `${trimNumber(re)}${sign}${trimNumber(Math.abs(im))}j`;
    }
    case "bytes": {
      const bytes = new Uint8Array(
        view.buffer,
        view.byteOffset + byteOffset,
        dtype.itemsize,
      );
      let end = bytes.length;
      while (end > 0 && bytes[end - 1] === 0) {
        end -= 1;
      }
      return latin1(bytes.subarray(0, end));
    }
    case "str": {
      const chars: string[] = [];
      for (let i = 0; i < dtype.itemsize; i += 4) {
        const code = view.getUint32(byteOffset + i, le);
        if (code === 0) {
          break;
        }
        chars.push(String.fromCodePoint(code));
      }
      return chars.join("");
    }
    case "datetime": {
      const raw = view.getBigInt64(byteOffset, le);
      if (raw === -9223372036854775808n) {
        return "NaT";
      }
      const ms = datetimeToMs(Number(raw), dtype.timeUnit);
      if (ms === null || !Number.isFinite(ms) || Math.abs(ms) > 8.64e15) {
        return raw.toString();
      }
      return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
    }
    case "timedelta": {
      const raw = view.getBigInt64(byteOffset, le);
      return raw === -9223372036854775808n
        ? "NaT"
        : `${raw.toString()}${dtype.timeUnit ? ` ${dtype.timeUnit}` : ""}`;
    }
    case "object":
      return "<object>";
    default:
      break;
  }

  const reader = makeScalarReader(dtype);
  return trimNumber(reader(view, byteOffset));
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    out += String.fromCharCode(b);
  }
  return out;
}

/** Compact, lossless-enough number rendering for tables and labels. */
export function trimNumber(value: number): string {
  if (Number.isNaN(value)) {
    return "NaN";
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? "inf" : "-inf";
  }
  if (Number.isInteger(value) && Math.abs(value) < 1e15) {
    return String(value);
  }
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e9)) {
    return value.toExponential(4);
  }
  return String(Number(value.toPrecision(7)));
}
