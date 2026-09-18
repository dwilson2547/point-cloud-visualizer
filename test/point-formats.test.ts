import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  INGEST_FORMAT_Q4,
  Q4_METERS,
  Q4_STRIDE_BYTES,
  Q8_STRIDE_BYTES,
  SERVE_FORMAT_Q8,
  decodeQ8Chunk,
  encodeQ4,
  encodeQ8Chunk,
  toInternalPoints,
} from '../src/point-formats.js';
import { POINT_FORMAT, POINT_STRIDE_BYTES } from '../src/protocol.js';
import { connect, messagesOf, reservePort, startServer, stopServer } from './helpers.js';

function internal(points: Array<[number, number, number, number]>): Buffer {
  const buffer = Buffer.alloc(points.length * POINT_STRIDE_BYTES);
  points.forEach(([x, y, z, intensity], i) => {
    const o = i * POINT_STRIDE_BYTES;
    buffer.writeFloatLE(x, o);
    buffer.writeFloatLE(y, o + 4);
    buffer.writeFloatLE(z, o + 8);
    buffer[o + 12] = 10;
    buffer[o + 13] = 20;
    buffer[o + 14] = 30;
    buffer.writeUInt16LE(intensity, o + 15);
  });
  return buffer;
}

test('xyzi_q4_v2 round-trips within 2 mm and saturates at the int16 range', () => {
  const source = internal([[1.2345, -0.0011, 7.777, 65535], [-131.07, 200, 0, 0x1234]]);
  const q4 = encodeQ4(source);
  assert.equal(q4.byteLength, 2 * Q4_STRIDE_BYTES);
  const back = toInternalPoints(q4, INGEST_FORMAT_Q4);
  assert.equal(back.byteLength, 2 * POINT_STRIDE_BYTES);
  for (const [i, expected] of [[0, 1.2345], [4, -0.0011], [8, 7.777]] as const) {
    assert.ok(Math.abs(back.readFloatLE(i) - expected) <= Q4_METERS / 2 + 1e-9);
  }
  assert.equal(back[12], 255, 'colour is the 8-bit intensity');
  assert.equal(back.readUInt16LE(15), 255 << 8);
  assert.ok(Math.abs(back.readFloatLE(POINT_STRIDE_BYTES + 4) - 32767 * Q4_METERS) < 1e-4, '200 m saturates');
  assert.equal(toInternalPoints(source, POINT_FORMAT), source, 'v1 passes through untouched');
});

test('q8_chunk_v2 places served voxels within one step of their chunk-relative position', () => {
  const size = 2;
  const origin: [number, number, number] = [4, -2, 0];
  const source = internal([[4.013, -1.999, 1.999, 300], [5.5, -1, 0.5, 0]]);
  const q8 = encodeQ8Chunk(source, origin, size);
  assert.equal(q8.byteLength, 2 * Q8_STRIDE_BYTES);
  const back = decodeQ8Chunk(q8, origin, size);
  const step = size / 256;
  for (let i = 0; i < 2; i++) {
    for (const axis of [0, 4, 8]) {
      const o = i * POINT_STRIDE_BYTES + axis;
      assert.ok(Math.abs(back.readFloatLE(o) - source.readFloatLE(o)) <= step, `axis ${axis} within ${step} m`);
    }
  }
  assert.deepEqual([back[12], back[13], back[14]], [10, 20, 30]);
});

