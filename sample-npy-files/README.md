# Sample `.npy` files

Thirty-seven arrays for exercising the NPY Viewer. Every one is synthetic but
deliberately _meaningful_ — procedural landscapes, ridged terrain, digit
glyphs, chirped audio, a spherical MRI phantom — so each view has something
recognisable to draw and each statistic sits on a real distribution rather than
on noise.

Click any file in the Explorer to open it. `MANIFEST.md` lists every file with
its exact dtype, shape and size.

## Start here

| Try                          | To see                                                         |
| ---------------------------- | -------------------------------------------------------------- |
| `01-photo-rgb.npy`           | A colour photo rendered directly from `(H, W, 3)` uint8        |
| `05-digits-batch.npy`        | 64 digits as a contact sheet — click a tile to open it         |
| `08-terrain-heightmap.npy`   | A heightmap; switch **Scale** to _Log_ and watch detail appear |
| `12-sensor-series.npy`       | A time series with three outages, and the NaN report           |
| `17-lognormal-durations.npy` | Skewness, heavy tails and a wide dynamic range                 |

## What each group demonstrates

**Images (01–07).** Channel-last RGB and RGBA, grayscale, channel-first CHW, and
image batches in both NHWC and NCHW. `02-badge-rgba` has a soft alpha edge, so
transparency shows through as the checkerboard. Where a shape is ambiguous the
toolbar offers a channel-order switch rather than guessing silently.

**Fields and matrices (08–10, 15, 16).** A ridged heightmap in metres, a real
correlation matrix (symmetric, unit diagonal), and a two-source interference
pattern whose values straddle zero — that one automatically picks a diverging
colour ramp centred on zero. The feature and activation matrices show the
per-column breakdown and the sparsity report.

**Signals and labels (11–14, 17).** A one-second chirp with harmonics, a daily
sensor series with three dropped windows, long-tailed class labels that trigger
the imbalance warning, one-hot encodings, and log-normal durations.

**Higher rank (18–21).** A 32-slice MRI phantom with an off-centre lesion, a
24-band hyperspectral cube where the trailing axis is correctly read as bands
rather than as a plane edge, a 4-D attention tensor with visible causal
structure, and a rank-5 tensor navigated over three leading axes.

**Awkward dtypes (22–32).** Boolean masks, complex spectra summarised by
magnitude, `datetime64` and `timedelta64`, structured records, fixed-width
strings, pickled Python objects, Fortran memory order, big-endian floats,
`float16`, and `int64` values past 2⁵³ that must stay exact in the data table.

**Edge cases (33–37).** A 0-d scalar, a constant array, NaN and ±infinity mixed
together, a zero-length dimension, and a 2.4-million-element array that exceeds
the preview cap so the visual is decimated while the statistics stay exact.

`28-object-array.npy` is the one file that **needs Python with NumPy** — it
holds pickled objects that the built-in parser cannot decode. Without a NumPy
backend it reports that clearly instead of failing.

## Regenerating

```sh
python generate.py            # the standard set, ~16 MB
python generate.py --large    # also writes a 500 MB array
```

The generator needs only NumPy and is seeded, so it reproduces byte-identical
files. `--large` adds `38-huge-streamed.npy`, a `(256, 512, 1024)` float32 array
of 134 million elements — well past the point where the viewer stops loading
files into memory and streams them from disk instead. It is not committed
because of its size; generate it locally if you want to watch the streaming
reader work.
