import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { POINT_FORMAT, POINT_STRIDE_BYTES } from '../src/protocol.js';
import { SocketMessages, connect, reservePort, startServer, stopServer } from './helpers.js';

test('a viewer receives a keyframe, then only the added voxels as deltas', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcv-deltas-'));
  const port = await reservePort();
  const server = await startServer(port, dataDir, { CHUNK_SIZE_METERS: '1', LIVE_REFRESH_MS: '50' });
  t.after(async () => {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const ingest = await connect(`ws://127.0.0.1:${port}/ws/ingest`);
  const ingestMessages = new SocketMessages(ingest);
  ingest.send(
    JSON.stringify({
      type: 'create_session',
      protocol_version: 1,
      session_id: 'deltas',
      publisher_id: 'deltas-pub',
      started_at: '2026-07-10T00:00:00Z',
      frame_id: 'map',
      units: 'meters',
    }),
  );
  assert.equal((await ingestMessages.nextJson()).type, 'session_ack');
  let sequence = 0;
  const publish = async (points: Array<[number, number, number]>): Promise<void> => {
    const poseSequence = ++sequence;
    const batchSequence = ++sequence;
    const timestamp = new Date().toISOString();
    ingest.send(
      JSON.stringify({
        type: 'pose_update',
        session_id: 'deltas',
        publisher_id: 'deltas-pub',
        sequence: poseSequence,
        timestamp,
        pose: { translation_m: [0, 0, 0], rotation_xyzw: [0, 0, 0, 1] },
      }),
    );
    const payload = Buffer.alloc(points.length * POINT_STRIDE_BYTES);
    points.forEach(([x, y, z], i) => {
      payload.writeFloatLE(x, i * POINT_STRIDE_BYTES);
      payload.writeFloatLE(y, i * POINT_STRIDE_BYTES + 4);
      payload.writeFloatLE(z, i * POINT_STRIDE_BYTES + 8);
    });
    ingest.send(
      JSON.stringify({
        type: 'point_batch_header',
        session_id: 'deltas',
        publisher_id: 'deltas-pub',
        sequence: batchSequence,
        timestamp,
        pose_sequence: poseSequence,
        point_count: points.length,
        point_format: POINT_FORMAT,
        encoding: 'binary_le',
        compression: 'none',
        stride_bytes: POINT_STRIDE_BYTES,
      }),
    );
    ingest.send(payload, { binary: true });
    assert.equal((await ingestMessages.nextJson()).type, 'point_batch_ack');
  };

  // Two voxels in chunk 0 before the viewer arrives.
  await publish([[0.1, 0.5, 0.5], [0.2, 0.5, 0.5]]);

  const viewer = await connect(`ws://127.0.0.1:${port}/ws/view?session_id=deltas&lod=1`);
  const viewerMessages = new SocketMessages(viewer);
  assert.equal((await viewerMessages.nextJson()).type, 'viewer_session_state');
  viewer.send(
    JSON.stringify({
      type: 'viewer_view',
      session_id: 'deltas',
      position: [-3, 0.5, 0.5],
      forward: [1, 0, 0],
      up: [0, 0, 1],
      fov_y_rad: 1.0,
      viewport_px: [800, 600],
      near_m: 0.05,
      far_m: 100,
    }),
  );
  // Live overlay updates for the viewer arrive too; skip anything that is not base-layer.
  const nextBase = async (): Promise<Record<string, unknown>> => {
    for (;;) {
      const msg = await viewerMessages.nextJson();
      if (msg.type === 'chunk_update') {
        await viewerMessages.next(); // its payload
        continue;
      }
      return msg;
    }
  };
  const keyframe = await nextBase();
  assert.equal(keyframe.type, 'chunk_lod');
  assert.equal(keyframe.point_count, 2);
  assert.equal(keyframe.version, 2);
  assert.equal(Buffer.from((await viewerMessages.next()).data as ArrayBuffer).byteLength, 2 * POINT_STRIDE_BYTES);

  // One new voxel plus a repeat hit: the refresh tick sends a delta of exactly one point.
  await publish([[0.3, 0.5, 0.5], [0.101, 0.5, 0.5]]);
  const delta = await nextBase();
  assert.equal(delta.type, 'chunk_delta', JSON.stringify(delta));
  assert.equal(delta.point_count, 1);
  assert.equal(delta.version, 3);
  const deltaPayload = Buffer.from((await viewerMessages.next()).data as ArrayBuffer);
  assert.equal(deltaPayload.byteLength, POINT_STRIDE_BYTES);
  assert.ok(Math.abs(deltaPayload.readFloatLE(0) - 0.3) < 1e-6);

  // Doubling since the keyframe (2 -> 4 voxels) forces a fresh keyframe.
  await publish([[0.4, 0.5, 0.5]]);
  const settled = await nextBase();
  assert.equal(settled.type, 'chunk_lod');
  assert.equal(settled.point_count, 4);
  assert.equal(settled.version, 4);
  await viewerMessages.next();

  ingest.close();
  viewer.close();
  await Promise.all([once(ingest, 'close'), once(viewer, 'close')]);
});
