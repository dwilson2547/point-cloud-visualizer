import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  type AcceptedBatch,
} from './session-store.js';
import { POINT_STRIDE_BYTES } from './protocol.js';

export interface ChunkStoreOptions {
  rootDir: string;
  chunkSizeMeters?: number;
  fuseVoxelMeters?: number;
  flushPointThreshold?: number;
  maxDirtyChunks?: number;
}

export interface ChunkMetadata {
  sessionId: string;
  chunkKey: string;
  chunkX: number;
  chunkY: number;
  chunkZ: number;
  filePath: string;
  pointCount: number;
  batchCount: number;
  bytes: number;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  updatedAt: string;
}

export interface StorageSummary {
  chunkSizeMeters: number;
  fuseVoxelMeters: number;
  flushPointThreshold: number;
  maxDirtyChunks: number;
  activeChunks: number;
  persistedSessions: number;
  persistedChunks: number;
  persistedBytes: number;
}

// One occupied voxel's running fusion state: component sums plus a count, so the
// representative point is the mean. Sums are commutative/associative, making fusion
// order-independent and robust to out-of-order batches and revisits.
interface VoxelAccumulator {
  sx: number;
  sy: number;
  sz: number;
  sr: number;
  sg: number;
  sb: number;
  si: number;
  n: number;
}

// A chunk resident in memory: its full current voxel set (seeded from disk on
// activation, so it is a superset of the on-disk file). Stays resident across
// periodic flushes and is released (persisted + dropped) only on eviction or an
// explicit flush.
interface ActiveChunk {
  sessionId: string;
  chunkKey: string;
  chunkX: number;
  chunkY: number;
  chunkZ: number;
  filePath: string;
  voxels: Map<string, VoxelAccumulator>;
  pointsSinceFlush: number;
}

interface SerializedVoxels {
  buffer: Buffer;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

interface SessionSnapshot {
  sessionId: string;
  publisherId: string;
  startedAt: string;
  lastSeenAt: string;
  frameId: string;
  units: string;
  metadata?: unknown;
  closed: boolean;
  totalPoints: number;
  pointBatches: number;
  lastSequence: number;
  lastPoseSequence: number | null;
}

export class ChunkStore {
  readonly chunkSizeMeters: number;
  readonly fuseVoxelMeters: number;
  readonly flushPointThreshold: number;
  readonly maxDirtyChunks: number;

  private readonly rootDir: string;
  private readonly chunksDir: string;
  private readonly database: DatabaseSync;
  // Chunks currently resident in memory, keyed `sessionId:chunkKey`. Insertion
  // order is the LRU order used for eviction.
  private readonly activeChunks = new Map<string, ActiveChunk>();

  constructor(options: ChunkStoreOptions) {
    this.rootDir = options.rootDir;
    this.chunksDir = path.join(this.rootDir, 'chunks');
    this.chunkSizeMeters = options.chunkSizeMeters ?? 2;
    this.fuseVoxelMeters = options.fuseVoxelMeters ?? 0.04;
    this.flushPointThreshold = options.flushPointThreshold ?? 50_000;
    this.maxDirtyChunks = options.maxDirtyChunks ?? 128;

    fs.mkdirSync(this.chunksDir, { recursive: true });
    this.database = new DatabaseSync(path.join(this.rootDir, 'metadata.sqlite'));
    this.initializeSchema();
  }

  syncSession(session: SessionSnapshot): void {
    this.database
      .prepare(
        `INSERT INTO sessions (
          session_id, publisher_id, started_at, last_seen_at, frame_id, units, metadata_json,
          closed, total_points, point_batches, last_sequence, last_pose_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          publisher_id = excluded.publisher_id,
          started_at = excluded.started_at,
          last_seen_at = excluded.last_seen_at,
          frame_id = excluded.frame_id,
          units = excluded.units,
          metadata_json = excluded.metadata_json,
          closed = excluded.closed,
          total_points = excluded.total_points,
          point_batches = excluded.point_batches,
          last_sequence = excluded.last_sequence,
          last_pose_sequence = excluded.last_pose_sequence`,
      )
      .run(
        session.sessionId,
        session.publisherId,
        session.startedAt,
        session.lastSeenAt,
        session.frameId,
        session.units,
        session.metadata ? JSON.stringify(session.metadata) : null,
        session.closed ? 1 : 0,
        session.totalPoints,
        session.pointBatches,
        session.lastSequence,
        session.lastPoseSequence,
      );
  }

