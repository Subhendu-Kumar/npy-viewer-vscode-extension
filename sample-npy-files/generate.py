#!/usr/bin/env python
"""Generates the sample .npy files used to exercise the NPY Viewer.

Every array here is synthetic but *meaningful* — procedural landscapes, terrain,
waveforms and digit glyphs rather than noise — so each view has something
recognisable to draw and each statistic has a real distribution behind it.

    python generate.py            # the standard set (~15 MB)
    python generate.py --large    # adds a 500 MB array to exercise streaming

Requires only NumPy.
"""

import argparse
import os

import numpy as np

OUT = os.path.dirname(os.path.abspath(__file__))
rng = np.random.default_rng(20240501)

manifest = []


def save(name, arr, note, **kwargs):
    path = os.path.join(OUT, name + ".npy")
    np.save(path, arr, **kwargs)
    size = os.path.getsize(path)
    manifest.append((name + ".npy", str(arr.dtype), tuple(arr.shape), size, note))
    print(
        f"  {name + '.npy':34s} {str(arr.dtype):16s} {str(tuple(arr.shape)):20s} {size:>12,d} B"
    )


# ---------------------------------------------------------------------------
# Procedural helpers
# ---------------------------------------------------------------------------


def grid(height, width):
    """Full (y, x) coordinate meshes in [0, 1], both shaped `(height, width)`."""
    return np.meshgrid(
        np.linspace(0, 1, height), np.linspace(0, 1, width), indexing="ij"
    )


def box_blur(image, radius, passes=3):
    """Separable box blur, repeated to approximate a Gaussian."""
    out = image.astype(np.float64)
    width = 2 * radius + 1
    kernel = np.ones(width) / width
    for _ in range(passes):
        out = np.apply_along_axis(lambda m: np.convolve(m, kernel, mode="same"), 0, out)
        out = np.apply_along_axis(lambda m: np.convolve(m, kernel, mode="same"), 1, out)
    return out


def value_noise(height, width, cells, generator):
    """One octave of smooth value noise, bilinearly upsampled from a coarse grid."""
    coarse = generator.random((cells + 1, cells + 1))
    ys = np.linspace(0, cells, height)
    xs = np.linspace(0, cells, width)
    y0, x0 = np.floor(ys).astype(int), np.floor(xs).astype(int)
    y1 = np.minimum(y0 + 1, cells)
    x1 = np.minimum(x0 + 1, cells)
    fy = (ys - y0)[:, None]
    fx = (xs - x0)[None, :]
    # Smoothstep the interpolation so the octaves have no visible grid seams.
    fy = fy * fy * (3 - 2 * fy)
    fx = fx * fx * (3 - 2 * fx)

    top = coarse[np.ix_(y0, x0)] * (1 - fx) + coarse[np.ix_(y0, x1)] * fx
    bottom = coarse[np.ix_(y1, x0)] * (1 - fx) + coarse[np.ix_(y1, x1)] * fx
    return top * (1 - fy) + bottom * fy


def fractal_noise(height, width, octaves=6, generator=None):
    """Sum of octaves — the usual recipe for natural-looking terrain."""
    generator = generator or rng
    total = np.zeros((height, width))
    amplitude = 1.0
    weight = 0.0
    for octave in range(octaves):
        total += amplitude * value_noise(height, width, 2 * 2**octave, generator)
        weight += amplitude
        amplitude *= 0.5
    return total / weight


# 3 x 5 glyphs, upscaled and blurred into MNIST-shaped tiles.
DIGIT_FONT = {
    0: ["111", "101", "101", "101", "111"],
    1: ["010", "110", "010", "010", "111"],
    2: ["111", "001", "111", "100", "111"],
    3: ["111", "001", "111", "001", "111"],
    4: ["101", "101", "111", "001", "001"],
    5: ["111", "100", "111", "001", "111"],
    6: ["111", "100", "111", "101", "111"],
    7: ["111", "001", "001", "010", "010"],
    8: ["111", "101", "111", "101", "111"],
    9: ["111", "101", "111", "001", "111"],
}


