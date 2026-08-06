import type { Block } from "../common/types";

export interface DecodedBlock {
  values: Float32Array | Uint8Array;
  frames: number;
  height: number;
  width: number;
  channels: number;
  /** Elements per frame, the stride between planes in `values`. */
  frameStride: number;
  sourceFrames: number[];
  step: [number, number];
  downsampled: boolean;
  blockMin: number;
  blockMax: number;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Turns a transported {@link Block} back into a typed array view. */
export function decodeBlock(block: Block): DecodedBlock {
  const bytes = base64ToBytes(block.data);
  const [frames, height, width, channels] = block.shape;

  const values =
    block.encoding === "u8"
      ? bytes
      : new Float32Array(
          bytes.buffer,
          bytes.byteOffset,
          Math.floor(bytes.byteLength / 4),
        );

  return {
    values,
    frames,
    height,
    width,
    channels,
    frameStride: height * width * channels,
    sourceFrames: block.frames,
    step: block.step,
    downsampled: block.downsampled,
    blockMin: block.blockMin,
    blockMax: block.blockMax,
  };
}
