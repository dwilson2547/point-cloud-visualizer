import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildFrustum, frustumContainsPoint } from '../src/lod-select.js';
import { POINT_FORMAT, POINT_STRIDE_BYTES } from '../src/protocol.js';
import { connect, messagesOf, reservePort, startServer, stopServer } from './helpers.js';

test('frustumContainsPoint accepts points in view and rejects those behind or beside it', () => {
  const frustum = buildFrustum({
    position: [0, 0, 0],
    forward: [1, 0, 0],
    up: [0, 0, 1],
    fovYRad: Math.PI / 2,
    viewportPx: [100, 100],
    nearM: 0.1,
    farM: 50,
  });
  assert.equal(frustumContainsPoint(frustum, 5, 0, 0), true);
  assert.equal(frustumContainsPoint(frustum, 5, 4, 0), true, 'inside the 90° cone');
  assert.equal(frustumContainsPoint(frustum, 5, 6, 0), false, 'outside the cone');
  assert.equal(frustumContainsPoint(frustum, -5, 0, 0), false, 'behind');
  assert.equal(frustumContainsPoint(frustum, 60, 0, 0), false, 'beyond far');
});

test('the live overlay is culled per viewer to the points in its view, capped, or switched off', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcv-overlay-'));
  const port = await reservePort();
  const server = await startServer(port, dataDir, { LIVE_REFRESH_MS: '60000' });
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
      session_id: 'overlay',
      publisher_id: 'overlay-pub',
      started_at: '2026-07-10T00:00:00Z',
      frame_id: 'map',
      units: 'meters',
    }),
  );
  assert.equal((await ingestMessages.nextJson()).type, 'session_ack');
  let sequence = 0;
  const publish = async (xs: number[]): Promise<void> => {
    const poseSequence = ++sequence;
    const batchSequence = ++sequence;
    const timestamp = new Date().toISOString();
    ingest.send(
      JSON.stringify({
        type: 'pose_update',
        session_id: 'overlay',
        publisher_id: 'overlay-pub',
        sequence: poseSequence,
        timestamp,
        pose: { translation_m: [0, 0, 0], rotation_xyzw: [0, 0, 0, 1] },
      }),
    );
    const payload = Buffer.alloc(xs.length * POINT_STRIDE_BYTES);
    xs.forEach((x, i) => {
      payload.writeFloatLE(x, i * POINT_STRIDE_BYTES);
      payload.writeFloatLE(0.1, i * POINT_STRIDE_BYTES + 4);
      payload.writeFloatLE(0.1, i * POINT_STRIDE_BYTES + 8);
    });
    ingest.send(
      JSON.stringify({
        type: 'point_batch_header',
        session_id: 'overlay',
        publisher_id: 'overlay-pub',
        sequence: batchSequence,
        timestamp,
        pose_sequence: poseSequence,
        point_count: xs.length,
        point_format: POINT_FORMAT,
        encoding: 'binary_le',
        compression: 'none',
        stride_bytes: POINT_STRIDE_BYTES,
      }),
    );
    ingest.send(payload, { binary: true });
    assert.equal((await ingestMessages.nextJson()).type, 'point_batch_ack');
  };

  // A plain viewer (no view sent) and an LOD viewer looking down +x from the origin.
  const plain = await connect(`ws://127.0.0.1:${port}/ws/view?session_id=overlay`);
  const plainMessages = messagesOf(plain);
  assert.equal((await plainMessages.nextJson()).type, 'viewer_session_state');
  const lod = await connect(`ws://127.0.0.1:${port}/ws/view?session_id=overlay&lod=1`);
  const lodMessages = messagesOf(lod);
  assert.equal((await lodMessages.nextJson()).type, 'viewer_session_state');
  const view = (extra: Record<string, unknown> = {}): void => {
    lod.send(
      JSON.stringify({
        type: 'viewer_view',
        session_id: 'overlay',
        position: [0, 0, 0],
        forward: [1, 0, 0],
        up: [0, 0, 1],
        fov_y_rad: Math.PI / 2,
        viewport_px: [100, 100],
        near_m: 0.05,
        far_m: 50,
        ...extra,
      }),
    );
  };
  view();
  await new Promise((resolve) => setTimeout(resolve, 150)); // let the view register (throttled 100 ms)
  // Base-layer traffic (keyframes for chunks that appear) interleaves with the overlay;
  // wait for the next chunk_update, or report quiet after `timeoutMs`.
  const nextOverlay = async (timeoutMs = 2_000): Promise<Record<string, unknown> | null> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      const msg = await Promise.race([
        lodMessages.nextJson(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
      ]);
      if (msg === null) return null;
      if (msg.type === 'chunk_update') return msg;
      if (msg.type === 'chunk_lod' || msg.type === 'chunk_delta') await lodMessages.next(); // payload
    }
  };

  // Four points ahead, four behind: the plain viewer gets all eight, the LOD viewer four.
  await publish([1, 2, 3, 4, -1, -2, -3, -4]);
  const plainUpdate = await plainMessages.nextJson();
  assert.equal(plainUpdate.type, 'chunk_update');
  assert.equal(plainUpdate.point_count, 8);
  assert.equal(Buffer.from((await plainMessages.next()).data as ArrayBuffer).byteLength, 8 * POINT_STRIDE_BYTES);
  const culled = await nextOverlay();
  assert.ok(culled, 'overlay expected');
  assert.equal(culled.point_count, 4);
  const culledPayload = Buffer.from((await lodMessages.next()).data as ArrayBuffer);
  assert.equal(culledPayload.byteLength, 4 * POINT_STRIDE_BYTES);
  for (let i = 0; i < 4; i++) {
    assert.ok(culledPayload.readFloatLE(i * POINT_STRIDE_BYTES) > 0, 'only points ahead of the camera');
  }

  // A cap thins the kept points evenly.
  view({ overlay_max_points: 2 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await publish([1, 2, 3, 4, -1, -2, -3, -4]);
  await plainMessages.nextJson();
  await plainMessages.next();
  const capped = await nextOverlay();
  assert.ok(capped, 'capped overlay expected');
  assert.equal(capped.point_count, 2);
  const cappedPayload = Buffer.from((await lodMessages.next()).data as ArrayBuffer);
  assert.deepEqual([cappedPayload.readFloatLE(0), cappedPayload.readFloatLE(POINT_STRIDE_BYTES)], [1, 3]);

  // Overlay off: nothing arrives for the LOD viewer while the plain viewer still gets the batch.
  view({ overlay: false });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await publish([1, 2]);
  assert.equal((await plainMessages.nextJson()).point_count, 2);
  await plainMessages.next();
  assert.equal(await nextOverlay(400), null, 'no overlay for a viewer that switched it off');

  ingest.close();
  plain.close();
  lod.close();
  await Promise.all([once(ingest, 'close'), once(plain, 'close'), once(lod, 'close')]);
});
