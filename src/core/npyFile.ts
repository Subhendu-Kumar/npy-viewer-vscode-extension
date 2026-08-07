import {
  parseDescr,
  formatScalar,
  makeScalarReader,
  type ParsedDtype,
} from "./dtype";
import type {
  Block,
  Layout,
  ArrayMeta,
  TableWindow,
  TextPreview,
} from "../common/types";
import { ByteSource, MAX_WINDOW_BYTES } from "./reader";
import { computeStrides, frameToIndices } from "./layout";
import { parseHeader, HEADER_PROBE_BYTES } from "./npyHeader";

/** Rows/records shown in the fallback text view. */
const TEXT_PREVIEW_ROWS = 500;

export interface OpenOptions {
  /** Pre-materialised bytes, used when the Python backend already read them. */
  buffer?: Buffer;
}

/**
 * An open `.npy` file: header metadata plus strided reads into its data.
 *
 * All reads go through {@link ByteSource}, so the same code path serves a 2 KB
 * array held in memory and a 40 GB array streamed from disk.
 */
export class NpyFile {
  private constructor(
    readonly source: ByteSource,
    readonly meta: ArrayMeta,
    readonly dtype: ParsedDtype,
    readonly dataOffset: number,
    readonly strides: number[],
  ) {}

  static async open(
    filePath: string,
    options: OpenOptions = {},
  ): Promise<NpyFile> {
    const source = options.buffer
      ? ByteSource.fromBuffer(options.buffer)
      : await ByteSource.open(filePath);

    try {
      const probe = await source.read(
        0,
        Math.min(HEADER_PROBE_BYTES, source.byteLength),
      );
      const { meta, dtype, dataOffset } = parseHeader(probe, source.byteLength);

      const available = source.byteLength - dataOffset;
      if (available < meta.dataBytes) {
        meta.dataBytes = Math.max(0, available);
      }

      return new NpyFile(
        source,
        meta,
        dtype,
        dataOffset,
        computeStrides(meta.shape, meta.fortranOrder),
      );
    } catch (err) {
      await source.close();
      throw err;
    }
  }

  get truncated(): boolean {
    return (
      this.source.byteLength - this.dataOffset <
      this.meta.size * this.dtype.itemsize
    );
  }

  async close(): Promise<void> {
    await this.source.close();
  }

  /** Element index at which `frame`'s plane begins. */
  private frameBase(layout: Layout, frame: number): number {
    if (this.meta.ndim <= 1) {
      return 0;
    }
    const indices = frameToIndices(layout, frame);
    let base = 0;
    layout.frameAxes.forEach((axis, i) => {
      base += indices[i] * this.strides[axis];
    });
    return base;
  }

  private axisStride(layout: Layout, axis: number): number {
    // A 1-D array is presented as a 1 x N plane whose row axis does not exist.
    if (this.meta.ndim === 1) {
      return axis === layout.colAxis ? this.strides[0] : 0;
    }
    return this.strides[axis] ?? 0;
  }

  /**
   * Reads a decimated block of frames.
   *
   * Rows and columns are strided down so the result never exceeds `maxSide`
   * per edge or `maxElements` in total — the array on disk may be enormous, but
   * what crosses into the webview is bounded.
   */
  async readBlock(
    layout: Layout,
    frames: number[],
    maxSide: number,
    maxElements: number,
  ): Promise<Block> {
    const channels = layout.channels;
    const frameCount = Math.max(1, frames.length);

    // Shrink the per-edge cap until the whole block fits the element budget.
    let side = Math.max(1, Math.floor(maxSide));
    let rowStep = Math.max(1, Math.ceil(layout.height / side));
    let colStep = Math.max(1, Math.ceil(layout.width / side));
    let outH = Math.ceil(layout.height / rowStep);
    let outW = Math.ceil(layout.width / colStep);

    while (frameCount * outH * outW * channels > maxElements && side > 1) {
      side = Math.max(1, Math.floor(side / 2));
      rowStep = Math.max(1, Math.ceil(layout.height / side));
      colStep = Math.max(1, Math.ceil(layout.width / side));
      outH = Math.ceil(layout.height / rowStep);
      outW = Math.ceil(layout.width / colStep);
    }

    const useBytes =
      this.dtype.kind === "bool" ||
      (this.dtype.kind === "uint" && this.dtype.itemsize === 1);
    const total = frameCount * outH * outW * channels;
    const out = useBytes ? new Uint8Array(total) : new Float32Array(total);

    const rowStride = this.axisStride(layout, layout.rowAxis);
    const colStride = this.axisStride(layout, layout.colAxis);
    const chanStride =
      layout.channelAxis === null
        ? 0
        : this.axisStride(layout, layout.channelAxis);

    let blockMin = Number.POSITIVE_INFINITY;
    let blockMax = Number.NEGATIVE_INFINITY;
    let cursor = 0;

    for (const frame of frames) {
      const base = this.frameBase(layout, frame);
      for (let oy = 0; oy < outH; oy += 1) {
        const rowBase = base + oy * rowStep * rowStride;
        const extent = await this.gather(
          rowBase,
          outW,
          colStep * colStride,
          channels,
          chanStride,
          out,
          cursor,
        );
        if (extent.min < blockMin) {
          blockMin = extent.min;
        }
        if (extent.max > blockMax) {
          blockMax = extent.max;
        }
        cursor += outW * channels;
      }
    }

    return {
      encoding: useBytes ? "u8" : "f32",
      data: Buffer.from(out.buffer, out.byteOffset, out.byteLength).toString(
        "base64",
      ),
      shape: [frameCount, outH, outW, channels],
      frames: [...frames],
      step: [rowStep, colStep],
      downsampled: rowStep > 1 || colStep > 1,
      blockMin: Number.isFinite(blockMin) ? blockMin : 0,
      blockMax: Number.isFinite(blockMax) ? blockMax : 0,
    };
  }