def render_digit(value, generator):
    """One 28 x 28 uint8 tile holding a slightly jittered digit."""
    glyph = np.array(
        [[int(c) for c in row] for row in DIGIT_FONT[value]], dtype=np.float64
    )
    scale = 5
    stamp = np.kron(glyph, np.ones((scale, scale)))

    canvas = np.zeros((28, 28))
    top = (28 - stamp.shape[0]) // 2 + generator.integers(-2, 3)
    left = (28 - stamp.shape[1]) // 2 + generator.integers(-2, 3)
    top = int(np.clip(top, 0, 28 - stamp.shape[0]))
    left = int(np.clip(left, 0, 28 - stamp.shape[1]))
    canvas[top : top + stamp.shape[0], left : left + stamp.shape[1]] = stamp

    canvas = box_blur(canvas, 1)
    canvas += generator.normal(0, 0.02, canvas.shape)
    canvas = np.clip(canvas / max(canvas.max(), 1e-9), 0, 1)
    return (canvas * 255).astype(np.uint8)


def shape_tile(kind, size, generator):
    """A filled circle, ring, cross, square or triangle on a coloured ground."""
    y, x = grid(size, size)
    cy, cx = 0.5 + generator.uniform(-0.1, 0.1), 0.5 + generator.uniform(-0.1, 0.1)
    radius = generator.uniform(0.22, 0.34)
    dist = np.hypot(y - cy, x - cx)

    if kind == 0:
        mask = dist < radius
    elif kind == 1:
        mask = (dist < radius) & (dist > radius * 0.55)
    elif kind == 2:
        mask = (np.abs(y - cy) < radius * 0.28) | (np.abs(x - cx) < radius * 0.28)
        mask &= dist < radius * 1.2
    elif kind == 3:
        mask = (np.abs(y - cy) < radius) & (np.abs(x - cx) < radius)
    else:
        mask = (y - cy > -radius) & (np.abs(x - cx) < (y - cy + radius) * 0.6)
        mask &= y - cy < radius

    ground = generator.uniform(0.05, 0.25, 3)
    ink = generator.uniform(0.55, 1.0, 3)
    tile = np.broadcast_to(ground, (size, size, 3)).copy()
    tile[mask] = ink
    tile += generator.normal(0, 0.02, tile.shape)
    return (np.clip(tile, 0, 1) * 255).astype(np.uint8)


# ---------------------------------------------------------------------------
# Samples
# ---------------------------------------------------------------------------


def landscape():
    """A procedural sunset: sky gradient, sun with glow, hills, rippled water."""
    h, w = 240, 320
    y, x = grid(h, w)
    horizon = 0.62

    sky_top = np.array([0.10, 0.13, 0.36])
    sky_bottom = np.array([0.99, 0.55, 0.28])
    t = np.clip(y / horizon, 0, 1)[..., None]
    image = sky_top * (1 - t) + sky_bottom * t

    sun_y, sun_x, sun_r = 0.44, 0.66, 0.075
    # x spans more pixels than y, so scale it to keep the sun circular.
    d = np.hypot(y - sun_y, (x - sun_x) * (w / h))
    image += (np.exp(-((d / (sun_r * 3.2)) ** 2)) * 0.55)[..., None] * np.array(
        [1.0, 0.85, 0.5]
    )
    image[d < sun_r] = np.array([1.0, 0.96, 0.82])

    # Two hill silhouettes, the nearer one darker.
    for depth, (amp, freq, phase, base, shade) in enumerate(
        [
            (0.035, 3.0, 0.4, horizon + 0.02, 0.30),
            (0.055, 1.7, 2.1, horizon + 0.09, 0.16),
        ]
    ):
        ridge = (
            base
            - amp * np.sin(x * freq * 2 * np.pi + phase)
            - amp * 0.4 * np.sin(x * freq * 5 * np.pi)
        )
        mask = y > ridge
        image[mask] = np.array([shade, shade * 0.75, shade * 0.95])
        del depth

    # Water below the horizon, mirroring the sky with ripples.
    water = y > 0.80
    ripple = 0.012 * np.sin(y * 90) * np.sin(x * 14 + y * 30)
    mirrored = np.clip(1.62 - y + ripple, 0, 1)[..., None]
    image[water] = (sky_bottom * mirrored + sky_top * (1 - mirrored))[water] * 0.85

    image += rng.normal(0, 0.006, image.shape)
    return (np.clip(image, 0, 1) * 255).astype(np.uint8)


