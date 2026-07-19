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

test('fuses repeated observations of a voxel into one mean representative and bounds density', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcv-fuse-'));
  const sessionStore = new SessionStore();
  // 4 cm voxels, high flush threshold so the batch stays resident (read from memory),
  // then we flush and re-read to prove the disk round-trip fuses identically.
  const chunkStore = new ChunkStore({
    rootDir,
    chunkSizeMeters: 1,
    fuseVoxelMeters: 0.04,
    flushPointThreshold: 100_000,
    maxDirtyChunks: 8,
  });

  const session = sessionStore.createSession({
    type: 'create_session',
    protocol_version: 1,
    session_id: 'session-fuse',
    publisher_id: 'publisher-fuse',
    started_at: '2026-07-10T00:00:00Z',
    frame_id: 'map',
    units: 'meters',
  });
  chunkStore.syncSession(session);
  sessionStore.applyPoseUpdate({
    type: 'pose_update',
    session_id: 'session-fuse',
    publisher_id: 'publisher-fuse',
    sequence: 1,
    timestamp: '2026-07-10T00:00:01Z',
    pose: { translation_m: [0, 0, 0], rotation_xyzw: [0, 0, 0, 1] },
  });

  // Three local points: A and B share a voxel (0.100 and 0.105 both floor to 0.04*2),
  // C lands in its own voxel. Identity pose, so local == world.
  const points: Array<[number, number, number]> = [
    [0.1, 0.1, 0.1],
    [0.105, 0.1, 0.1],
    [0.5, 0.5, 0.5],
  ];
  const payload = Buffer.alloc(POINT_STRIDE_BYTES * points.length);
  points.forEach(([x, y, z], i) => {
    payload.writeFloatLE(x, i * POINT_STRIDE_BYTES);
    payload.writeFloatLE(y, i * POINT_STRIDE_BYTES + 4);
    payload.writeFloatLE(z, i * POINT_STRIDE_BYTES + 8);
  });

  const countPoints = (buffers: Buffer[]): number =>
    buffers.reduce((total, buffer) => total + buffer.byteLength / POINT_STRIDE_BYTES, 0);

  // Observe the identical batch five times: density must stay at 2 occupied voxels,
  // not 15 raw points.
  for (let seq = 0; seq < 5; seq++) {
    const accepted = sessionStore.acceptPointBatch(
      {
        type: 'point_batch_header',
        session_id: 'session-fuse',
        publisher_id: 'publisher-fuse',
        sequence: 2 + seq,
        timestamp: '2026-07-10T00:00:02Z',
        pose_sequence: 1,
        point_count: points.length,
        point_format: POINT_FORMAT,
        encoding: 'binary_le',
        compression: 'none',
        stride_bytes: POINT_STRIDE_BYTES,
      },
      payload,
    );
    chunkStore.storeAcceptedBatch(accepted);
  }

  const residentRead = chunkStore.readSessionWorldChunks('session-fuse');
  assert.equal(countPoints(residentRead), 2, 'repeated observations must not grow point count');
  // A/B voxel representative is the mean of 0.100 and 0.105 across all repeats = 0.1025.
  assert.ok(Math.abs(residentRead[0].readFloatLE(0) - 0.1025) < 1e-4);
  assert.ok(Math.abs(residentRead[0].readFloatLE(POINT_STRIDE_BYTES) - 0.5) < 1e-4);

  // The disk round-trip (flush -> re-seed on next touch is implied) fuses identically.
  chunkStore.flushAll();
  const flushedRead = chunkStore.readSessionWorldChunks('session-fuse');
  assert.equal(countPoints(flushedRead), 2);
  assert.ok(Math.abs(flushedRead[0].readFloatLE(0) - 0.1025) < 1e-4);

  const [meta] = chunkStore.listSessionChunks('session-fuse');
  assert.equal(meta.pointCount, 2);
  assert.equal(meta.bytes, POINT_STRIDE_BYTES * 2);
});