  /**
   * Reads `count` strided samples (each with `channels` interleaved values)
   * into `out`, splitting the read whenever the source span would exceed the
   * reader's window.
   */
  private async gather(
    startElement: number,
    count: number,
    step: number,
    channels: number,
    chanStride: number,
    out: Float32Array | Uint8Array,
    outOffset: number,
  ): Promise<{ min: number; max: number }> {
    const read = makeScalarReader(this.dtype);
    const itemsize = this.dtype.itemsize;
    const channelSpan = Math.max(0, (channels - 1) * chanStride);

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let i = 0;

    while (i < count) {
      const spanStartElement = startElement + i * step;
      const perItem = Math.max(Math.abs(step), 1) * itemsize;
      const budget = Math.max(
        1,
        Math.floor((MAX_WINDOW_BYTES - channelSpan * itemsize) / perItem),
      );
      const batch = Math.min(count - i, budget);

      const firstByte = this.dataOffset + spanStartElement * itemsize;
      const lastByte =
        this.dataOffset +
        (spanStartElement + (batch - 1) * step + channelSpan) * itemsize +
        itemsize;

      await this.source.ensure(firstByte, lastByte);
      const { view, base } = this.source.view();

      for (let k = 0; k < batch; k += 1) {
        const element = spanStartElement + k * step;
        for (let c = 0; c < channels; c += 1) {
          const byteOffset =
            this.dataOffset + (element + c * chanStride) * itemsize - base;
          let value: number;
          if (byteOffset < 0 || byteOffset + itemsize > view.byteLength) {
            value = Number.NaN;
          } else {
            value = read(view, byteOffset);
          }
          out[outOffset + (i + k) * channels + c] = value;
          if (value < min) {
            min = value;
          }
          if (value > max) {
            max = value;
          }
        }
      }

      i += batch;
    }

    return { min, max };
  }

  /** Exact, fully formatted values for a window of one plane. */
  async readTable(
    layout: Layout,
    frame: number,
    rowStart: number,
    colStart: number,
    rowCount: number,
    colCount: number,
  ): Promise<TableWindow> {
    const totalRows = layout.height;
    const totalCols = layout.width;
    const rows = Math.max(0, Math.min(rowCount, totalRows - rowStart));
    const cols = Math.max(0, Math.min(colCount, totalCols - colStart));

    const base = this.frameBase(layout, frame);
    const rowStride = this.axisStride(layout, layout.rowAxis);
    const colStride = this.axisStride(layout, layout.colAxis);
    const chanStride =
      layout.channelAxis === null
        ? 0
        : this.axisStride(layout, layout.channelAxis);
    const channels = layout.channels;

    const read = makeScalarReader(this.dtype);
    const itemsize = this.dtype.itemsize;

    const cells: string[][] = [];
    const values: number[][] = [];

    for (let r = 0; r < rows; r += 1) {
      const rowBase = base + (rowStart + r) * rowStride;
      const firstElement = rowBase + colStart * colStride;
      const lastElement =
        rowBase +
        (colStart + cols - 1) * colStride +
        (channels - 1) * chanStride;

      const firstByte = this.dataOffset + firstElement * itemsize;
      const lastByte = this.dataOffset + lastElement * itemsize + itemsize;

      const rowCells: string[] = [];
      const rowValues: number[] = [];

      if (lastByte - firstByte <= MAX_WINDOW_BYTES) {
        await this.source.ensure(firstByte, lastByte);
      }
      for (let c = 0; c < cols; c += 1) {
        const element = rowBase + (colStart + c) * colStride;
        const byteStart = this.dataOffset + element * itemsize;
        const byteEnd =
          byteStart + (channels - 1) * chanStride * itemsize + itemsize;
        if (!this.source.covers(byteStart, byteEnd)) {
          await this.source.ensure(byteStart, byteEnd);
        }
        const { view, base: windowBase } = this.source.view();

        const parts: string[] = [];
        let numeric = Number.NaN;
        for (let ch = 0; ch < channels; ch += 1) {
          const offset = byteStart + ch * chanStride * itemsize - windowBase;
          if (offset < 0 || offset + itemsize > view.byteLength) {
            parts.push("--");
            continue;
          }
          parts.push(formatScalar(view, offset, this.dtype));
          if (ch === 0) {
            numeric = read(view, offset);
          }
        }
        rowCells.push(channels > 1 ? parts.join(", ") : parts[0]);
        rowValues.push(numeric);
      }

      cells.push(rowCells);
      values.push(rowValues);
    }

    return {
      frame,
      rowStart,
      colStart,
      rowCount: rows,
      colCount: cols,
      totalRows,
      totalCols,
      cells,
      values,
    };
  }