def badge_rgba():
    """A ring with a soft alpha edge, so transparency is visible in the viewer."""
    size = 128
    y, x = grid(size, size)
    dist = np.hypot(y - 0.5, x - 0.5)

    hue = np.clip((y + x) / 2, 0, 1)
    rgb = np.stack(
        [0.20 + 0.75 * hue, 0.35 + 0.45 * (1 - hue), 0.85 - 0.35 * hue], axis=-1
    )
    ring = np.clip(1 - np.abs(dist - 0.33) / 0.11, 0, 1) ** 0.7
    alpha = np.clip(ring, 0, 1)

    out = np.zeros((size, size, 4))
    out[..., :3] = rgb
    out[..., 3] = alpha
    return (out * 255).astype(np.uint8)


def grayscale_vignette():
    """Concentric rings under a vignette — obvious structure at any zoom."""
    h = w = 256
    y, x = grid(h, w)
    dist = np.hypot(y - 0.5, x - 0.5)
    rings = 0.5 + 0.5 * np.sin(dist * 42)
    vignette = np.clip(1 - (dist / 0.72) ** 2, 0, 1)
    return (np.clip(rings * vignette, 0, 1) * 255).astype(np.uint8)


def ridged_noise(height, width, octaves=6, generator=None):
    """
    Ridged multifractal noise.

    Folding each octave about its midpoint (`1 - |2n - 1|`) turns smooth blobs
    into creases, and weighting each octave by the one above it concentrates
    detail along those creases — which is what makes it read as mountains
    rather than as clouds.
    """
    generator = generator or rng
    total = np.zeros((height, width))
    amplitude = 1.0
    weight = 1.0
    normaliser = 0.0

    for octave in range(octaves):
        layer = 1.0 - np.abs(
            2.0 * value_noise(height, width, 2 * 2**octave, generator) - 1.0
        )
        layer = layer**2
        layer *= np.clip(weight, 0, 1)
        weight = layer * 2.0
        total += layer * amplitude
        normaliser += amplitude
        amplitude *= 0.55

    return total / normaliser


def terrain():
    """Ridged heightmap in metres — wide range, good for the log colour scale."""
    height = ridged_noise(200, 300, octaves=7)
    height = (height - height.min()) / (height.max() - height.min())
    # A gentle power keeps valleys flat while peaks stay sharp, as real terrain does.
    return (height**1.4 * 2400).astype(np.float32)


def correlation_matrix():
    """A genuine correlation matrix: symmetric, unit diagonal, values in [-1, 1]."""
    n = 12
    factors = rng.normal(size=(n, 4))
    cov = factors @ factors.T + np.eye(n) * 0.6
    d = np.sqrt(np.diag(cov))
    return cov / np.outer(d, d)


def interference():
    """Two-source interference — signed values centred on zero."""
    h, w = 150, 200
    y, x = grid(h, w)
    a = np.hypot(y - 0.35, x - 0.30)
    b = np.hypot(y - 0.70, x - 0.72)
    return (np.sin(a * 70) + np.sin(b * 70)) * np.exp(
        -((y - 0.5) ** 2 + (x - 0.5) ** 2)
    )


def waveform():
    """A one-second chirp with harmonics and an attack/decay envelope."""
    n = 48000
    t = np.linspace(0, 1, n, endpoint=False)
    frequency = 110 * (2 ** (t * 3))
    phase = 2 * np.pi * np.cumsum(frequency) / n
    signal = np.sin(phase) + 0.35 * np.sin(2 * phase) + 0.18 * np.sin(3 * phase)
    envelope = np.minimum(t / 0.02, 1.0) * np.exp(-t * 1.8)
    return (signal * envelope * 0.7).astype(np.float32)


