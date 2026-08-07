#!/usr/bin/env python
"""Analysis helper for the NPY Viewer VS Code extension.

Invoked as a short-lived subprocess. Everything is written to stdout as a
single JSON object; nothing else is printed, so the extension can parse the
output verbatim.

Modes
  probe    report interpreter and NumPy versions
  meta     header fields, used when the built-in TypeScript parser cannot read
           an exotic dtype
  analyze  full descriptive statistics, plus a text preview for dtypes that
           have no numeric meaning

NumPy is used for the statistics pass because it is one to two orders of
magnitude faster than the JavaScript fallback on large arrays, and because it
computes exact quantiles on arrays far larger than the fallback can sort.
"""

import sys
import json
import math
import argparse

PERCENTILES = [0.1, 1, 5, 10, 25, 50, 75, 90, 95, 99, 99.9]

# Elements processed per chunk when reducing over a memory-mapped array.
CHUNK = 8_000_000

# Distinct values tracked before cardinality is reported as unknown.
MAX_UNIQUE = 8192

# Groups (channels / columns) broken out individually.
MAX_GROUPS = 512

# Above this, per-group breakdowns are skipped to bound peak memory.
MAX_GROUP_BYTES = 2 * 1024**3

TEXT_PREVIEW_ROWS = 500


def emit(payload):
    """Writes one JSON object to stdout and exits."""
    sys.stdout.write(json.dumps(payload, allow_nan=False, default=_fallback))
    sys.stdout.flush()


def _fallback(obj):
    try:
        return obj.item()
    except AttributeError:
        return str(obj)