  // Transform a batch's local-frame points into the world frame and fuse them into
  // per-chunk voxel grids. Density is bounded by occupied voxels, not by measurement
  // count, so re-observing a surface adds no points once its voxels are filled.
  storeAcceptedBatch(accepted: AcceptedBatch): void {
    const payload = accepted.payload;
    const sessionId = accepted.session.sessionId;
    const [tx, ty, tz] = accepted.pose.pose.translation_m;
    const [qx, qy, qz, qw] = accepted.pose.pose.rotation_xyzw;
    const chunkSize = this.chunkSizeMeters;
    const voxelSize = this.fuseVoxelMeters;

    const touched = new Set<ActiveChunk>();

    for (let offset = 0; offset < payload.byteLength; offset += POINT_STRIDE_BYTES) {
      const localX = payload.readFloatLE(offset);
      const localY = payload.readFloatLE(offset + 4);
      const localZ = payload.readFloatLE(offset + 8);
      const [worldX, worldY, worldZ] = rotateAndTranslate(
        localX,
        localY,
        localZ,
        qx,
        qy,
        qz,
        qw,
        tx,
        ty,
        tz,
      );

      const chunkX = Math.floor(worldX / chunkSize);
      const chunkY = Math.floor(worldY / chunkSize);
      const chunkZ = Math.floor(worldZ / chunkSize);
      const active = this.activateChunk(sessionId, chunkX, chunkY, chunkZ);

      const key = voxelKey(worldX, worldY, worldZ, voxelSize);
      let acc = active.voxels.get(key);
      if (!acc) {
        acc = { sx: 0, sy: 0, sz: 0, sr: 0, sg: 0, sb: 0, si: 0, n: 0 };
        active.voxels.set(key, acc);
      }
      acc.sx += worldX;
      acc.sy += worldY;
      acc.sz += worldZ;
      acc.sr += payload[offset + 12];
      acc.sg += payload[offset + 13];
      acc.sb += payload[offset + 14];
      acc.si += payload.readUInt16LE(offset + 15);
      acc.n += 1;

      active.pointsSinceFlush += 1;
      touched.add(active);
    }

    // Refresh LRU order for touched chunks and persist any that crossed the flush
    // cadence (kept resident afterwards so fusion continues in place).
    for (const active of touched) {
      const dirtyKey = `${active.sessionId}:${active.chunkKey}`;
      this.activeChunks.delete(dirtyKey);
      this.activeChunks.set(dirtyKey, active);
      if (active.pointsSinceFlush >= this.flushPointThreshold) {
        this.persistChunk(active);
      }
    }

    // Bound resident memory: evict least-recently-used chunks (persist + drop).
    while (this.activeChunks.size > this.maxDirtyChunks) {
      const oldestKey = this.activeChunks.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.evictChunk(oldestKey);
    }

    this.syncSession(accepted.session);
  }

  flushSession(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of [...this.activeChunks.keys()]) {
      if (key.startsWith(prefix)) {
        this.evictChunk(key);
      }
    }
  }

  flushAll(): void {
    for (const key of [...this.activeChunks.keys()]) {
      this.evictChunk(key);
    }
  }

