# Change Log

## [0.0.1]

First release.

- Custom read-only editor for `.npy` files: clicking one in the Explorer opens
  it as a visual document rather than as binary text.
- Automatic view selection from shape and dtype — RGB/RGBA images,
  channel-first images, image stacks, NHWC and NCHW batches, band rasters,
  heatmaps, line plots, tables and frame navigators for 5-D and beyond, with a
  channel-order switch where the reading is ambiguous.
- Visual tab with eight colormaps, linear/log/symlog scaling, three
  normalisation ranges, frame navigation, zoom, a live value readout and PNG
  export. Signed data defaults to a diverging ramp centred on zero.
- Statistics tab covering counts, moments, percentiles, Tukey fences, norms,
  cardinality and per-channel/per-column breakdowns, with a histogram, a box
  plot, frequency bars and plain-language observations about the data.
- Data tab with paged exact values, value shading, copy and CSV export.
- Metadata tab with header, dtype, memory order, record fields and backend
  detail.
- Streaming reads: arrays larger than 96 MB are never fully loaded, statistics
  run in one sequential pass, and previews are decimated to a bounded size.
- Built-in TypeScript parser supporting `bool`, all integer and float widths
  including `float16`, `complex64/128`, `datetime64`, `timedelta64`, fixed-width
  strings and bytes, structured records, big-endian data and Fortran ordering,
  across NPY format versions 1.0, 2.0 and 3.0.
- Optional NumPy backend, auto-detected from the `npyViewer.python.path`
  setting, the Python extension's interpreter, or `PATH`. It adds support for
  pickled object arrays and exact quantiles on very large arrays.
