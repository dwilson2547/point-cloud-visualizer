import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { POINT_FORMAT, POINT_STRIDE_BYTES } from '../src/protocol.js';
import { connect, messagesOf, reservePort, startServer, stopServer } from './helpers.js';

test('restores sessions and chunks across restart, then resumes at the persisted sequence', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcv-restart-'));
  const port = await reservePort();
  let server = await startServer(port, dataDir);
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
      session_id: 'restart-session',
      publisher_id: 'restart-publisher',
      started_at: '2026-07-10T00:00:00Z',
      frame_id: 'map',
      units: 'meters',
    }),
  );
  assert.equal((await ingestMessages.nextJson()).type, 'session_ack');
  sendPoseAndBatch(ingest, 1, 2, 0.25);
  const firstAck = await ingestMessages.nextJson();
  assert.equal(firstAck.type, 'point_batch_ack');
  assert.equal(firstAck.sequence, 2);
  ingest.close();
  await once(ingest, 'close');

  await stopServer(server);
  server = await startServer(port, dataDir);

  const sessionsResponse = await fetch(`http://127.0.0.1:${port}/sessions`);
  assert.equal(sessionsResponse.ok, true);
  const sessions = (await sessionsResponse.json()) as Array<Record<string, unknown>>;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, 'restart-session');
  assert.equal(sessions[0].lastSequence, 2);
  assert.equal(sessions[0].totalPoints, 1);

  const viewer = await connect(
    `ws://127.0.0.1:${port}/ws/view?session_id=restart-session`,
  );
  const viewerMessages = messagesOf(viewer);
  const state = await viewerMessages.nextJson();
  assert.equal(state.type, 'viewer_session_state');
  assert.equal(state.last_sequence, 2);
  const bootstrap = await viewerMessages.nextJson();
  assert.equal(bootstrap.type, 'chunk_bootstrap');
  assert.equal(bootstrap.point_count, 1);
  const bootstrapPayload = await viewerMessages.next();
  assert.equal(bootstrapPayload.isBinary, true);
  assert.equal(Buffer.from(bootstrapPayload.data as ArrayBuffer).byteLength, POINT_STRIDE_BYTES);
  viewer.close();
  await once(viewer, 'close');

  const resumed = await connect(`ws://127.0.0.1:${port}/ws/ingest`);
  const resumedMessages = messagesOf(resumed);
  resumed.send(
    JSON.stringify({
      type: 'resume_session',
      protocol_version: 1,
      session_id: 'restart-session',
      publisher_id: 'restart-publisher',
      last_client_sequence: 2,
    }),
  );
  const resumeAck = await resumedMessages.nextJson();
  assert.equal(resumeAck.type, 'session_ack');
  assert.equal(resumeAck.resume_from_sequence, 3);

  sendPoseAndBatch(resumed, 3, 4, 0.5);
  const secondAck = await resumedMessages.nextJson();
  assert.equal(secondAck.type, 'point_batch_ack');
  assert.equal(secondAck.sequence, 4);
  const resumedClosed = once(resumed, 'close');
  await stopServer(server);
  await resumedClosed;
});

function sendPoseAndBatch(ws: WebSocket, poseSequence: number, batchSequence: number, x: number): void {
  const timestamp = new Date().toISOString();
  ws.send(
    JSON.stringify({
      type: 'pose_update',
      session_id: 'restart-session',
      publisher_id: 'restart-publisher',
      sequence: poseSequence,
      timestamp,
      pose: {
        translation_m: [0, 0, 0],
        rotation_xyzw: [0, 0, 0, 1],
      },
    }),
  );
  const payload = Buffer.alloc(POINT_STRIDE_BYTES);
  payload.writeFloatLE(x, 0);
  payload.writeFloatLE(0.25, 4);
  payload.writeFloatLE(0.25, 8);
  ws.send(
    JSON.stringify({
      type: 'point_batch_header',
      session_id: 'restart-session',
      publisher_id: 'restart-publisher',
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