  getStorageSummary(): StorageSummary {
    const counts = this.database
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM sessions) AS persisted_sessions,
          (SELECT COUNT(*) FROM chunks) AS persisted_chunks,
          COALESCE((SELECT SUM(bytes) FROM chunks), 0) AS persisted_bytes`,
      )
      .get() as {
      persisted_sessions: number;
      persisted_chunks: number;
      persisted_bytes: number;
    };

    return {
      chunkSizeMeters: this.chunkSizeMeters,
      fuseVoxelMeters: this.fuseVoxelMeters,
      flushPointThreshold: this.flushPointThreshold,
      maxDirtyChunks: this.maxDirtyChunks,
      activeChunks: this.activeChunks.size,
      persistedSessions: counts.persisted_sessions,
      persistedChunks: counts.persisted_chunks,
      persistedBytes: counts.persisted_bytes,
    };
  }

  listSessionChunks(sessionId: string): ChunkMetadata[] {
    return this.database
      .prepare(
        `SELECT
          session_id, chunk_key, chunk_x, chunk_y, chunk_z, file_path,
          point_count, batch_count, bytes,
          min_x, min_y, min_z, max_x, max_y, max_z, updated_at
        FROM chunks
        WHERE session_id = ?
        ORDER BY chunk_x, chunk_y, chunk_z`,
      )
      .all(sessionId)
      .map((row) => ({
        sessionId: String(row.session_id),
        chunkKey: String(row.chunk_key),
        chunkX: Number(row.chunk_x),
        chunkY: Number(row.chunk_y),
        chunkZ: Number(row.chunk_z),
        filePath: String(row.file_path),
        pointCount: Number(row.point_count),
        batchCount: Number(row.batch_count),
        bytes: Number(row.bytes),
        minX: Number(row.min_x),
        minY: Number(row.min_y),
        minZ: Number(row.min_z),
        maxX: Number(row.max_x),
        maxY: Number(row.max_y),
        maxZ: Number(row.max_z),
        updatedAt: String(row.updated_at),
      }));
  }

  // Every fused world-frame point for a session, one buffer per source chunk (empties
  // skipped) so callers can stream the bootstrap incrementally. Resident chunks are
  // emitted from their in-memory voxel set — which already folds in whatever was on
  // disk — and only non-resident chunks are read from their files, so no voxel is
  // counted twice. Points are already world-frame; no pose transform is needed.
  readSessionWorldChunks(sessionId: string): Buffer[] {
    const chunks: Buffer[] = [];
    const emitted = new Set<string>();
    const prefix = `${sessionId}:`;

    for (const [key, active] of this.activeChunks) {
      if (!key.startsWith(prefix) || active.voxels.size === 0) {
        continue;
      }
      chunks.push(this.serializeVoxels(active.voxels).buffer);
      emitted.add(active.chunkKey);
    }

    for (const chunk of this.listSessionChunks(sessionId)) {
      if (emitted.has(chunk.chunkKey)) {
        continue;
      }
      try {
        const data = fs.readFileSync(path.join(this.rootDir, chunk.filePath));
        if (data.byteLength > 0) {
          chunks.push(data);
        }
      } catch {
        // Metadata can briefly lead the file on disk; skip an unreadable chunk.
      }
    }

    return chunks;
  }

  private initializeSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        publisher_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        frame_id TEXT NOT NULL,
        units TEXT NOT NULL,
        metadata_json TEXT,
        closed INTEGER NOT NULL,
        total_points INTEGER NOT NULL,
        point_batches INTEGER NOT NULL,
        last_sequence INTEGER NOT NULL,
        last_pose_sequence INTEGER
      );

      CREATE TABLE IF NOT EXISTS chunks (
        session_id TEXT NOT NULL,
        chunk_key TEXT NOT NULL,
        chunk_x INTEGER NOT NULL,
        chunk_y INTEGER NOT NULL,
        chunk_z INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        point_count INTEGER NOT NULL,
        batch_count INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        min_x REAL NOT NULL,
        min_y REAL NOT NULL,
        min_z REAL NOT NULL,
        max_x REAL NOT NULL,
        max_y REAL NOT NULL,
        max_z REAL NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, chunk_key)
      );
    `);
  }

  // Return the resident chunk for a cell, creating it (and seeding it from any
  // existing file so fusion continues from prior state) on first touch.
  private activateChunk(
    sessionId: string,
    chunkX: number,
    chunkY: number,
    chunkZ: number,
  ): ActiveChunk {
    const chunkKey = encodeChunkKey(chunkX, chunkY, chunkZ);
    const dirtyKey = `${sessionId}:${chunkKey}`;
    const existing = this.activeChunks.get(dirtyKey);
    if (existing) {
      return existing;
    }

    const active: ActiveChunk = {
      sessionId,
      chunkKey,
      chunkX,
      chunkY,
      chunkZ,
      filePath: path.join(this.chunksDir, sessionId, `${chunkKey}.bin`),
      voxels: new Map(),
      pointsSinceFlush: 0,
    };
    this.seedFromDisk(active);
    this.activeChunks.set(dirtyKey, active);
    return active;
  }

  // Load a previously-flushed chunk file back into voxel accumulators. The file is
  // already one representative per voxel, so each seeds a fresh accumulator at n=1.
  private seedFromDisk(active: ActiveChunk): void {
    let data: Buffer;
    try {
      data = fs.readFileSync(active.filePath);
    } catch {
      return; // resting chunk with no file yet, or unreadable — start empty
    }
    for (let o = 0; o + POINT_STRIDE_BYTES <= data.byteLength; o += POINT_STRIDE_BYTES) {
      const worldX = data.readFloatLE(o);
      const worldY = data.readFloatLE(o + 4);
      const worldZ = data.readFloatLE(o + 8);
      active.voxels.set(voxelKey(worldX, worldY, worldZ, this.fuseVoxelMeters), {
        sx: worldX,
        sy: worldY,
        sz: worldZ,
        sr: data[o + 12],
        sg: data[o + 13],
        sb: data[o + 14],
        si: data.readUInt16LE(o + 15),
        n: 1,
      });
    }
  }

  // Overwrite a chunk's file with its current voxel representatives and upsert its
  // metadata. The chunk stays resident so fusion continues in place.
  private persistChunk(active: ActiveChunk): void {
    active.pointsSinceFlush = 0;
    if (active.voxels.size === 0) {
      return;
    }

    const serialized = this.serializeVoxels(active.voxels);
    fs.mkdirSync(path.dirname(active.filePath), { recursive: true });
    fs.writeFileSync(active.filePath, serialized.buffer);

    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO chunks (
          session_id, chunk_key, chunk_x, chunk_y, chunk_z, file_path,
          point_count, batch_count, bytes,
          min_x, min_y, min_z, max_x, max_y, max_z, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, chunk_key) DO UPDATE SET
          file_path = excluded.file_path,
          point_count = excluded.point_count,
          batch_count = chunks.batch_count + 1,
          bytes = excluded.bytes,
          min_x = excluded.min_x,
          min_y = excluded.min_y,
          min_z = excluded.min_z,
          max_x = excluded.max_x,
          max_y = excluded.max_y,
          max_z = excluded.max_z,
          updated_at = excluded.updated_at`,
      )
      .run(
        active.sessionId,
        active.chunkKey,
        active.chunkX,
        active.chunkY,
        active.chunkZ,
        path.relative(this.rootDir, active.filePath),
        active.voxels.size,
        1,
        serialized.buffer.byteLength,
        serialized.minX,
        serialized.minY,
        serialized.minZ,
        serialized.maxX,
        serialized.maxY,
        serialized.maxZ,
        now,
      );
  }

  private evictChunk(dirtyKey: string): void {
    const active = this.activeChunks.get(dirtyKey);
    if (!active) {
      return;
    }
    this.persistChunk(active);
    this.activeChunks.delete(dirtyKey);
  }

  // Encode a voxel set to the on-disk / wire 18-byte point format (one representative
  // per voxel, the component mean) and compute its world-frame bounds in one pass.
  private serializeVoxels(voxels: Map<string, VoxelAccumulator>): SerializedVoxels {
    const buffer = Buffer.allocUnsafe(voxels.size * POINT_STRIDE_BYTES);
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;

    let offset = 0;
    for (const acc of voxels.values()) {
      const x = acc.sx / acc.n;
      const y = acc.sy / acc.n;
      const z = acc.sz / acc.n;
      buffer.writeFloatLE(x, offset);
      buffer.writeFloatLE(y, offset + 4);
      buffer.writeFloatLE(z, offset + 8);
      buffer[offset + 12] = clampU8(Math.round(acc.sr / acc.n));
      buffer[offset + 13] = clampU8(Math.round(acc.sg / acc.n));
      buffer[offset + 14] = clampU8(Math.round(acc.sb / acc.n));
      buffer.writeUInt16LE(clampU16(Math.round(acc.si / acc.n)), offset + 15);
      buffer[offset + 17] = 0;

      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;

      offset += POINT_STRIDE_BYTES;
    }

    return { buffer, minX, minY, minZ, maxX, maxY, maxZ };
  }
}

function encodeChunkKey(chunkX: number, chunkY: number, chunkZ: number): string {
  return `${chunkX}_${chunkY}_${chunkZ}`;
}

function voxelKey(x: number, y: number, z: number, size: number): string {
  return `${Math.floor(x / size)}_${Math.floor(y / size)}_${Math.floor(z / size)}`;
}

function clampU8(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

function clampU16(value: number): number {
  return value < 0 ? 0 : value > 65535 ? 65535 : value;
}

function rotateAndTranslate(
  x: number,
  y: number,
  z: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  tx: number,
  ty: number,
  tz: number,
): [number, number, number] {
  const uvx = qy * z - qz * y;
  const uvy = qz * x - qx * z;
  const uvz = qx * y - qy * x;

  const uuvx = qy * uvz - qz * uvy;
  const uuvy = qz * uvx - qx * uvz;
  const uuvz = qx * uvy - qy * uvx;

  const rotatedX = x + 2 * ((qw * uvx) + uuvx);
  const rotatedY = y + 2 * ((qw * uvy) + uuvy);
  const rotatedZ = z + 2 * ((qw * uvz) + uuvz);

  return [rotatedX + tx, rotatedY + ty, rotatedZ + tz];
}
