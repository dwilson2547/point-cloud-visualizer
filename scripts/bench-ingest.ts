// Ingest-path microbenchmark: VLP-16-like spins (28.8k pts, 16 rings) bouncing off an
// 8 x 8 x 2.7 m room from a sensor turning slowly on a small circle. Measures per-batch
// latency of ChunkStore.storeAcceptedBatchDurably, counts fsync calls, and reports the
// fusion-only cost for comparison. Run with `npm run bench:ingest`. Numbers depend on
// the disk under $TMPDIR; docs/batch-log.md records one measured run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ChunkStore } from '../src/chunk-store.js';
import { POINT_STRIDE_BYTES } from '../src/protocol.js';

let fsyncs = 0;
const origFsync = fs.fsyncSync;
(fs as any).fsyncSync = (fd: number) => { fsyncs++; return origFsync(fd); };

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcv-bench-'));
const store = new ChunkStore({ rootDir: dataDir, log: () => {} });

const N = 28_800; // VLP-16 @10Hz ≈ 28.8k pts/spin
const rings = [-15, -13, -11, -9, -7, -5, -3, -1, 1, 3, 5, 7, 9, 11, 13, 15].map((d) => (d * Math.PI) / 180);
function makeSpin(): Buffer {
  const buf = Buffer.alloc(N * POINT_STRIDE_BYTES);
  const perRing = N / 16;
  for (let r = 0; r < 16; r++) {
    for (let i = 0; i < perRing; i++) {
      const az = (i / perRing) * Math.PI * 2;
      const el = rings[r];
      // A 8x8x3 m room: intersect ray with the nearest wall/floor/ceiling.
      const dx = Math.cos(el) * Math.cos(az), dy = Math.cos(el) * Math.sin(az), dz = Math.sin(el);
      const tx = dx !== 0 ? (dx > 0 ? 4 : -4) / dx : Infinity;
      const ty = dy !== 0 ? (dy > 0 ? 4 : -4) / dy : Infinity;
      const tz = dz !== 0 ? (dz > 0 ? 1.5 : -1.2) / dz : Infinity;
      const t = Math.min(tx, ty, tz);
      const o = (r * perRing + i) * POINT_STRIDE_BYTES;
      buf.writeFloatLE(dx * t + (Math.random() - 0.5) * 0.02, o);
      buf.writeFloatLE(dy * t + (Math.random() - 0.5) * 0.02, o + 4);
      buf.writeFloatLE(dz * t + (Math.random() - 0.5) * 0.02, o + 8);
      buf[o + 12] = 128; buf[o + 13] = 128; buf[o + 14] = 128;
      buf.writeUInt16LE(1000, o + 15);
    }
  }
  return buf;
}

const session: any = {
  sessionId: 'bench', publisherId: 'p', startedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
  frameId: 'map', units: 'meters', closed: false, lastSequence: 0, lastPoseSequence: null, totalPoints: 0, pointBatches: 0, poses: new Map(),
};
const BATCHES = 60;
const lat: number[] = [];
let chunksTouched = 0;
for (let b = 0; b < BATCHES; b++) {
  const yaw = (b / BATCHES) * Math.PI * 2 * 0.25; // slow quarter turn over the run
  const pose = { translation_m: [Math.cos(yaw) * 0.5, Math.sin(yaw) * 0.5, 0], rotation_xyzw: [0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2)] };
  const seq = 2 * b + 2;
  const accepted: any = {
    session, payload: makeSpin(), pose: { pose },
    header: { sequence: seq, point_count: N, session_id: 'bench' },
  };
  const next = { ...session, lastSequence: seq, pointBatches: b + 1, totalPoints: (b + 1) * N };
  const f0 = fsyncs;
  const t0 = performance.now();
  const keys = store.storeAcceptedBatchDurably(accepted, next);
  lat.push(performance.now() - t0);
  chunksTouched = keys.length;
  if (b === 0) console.log(`first batch: ${keys.length} chunks, ${fsyncs - f0} fsyncs, ${lat[0].toFixed(1)} ms`);
}
lat.sort((a, b) => a - b);
const c0 = fsyncs;
const ct = performance.now();
store.checkpointAll();
console.log(`full checkpoint after run: ${(performance.now() - ct).toFixed(1)} ms, ${fsyncs - c0} fsyncs`);
const summary = store.getStorageSummary();
console.log(`batches=${BATCHES} pts/batch=${N} chunks/batch=${chunksTouched}`);
console.log(`latency ms: p50=${lat[Math.floor(lat.length * 0.5)].toFixed(1)} p90=${lat[Math.floor(lat.length * 0.9)].toFixed(1)} max=${lat[lat.length - 1].toFixed(1)}`);
console.log(`fsyncs total=${fsyncs} per batch=${(fsyncs / BATCHES).toFixed(0)}`);
console.log(`persisted chunks=${summary.persistedChunks} bytes=${summary.persistedBytes} (.bin only) log bytes=${summary.logBytes}`);
const accBytes = fs.readdirSync(path.join(dataDir, 'chunks', 'bench')).filter((f) => f.endsWith('.acc')).reduce((s, f) => s + fs.statSync(path.join(dataDir, 'chunks', 'bench', f)).size, 0);
console.log(`.acc sidecar bytes=${accBytes} (${(accBytes / summary.persistedBytes).toFixed(1)}x the .bin)`);
// Fusion-only cost (no disk): time fuse on a fresh store with persistence disabled.
const store2 = new ChunkStore({ rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pcv-bench2-')), maxDirtyChunks: 100000, flushPointThreshold: 1e12, log: () => {} });
const t1 = performance.now();
for (let b = 0; b < 20; b++) {
  const accepted: any = { session, payload: makeSpin(), pose: { pose: { translation_m: [0, 0, 0], rotation_xyzw: [0, 0, 0, 1] } }, header: { sequence: b + 1, point_count: N, session_id: 'bench' } };
  store2.storeAcceptedBatch(accepted);
}
console.log(`fuse-only (no disk): ${((performance.now() - t1) / 20).toFixed(1)} ms/batch`);
store.close(); store2.close();
fs.rmSync(dataDir, { recursive: true, force: true });
