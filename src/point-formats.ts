// Wire point formats. The store fuses from the 18-byte `xyz_rgb_i_v1` layout; every
// other format is decoded to it at the boundary (ingest, replay) or encoded from it
// (serving). Formats are negotiated per connection: a publisher names one in each
// point_batch_header, a viewer asks for a served format with `?fmt=`.
//
//   xyz_rgb_i_v1  18 B  f32 x,y,z · u8 r,g,b · u16 intensity · pad      (ingest + serve)
//   xyzi_q4_v2     7 B  i16 x,y,z at 4 mm (±131 m) · u8 intensity       (ingest)
//   q8_chunk_v2    7 B  u8 x,y,z relative to the chunk origin in units of
//                       chunk_size/256 · u8 r,g,b · u8 intensity         (serve)
import { POINT_FORMAT, POINT_STRIDE_BYTES } from './protocol.js';

export const INGEST_FORMAT_Q4 = 'xyzi_q4_v2';
export const SERVE_FORMAT_Q8 = 'q8_chunk_v2';
export const Q4_METERS = 0.004;
export const Q4_STRIDE_BYTES = 7;
export const Q8_STRIDE_BYTES = 7;
export const Q8_STEPS = 256;

export const INGEST_FORMATS: Record<string, number> = {
  [POINT_FORMAT]: POINT_STRIDE_BYTES,
  [INGEST_FORMAT_Q4]: Q4_STRIDE_BYTES,
};

export const SERVE_FORMATS: Record<string, number> = {
  [POINT_FORMAT]: POINT_STRIDE_BYTES,
  [SERVE_FORMAT_Q8]: Q8_STRIDE_BYTES,
};

export function ingestStride(format: string): number {
  const stride = INGEST_FORMATS[format];
  if (stride === undefined) {
    throw new Error(`Unsupported point format ${format}`);
  }
  return stride;
}

// Decode an ingest payload to the internal 18-byte layout. v1 is returned as is.
// v2 has no colour; r, g and b are set to the intensity so the fused cloud has a
// consistent grey ramp.
export function toInternalPoints(payload: Buffer, format: string): Buffer {
  if (format === POINT_FORMAT) {
    return payload;
  }
  if (format !== INGEST_FORMAT_Q4) {
    throw new Error(`Unsupported point format ${format}`);
  }
  const count = payload.byteLength / Q4_STRIDE_BYTES;
  const out = Buffer.allocUnsafe(count * POINT_STRIDE_BYTES);
  for (let i = 0; i < count; i++) {
    const o = i * Q4_STRIDE_BYTES;
    const w = i * POINT_STRIDE_BYTES;
    out.writeFloatLE(payload.readInt16LE(o) * Q4_METERS, w);
    out.writeFloatLE(payload.readInt16LE(o + 2) * Q4_METERS, w + 4);
    out.writeFloatLE(payload.readInt16LE(o + 4) * Q4_METERS, w + 8);
    const intensity = payload[o + 6];
    out[w + 12] = intensity;
    out[w + 13] = intensity;
    out[w + 14] = intensity;
    out.writeUInt16LE(intensity << 8, w + 15);
    out[w + 17] = 0;
  }
  return out;
}

// Encode internal points as xyzi_q4_v2 (publishers and tests). Coordinates beyond
// ±131 m saturate; the ingest range limit is far below that.
export function encodeQ4(internal: Buffer): Buffer {
  const count = internal.byteLength / POINT_STRIDE_BYTES;
  const out = Buffer.allocUnsafe(count * Q4_STRIDE_BYTES);
  for (let i = 0; i < count; i++) {
    const o = i * POINT_STRIDE_BYTES;
    const w = i * Q4_STRIDE_BYTES;
    out.writeInt16LE(clampI16(Math.round(internal.readFloatLE(o) / Q4_METERS)), w);
    out.writeInt16LE(clampI16(Math.round(internal.readFloatLE(o + 4) / Q4_METERS)), w + 2);
    out.writeInt16LE(clampI16(Math.round(internal.readFloatLE(o + 8) / Q4_METERS)), w + 4);
    out[w + 6] = internal.readUInt16LE(o + 15) >> 8;
  }
  return out;
}

// Encode served world-frame points as q8_chunk_v2 relative to a chunk origin. Points
// are voxel means inside the chunk, so they always fit; anything outside clamps.
export function encodeQ8Chunk(internal: Buffer, origin: [number, number, number], chunkSizeMeters: number): Buffer {
  const count = internal.byteLength / POINT_STRIDE_BYTES;
  const out = Buffer.allocUnsafe(count * Q8_STRIDE_BYTES);
  const scale = Q8_STEPS / chunkSizeMeters;
  for (let i = 0; i < count; i++) {
    const o = i * POINT_STRIDE_BYTES;
    const w = i * Q8_STRIDE_BYTES;
    out[w] = clampU8(Math.floor((internal.readFloatLE(o) - origin[0]) * scale));
    out[w + 1] = clampU8(Math.floor((internal.readFloatLE(o + 4) - origin[1]) * scale));
    out[w + 2] = clampU8(Math.floor((internal.readFloatLE(o + 8) - origin[2]) * scale));
    out[w + 3] = internal[o + 12];
    out[w + 4] = internal[o + 13];
    out[w + 5] = internal[o + 14];
    out[w + 6] = internal.readUInt16LE(o + 15) >> 8;
  }
  return out;
}

// Decode q8_chunk_v2 back to internal world-frame points (tests and tooling; the web
// viewer has its own decoder). Positions are reconstructed at cell centres.
export function decodeQ8Chunk(payload: Buffer, origin: [number, number, number], chunkSizeMeters: number): Buffer {
  const count = payload.byteLength / Q8_STRIDE_BYTES;
  const out = Buffer.allocUnsafe(count * POINT_STRIDE_BYTES);
  const quantum = chunkSizeMeters / Q8_STEPS;
  for (let i = 0; i < count; i++) {
    const o = i * Q8_STRIDE_BYTES;
    const w = i * POINT_STRIDE_BYTES;
    out.writeFloatLE(origin[0] + (payload[o] + 0.5) * quantum, w);
    out.writeFloatLE(origin[1] + (payload[o + 1] + 0.5) * quantum, w + 4);
    out.writeFloatLE(origin[2] + (payload[o + 2] + 0.5) * quantum, w + 8);
    out[w + 12] = payload[o + 3];
    out[w + 13] = payload[o + 4];
    out[w + 14] = payload[o + 5];
    out.writeUInt16LE(payload[o + 6] << 8, w + 15);
    out[w + 17] = 0;
  }
  return out;
}

function clampI16(value: number): number {
  return value < -32768 ? -32768 : value > 32767 ? 32767 : value;
}

function clampU8(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}
