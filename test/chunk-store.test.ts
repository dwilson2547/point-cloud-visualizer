import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ChunkStore } from '../src/chunk-store.js';
import { POINT_FORMAT, POINT_STRIDE_BYTES } from '../src/protocol.js';
import { SessionStore } from '../src/session-store.js';

test('persists accepted batches into chunk files and metadata', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcv-chunks-'));
  const sessionStore = new SessionStore();
  const chunkStore = new ChunkStore({
    rootDir,
    chunkSizeMeters: 1,
    flushPointThreshold: 2,
    maxDirtyChunks: 8,
  });

  const session = sessionStore.createSession({
    type: 'create_session',
    protocol_version: 1,
    session_id: 'session-storage',
    publisher_id: 'publisher-storage',
    started_at: '2026-07-10T00:00:00Z',
    frame_id: 'map',
    units: 'meters',
  });
  chunkStore.syncSession(session);

  sessionStore.applyPoseUpdate({
    type: 'pose_update',
    session_id: 'session-storage',
    publisher_id: 'publisher-storage',
    sequence: 1,
    timestamp: '2026-07-10T00:00:01Z',
    pose: {
      translation_m: [1, 0, 0],
      rotation_xyzw: [0, 0, 0, 1],
    },
  });

  const payload = Buffer.alloc(POINT_STRIDE_BYTES * 2);
  payload.writeFloatLE(0.25, 0);
  payload.writeFloatLE(0.25, 4);
  payload.writeFloatLE(0.25, 8);
  payload[12] = 10;
  payload[13] = 20;
  payload[14] = 30;
  payload.writeUInt16LE(40, 15);

  payload.writeFloatLE(0.75, POINT_STRIDE_BYTES);
  payload.writeFloatLE(0.5, POINT_STRIDE_BYTES + 4);
  payload.writeFloatLE(0.5, POINT_STRIDE_BYTES + 8);
  payload[POINT_STRIDE_BYTES + 12] = 50;
  payload[POINT_STRIDE_BYTES + 13] = 60;
  payload[POINT_STRIDE_BYTES + 14] = 70;
  payload.writeUInt16LE(80, POINT_STRIDE_BYTES + 15);

  const accepted = sessionStore.acceptPointBatch(
    {
      type: 'point_batch_header',
      session_id: 'session-storage',
      publisher_id: 'publisher-storage',
      sequence: 2,
      timestamp: '2026-07-10T00:00:02Z',
      pose_sequence: 1,
      point_count: 2,
      point_format: POINT_FORMAT,
      encoding: 'binary_le',
      compression: 'none',
      stride_bytes: POINT_STRIDE_BYTES,
    },
    payload,
  );

  chunkStore.storeAcceptedBatch(accepted);
  chunkStore.flushAll();

  const chunks = chunkStore.listSessionChunks('session-storage');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].pointCount, 2);
  assert.equal(chunks[0].chunkKey, '1_0_0');
  assert.equal(chunks[0].bytes, POINT_STRIDE_BYTES * 2);

  const chunkFile = path.join(rootDir, chunks[0].filePath);
  const stored = fs.readFileSync(chunkFile);
  assert.equal(stored.byteLength, POINT_STRIDE_BYTES * 2);
  assert.equal(stored.readFloatLE(0), 1.25);
  assert.equal(stored.readFloatLE(POINT_STRIDE_BYTES), 1.75);
});

test('reads back world-frame points for a session from both dirty and flushed state', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcv-bootstrap-'));
  const sessionStore = new SessionStore();
  // High flush threshold so the batch stays in dirty buffers until we flush.
  const chunkStore = new ChunkStore({ rootDir, chunkSizeMeters: 1, flushPointThreshold: 1000, maxDirtyChunks: 8 });

  const session = sessionStore.createSession({
    type: 'create_session',
    protocol_version: 1,
    session_id: 'session-bootstrap',
    publisher_id: 'publisher-bootstrap',
    started_at: '2026-07-10T00:00:00Z',
    frame_id: 'map',
    units: 'meters',
  });
  chunkStore.syncSession(session);
  sessionStore.applyPoseUpdate({
    type: 'pose_update',
    session_id: 'session-bootstrap',
    publisher_id: 'publisher-bootstrap',
    sequence: 1,
    timestamp: '2026-07-10T00:00:01Z',
    pose: { translation_m: [1, 0, 0], rotation_xyzw: [0, 0, 0, 1] },
  });

  const payload = Buffer.alloc(POINT_STRIDE_BYTES * 2);
  payload.writeFloatLE(0.25, 0);
  payload.writeFloatLE(0.75, POINT_STRIDE_BYTES);
  const accepted = sessionStore.acceptPointBatch(
    {
      type: 'point_batch_header',
      session_id: 'session-bootstrap',
      publisher_id: 'publisher-bootstrap',
      sequence: 2,
      timestamp: '2026-07-10T00:00:02Z',
      pose_sequence: 1,
      point_count: 2,
      point_format: POINT_FORMAT,
      encoding: 'binary_le',
      compression: 'none',
      stride_bytes: POINT_STRIDE_BYTES,
    },
    payload,
  );
  chunkStore.storeAcceptedBatch(accepted);

  const countPoints = (buffers: Buffer[]): number =>
    buffers.reduce((total, buffer) => total + buffer.byteLength / POINT_STRIDE_BYTES, 0);

  // Still dirty (below threshold): read comes from the in-memory buffers, world-frame.
  const dirtyRead = chunkStore.readSessionWorldChunks('session-bootstrap');
  assert.equal(countPoints(dirtyRead), 2);
  assert.equal(dirtyRead[0].readFloatLE(0), 1.25);

  // After flush: read comes from the chunk file, same world-frame points, no double count.
  chunkStore.flushAll();
  const flushedRead = chunkStore.readSessionWorldChunks('session-bootstrap');
  assert.equal(countPoints(flushedRead), 2);
  assert.equal(flushedRead[0].readFloatLE(0), 1.25);
});
