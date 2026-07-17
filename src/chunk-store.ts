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
  flushPointThreshold: number;
  maxDirtyChunks: number;
  dirtyChunks: number;
  persistedSessions: number;
  persistedChunks: number;
  persistedBytes: number;
}

interface DirtyChunk {
  sessionId: string;
  chunkKey: string;
  chunkX: number;
  chunkY: number;
  chunkZ: number;
  filePath: string;
  buffers: Buffer[];
  pointCount: number;
  bytes: number;
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
  readonly flushPointThreshold: number;
  readonly maxDirtyChunks: number;

  private readonly rootDir: string;
  private readonly chunksDir: string;
  private readonly database: DatabaseSync;
  private readonly dirtyChunks = new Map<string, DirtyChunk>();

  constructor(options: ChunkStoreOptions) {
    this.rootDir = options.rootDir;
    this.chunksDir = path.join(this.rootDir, 'chunks');
    this.chunkSizeMeters = options.chunkSizeMeters ?? 2;
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

  storeAcceptedBatch(accepted: AcceptedBatch): void {
    const perChunk = new Map<string, DirtyChunk>();
    const payload = accepted.payload;
    const [tx, ty, tz] = accepted.pose.pose.translation_m;
    const [qx, qy, qz, qw] = accepted.pose.pose.rotation_xyzw;

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

      const chunkX = Math.floor(worldX / this.chunkSizeMeters);
      const chunkY = Math.floor(worldY / this.chunkSizeMeters);
      const chunkZ = Math.floor(worldZ / this.chunkSizeMeters);
      const chunkKey = encodeChunkKey(chunkX, chunkY, chunkZ);
      let dirtyChunk = perChunk.get(chunkKey);
      if (!dirtyChunk) {
        dirtyChunk = this.createDirtyChunk(accepted.session.sessionId, chunkKey, chunkX, chunkY, chunkZ);
        perChunk.set(chunkKey, dirtyChunk);
      }

      const point = Buffer.allocUnsafe(POINT_STRIDE_BYTES);
      point.writeFloatLE(worldX, 0);
      point.writeFloatLE(worldY, 4);
      point.writeFloatLE(worldZ, 8);
      point[12] = payload[offset + 12];
      point[13] = payload[offset + 13];
      point[14] = payload[offset + 14];
      point.writeUInt16LE(payload.readUInt16LE(offset + 15), 15);
      point[17] = 0;

      dirtyChunk.buffers.push(point);
      dirtyChunk.pointCount += 1;
      dirtyChunk.bytes += POINT_STRIDE_BYTES;
      dirtyChunk.minX = Math.min(dirtyChunk.minX, worldX);
      dirtyChunk.minY = Math.min(dirtyChunk.minY, worldY);
      dirtyChunk.minZ = Math.min(dirtyChunk.minZ, worldZ);
      dirtyChunk.maxX = Math.max(dirtyChunk.maxX, worldX);
      dirtyChunk.maxY = Math.max(dirtyChunk.maxY, worldY);
      dirtyChunk.maxZ = Math.max(dirtyChunk.maxZ, worldZ);
    }

    for (const dirtyChunk of perChunk.values()) {
      this.enqueueDirtyChunk(dirtyChunk);
    }

    this.syncSession(accepted.session);
  }

  flushSession(sessionId: string): void {
    for (const key of [...this.dirtyChunks.keys()]) {
      if (key.startsWith(`${sessionId}:`)) {
        this.flushDirtyChunk(key);
      }
    }
  }