  /** Reads the single value of a 0-d array. */
  async readScalar(): Promise<string> {
    await this.source.ensure(
      this.dataOffset,
      this.dataOffset + this.dtype.itemsize,
    );
    const { view, base } = this.source.view();
    return formatScalar(view, this.dataOffset - base, this.dtype);
  }

  /**
   * Renders string, bytes and record arrays as a plain table, which is the
   * only sensible presentation for dtypes with no numeric meaning.
   */
  async readTextPreview(): Promise<TextPreview> {
    if (this.dtype.kind === "struct" && this.dtype.fields) {
      return this.readRecordPreview();
    }

    const itemsize = this.dtype.itemsize;
    const lastAxis =
      this.meta.ndim > 1 ? this.meta.shape[this.meta.ndim - 1] : 1;
    const columnCount = Math.min(lastAxis, 32);
    const rowTotal = Math.ceil(this.meta.size / Math.max(lastAxis, 1));
    const rowLimit = Math.min(rowTotal, TEXT_PREVIEW_ROWS);

    const columns =
      this.meta.ndim > 1
        ? ["index", ...Array.from({ length: columnCount }, (_, i) => String(i))]
        : ["index", "value"];

    const rows: string[][] = [];
    for (let r = 0; r < rowLimit; r += 1) {
      const cells = [String(r)];
      const perRow = this.meta.ndim > 1 ? columnCount : 1;
      for (let c = 0; c < perRow; c += 1) {
        const element = r * lastAxis + c;
        if (element >= this.meta.size) {
          break;
        }
        const byteStart = this.dataOffset + element * itemsize;
        await this.source.ensure(byteStart, byteStart + itemsize);
        const { view, base } = this.source.view();
        cells.push(formatScalar(view, byteStart - base, this.dtype));
      }
      rows.push(cells);
    }

    return { columns, rows, totalRows: rowTotal };
  }

  private async readRecordPreview(): Promise<TextPreview> {
    const fields = this.dtype.fields ?? [];
    const itemsize = this.dtype.itemsize;
    const rowLimit = Math.min(this.meta.size, TEXT_PREVIEW_ROWS);

    const fieldDtypes = fields.map((f) => parseDescr(f.descr));
    const columns = ["index", ...fields.map((f) => `${f.name} (${f.dtype})`)];
    const rows: string[][] = [];

    for (let r = 0; r < rowLimit; r += 1) {
      const recordStart = this.dataOffset + r * itemsize;
      await this.source.ensure(recordStart, recordStart + itemsize);
      const { view, base } = this.source.view();

      const cells = [String(r)];
      fields.forEach((field, i) => {
        const fieldType = fieldDtypes[i];
        const repeat = field.shape.reduce((a, b) => a * b, 1);
        const parts: string[] = [];
        for (let k = 0; k < Math.min(repeat, 8); k += 1) {
          const offset = recordStart - base + field.offset + k * field.itemsize;
          parts.push(
            offset + field.itemsize <= view.byteLength
              ? formatScalar(view, offset, fieldType)
              : "--",
          );
        }
        cells.push(
          repeat > 1
            ? `[${parts.join(", ")}${repeat > 8 ? ", …" : ""}]`
            : parts[0],
        );
      });
      rows.push(cells);
    }

    return { columns, rows, totalRows: this.meta.size };
  }
}
