import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { POINT_FORMAT, POINT_STRIDE_BYTES } from '../src/protocol.js';
import { SocketMessages, connect, reservePort, startServer, stopServer } from './helpers.js';

test('installing pose corrections rebuilds the session from its log and resets viewers', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcv-corrections-'));
  const port = await reservePort();
  const server = await startServer(port, dataDir, { CHUNK_SIZE_METERS: '1', CHECKPOINT_TICK_MS: '50' });
  t.after(async () => {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;

  const ingest = await connect(`ws://127.0.0.1:${port}/ws/ingest`);
  const ingestMessages = new SocketMessages(ingest);
  ingest.send(
    JSON.stringify({
      type: 'create_session',
      protocol_version: 1,
      session_id: 'corr-session',
      publisher_id: 'corr-publisher',
      started_at: '2026-07-10T00:00:00Z',
      frame_id: 'map',
      units: 'meters',
    }),
  );
  assert.equal((await ingestMessages.nextJson()).type, 'session_ack');

  const viewer = await connect(`ws://127.0.0.1:${port}/ws/view?session_id=corr-session&lod=1`);
  const viewerMessages = new SocketMessages(viewer);
  assert.equal((await viewerMessages.nextJson()).type, 'viewer_session_state');

  // One point at local x=0.25 with an identity pose: world chunk 0.
  sendPoseAndBatch(ingest, 1, 2, 0.25);
  assert.equal((await ingestMessages.nextJson()).type, 'point_batch_ack');
  const liveUpdate = await viewerMessages.nextJson();
  assert.equal(liveUpdate.type, 'chunk_update');
  assert.deepEqual((liveUpdate.pose as { translation_m: number[] }).translation_m, [0, 0, 0]);
  await viewerMessages.next(); // binary payload

  const logResponse = await fetch(`${base}/sessions/corr-session/log`);
  assert.equal(logResponse.ok, true);
  const logBytes = (await logResponse.arrayBuffer()).byteLength;
  assert.ok(logBytes > POINT_STRIDE_BYTES);
  // The sidecar tails the log with Range requests.
  const partial = await fetch(`${base}/sessions/corr-session/log`, { headers: { range: 'bytes=16-' } });
  assert.equal(partial.status, 206);
  assert.equal((await partial.arrayBuffer()).byteLength, logBytes - 16);
  const nothingNew = await fetch(`${base}/sessions/corr-session/log`, { headers: { range: `bytes=${logBytes}-` } });
  assert.equal(nothingNew.status, 416);

  assert.equal((await fetch(`${base}/sessions/corr-session/pose-corrections`)).status, 404);

  // Correct pose 1 by +1 m in x and apply a +2 m tail to everything after it.
  const put = await fetch(`${base}/sessions/corr-session/pose-corrections`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      poses: [{ pose_sequence: 1, pose: { translation_m: [1, 0, 0], rotation_xyzw: [0, 0, 0, 1] } }],
      tail: { translation_m: [2, 0, 0], rotation_xyzw: [0, 0, 0, 1] },
      metadata: { producer: 'test' },
    }),
  });
  const putText = await put.text();
  assert.equal(put.status, 200, putText);
  const putBody = JSON.parse(putText) as { batches: number; chunks: number; mode: string };
  assert.equal(putBody.batches, 1);
  assert.equal(putBody.mode, 'full', 'one batch moved out of one: past the partial threshold');

  const rebuilt = await viewerMessages.nextJson();
  assert.equal(rebuilt.type, 'session_rebuilt');
  assert.equal(rebuilt.batches, 1);

  let chunks = (await (await fetch(`${base}/sessions/corr-session/chunks`)).json()) as Array<{ chunkX: number }>;
  assert.deepEqual(chunks.map((c) => c.chunkX), [1], 'point re-fused at x=1.25');

  const installed = (await (await fetch(`${base}/sessions/corr-session/pose-corrections`)).json()) as {
    poses: unknown[];
    metadata: { producer: string };
  };
  assert.equal(installed.poses.length, 1);
  assert.equal(installed.metadata.producer, 'test');

  // A live batch after the corrected sequence is fused, and broadcast, with the tail.
  sendPoseAndBatch(ingest, 3, 4, 0.25);
  assert.equal((await ingestMessages.nextJson()).type, 'point_batch_ack');
  const tailUpdate = await viewerMessages.nextJson();
  assert.equal(tailUpdate.type, 'chunk_update');
  assert.deepEqual((tailUpdate.pose as { translation_m: number[] }).translation_m, [2, 0, 0]);
  await viewerMessages.next();
  // The live batch's chunk is resident until the checkpoint tick persists it, and the
  // chunks listing only shows persisted chunks.
  chunks = await pollChunks(base, (rows) => rows.length === 2);
  assert.deepEqual(chunks.map((c) => c.chunkX).sort(), [1, 2]);

  // Removing the corrections rebuilds with the raw logged poses.
  const del = await fetch(`${base}/sessions/corr-session/pose-corrections`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await viewerMessages.nextJson()).type, 'session_rebuilt');
  chunks = (await (await fetch(`${base}/sessions/corr-session/chunks`)).json()) as Array<{ chunkX: number }>;
  assert.deepEqual(chunks.map((c) => c.chunkX), [0]);

  assert.equal((await fetch(`${base}/sessions/nope/rebuild`, { method: 'POST' })).status, 404);

  ingest.close();
  viewer.close();
  await Promise.all([once(ingest, 'close'), once(viewer, 'close')]);
});

async function pollChunks(
  base: string,
  ready: (rows: Array<{ chunkX: number }>) => boolean,
): Promise<Array<{ chunkX: number }>> {
  const deadline = Date.now() + 5_000;
  let rows: Array<{ chunkX: number }> = [];
  while (Date.now() < deadline) {
    rows = (await (await fetch(`${base}/sessions/corr-session/chunks`)).json()) as Array<{ chunkX: number }>;
    if (ready(rows)) {
      return rows;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return rows;
}

function sendPoseAndBatch(ws: import('ws').WebSocket, poseSequence: number, batchSequence: number, x: number): void {
  const timestamp = new Date().toISOString();
  ws.send(
    JSON.stringify({
      type: 'pose_update',
      session_id: 'corr-session',
      publisher_id: 'corr-publisher',
      sequence: poseSequence,
      timestamp,
      pose: { translation_m: [0, 0, 0], rotation_xyzw: [0, 0, 0, 1] },
    }),
  );
  const payload = Buffer.alloc(POINT_STRIDE_BYTES);
  payload.writeFloatLE(x, 0);
  payload.writeFloatLE(0.25, 4);
  payload.writeFloatLE(0.25, 8);
  ws.send(
    JSON.stringify({
      type: 'point_batch_header',
      session_id: 'corr-session',
      publisher_id: 'corr-publisher',
      sequence: batchSequence,
      timestamp,
      pose_sequence: poseSequence,
      point_count: 1,
      point_format: POINT_FORMAT,
      encoding: 'binary_le',
      compression: 'none',
      stride_bytes: POINT_STRIDE_BYTES,
    }),
  );
  ws.send(payload, { binary: true });
}
