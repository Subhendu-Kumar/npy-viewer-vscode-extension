#!/usr/bin/env python
"""Exercises the shipped NumPy backend against the sample arrays.

`src/python/npy_load.py` is copied verbatim into the extension, so a mistake in
it ships. This runs it the way the extension does — as a subprocess, parsing the
JSON off stdout — and checks the numbers against NumPy directly.

    python .github/scripts/check_backend.py [sample-dir]
"""

import os
import sys
import json
import math
import subprocess
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LOADER = os.path.join(ROOT, "src", "python", "npy_load.py")
SAMPLES = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "sample-npy-files")

failures = []
checked = 0


def run(*args):
    """Invokes the loader and returns its parsed JSON."""
    result = subprocess.run(
        [sys.executable, LOADER, *args],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if result.returncode != 0:
        raise RuntimeError(f"exit {result.returncode}: {result.stderr.strip()[:400]}")
    if result.stderr.strip():
        # The extension parses stdout only; anything on stderr means a traceback
        # leaked through and the JSON contract is at risk.
        raise RuntimeError(f"unexpected stderr: {result.stderr.strip()[:400]}")
    return json.loads(result.stdout)


def close(got, want, tol):
    if got is None or want is None:
        return got is None and want is None
    if math.isnan(got) and math.isnan(want):
        return True
    return abs(got - want) <= tol * max(abs(got), abs(want), 1.0)


def numeric_view(arr):
    kind = arr.dtype.kind
    if kind == "c":
        return np.abs(arr).reshape(-1).astype(np.float64)
    if kind in "Mm":
        return arr.view(np.int64).reshape(-1).astype(np.float64)
    if kind == "b":
        return arr.view(np.uint8).reshape(-1).astype(np.float64)
    if kind in "iuf":
        return arr.reshape(-1).astype(np.float64)
    return None


def check(name, field, got, want, tol=1e-9):
    global checked
    checked += 1
    if not close(got, want, tol):
        failures.append(f"{name}: {field} got {got!r} want {want!r}")


# --- probe -----------------------------------------------------------------

probe = run("--mode", "probe")
assert probe["ok"], probe
print(f"probe: Python {probe['python']}, NumPy {probe['numpy']}")

# --- every sample ----------------------------------------------------------

names = sorted(f for f in os.listdir(SAMPLES) if f.endswith(".npy"))
if not names:
    print(f"No .npy files in {SAMPLES}", file=sys.stderr)
    sys.exit(2)

for name in names:
    path = os.path.join(SAMPLES, name)
    try:
        payload = run(
            "--mode",
            "analyze",
            "--path",
            path,
            "--exact-limit",
            "5000000",
            "--hist-bins",
            "64",
            "--channel-axis",
            "-1",
            "--column-axis",
            "-1",
        )
    except Exception as err:  # noqa: BLE001 - reported, not raised
        failures.append(f"{name}: {err}")
        continue

    if not payload.get("ok"):
        failures.append(f"{name}: backend reported {payload.get('error')}")
        continue

    stats = payload.get("stats")
    arr = np.load(path, allow_pickle=bool(payload.get("pickled")))

    # Non-numeric dtypes must come back with a text preview instead of stats.
    if stats is None:
        if payload.get("text") is None and arr.size > 0:
            failures.append(f"{name}: neither statistics nor a text preview")
        checked += 1
        continue

    flat = numeric_view(arr)
    if flat is None:
        continue
    finite = flat[np.isfinite(flat)]

    check(name, "total", stats["total"], int(flat.size), 0)
    check(name, "finite", stats["finite"], int(finite.size), 0)
    check(name, "nan", stats["nan"], int(np.count_nonzero(np.isnan(flat))), 0)

    if finite.size == 0:
        continue

    # float64 cannot hold every int64, so allow ulp-scaled slack up at 2**53.
    peak = max(abs(float(finite.min())), abs(float(finite.max())))
    spread = float(finite.max() - finite.min()) or 1.0
    tol = max(1e-9, 4 * float(np.spacing(peak)) / spread) if peak > 2**50 else 1e-9

    check(name, "min", stats["min"], float(finite.min()), tol)
    check(name, "max", stats["max"], float(finite.max()), tol)
    check(name, "mean", stats["mean"], float(finite.mean()), tol)
    if finite.size > 1:
        check(name, "std", stats["std"], float(finite.std(ddof=1)), tol)

    if not stats["approximate"]:
        check(name, "median", stats["median"], float(np.percentile(finite, 50)), tol)
        histogram = stats.get("histogram")
        if histogram is not None:
            # Every finite value must land in a bin; a degenerate range used to
            # produce a NaN index and silently drop the count.
            check(
                name, "histogram total", sum(histogram["counts"]), int(finite.size), 0
            )

print(f"{checked} assertions over {len(names)} sample arrays")

if failures:
    print(f"\n{len(failures)} FAILURES:", file=sys.stderr)
    for failure in failures[:40]:
        print(f"  {failure}", file=sys.stderr)
    sys.exit(1)

print("NumPy backend agrees with NumPy")