def clean(value):
    """JSON has no NaN or Infinity, so non-finite floats travel as null."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def kind_of(dtype):
    mapping = {
        "b": "bool",
        "i": "int",
        "u": "uint",
        "f": "float",
        "c": "complex",
        "S": "bytes",
        "U": "str",
        "M": "datetime",
        "m": "timedelta",
        "O": "object",
        "V": "struct",
    }
    return mapping.get(dtype.kind, "object")


def to_numeric(np, arr):
    """Maps an array onto the real values statistics are computed over."""
    dtype = arr.dtype
    if dtype.kind == "c":
        # Magnitude is the meaningful scalar summary of a complex array.
        return np.abs(arr), "magnitude"
    if dtype.kind == "b":
        return arr.view(np.uint8), "boolean"
    if dtype.kind in ("M", "m"):
        return arr.view(np.int64), "ticks"
    if dtype.kind in ("i", "u", "f"):
        return arr, "value"
    return None, "unsupported"


def chunks(total, size=CHUNK):
    start = 0
    while start < total:
        stop = min(start + size, total)
        yield start, stop
        start = stop


def finite_values(np, block, exact):
    """
    Drops non-finite entries, skipping the mask entirely when the dtype cannot
    hold them. Integer and boolean data can never be NaN or infinite, and the
    mask plus fancy-index copy is the most expensive step in the pass.
    """
    if exact:
        return block, 0, 0, 0

    nan = int(np.count_nonzero(np.isnan(block)))
    posinf = int(np.count_nonzero(np.isposinf(block)))
    neginf = int(np.count_nonzero(np.isneginf(block)))
    if nan + posinf + neginf == 0:
        return block, 0, 0, 0
    return block[np.isfinite(block)], nan, posinf, neginf


def reduce_pass_one(np, flat):
    """Counts, extrema and raw sums, accumulated in float64 over chunks."""
    kind = flat.dtype.kind
    # Integer, boolean and datetime data is exact: no NaN, no infinities, and
    # every value is by definition a whole number.
    exact = kind in "iubMm"

    state = {
        "total": int(flat.size),
        "n": 0,
        "nan": 0,
        "posinf": 0,
        "neginf": 0,
        "zeros": 0,
        "negatives": 0,
        "positives": 0,
        "min": math.inf,
        "max": -math.inf,
        "sum": 0.0,
        "l1": 0.0,
        "l2sq": 0.0,
        "integral": True,
    }

    for start, stop in chunks(flat.size):
        block = np.asarray(flat[start:stop])
        values, nan, posinf, neginf = finite_values(np, block, exact)
        state["nan"] += nan
        state["posinf"] += posinf
        state["neginf"] += neginf

        if values.size == 0:
            continue

        state["n"] += int(values.size)
        state["zeros"] += int(np.count_nonzero(values == 0))
        state["negatives"] += int(np.count_nonzero(values < 0)) if kind != "u" else 0
        state["positives"] += int(np.count_nonzero(values > 0))
        state["min"] = min(state["min"], float(values.min()))
        state["max"] = max(state["max"], float(values.max()))
        state["sum"] += float(values.sum(dtype=np.float64))

        # Unsigned values are their own magnitude, so abs() can be skipped.
        state["l1"] += float(
            values.sum(dtype=np.float64)
            if kind in "ub"
            else np.abs(values).sum(dtype=np.float64)
        )
        state["l2sq"] += float(
            np.square(values, dtype=np.float64).sum(dtype=np.float64)
        )

        if not exact and state["integral"]:
            if not bool(np.all(np.equal(np.mod(values, 1), 0))):
                state["integral"] = False

    return state


def reduce_pass_two(np, flat, mean):
    """Central moments about the exact mean, so skew and kurtosis stay stable."""
    exact = flat.dtype.kind in "iubMm"
    m2 = m3 = m4 = 0.0

    for start, stop in chunks(flat.size):
        block = np.asarray(flat[start:stop])
        values, _, _, _ = finite_values(np, block, exact)
        if values.size == 0:
            continue

        delta = np.subtract(values, mean, dtype=np.float64)
        squared = np.square(delta)
        # np.dot dispatches to BLAS, which is markedly faster than sum().
        m2 += float(np.dot(delta, delta))
        m3 += float(np.dot(squared, delta))
        m4 += float(np.dot(squared, squared))

    return m2, m3, m4


def gather_sample(np, flat, limit):
    """Every finite value when the array is small enough, else a uniform sample."""
    if flat.size <= limit:
        values = np.asarray(flat, dtype=np.float64).ravel()
        return values[np.isfinite(values)], False

    rng = np.random.default_rng(0)
    indices = np.unique(rng.integers(0, flat.size, size=limit))
    values = np.asarray(flat.reshape(-1)[indices], dtype=np.float64)
    return values[np.isfinite(values)], True


def group_stats(np, arr, axis, label):
    """Per-channel or per-column summaries by reducing over every other axis."""
    if axis is None or axis < 0 or axis >= arr.ndim:
        return None
    extent = int(arr.shape[axis])
    if extent <= 1 or extent > MAX_GROUPS:
        return None
    if arr.nbytes > MAX_GROUP_BYTES:
        return None

    moved = np.moveaxis(np.asarray(arr), axis, 0).reshape(extent, -1)
    out = []
    for index in range(extent):
        row = np.asarray(moved[index], dtype=np.float64)
        finite = row[np.isfinite(row)]
        out.append(
            {
                "label": "%s %d" % (label, index),
                "index": index,
                "count": int(finite.size),
                "min": clean(finite.min()) if finite.size else None,
                "max": clean(finite.max()) if finite.size else None,
                "mean": clean(finite.mean()) if finite.size else None,
                "std": clean(finite.std(ddof=1)) if finite.size > 1 else 0.0,
                "nan": int(np.count_nonzero(np.isnan(row))),
                "zeros": int(np.count_nonzero(finite == 0)) if finite.size else 0,
            }
        )
    return out


def build_histogram(np, sample, state, bins, scale):
    if (
        sample.size == 0
        or not math.isfinite(state["min"])
        or not math.isfinite(state["max"])
    ):
        return None

    lo, hi = state["min"], state["max"]
    count = bins
    span = hi - lo

    if state["integral"] and span > 0 and span + 1 <= bins:
        # One bin per integer value reads far better than arbitrary buckets.
        count = int(span) + 1
        lo, hi = lo - 0.5, hi + 0.5

    if not hi > lo:
        # Padding by a fixed 0.5 is a no-op once the values are large enough
        # that half a unit falls below one ulp — at 6e23 the spacing is already
        # 6.7e7. Scale the padding to the magnitude so a constant array still
        # gets a drawable range.
        pad = max(abs(lo) * 1e-9, 0.5)
        lo, hi = lo - pad, hi + pad

    counts, edges = np.histogram(sample, bins=count, range=(lo, hi))
    if scale > 1.0001:
        counts = np.rint(counts * scale).astype(np.int64)

    return {
        "binEdges": [clean(edge) for edge in edges.tolist()],
        "counts": [int(value) for value in counts.tolist()],
        "excludedNonFinite": state["nan"] + state["posinf"] + state["neginf"],
    }


def unique_summary(np, sample, scale):
    if sample.size == 0:
        return None, True, None

    values, counts = np.unique(sample, return_counts=True)
    if values.size > MAX_UNIQUE:
        return None, False, None

    order = np.argsort(-counts)[:12]
    top = [
        {
            "value": clean(values[i]),
            "count": int(round(float(counts[i]) * scale)),
            "label": format_number(float(values[i])),
        }
        for i in order
    ]
    return int(values.size), True, top


def format_number(value):
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "inf" if value > 0 else "-inf"
    if value == int(value) and abs(value) < 1e15:
        return str(int(value))
    magnitude = abs(value)
    if magnitude and (magnitude < 1e-4 or magnitude >= 1e9):
        return "%.4e" % value
    return repr(round(value, 7))


def analyze_numeric(np, arr, args):
    numeric, interpretation = to_numeric(np, arr)
    if numeric is None:
        return None, None, None, interpretation
    if arr.size == 0:
        # Summarising nothing produces a table of NaNs; say so instead.
        return None, None, None, "empty"

    flat = numeric.reshape(-1)
    state = reduce_pass_one(np, flat)

    if state["n"] == 0:
        mean = float("nan")
        m2 = m3 = m4 = 0.0
    else:
        mean = state["sum"] / state["n"]
        m2, m3, m4 = reduce_pass_two(np, flat, mean)

    n = state["n"]
    variance = m2 / (n - 1) if n > 1 else 0.0
    std = math.sqrt(variance)
    skewness = (math.sqrt(n) * m3) / m2**1.5 if n > 2 and m2 > 0 else 0.0
    kurtosis = (n * m4) / (m2 * m2) - 3 if n > 3 and m2 > 0 else 0.0

    sample, approximate = gather_sample(np, flat, args.exact_limit)
    scale = (n / sample.size) if sample.size else 1.0

    percentiles = {}
    if sample.size:
        computed = np.percentile(sample, PERCENTILES)
        for key, value in zip(PERCENTILES, np.atleast_1d(computed)):
            percentiles[_percentile_key(key)] = clean(value)
    else:
        for key in PERCENTILES:
            percentiles[_percentile_key(key)] = None

    median = percentiles["50"]
    q1 = percentiles["25"]
    q3 = percentiles["75"]
    iqr = (q3 - q1) if (q1 is not None and q3 is not None) else float("nan")
    lower = (q1 - 1.5 * iqr) if q1 is not None else float("nan")
    upper = (q3 + 1.5 * iqr) if q3 is not None else float("nan")

    if sample.size and math.isfinite(lower) and math.isfinite(upper):
        outliers = int(
            round(float(np.count_nonzero((sample < lower) | (sample > upper))) * scale)
        )
    else:
        outliers = 0

    mad = (
        clean(np.median(np.abs(sample - median)))
        if sample.size and median is not None
        else None
    )
    unique_count, unique_exact, top_values = unique_summary(np, sample, scale)
    has_spread = math.isfinite(state["min"]) and math.isfinite(state["max"])

    stats = {
        "approximate": approximate,
        "sampleSize": int(sample.size),
        "total": state["total"],
        "finite": n,
        "nan": state["nan"],
        "posInf": state["posinf"],
        "negInf": state["neginf"],
        "zeros": state["zeros"],
        "negatives": state["negatives"],
        "positives": state["positives"],
        "min": clean(state["min"]) if has_spread else None,
        "max": clean(state["max"]) if has_spread else None,
        "range": clean(state["max"] - state["min"]) if has_spread else None,
        "sum": clean(state["sum"]),
        "mean": clean(mean),
        "variance": clean(variance),
        "std": clean(std),
        "sem": clean(std / math.sqrt(n)) if n > 1 else 0.0,
        "skewness": clean(skewness),
        "kurtosis": clean(kurtosis),
        # Only meaningful on ratio-scale data; omitted when values span zero.
        "cv": (
            clean(std / mean)
            if (n and has_spread and state["min"] >= 0 and mean > 1e-12)
            else None
        ),
        "median": median,
        "percentiles": percentiles,
        "iqr": clean(iqr),
        "madMedian": mad,
        "l1": clean(state["l1"]),
        "l2": clean(math.sqrt(state["l2sq"])),
        "sparsity": (state["zeros"] / state["total"]) if state["total"] else 0.0,
        "lowerFence": clean(lower),
        "upperFence": clean(upper),
        "outliers": outliers,
        "uniqueCount": unique_count,
        "uniqueExact": unique_exact,
        "topValues": top_values,
        "histogram": build_histogram(np, sample, state, args.hist_bins, scale),
        "integral": state["integral"],
        "unitRange": has_spread
        and state["min"] >= 0
        and state["max"] <= 1
        and not state["integral"],
    }

    channels = group_stats(np, numeric, args.channel_axis, "Channel")
    columns = group_stats(np, numeric, args.column_axis, "Column")
    return stats, channels, columns, interpretation


def _percentile_key(value):
    return str(int(value)) if float(value).is_integer() else str(value)


def text_preview(np, arr):
    """Renders string, bytes, record and object arrays as a plain table."""
    flat = arr.reshape(-1) if arr.ndim else arr.reshape(1)
    names = arr.dtype.names

    if names:
        columns = ["index"] + [
            "%s (%s)" % (name, arr.dtype[name].str) for name in names
        ]
        rows = []
        for i in range(min(flat.size, TEXT_PREVIEW_ROWS)):
            record = flat[i]
            rows.append([str(i)] + [_render(record[name]) for name in names])
        return {"columns": columns, "rows": rows, "totalRows": int(flat.size)}

    if arr.ndim > 1:
        width = min(int(arr.shape[-1]), 32)
        reshaped = arr.reshape(-1, arr.shape[-1])
        columns = ["index"] + [str(i) for i in range(width)]
        rows = []
        for i in range(min(reshaped.shape[0], TEXT_PREVIEW_ROWS)):
            rows.append([str(i)] + [_render(reshaped[i, j]) for j in range(width)])
        return {"columns": columns, "rows": rows, "totalRows": int(reshaped.shape[0])}

    columns = ["index", "value"]
    rows = [
        [str(i), _render(flat[i])] for i in range(min(flat.size, TEXT_PREVIEW_ROWS))
    ]
    return {"columns": columns, "rows": rows, "totalRows": int(flat.size)}


def _render(value):
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return repr(value)
    text = str(value)
    return text if len(text) <= 200 else text[:197] + "..."


def load_array(np, path):
    """Opens the array, memory-mapping it when the dtype allows."""
    try:
        return np.load(path, mmap_mode="r", allow_pickle=False), False
    except ValueError:
        # Object arrays are pickled and cannot be memory-mapped.
        return np.load(path, allow_pickle=True), True


def read_header(path):
    """Reads format version, header length and the raw header dict."""
    from numpy.lib import format as npformat

    with open(path, "rb") as handle:
        version = npformat.read_magic(handle)
        if version == (1, 0):
            shape, fortran, dtype = npformat.read_array_header_1_0(handle)
        else:
            shape, fortran, dtype = npformat.read_array_header_2_0(handle)
        return {
            "version": "%d.%d" % version,
            "headerBytes": handle.tell(),
            "shape": [int(d) for d in shape],
            "fortranOrder": bool(fortran),
            "dtype": dtype,
        }


def describe(arr, path, pickled):
    import os

    dtype = arr.dtype
    fields = None
    if dtype.names:
        fields = []
        for name in dtype.names:
            sub, sub_offset = dtype.fields[name][0], dtype.fields[name][1]
            base = sub.subdtype[0] if sub.subdtype else sub
            shape = list(sub.subdtype[1]) if sub.subdtype else []
            fields.append(
                {
                    "name": name,
                    "descr": base.str,
                    "dtype": str(base),
                    "kind": kind_of(base),
                    "offset": int(sub_offset),
                    "itemsize": int(base.itemsize),
                    "shape": [int(d) for d in shape],
                }
            )

    try:
        header = read_header(path)
        version = header["version"]
        header_bytes = header["headerBytes"]
        fortran = header["fortranOrder"]
    except Exception:  # noqa: BLE001 - header details are cosmetic
        version = "1.0"
        header_bytes = 0
        fortran = bool(arr.flags.f_contiguous and not arr.flags.c_contiguous)

    try:
        file_bytes = os.path.getsize(path)
    except OSError:
        file_bytes = 0

    return {
        "dtype": str(dtype),
        "descr": dtype.str,
        "kind": kind_of(dtype),
        "itemsize": int(dtype.itemsize),
        "littleEndian": dtype.byteorder != ">",
        "shape": [int(d) for d in arr.shape],
        "ndim": int(arr.ndim),
        "size": int(arr.size),
        "dataBytes": int(arr.nbytes),
        "fortranOrder": fortran,
        "npyVersion": version,
        "headerBytes": header_bytes,
        "fileBytes": file_bytes,
        "fields": fields,
        "pickled": pickled,
    }


def main(argv):
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--mode", required=True, choices=["probe", "meta", "analyze"])
    parser.add_argument("--path")
    parser.add_argument("--exact-limit", type=int, default=20_000_000)
    parser.add_argument("--hist-bins", type=int, default=64)
    parser.add_argument("--channel-axis", type=int, default=-1)
    parser.add_argument("--column-axis", type=int, default=-1)
    args = parser.parse_args(argv)

    if args.channel_axis < 0:
        args.channel_axis = None
    if args.column_axis < 0:
        args.column_axis = None

    try:
        import numpy as np
    except ImportError:
        emit(
            {
                "ok": False,
                "error": "numpy is not installed for this interpreter.",
                "code": "no-numpy",
            }
        )
        return 0

    if args.mode == "probe":
        emit(
            {
                "ok": True,
                "python": "%d.%d.%d" % sys.version_info[:3],
                "numpy": np.__version__,
            }
        )
        return 0

    if not args.path:
        emit({"ok": False, "error": "--path is required.", "code": "bad-args"})
        return 0

    try:
        arr, pickled = load_array(np, args.path)
    except Exception as err:  # noqa: BLE001 - surfaced verbatim to the user
        emit(
            {
                "ok": False,
                "error": "%s: %s" % (type(err).__name__, err),
                "code": "load-failed",
            }
        )
        return 0

    if args.mode == "meta":
        emit({"ok": True, "meta": describe(arr, args.path, pickled)})
        return 0

    try:
        stats, channels, columns, interpretation = analyze_numeric(np, arr, args)
    except Exception as err:  # noqa: BLE001
        emit(
            {
                "ok": False,
                "error": "%s: %s" % (type(err).__name__, err),
                "code": "analyze-failed",
            }
        )
        return 0

    payload = {
        "ok": True,
        "pickled": pickled,
        "interpretation": interpretation,
        "stats": stats,
        "channels": channels,
        "columns": columns,
        "text": None,
    }

    if stats is None:
        try:
            payload["text"] = text_preview(np, arr)
        except Exception as err:  # noqa: BLE001
            payload["textError"] = "%s: %s" % (type(err).__name__, err)

    emit(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