test('derives coarser LOD levels by mean-binning the fine grid (resident and on disk)', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcv-lod-'));
  const sessionStore = new SessionStore();
  // Finest voxel 0.5 m, 2 levels: level 1 = 0.5 m (fine grid), level 0 = 1.0 m (coarse).
  const chunkStore = new ChunkStore({
    rootDir,
    chunkSizeMeters: 4,
    fuseVoxelMeters: 0.5,
    numLevels: 2,
    flushPointThreshold: 100_000,
    maxDirtyChunks: 8,
  });
  assert.equal(chunkStore.levelVoxelMeters(1), 0.5);
  assert.equal(chunkStore.levelVoxelMeters(0), 1.0);
  // Clamps out-of-range levels to the ends of the ladder.
  assert.equal(chunkStore.levelVoxelMeters(5), 0.5);
  assert.equal(chunkStore.levelVoxelMeters(-3), 1.0);

  const session = sessionStore.createSession({
    type: 'create_session',
    protocol_version: 1,
    session_id: 'session-lod',
    publisher_id: 'publisher-lod',
    started_at: '2026-07-10T00:00:00Z',
    frame_id: 'map',
    units: 'meters',
  });
  chunkStore.syncSession(session);
  sessionStore.applyPoseUpdate({
    type: 'pose_update',
    session_id: 'session-lod',
    publisher_id: 'publisher-lod',
    sequence: 1,
    timestamp: '2026-07-10T00:00:01Z',
    pose: { translation_m: [0, 0, 0], rotation_xyzw: [0, 0, 0, 1] },
  });

  // Three points, all in one 4 m chunk. Identity pose so local == world.
  //   A(0.25) and B(0.75) sit in distinct 0.5 m voxels but share the 1.0 m voxel (0,0,0).
  //   C(2.25) is alone in both grids.
  const points: Array<[number, number, number]> = [
    [0.25, 0.25, 0.25],
    [0.75, 0.25, 0.25],
    [2.25, 2.25, 2.25],
  ];
  const payload = Buffer.alloc(POINT_STRIDE_BYTES * points.length);
  points.forEach(([x, y, z], i) => {
    payload.writeFloatLE(x, i * POINT_STRIDE_BYTES);
    payload.writeFloatLE(y, i * POINT_STRIDE_BYTES + 4);
    payload.writeFloatLE(z, i * POINT_STRIDE_BYTES + 8);
  });
  chunkStore.storeAcceptedBatch(
    sessionStore.acceptPointBatch(
      {
        type: 'point_batch_header',
        session_id: 'session-lod',
        publisher_id: 'publisher-lod',
        sequence: 2,
        timestamp: '2026-07-10T00:00:02Z',
        pose_sequence: 1,
        point_count: points.length,
        point_format: POINT_FORMAT,
        encoding: 'binary_le',
        compression: 'none',
        stride_bytes: POINT_STRIDE_BYTES,
      },
      payload,
    ),
  );

  const chunkKey = '0_0_0';
  const readXs = (buffer: Buffer): number[] => {
    const xs: number[] = [];
    for (let o = 0; o + POINT_STRIDE_BYTES <= buffer.byteLength; o += POINT_STRIDE_BYTES) {
      xs.push(buffer.readFloatLE(o));
    }
    return xs;
  };

  // Finest level (1) is the fine grid unchanged: three representatives.
  const fine = chunkStore.deriveChunkLevel('session-lod', chunkKey, 1);
  assert.deepEqual(readXs(fine).sort((a, b) => a - b), [0.25, 0.75, 2.25]);
  // A level past the finest clamps to the fine grid.
  assert.equal(chunkStore.deriveChunkLevel('session-lod', chunkKey, 9).byteLength, fine.byteLength);

  // Coarse level (0): A and B collapse into one 1.0 m voxel at their mean (0.5); C stays.
  const coarseResident = chunkStore.deriveChunkLevel('session-lod', chunkKey, 0);
  assert.equal(readXs(coarseResident).length, 2, 'coarse level must have fewer points');
  assert.deepEqual(readXs(coarseResident).sort((a, b) => a - b), [0.5, 2.25]);
  // The merged coarse representative stays within its children's bounds (nesting holds).
  assert.ok(0.25 <= 0.5 && 0.5 <= 0.75);

  // Same derivation once the chunk is resting on disk (read + coarsen path).
  chunkStore.flushAll();
  const coarseDisk = chunkStore.deriveChunkLevel('session-lod', chunkKey, 0);
  assert.deepEqual(readXs(coarseDisk).sort((a, b) => a - b), [0.5, 2.25]);

  // Unknown chunk yields an empty buffer, not a throw.
  assert.equal(chunkStore.deriveChunkLevel('session-lod', '9_9_9', 0).byteLength, 0);
});

test('listSessionChunkKeys unions resident and persisted cells', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcv-keys-'));
  const sessionStore = new SessionStore();
  const chunkStore = new ChunkStore({
    rootDir,
    chunkSizeMeters: 1,
    flushPointThreshold: 100_000, // keep chunks resident until we explicitly flush
    maxDirtyChunks: 8,
  });

  const session = sessionStore.createSession({
    type: 'create_session',
    protocol_version: 1,
    session_id: 'session-keys',
    publisher_id: 'publisher-keys',
    started_at: '2026-07-10T00:00:00Z',
    frame_id: 'map',
    units: 'meters',
  });
  chunkStore.syncSession(session);

  let sequence = 0;
  const storePoint = (x: number, y: number, z: number): void => {
    sessionStore.applyPoseUpdate({
      type: 'pose_update',
      session_id: 'session-keys',
      publisher_id: 'publisher-keys',
      sequence: ++sequence,
      timestamp: '2026-07-10T00:00:01Z',
      pose: { translation_m: [0, 0, 0], rotation_xyzw: [0, 0, 0, 1] },
    });
    const payload = Buffer.alloc(POINT_STRIDE_BYTES);
    payload.writeFloatLE(x, 0);
    payload.writeFloatLE(y, 4);
    payload.writeFloatLE(z, 8);
    chunkStore.storeAcceptedBatch(
      sessionStore.acceptPointBatch(
        {
          type: 'point_batch_header',
          session_id: 'session-keys',
          publisher_id: 'publisher-keys',
          sequence: ++sequence,
          timestamp: '2026-07-10T00:00:02Z',
          pose_sequence: sequence - 1,
          point_count: 1,
          point_format: POINT_FORMAT,
          encoding: 'binary_le',
          compression: 'none',
          stride_bytes: POINT_STRIDE_BYTES,
        },
        payload,
      ),
    );
  };

  // Two resident cells, nothing flushed yet.
  storePoint(0.5, 0.5, 0.5); // cell 0_0_0
  storePoint(3.5, 0.5, 0.5); // cell 3_0_0
  assert.equal(chunkStore.listSessionChunks('session-keys').length, 0, 'nothing persisted yet');
  assert.deepEqual(
    chunkStore.listSessionChunkKeys('session-keys').map((c) => c.chunkKey).sort(),
    ['0_0_0', '3_0_0'],
  );

  // Flush (both persisted) then add a third resident cell: union covers all three.
  chunkStore.flushAll();
  storePoint(6.5, 0.5, 0.5); // cell 6_0_0
  assert.deepEqual(
    chunkStore.listSessionChunkKeys('session-keys').map((c) => c.chunkKey).sort(),
    ['0_0_0', '3_0_0', '6_0_0'],
  );
});
