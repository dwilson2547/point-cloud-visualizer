// Append-only per-session batch log: the durability anchor for ingest. One record per
// accepted point batch (the raw local-frame payload plus the pose it was registered
// with), framed so a torn tail is detectable and truncated on recovery. Fused chunk
// files are a cache derived from this log; anything after a session's checkpoint
// offset is replayed into the chunk store at startup.
//
// Record layout (little-endian):
//   u32 magic 'PCVL'
//   u32 header length (JSON bytes)
//   u32 payload length (point bytes)
//   u32 crc32 over header ++ payload
//   header JSON, then payload
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import type { Pose } from './protocol.js';

export const LOG_MAGIC = 0x4c564350; // 'PCVL'
const FRAME_BYTES = 16;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 2 ** 31 - 1;

export interface LogRecordHeader {
  sequence: number;
  pose_sequence: number;
  timestamp: string;
  point_count: number;
  pose: Pose;
}

export interface LogRecord {
  header: LogRecordHeader;
  payload: Buffer;
  offset: number; // byte offset of this record's frame
  nextOffset: number; // byte offset just past the record
}

export interface ReplayResult {
  endOffset: number; // where the next append will land (after any truncation)
  records: number;
  truncatedBytes: number; // bytes discarded from a torn or corrupt tail
}

export function encodeRecord(header: LogRecordHeader, payload: Buffer): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const frame = Buffer.allocUnsafe(FRAME_BYTES);
  frame.writeUInt32LE(LOG_MAGIC, 0);
  frame.writeUInt32LE(headerBytes.byteLength, 4);
  frame.writeUInt32LE(payload.byteLength, 8);
  frame.writeUInt32LE(zlib.crc32(payload, zlib.crc32(headerBytes)), 12);
  return Buffer.concat([frame, headerBytes, payload]);
}

// One open log per active session. Appends are a single write plus one fsync, which
// is the whole per-batch durability cost of the ingest path.
export class BatchLogWriter {
  private descriptor: number | undefined;
  private endOffset: number;

  constructor(readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.descriptor = fs.openSync(filePath, 'a');
    this.endOffset = fs.fstatSync(this.descriptor).size;
  }

  get offset(): number {
    return this.endOffset;
  }

  append(header: LogRecordHeader, payload: Buffer): number {
    if (this.descriptor === undefined) {
      throw new Error(`Batch log ${this.filePath} is closed`);
    }
    const record = encodeRecord(header, payload);
    let written = 0;
    while (written < record.byteLength) {
      written += fs.writeSync(this.descriptor, record, written, record.byteLength - written);
    }
    fs.fsyncSync(this.descriptor);
    this.endOffset += record.byteLength;
    return this.endOffset;
  }

  close(): void {
    if (this.descriptor !== undefined) {
      fs.closeSync(this.descriptor);
      this.descriptor = undefined;
    }
  }
}

// Read the single record that starts at `offset`. Used by partial rebuilds, which know
// each batch's offset from the store's batch index. Throws on a corrupt frame.
export function readLogRecordAt(filePath: string, offset: number): LogRecord {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const frame = Buffer.allocUnsafe(FRAME_BYTES);
    if (fs.readSync(descriptor, frame, 0, FRAME_BYTES, offset) !== FRAME_BYTES) {
      throw new Error(`Batch log ${filePath}: no record at offset ${offset}`);
    }
    const headerLength = frame.readUInt32LE(4);
    const payloadLength = frame.readUInt32LE(8);
    if (frame.readUInt32LE(0) !== LOG_MAGIC || headerLength === 0 || headerLength > MAX_HEADER_BYTES) {
      throw new Error(`Batch log ${filePath}: corrupt frame at offset ${offset}`);
    }
    const body = Buffer.allocUnsafe(headerLength + payloadLength);
    if (fs.readSync(descriptor, body, 0, body.byteLength, offset + FRAME_BYTES) !== body.byteLength) {
      throw new Error(`Batch log ${filePath}: torn record at offset ${offset}`);
    }
    if (zlib.crc32(body) !== frame.readUInt32LE(12)) {
      throw new Error(`Batch log ${filePath}: crc mismatch at offset ${offset}`);
    }
    const header = JSON.parse(body.subarray(0, headerLength).toString('utf8')) as LogRecordHeader;
    return { header, payload: body.subarray(headerLength), offset, nextOffset: offset + FRAME_BYTES + body.byteLength };
  } finally {
    fs.closeSync(descriptor);
  }
}

// Walk records from `fromOffset`, calling `visit` for each intact one. Stops at the
// first torn or corrupt record and truncates the file there, so a crash mid-append
// leaves a log whose every record is complete. Returns where the log now ends.
export function replayLog(
  filePath: string,
  fromOffset: number,
  visit: (record: LogRecord) => void,
): ReplayResult {
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, 'r+');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return { endOffset: 0, records: 0, truncatedBytes: 0 };
    }
    throw error;
  }
  try {
    const size = fs.fstatSync(descriptor).size;
    let offset = Math.min(fromOffset, size);
    let records = 0;
    const frame = Buffer.allocUnsafe(FRAME_BYTES);

    while (offset < size) {
      if (size - offset < FRAME_BYTES) {
        break; // torn frame
      }
      fs.readSync(descriptor, frame, 0, FRAME_BYTES, offset);
      const magic = frame.readUInt32LE(0);
      const headerLength = frame.readUInt32LE(4);
      const payloadLength = frame.readUInt32LE(8);
      const expectedCrc = frame.readUInt32LE(12);
      if (
        magic !== LOG_MAGIC ||
        headerLength === 0 ||
        headerLength > MAX_HEADER_BYTES ||
        payloadLength > MAX_PAYLOAD_BYTES ||
        size - offset - FRAME_BYTES < headerLength + payloadLength
      ) {
        break; // corrupt frame or torn body
      }
      const body = Buffer.allocUnsafe(headerLength + payloadLength);
      fs.readSync(descriptor, body, 0, body.byteLength, offset + FRAME_BYTES);
      if (zlib.crc32(body) !== expectedCrc) {
        break;
      }
      let header: LogRecordHeader;
      try {
        header = JSON.parse(body.subarray(0, headerLength).toString('utf8')) as LogRecordHeader;
      } catch {
        break;
      }
      const nextOffset = offset + FRAME_BYTES + body.byteLength;
      visit({ header, payload: body.subarray(headerLength), offset, nextOffset });
      records += 1;
      offset = nextOffset;
    }

    const truncatedBytes = size - offset;
    if (truncatedBytes > 0) {
      fs.ftruncateSync(descriptor, offset);
      fs.fsyncSync(descriptor);
    }
    return { endOffset: offset, records, truncatedBytes };
  } finally {
    fs.closeSync(descriptor);
  }
}
