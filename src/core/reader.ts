import * as fs from "node:fs/promises";

/** Files at or below this size are held entirely in memory. */
export const IN_MEMORY_LIMIT = 96 * 1024 * 1024;

/** Largest window the sliding reader will materialise for a random-access read. */
export const MAX_WINDOW_BYTES = 32 * 1024 * 1024;

/** Chunk size used by sequential scans. */
export const SCAN_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Random and sequential access over a file's bytes.
 *
 * Small files are read once into memory; larger ones keep a sliding window so a
 * multi-gigabyte array can be sliced without ever being fully resident. Both
 * back the same interface, so callers never branch on file size.
 */
export class ByteSource {
  private handle: fs.FileHandle | null;
  private window: Buffer;
  private windowStart: number;
  private windowEnd: number;
  private cachedView: DataView | null = null;

  private constructor(
    handle: fs.FileHandle | null,
    readonly byteLength: number,
    initial: Buffer,
    initialStart: number,
  ) {
    this.handle = handle;
    this.window = initial;
    this.windowStart = initialStart;
    this.windowEnd = initialStart + initial.length;
  }

  static async open(filePath: string): Promise<ByteSource> {
    const handle = await fs.open(filePath, "r");
    try {
      const stat = await handle.stat();
      const size = stat.size;

      if (size <= IN_MEMORY_LIMIT) {
        const buffer = Buffer.allocUnsafe(size);
        let read = 0;
        while (read < size) {
          const { bytesRead } = await handle.read(
            buffer,
            read,
            size - read,
            read,
          );
          if (bytesRead <= 0) {
            break;
          }
          read += bytesRead;
        }
        await handle.close();
        return new ByteSource(null, size, buffer.subarray(0, read), 0);
      }

      return new ByteSource(handle, size, Buffer.alloc(0), 0);
    } catch (err) {
      await handle.close().catch(() => undefined);
      throw err;
    }
  }

  /** Wraps an already-materialised buffer (used by the Python backend path). */
  static fromBuffer(buffer: Buffer): ByteSource {
    return new ByteSource(null, buffer.length, buffer, 0);
  }

  get isResident(): boolean {
    return this.handle === null;
  }

  /**
   * Makes `[start, end)` addressable by {@link view}. Throws if the span is
   * larger than {@link MAX_WINDOW_BYTES}; callers split such reads themselves.
   */
  async ensure(start: number, end: number): Promise<void> {
    const clampedStart = Math.max(0, Math.min(start, this.byteLength));
    const clampedEnd = Math.max(clampedStart, Math.min(end, this.byteLength));

    if (clampedStart >= this.windowStart && clampedEnd <= this.windowEnd) {
      return;
    }
    if (this.handle === null) {
      // Resident source: the whole file is already the window.
      return;
    }

    const span = clampedEnd - clampedStart;
    if (span > MAX_WINDOW_BYTES) {
      throw new Error(
        `Requested read span of ${span} bytes exceeds the ${MAX_WINDOW_BYTES}-byte window limit.`,
      );
    }

    // Over-read a little so nearby follow-up reads stay inside the window.
    const padded = Math.min(Math.max(span * 2, 1 << 20), MAX_WINDOW_BYTES);
    const readStart = Math.max(
      0,
      Math.min(clampedStart, this.byteLength - padded),
    );
    const readEnd = Math.min(this.byteLength, readStart + padded);
    const length = readEnd - readStart;

    const buffer = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await this.handle.read(
        buffer,
        filled,
        length - filled,
        readStart + filled,
      );
      if (bytesRead <= 0) {
        break;
      }
      filled += bytesRead;
    }

    this.window = buffer.subarray(0, filled);
    this.windowStart = readStart;
    this.windowEnd = readStart + filled;
    this.cachedView = null;
  }

  /**
   * A `DataView` over the current window plus the offset that maps absolute
   * file positions into it. Only valid for spans passed to {@link ensure}.
   */
  view(): { view: DataView; base: number } {
    if (!this.cachedView) {
      this.cachedView = new DataView(
        this.window.buffer,
        this.window.byteOffset,
        this.window.byteLength,
      );
    }
    return { view: this.cachedView, base: this.windowStart };
  }

  /** True when `[start, end)` is already addressable without another read. */
  covers(start: number, end: number): boolean {
    return start >= this.windowStart && end <= this.windowEnd;
  }

  /** Copies out an arbitrary range, stitching across window boundaries. */
  async read(start: number, length: number): Promise<Buffer> {
    const clampedStart = Math.max(0, Math.min(start, this.byteLength));
    const clampedLength = Math.max(
      0,
      Math.min(length, this.byteLength - clampedStart),
    );

    if (this.handle === null) {
      return this.window.subarray(clampedStart, clampedStart + clampedLength);
    }

    const out = Buffer.allocUnsafe(clampedLength);
    let filled = 0;
    while (filled < clampedLength) {
      const { bytesRead } = await this.handle.read(
        out,
        filled,
        clampedLength - filled,
        clampedStart + filled,
      );
      if (bytesRead <= 0) {
        break;
      }
      filled += bytesRead;
    }
    return out.subarray(0, filled);
  }

  /**
   * Walks `[start, start + length)` in order, yielding buffers aligned to
   * `itemsize` so no element is ever split across two chunks.
   */
  async *scan(
    start: number,
    length: number,
    itemsize: number,
    chunkBytes = SCAN_CHUNK_BYTES,
  ): AsyncGenerator<{ buffer: Buffer; elementIndex: number }> {
    const aligned = Math.max(
      itemsize,
      Math.floor(chunkBytes / itemsize) * itemsize,
    );
    let offset = 0;
    while (offset < length) {
      const size = Math.min(aligned, length - offset);
      const buffer = await this.read(start + offset, size);
      if (buffer.length === 0) {
        return;
      }
      yield { buffer, elementIndex: Math.floor(offset / itemsize) };
      offset += buffer.length;
      if (buffer.length < size) {
        return;
      }
    }
  }

  async close(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    this.window = Buffer.alloc(0);
    this.cachedView = null;
    if (handle) {
      await handle.close().catch(() => undefined);
    }
  }
}