test('a q4 publisher and a q8 viewer interoperate end to end', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcv-formats-'));
  const port = await reservePort();
  const server = await startServer(port, dataDir, { CHUNK_SIZE_METERS: '2', CHECKPOINT_TICK_MS: '50' });
  t.after(async () => {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const ingest = await connect(`ws://127.0.0.1:${port}/ws/ingest`);
  const ingestMessages = messagesOf(ingest);
  ingest.send(
    JSON.stringify({
      type: 'create_session',
      protocol_version: 1,
      session_id: 'formats',
      publisher_id: 'formats-pub',
      started_at: '2026-07-10T00:00:00Z',
      frame_id: 'map',
      units: 'meters',
    }),
  );
  assert.equal((await ingestMessages.nextJson()).type, 'session_ack');
  const timestamp = new Date().toISOString();
  ingest.send(
    JSON.stringify({
      type: 'pose_update',
      session_id: 'formats',
      publisher_id: 'formats-pub',
      sequence: 1,
      timestamp,
      pose: { translation_m: [4, 0, 0], rotation_xyzw: [0, 0, 0, 1] },
    }),
  );
  // Local (0.5, 0.5, 0.5) at 4 mm steps -> world (4.5, 0.5, 0.5): chunk 2_0_0.
  const payload = encodeQ4(internal([[0.5, 0.5, 0.5, 0x8000]]));
  ingest.send(
    JSON.stringify({
      type: 'point_batch_header',
      session_id: 'formats',
      publisher_id: 'formats-pub',
      sequence: 2,
      timestamp,
      pose_sequence: 1,
      point_count: 1,
      point_format: INGEST_FORMAT_Q4,
      encoding: 'binary_le',
      compression: 'none',
      stride_bytes: Q4_STRIDE_BYTES,
    }),
  );
  ingest.send(payload, { binary: true });
  const ack = await ingestMessages.nextJson();
  assert.equal(ack.type, 'point_batch_ack', JSON.stringify(ack));

  // A wrong stride for the format is rejected without advancing the sequence.
  ingest.send(
    JSON.stringify({
      type: 'point_batch_header',
      session_id: 'formats',
      publisher_id: 'formats-pub',
      sequence: 3,
      timestamp,
      pose_sequence: 1,
      point_count: 1,
      point_format: INGEST_FORMAT_Q4,
      encoding: 'binary_le',
      compression: 'none',
      stride_bytes: 18,
    }),
  );
  ingest.send(Buffer.alloc(18), { binary: true });
  const rejected = await ingestMessages.nextJson();
  assert.equal(rejected.type, 'error');
  assert.match(String(rejected.message), /stride/);

  // The chunks listing shows persisted chunks; wait for the checkpoint tick.
  let chunks: Array<{ chunkKey: string }> = [];
  for (const deadline = Date.now() + 5_000; chunks.length === 0 && Date.now() < deadline; ) {
    chunks = (await (await fetch(`http://127.0.0.1:${port}/sessions/formats/chunks`)).json()) as Array<{ chunkKey: string }>;
    if (chunks.length === 0) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.deepEqual(chunks.map((c) => c.chunkKey), ['2_0_0'], 'decoded into the right chunk');

  assert.equal(
    (await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json()) as { ingestFormats: string[] }).ingestFormats.includes(INGEST_FORMAT_Q4),
    true,
  );

  const viewer = await connect(`ws://127.0.0.1:${port}/ws/view?session_id=formats&lod=1&fmt=${SERVE_FORMAT_Q8}`);
  const viewerMessages = messagesOf(viewer);
  assert.equal((await viewerMessages.nextJson()).type, 'viewer_session_state');
  viewer.send(
    JSON.stringify({
      type: 'viewer_view',
      session_id: 'formats',
      position: [4.5, -5, 0.5],
      forward: [0, 1, 0],
      up: [0, 0, 1],
      fov_y_rad: 1.0,
      viewport_px: [800, 600],
      near_m: 0.05,
      far_m: 100,
    }),
  );
  const keyframe = await viewerMessages.nextJson();
  assert.equal(keyframe.type, 'chunk_lod');
  assert.equal(keyframe.point_format, SERVE_FORMAT_Q8);
  assert.equal(keyframe.stride_bytes, Q8_STRIDE_BYTES);
  assert.deepEqual(keyframe.origin, [4, 0, 0]);
  assert.equal(keyframe.quantum, 2 / 256);
  const body = Buffer.from((await viewerMessages.next()).data as ArrayBuffer);
  assert.equal(body.byteLength, Q8_STRIDE_BYTES);
  const decoded = decodeQ8Chunk(body, keyframe.origin as [number, number, number], 2);
  assert.ok(Math.abs(decoded.readFloatLE(0) - 4.5) <= 2 / 256);
  assert.ok(Math.abs(decoded.readFloatLE(4) - 0.5) <= 2 / 256);
  assert.equal(decoded[12], 0x80, 'intensity carried as grey');

  // An unknown served format is refused at the upgrade.
  const bad = new (await import('ws')).WebSocket(`ws://127.0.0.1:${port}/ws/view?session_id=formats&lod=1&fmt=nope`);
  await once(bad, 'error');

  ingest.close();
  viewer.close();
  await Promise.all([once(ingest, 'close'), once(viewer, 'close')]);
});