def sensor_series():
    """Daily readings with trend, seasonality, noise, and dropped samples."""
    n = 2000
    t = np.arange(n)
    series = (
        18
        + 0.004 * t
        + 6 * np.sin(2 * np.pi * t / 365)
        + 1.5 * np.sin(2 * np.pi * t / 7)
        + rng.normal(0, 0.8, n)
    )
    # Three outages, so the NaN handling has something to report.
    for start, length in [(310, 24), (900, 60), (1640, 15)]:
        series[start : start + length] = np.nan
    return series


def imbalanced_labels():
    """Class labels following a realistic long-tail distribution."""
    weights = np.array([0.42, 0.21, 0.13, 0.08, 0.06, 0.04, 0.03, 0.02, 0.007, 0.003])
    return rng.choice(10, size=5000, p=weights / weights.sum()).astype(np.int64)


def sparse_embeddings():
    """Mostly-zero activations, as a ReLU layer produces.

    Deliberately tall and narrow so it is read as a feature matrix rather than
    as a grayscale image, which is what a near-square block of this size would
    look like.
    """
    dense = rng.normal(0, 1, (640, 96)).astype(np.float32)
    dense[dense < 0.6] = 0
    return dense


def mri_volume():
    """A spherical phantom with internal structure — 32 axial slices."""
    depth, size = 32, 64
    z = np.linspace(-1, 1, depth)[:, None, None]
    y = np.linspace(-1, 1, size)[None, :, None]
    x = np.linspace(-1, 1, size)[None, None, :]
    r = np.sqrt(x**2 + y**2 + z**2)

    volume = np.zeros((depth, size, size))
    volume += np.where(r < 0.85, 0.45, 0.0)
    volume += np.where(r < 0.55, 0.30, 0.0)
    # An off-centre lesion, so the slices differ from one another.
    lesion = np.sqrt((x - 0.25) ** 2 + (y + 0.2) ** 2 + (z - 0.15) ** 2)
    volume += np.where(lesion < 0.18, 0.35, 0.0)
    volume += rng.normal(0, 0.02, volume.shape)
    return np.clip(volume, 0, None).astype(np.float32)


def hyperspectral():
    """One scene across 24 wavelength bands, each with its own response."""
    h = w = 128
    bands = 24
    base = fractal_noise(h, w, octaves=5)
    y, x = grid(h, w)
    water = (y > 0.7) & (x < 0.55)

    cube = np.zeros((h, w, bands), dtype=np.float32)
    for band in range(bands):
        wavelength = band / (bands - 1)
        vegetation = base * (0.3 + 0.7 * np.exp(-((wavelength - 0.75) ** 2) / 0.02))
        layer = vegetation + 0.15 * wavelength
        layer = np.where(water, 0.08 * (1 - wavelength), layer)
        cube[..., band] = layer + rng.normal(0, 0.005, (h, w))
    return cube


def attention_tensor():
    """(batch, heads, query, key) attention weights — each row sums to one.

    Six heads, not three or four: those counts are indistinguishable from colour
    channels by shape alone, and would be read as an image batch rather than as
    the 4-D frame stack this actually is.
    """
    batch, heads, tokens = 2, 6, 16
    logits = rng.normal(0, 1.4, (batch, heads, tokens, tokens))
    # A causal mask, which gives the visual an unmistakable triangular structure.
    mask = np.tril(np.ones((tokens, tokens)))
    logits = np.where(mask == 1, logits, -np.inf)
    weights = np.exp(logits - logits.max(axis=-1, keepdims=True))
    weights = np.nan_to_num(weights)
    return (weights / weights.sum(axis=-1, keepdims=True)).astype(np.float32)


