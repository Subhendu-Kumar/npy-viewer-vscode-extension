# Change Log

All notable changes to NPY Viewer are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-08-07

First public release.

### Added

- Custom read-only editor for `.npy` files: clicking one in the Explorer opens
  it as a visual document rather than as binary text.
- Automatic view selection from shape and dtype — RGB/RGBA images,
  channel-first images, image stacks, NHWC and NCHW batches, band rasters,
  heatmaps, line plots, tables, and frame navigators for 5-D and beyond. Where
  channel-first and channel-last are both plausible the toolbar offers a switch
  instead of guessing silently.
- **Visual** tab with eight colormaps, linear/log/symlog scaling, three
  normalisation ranges, frame navigation, zoom, a live value readout under the
  cursor, and PNG export. Signed data defaults to a diverging ramp centred on
  zero.
- **Statistics** tab covering counts, moments, eleven percentiles, Tukey fences,
  norms, cardinality and per-channel/per-column breakdowns, with a histogram, a
  box plot, frequency bars, and plain-language observations about the data.
- **Data** tab with paged exact values, value shading, copy and CSV export.
- **Metadata** tab with header, dtype, memory order, record fields and backend
  detail.
- Streaming reads: arrays larger than 96 MB are never fully loaded, statistics
  run in one sequential pass, and previews are decimated to a bounded size
  before they reach the webview.
- Built-in TypeScript parser supporting `bool`, all integer and float widths
  including `float16`, `complex64/128`, `datetime64`, `timedelta64`,
  fixed-width strings and bytes, structured records, big-endian data and Fortran
  ordering, across NPY format versions 1.0, 2.0 and 3.0.
- Optional NumPy backend, auto-detected from the `npyViewer.python.path`
  setting, the Python extension's selected interpreter, or `PATH`. It adds
  pickled object arrays and exact quantiles on very large arrays.
- `sample-npy-files/` — 37 arrays covering every supported view and dtype, with
  a seeded generator that reproduces them.
- Extension icon, and GitHub Actions workflows that test on Linux and Windows,
  check the NumPy backend against NumPy, and publish the `.vsix` to a GitHub
  release on a version tag.

### Notes

- Counts, extrema, mean and standard deviation are exact over every element at
  any array size. Quantiles above `npyViewer.stats.exactPercentileLimit` come
  from a uniform random sample and are labelled _approximate_.
- `int64`/`uint64` values beyond 2⁵³ carry a small relative error in statistics,
  as they would in any float64 computation. The data table shows them exactly.