  flushAll(): void {
    for (const key of [...this.dirtyChunks.keys()]) {
      this.flushDirtyChunk(key);
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
      flushPointThreshold: this.flushPointThreshold,
      maxDirtyChunks: this.maxDirtyChunks,
      dirtyChunks: this.dirtyChunks.size,
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

  // Every persisted world-frame point for a session: flushed chunk files plus any
  // not-yet-flushed dirty buffers (the two are disjoint — a flush deletes the dirty
  // entry). Points are already world-frame, so no pose transform is needed. Returns
  // one buffer per source chunk (empties skipped) so callers can stream the bootstrap
  // incrementally instead of concatenating one huge blob.
  readSessionWorldChunks(sessionId: string): Buffer[] {
    const chunks: Buffer[] = [];
    for (const chunk of this.listSessionChunks(sessionId)) {
      try {
        const data = fs.readFileSync(path.join(this.rootDir, chunk.filePath));
        if (data.byteLength > 0) {
          chunks.push(data);
        }
      } catch {
        // Metadata can briefly lead the file on disk; skip an unreadable chunk.
      }
    }
    const prefix = `${sessionId}:`;
    for (const [key, dirty] of this.dirtyChunks) {
      if (key.startsWith(prefix) && dirty.buffers.length > 0) {
        chunks.push(Buffer.concat(dirty.buffers));
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

  private createDirtyChunk(
    sessionId: string,
    chunkKey: string,
    chunkX: number,
    chunkY: number,
    chunkZ: number,
  ): DirtyChunk {
    return {
      sessionId,
      chunkKey,
      chunkX,
      chunkY,
      chunkZ,
      filePath: path.join(this.chunksDir, sessionId, `${chunkKey}.bin`),
      buffers: [],
      pointCount: 0,
      bytes: 0,
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      minZ: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
      maxZ: Number.NEGATIVE_INFINITY,
    };
  }

  private enqueueDirtyChunk(incoming: DirtyChunk): void {
    const dirtyKey = `${incoming.sessionId}:${incoming.chunkKey}`;
    const existing = this.dirtyChunks.get(dirtyKey);
    if (existing) {
      existing.buffers.push(...incoming.buffers);
      existing.pointCount += incoming.pointCount;
      existing.bytes += incoming.bytes;
      existing.minX = Math.min(existing.minX, incoming.minX);
      existing.minY = Math.min(existing.minY, incoming.minY);
      existing.minZ = Math.min(existing.minZ, incoming.minZ);
      existing.maxX = Math.max(existing.maxX, incoming.maxX);
      existing.maxY = Math.max(existing.maxY, incoming.maxY);
      existing.maxZ = Math.max(existing.maxZ, incoming.maxZ);
      this.dirtyChunks.delete(dirtyKey);
      this.dirtyChunks.set(dirtyKey, existing);
      if (existing.pointCount >= this.flushPointThreshold) {
        this.flushDirtyChunk(dirtyKey);
      }
      return;
    }

    this.dirtyChunks.set(dirtyKey, incoming);
    if (incoming.pointCount >= this.flushPointThreshold) {
      this.flushDirtyChunk(dirtyKey);
      return;
    }

    while (this.dirtyChunks.size > this.maxDirtyChunks) {
      const oldestKey = this.dirtyChunks.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.flushDirtyChunk(oldestKey);
    }
  }

  private flushDirtyChunk(dirtyKey: string): void {
    const dirtyChunk = this.dirtyChunks.get(dirtyKey);
    if (!dirtyChunk) {
      return;
    }

    fs.mkdirSync(path.dirname(dirtyChunk.filePath), { recursive: true });
    const payload = Buffer.concat(dirtyChunk.buffers);
    fs.appendFileSync(dirtyChunk.filePath, payload);

    const now = new Date().toISOString();
    const existing = this.database
      .prepare(
        `SELECT point_count, batch_count, bytes, min_x, min_y, min_z, max_x, max_y, max_z
        FROM chunks WHERE session_id = ? AND chunk_key = ?`,
      )
      .get(dirtyChunk.sessionId, dirtyChunk.chunkKey) as
      | {
          point_count: number;
          batch_count: number;
          bytes: number;
          min_x: number;
          min_y: number;
          min_z: number;
          max_x: number;
          max_y: number;
          max_z: number;
        }
      | undefined;

    if (existing) {
      this.database
        .prepare(
          `UPDATE chunks SET
            point_count = ?,
            batch_count = ?,
            bytes = ?,
            min_x = ?,
            min_y = ?,
            min_z = ?,
            max_x = ?,
            max_y = ?,
            max_z = ?,
            updated_at = ?
          WHERE session_id = ? AND chunk_key = ?`,
        )
        .run(
          existing.point_count + dirtyChunk.pointCount,
          existing.batch_count + 1,
          existing.bytes + dirtyChunk.bytes,
          Math.min(existing.min_x, dirtyChunk.minX),
          Math.min(existing.min_y, dirtyChunk.minY),
          Math.min(existing.min_z, dirtyChunk.minZ),
          Math.max(existing.max_x, dirtyChunk.maxX),
          Math.max(existing.max_y, dirtyChunk.maxY),
          Math.max(existing.max_z, dirtyChunk.maxZ),
          now,
          dirtyChunk.sessionId,
          dirtyChunk.chunkKey,
        );
    } else {
      this.database
        .prepare(
          `INSERT INTO chunks (
            session_id, chunk_key, chunk_x, chunk_y, chunk_z, file_path,
            point_count, batch_count, bytes,
            min_x, min_y, min_z, max_x, max_y, max_z, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          dirtyChunk.sessionId,
          dirtyChunk.chunkKey,
          dirtyChunk.chunkX,
          dirtyChunk.chunkY,
          dirtyChunk.chunkZ,
          path.relative(this.rootDir, dirtyChunk.filePath),
          dirtyChunk.pointCount,
          1,
          dirtyChunk.bytes,
          dirtyChunk.minX,
          dirtyChunk.minY,
          dirtyChunk.minZ,
          dirtyChunk.maxX,
          dirtyChunk.maxY,
          dirtyChunk.maxZ,
          now,
        );
    }

    this.dirtyChunks.delete(dirtyKey);
  }
}

function encodeChunkKey(chunkX: number, chunkY: number, chunkZ: number): string {
  return `${chunkX}_${chunkY}_${chunkZ}`;
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