def build_standard():
    print("Generating samples\n")

    save("01-photo-rgb", landscape(), "RGB image, HWC — the default image view")
    save("02-badge-rgba", badge_rgba(), "RGBA image — alpha shows as the checkerboard")
    save("03-rings-grayscale", grayscale_vignette(), "Single-channel image")
    save(
        "04-photo-chw",
        np.transpose(landscape().astype(np.float32) / 255, (2, 0, 1)),
        "Channel-first (CHW) float image, the PyTorch convention",
    )

    digits = np.stack([render_digit(i % 10, rng) for i in range(64)])
    save(
        "05-digits-batch",
        digits,
        "Stack of 64 grayscale frames — opens as a contact sheet",
    )

    shapes = np.stack([shape_tile(i % 5, 32, rng) for i in range(48)])
    save("06-shapes-nhwc", shapes, "Image batch, NHWC (N, H, W, C)")

    nchw = (
        np.stack(
            [np.transpose(shape_tile(i % 5, 40, rng), (2, 0, 1)) for i in range(24)]
        ).astype(np.float32)
        / 255
    )
    save("07-shapes-nchw", nchw, "Image batch, NCHW — channel-first batch detection")

    save(
        "08-terrain-heightmap",
        terrain(),
        "Heightmap in metres — try the log colour scale",
    )
    save(
        "09-correlation-matrix", correlation_matrix(), "Small matrix — opens as a table"
    )
    save(
        "10-interference-field",
        interference(),
        "Signed field — auto-selects a diverging ramp",
    )

    save(
        "11-audio-waveform",
        waveform(),
        "1-D signal — line plot with a min/max envelope",
    )
    save(
        "12-sensor-series",
        sensor_series(),
        "Time series with three outages — NaN reporting",
    )
    save(
        "13-class-labels",
        imbalanced_labels(),
        "Long-tailed class labels — imbalance warning",
    )
    save(
        "14-one-hot",
        np.eye(10, dtype=np.uint8)[imbalanced_labels()[:500]],
        "One-hot encoded labels",
    )
    save(
        "15-feature-matrix",
        rng.normal(0, 1, (2000, 24)) * rng.uniform(0.5, 2.0, 24)
        + rng.uniform(-1, 1, 24),
        "Standardised feature matrix — per-column breakdown",
    )
    save(
        "16-sparse-activations",
        sparse_embeddings(),
        "Sparse ReLU activations — sparsity report",
    )
    save(
        "17-lognormal-durations",
        rng.lognormal(3.0, 1.1, 50000),
        "Heavily skewed durations — skew, kurtosis and wide dynamic range",
    )

    save("18-mri-volume", mri_volume(), "32-slice volume — slice navigator")
    save(
        "19-hyperspectral-cube",
        hyperspectral(),
        "24 bands over one scene — band-axis detection",
    )
    save(
        "20-attention-weights",
        attention_tensor(),
        "4-D attention tensor (batch, head, q, k)",
    )
    save(
        "21-rank5-tensor",
        rng.random((2, 3, 4, 24, 24)).astype(np.float32),
        "Rank-5 tensor — frames over three leading axes",
    )

    y, x = grid(128, 128)
    save(
        "22-boolean-mask",
        (np.hypot(y - 0.5, x - 0.5) < 0.35) | (np.abs(y - x) < 0.06),
        "Boolean segmentation mask",
    )
    save(
        "23-complex-spectrum",
        np.fft.fft(waveform()[:1024].astype(np.float64)),
        "complex128 — statistics computed over magnitude",
    )
    save(
        "24-date-series",
        np.arange("2024-01-01", "2024-12-31", dtype="datetime64[D]"),
        "datetime64 — rendered as ISO timestamps",
    )
    save(
        "25-durations",
        (rng.exponential(3600, 500) * 1e9).astype("timedelta64[ns]"),
        "timedelta64 durations",
    )

    records = np.zeros(
        200,
        dtype=[
            ("id", "<i4"),
            ("score", "<f8"),
            ("colour", "|u1", (3,)),
            ("label", "S12"),
        ],
    )
    records["id"] = np.arange(200)
    records["score"] = rng.normal(72, 14, 200)
    records["colour"] = rng.integers(0, 256, (200, 3))
    records["label"] = np.array([b"alpha", b"beta", b"gamma", b"delta"] * 50)
    save("26-records", records, "Structured record array — one column per field")

    save(
        "27-strings",
        np.array([f"sample-{i:04d}" for i in range(300)]),
        "Fixed-width unicode strings",
    )

    objects = np.empty(40, dtype=object)
    for i in range(40):
        objects[i] = {
            "index": i,
            "tags": ["a", "b"][: i % 2 + 1],
            "weight": round(i * 0.37, 3),
        }
    save(
        "28-object-array",
        objects,
        "Pickled Python objects — needs the NumPy backend to read",
        allow_pickle=True,
    )

    save(
        "29-fortran-order",
        np.asfortranarray(fractal_noise(120, 160, octaves=4)),
        "Column-major (Fortran) memory order",
    )
    save(
        "30-big-endian",
        fractal_noise(80, 120, octaves=4).astype(">f8"),
        "Big-endian float64 — byte-swapped on read",
    )
    save(
        "31-float16",
        (fractal_noise(64, 96, octaves=4)).astype(np.float16),
        "float16, which JavaScript has no native type for",
    )
    save(
        "32-int64-precision",
        (rng.integers(0, 1 << 20, 1000).astype(np.int64) + (1 << 53)),
        "int64 values past 2^53 — shown exactly in the data table",
    )

    save("33-scalar", np.array(6.02214076e23), "0-dimensional array — a single value")
    save(
        "34-constant",
        np.full((64, 64), 7.5),
        "Constant array — degenerate-range handling",
    )

    mixed = rng.normal(size=2000)
    mixed[rng.choice(2000, 60, replace=False)] = np.nan
    mixed[rng.choice(2000, 20, replace=False)] = np.inf
    mixed[rng.choice(2000, 12, replace=False)] = -np.inf
    save(
        "35-nan-and-inf",
        mixed,
        "NaN and ±infinity — counted separately from the moments",
    )

    save("36-empty", np.zeros((0, 8)), "Empty array — a zero-length dimension")

    save(
        "37-large-decimated",
        (fractal_noise(1536, 1536, octaves=7) * 1000).astype(np.float32),
        "2.4M elements — exceeds the preview cap, so the visual is decimated",
    )


def build_large():
    """A 500 MB array, well past the point where the viewer streams from disk."""
    print("\nGenerating the streaming sample (this takes a minute)\n")
    path = os.path.join(OUT, "38-huge-streamed.npy")
    shape = (256, 512, 1024)

    # Written incrementally so the generator never holds 500 MB itself.
    header_array = np.lib.format.open_memmap(
        path, mode="w+", dtype=np.float32, shape=shape
    )
    for i in range(shape[0]):
        z = i / shape[0]
        plane = fractal_noise(shape[1], shape[2], octaves=4)
        header_array[i] = (plane * (0.5 + z)).astype(np.float32)
    header_array.flush()
    del header_array

    size = os.path.getsize(path)
    manifest.append(
        (
            "38-huge-streamed.npy",
            "float32",
            shape,
            size,
            "134M elements — streamed from disk, never fully loaded",
        )
    )
    print(
        f"  {'38-huge-streamed.npy':34s} {'float32':16s} {str(shape):20s} {size:>12,d} B"
    )


def write_manifest():
    lines = [
        "| File | dtype | Shape | Size | What it shows |",
        "| --- | --- | --- | ---: | --- |",
    ]
    for name, dtype, shape, size, note in manifest:
        shape_text = "()" if not shape else "(" + ", ".join(str(d) for d in shape) + ")"
        lines.append(
            f"| `{name}` | `{dtype}` | `{shape_text}` | {size / 1024:,.0f} KB | {note} |"
        )
    with open(os.path.join(OUT, "MANIFEST.md"), "w", encoding="utf-8") as handle:
        handle.write("<!-- Generated by generate.py. Do not edit by hand. -->\n\n")
        handle.write("\n".join(lines) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--large",
        action="store_true",
        help="also write a 500 MB array to exercise the streaming reader",
    )
    args = parser.parse_args()

    build_standard()
    if args.large:
        build_large()

    write_manifest()
    total = sum(entry[3] for entry in manifest)
    print(f"\n{len(manifest)} files, {total / 1024 / 1024:.1f} MB total, in {OUT}")


if __name__ == "__main__":
    main()
