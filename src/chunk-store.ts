import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  type AcceptedBatch,
  type SessionSnapshot,
} from './session-store.js';
import { POINT_STRIDE_BYTES } from './protocol.js';

const ACCUMULATOR_STRIDE_BYTES = 64;

export interface ChunkStoreOptions {
  rootDir: string;
  chunkSizeMeters?: number;
  fuseVoxelMeters?: number;
  numLevels?: number;
  flushPointThreshold?: number;
  maxDirtyChunks?: number;
  maxChunksPerBatch?: number;
  durableBatchHook?: (phase: 'staged' | 'session-synced') => void;
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
  numLevels: number;
  flushPointThreshold: number;
  maxDirtyChunks: number;
  maxChunksPerBatch: number;
  activeChunks: number;
  persistedSessions: number;
  persistedChunks: number;
  persistedBytes: number;
}

export class DurableBatchError extends Error {
  constructor(message: string, options: ErrorOptions) {
    super(message, options);
    this.name = 'DurableBatchError';
  }
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
  accumulatorPath: string;
  voxels: Map<string, VoxelAccumulator>;
  pointsSinceFlush: number;
}

interface SerializedVoxels {
  buffer: Buffer;
  accumulatorBuffer: Buffer;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

interface StagedChunk {
  chunkKey: string;
  chunkX: number;
  chunkY: number;
  chunkZ: number;
  stagedFile: string;
  finalFile: string;
  stagedAccumulatorFile: string;
  finalAccumulatorFile: string;
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

interface BatchTransactionManifest {
  sessionId: string;
  sequence: number;
  chunks: StagedChunk[];
}

export class ChunkStore {
  readonly chunkSizeMeters: number;
  readonly fuseVoxelMeters: number;
  readonly numLevels: number;
  readonly flushPointThreshold: number;
  readonly maxDirtyChunks: number;
  readonly maxChunksPerBatch: number;

  private readonly rootDir: string;
  private readonly chunksDir: string;
  private readonly transactionsDir: string;
  private readonly database: DatabaseSync;
  private readonly durableBatchHook?: (phase: 'staged' | 'session-synced') => void;
  // Chunks currently resident in memory, keyed `sessionId:chunkKey`. Insertion
  // order is the LRU order used for eviction.
  private readonly activeChunks = new Map<string, ActiveChunk>();

  constructor(options: ChunkStoreOptions) {
    this.rootDir = options.rootDir;
    this.chunksDir = path.join(this.rootDir, 'chunks');
    this.transactionsDir = path.join(this.rootDir, 'transactions');
    this.chunkSizeMeters = options.chunkSizeMeters ?? 2;
    this.fuseVoxelMeters = options.fuseVoxelMeters ?? 0.04;
    this.numLevels = Math.max(1, options.numLevels ?? 6);
    this.flushPointThreshold = options.flushPointThreshold ?? 50_000;
    this.maxDirtyChunks = options.maxDirtyChunks ?? 128;
    this.maxChunksPerBatch = options.maxChunksPerBatch ?? 128;
    this.durableBatchHook = options.durableBatchHook;

    fs.mkdirSync(this.chunksDir, { recursive: true });
    fs.mkdirSync(this.transactionsDir, { recursive: true });
    this.database = new DatabaseSync(path.join(this.rootDir, 'metadata.sqlite'));
    this.initializeSchema();
    this.recoverBatchTransactions();
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

  loadSessions(): SessionSnapshot[] {
    return this.database
      .prepare(
        `SELECT
          session_id, publisher_id, started_at, last_seen_at, frame_id, units, metadata_json,
          closed, total_points, point_batches, last_sequence, last_pose_sequence
        FROM sessions
        ORDER BY started_at`,
      )
      .all()
      .map((row) => ({
        sessionId: String(row.session_id),
        publisherId: String(row.publisher_id),
        startedAt: String(row.started_at),
        lastSeenAt: String(row.last_seen_at),
        frameId: String(row.frame_id),
        units: String(row.units),
        metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : undefined,
        closed: Number(row.closed) !== 0,
        totalPoints: Number(row.total_points),
        pointBatches: Number(row.point_batches),
        lastSequence: Number(row.last_sequence),
        lastPoseSequence:
          row.last_pose_sequence === null ? null : Number(row.last_pose_sequence),
      }));
  }

  // Transform a batch's local-frame points into the world frame and fuse them into
  // per-chunk voxel grids. Density is bounded by occupied voxels, not by measurement
  // count, so re-observing a surface adds no points once its voxels are filled. Returns
  // the chunk keys this batch touched, so callers can refresh those chunks for viewers.
  storeAcceptedBatch(accepted: AcceptedBatch): string[] {
    this.collectBatchChunkKeys(accepted);
    return this.fuseAcceptedBatch(accepted, true);
  }

  storeAcceptedBatchDurably(accepted: AcceptedBatch, nextSession: SessionSnapshot): string[] {
    const batchChunkKeys = this.collectBatchChunkKeys(accepted);
    if (batchChunkKeys.size > this.maxDirtyChunks) {
      throw new Error(
        `Batch touches ${batchChunkKeys.size} chunks but the resident chunk budget is ${this.maxDirtyChunks}`,
      );
    }
    this.prepareActiveCapacity(accepted.session.sessionId, batchChunkKeys);
    try {
      const touchedKeys = this.fuseAcceptedBatch(accepted, false);
      const manifest = this.stageBatchTransaction(
        accepted.session.sessionId,
        accepted.header.sequence,
        touchedKeys,
      );
      this.durableBatchHook?.('staged');
      this.syncSession(nextSession);
      this.durableBatchHook?.('session-synced');
      this.finalizeBatchTransaction(manifest);
      for (const chunkKey of touchedKeys) {
        const active = this.activeChunks.get(`${accepted.session.sessionId}:${chunkKey}`);
        if (active) {
          active.pointsSinceFlush = 0;
        }
      }
      this.enforceActiveLimit();
      return touchedKeys;
    } catch (error) {
      throw new DurableBatchError(
        `Failed to durably commit batch ${accepted.header.sequence} for ${accepted.session.sessionId}`,
        { cause: error },
      );
    }
  }

  private fuseAcceptedBatch(accepted: AcceptedBatch, allowPersistence: boolean): string[] {
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
      if (allowPersistence && active.pointsSinceFlush >= this.flushPointThreshold) {
        this.persistChunk(active);
      }
    }

    if (allowPersistence) {
      this.enforceActiveLimit();
    }

    const touchedKeys: string[] = [];
    for (const active of touched) {
      touchedKeys.push(active.chunkKey);
    }
    return touchedKeys;
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

  close(): void {
    this.database.close();
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
      numLevels: this.numLevels,
      flushPointThreshold: this.flushPointThreshold,
      maxDirtyChunks: this.maxDirtyChunks,
      maxChunksPerBatch: this.maxChunksPerBatch,
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
    return [...this.iterateSessionWorldChunks(sessionId)];
  }

  *iterateSessionWorldChunks(sessionId: string): Generator<Buffer> {
    const emitted = new Set<string>();
    const prefix = `${sessionId}:`;

    for (const [key, active] of this.activeChunks) {
      if (!key.startsWith(prefix) || active.voxels.size === 0) {
        continue;
      }
      yield this.serializeVoxels(active.voxels).buffer;
      emitted.add(active.chunkKey);
    }

    for (const chunk of this.listSessionChunks(sessionId)) {
      if (emitted.has(chunk.chunkKey)) {
        continue;
      }
      try {
        const data = fs.readFileSync(path.join(this.rootDir, chunk.filePath));
        if (data.byteLength > 0) {
          yield data;
        }
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
      }
    }

  }

  // All chunk cells for a session (resident + persisted, deduped). Chunk metadata only
  // covers flushed chunks, so resident-but-never-flushed cells are folded in from the
  // in-memory set. Integer cell coords let a caller derive the cell AABB for culling/LOD
  // without reading any point data.
  listSessionChunkKeys(
    sessionId: string,
  ): Array<{ chunkKey: string; chunkX: number; chunkY: number; chunkZ: number }> {
    const cells = new Map<string, { chunkKey: string; chunkX: number; chunkY: number; chunkZ: number }>();
    const prefix = `${sessionId}:`;
    for (const [key, active] of this.activeChunks) {
      if (key.startsWith(prefix)) {
        cells.set(active.chunkKey, {
          chunkKey: active.chunkKey,
          chunkX: active.chunkX,
          chunkY: active.chunkY,
          chunkZ: active.chunkZ,
        });
      }
    }
    for (const meta of this.listSessionChunks(sessionId)) {
      if (!cells.has(meta.chunkKey)) {
        cells.set(meta.chunkKey, {
          chunkKey: meta.chunkKey,
          chunkX: meta.chunkX,
          chunkY: meta.chunkY,
          chunkZ: meta.chunkZ,
        });
      }
    }
    return [...cells.values()];
  }

  // Voxel edge length for an LOD level. Level 0 is coarsest; the finest level
  // (numLevels - 1) is the fused ingest grid (fuseVoxelMeters). Coarser levels double
  // the edge each step, so their cells nest exactly over the fine grid.
  levelVoxelMeters(level: number): number {
    const finest = this.numLevels - 1;
    const clamped = level < 0 ? 0 : level > finest ? finest : level;
    return this.fuseVoxelMeters * 2 ** (finest - clamped);
  }

  // Derive a chunk's points at an LOD level: the fine representatives re-binned to the
  // level's coarser grid (each fine voxel counted once — spatially uniform). Returns
  // the 18-byte world-frame point buffer ready to ship, or an empty buffer if the
  // chunk has no data. Works whether the chunk is resident or resting on disk, since
  // both resolve to the same fine representative buffer first.
  deriveChunkLevel(sessionId: string, chunkKey: string, level: number): Buffer {
    const fine = this.readFineRepresentatives(sessionId, chunkKey);
    if (!fine || fine.byteLength === 0) {
      return Buffer.alloc(0);
    }
    if (level >= this.numLevels - 1) {
      return fine; // finest level is the fused grid itself — no coarsening needed
    }
    return this.serializeVoxels(binPoints(fine, this.levelVoxelMeters(level))).buffer;
  }

  // The chunk's fused fine representatives (one 18-byte point per occupied fine voxel):
  // from the in-memory voxel set if resident, else from its on-disk file.
  private readFineRepresentatives(sessionId: string, chunkKey: string): Buffer | null {
    const active = this.activeChunks.get(`${sessionId}:${chunkKey}`);
    if (active) {
      return active.voxels.size > 0 ? this.serializeVoxels(active.voxels).buffer : null;
    }
    try {
      return fs.readFileSync(path.join(this.chunksDir, sessionId, `${chunkKey}.bin`));
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
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

  private collectBatchChunkKeys(accepted: AcceptedBatch): Set<string> {
    const [tx, ty, tz] = accepted.pose.pose.translation_m;
    const [qx, qy, qz, qw] = accepted.pose.pose.rotation_xyzw;
    const chunks = new Set<string>();
    for (let offset = 0; offset < accepted.payload.byteLength; offset += POINT_STRIDE_BYTES) {
      const [worldX, worldY, worldZ] = rotateAndTranslate(
        accepted.payload.readFloatLE(offset),
        accepted.payload.readFloatLE(offset + 4),
        accepted.payload.readFloatLE(offset + 8),
        qx,
        qy,
        qz,
        qw,
        tx,
        ty,
        tz,
      );
      chunks.add(
        encodeChunkKey(
          Math.floor(worldX / this.chunkSizeMeters),
          Math.floor(worldY / this.chunkSizeMeters),
          Math.floor(worldZ / this.chunkSizeMeters),
        ),
      );
      if (chunks.size > this.maxChunksPerBatch) {
        throw new Error(
          `Batch touches more than the configured ${this.maxChunksPerBatch} chunk limit`,
        );
      }
    }
    return chunks;
  }

  private prepareActiveCapacity(sessionId: string, batchChunkKeys: Set<string>): void {
    let newChunkCount = 0;
    for (const chunkKey of batchChunkKeys) {
      if (!this.activeChunks.has(`${sessionId}:${chunkKey}`)) {
        newChunkCount += 1;
      }
    }
    while (this.activeChunks.size + newChunkCount > this.maxDirtyChunks) {
      const candidate = [...this.activeChunks.keys()].find((key) => {
        const separator = key.indexOf(':');
        const activeSessionId = key.slice(0, separator);
        const chunkKey = key.slice(separator + 1);
        return activeSessionId !== sessionId || !batchChunkKeys.has(chunkKey);
      });
      if (!candidate) {
        throw new Error('Unable to free enough resident chunk capacity for batch');
      }
      this.evictChunk(candidate);
    }
  }

  private stageBatchTransaction(
    sessionId: string,
    sequence: number,
    touchedKeys: string[],
  ): BatchTransactionManifest {
    const transactionDir = path.join(this.transactionsDir, sessionId, String(sequence));
    fs.mkdirSync(transactionDir, { recursive: true });
    const chunks: StagedChunk[] = [];

    for (const chunkKey of touchedKeys) {
      const active = this.activeChunks.get(`${sessionId}:${chunkKey}`);
      if (!active || active.voxels.size === 0) {
        continue;
      }
      const serialized = this.serializeVoxels(active.voxels);
      const stagedPath = path.join(transactionDir, `${chunkKey}.bin`);
      const stagedAccumulatorPath = path.join(transactionDir, `${chunkKey}.acc`);
      writeFileAtomically(stagedPath, serialized.buffer);
      writeFileAtomically(stagedAccumulatorPath, serialized.accumulatorBuffer);
      const previous = this.database
        .prepare('SELECT batch_count FROM chunks WHERE session_id = ? AND chunk_key = ?')
        .get(sessionId, chunkKey) as { batch_count?: number } | undefined;
      chunks.push({
        chunkKey,
        chunkX: active.chunkX,
        chunkY: active.chunkY,
        chunkZ: active.chunkZ,
        stagedFile: path.relative(this.rootDir, stagedPath),
        finalFile: path.relative(this.rootDir, active.filePath),
        stagedAccumulatorFile: path.relative(this.rootDir, stagedAccumulatorPath),
        finalAccumulatorFile: path.relative(this.rootDir, active.accumulatorPath),
        pointCount: active.voxels.size,
        batchCount: Number(previous?.batch_count ?? 0) + 1,
        bytes: serialized.buffer.byteLength,
        minX: serialized.minX,
        minY: serialized.minY,
        minZ: serialized.minZ,
        maxX: serialized.maxX,
        maxY: serialized.maxY,
        maxZ: serialized.maxZ,
        updatedAt: new Date().toISOString(),
      });
    }

    const manifest: BatchTransactionManifest = { sessionId, sequence, chunks };
    writeFileAtomically(
      path.join(transactionDir, 'manifest.json'),
      Buffer.from(JSON.stringify(manifest)),
    );
    return manifest;
  }

  private recoverBatchTransactions(): void {
    for (const sessionEntry of readDirectories(this.transactionsDir)) {
      const sessionDir = path.join(this.transactionsDir, sessionEntry);
      const sequenceEntries = readDirectories(sessionDir).sort((a, b) => Number(a) - Number(b));
      for (const sequenceEntry of sequenceEntries) {
        const transactionDir = path.join(sessionDir, sequenceEntry);
        const manifestPath = path.join(transactionDir, 'manifest.json');
        let manifest: BatchTransactionManifest;
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BatchTransactionManifest;
        } catch (error) {
          if (isNotFoundError(error)) {
            fs.rmSync(transactionDir, { recursive: true, force: true });
            continue;
          }
          throw error;
        }
        const persisted = this.database
          .prepare('SELECT last_sequence FROM sessions WHERE session_id = ?')
          .get(manifest.sessionId) as { last_sequence?: number } | undefined;
        if (Number(persisted?.last_sequence ?? -1) >= manifest.sequence) {
          this.finalizeBatchTransaction(manifest);
        } else {
          fs.rmSync(transactionDir, { recursive: true, force: true });
        }
      }
      removeDirectoryIfEmpty(sessionDir);
    }
  }

  private finalizeBatchTransaction(manifest: BatchTransactionManifest): void {
    for (const chunk of manifest.chunks) {
      const stagedPath = path.join(this.rootDir, chunk.stagedFile);
      const finalPath = path.join(this.rootDir, chunk.finalFile);
      const stagedAccumulatorPath = path.join(this.rootDir, chunk.stagedAccumulatorFile);
      const finalAccumulatorPath = path.join(this.rootDir, chunk.finalAccumulatorFile);
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      finalizeStagedFile(stagedAccumulatorPath, finalAccumulatorPath, chunk.chunkKey);
      finalizeStagedFile(stagedPath, finalPath, chunk.chunkKey);
      this.upsertChunkMetadata(manifest.sessionId, chunk);
    }

    const transactionDir = path.join(
      this.transactionsDir,
      manifest.sessionId,
      String(manifest.sequence),
    );
    fs.rmSync(transactionDir, { recursive: true, force: true });
    removeDirectoryIfEmpty(path.dirname(transactionDir));
  }

  private upsertChunkMetadata(sessionId: string, chunk: StagedChunk): void {
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
          batch_count = excluded.batch_count,
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
        sessionId,
        chunk.chunkKey,
        chunk.chunkX,
        chunk.chunkY,
        chunk.chunkZ,
        chunk.finalFile,
        chunk.pointCount,
        chunk.batchCount,
        chunk.bytes,
        chunk.minX,
        chunk.minY,
        chunk.minZ,
        chunk.maxX,
        chunk.maxY,
        chunk.maxZ,
        chunk.updatedAt,
      );
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
      accumulatorPath: path.join(this.chunksDir, sessionId, `${chunkKey}.acc`),
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
    if (this.seedAccumulatorsFromDisk(active)) {
      return;
    }
    let data: Buffer;
    try {
      data = fs.readFileSync(active.filePath);
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }
      throw error;
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

  private seedAccumulatorsFromDisk(active: ActiveChunk): boolean {
    let data: Buffer;
    try {
      data = fs.readFileSync(active.accumulatorPath);
    } catch (error) {
      if (isNotFoundError(error)) {
        return false;
      }
      throw error;
    }
    if (data.byteLength % ACCUMULATOR_STRIDE_BYTES !== 0) {
      throw new Error(`Invalid accumulator file length for ${active.chunkKey}`);
    }
    for (let offset = 0; offset < data.byteLength; offset += ACCUMULATOR_STRIDE_BYTES) {
      const acc: VoxelAccumulator = {
        sx: data.readDoubleLE(offset),
        sy: data.readDoubleLE(offset + 8),
        sz: data.readDoubleLE(offset + 16),
        sr: data.readDoubleLE(offset + 24),
        sg: data.readDoubleLE(offset + 32),
        sb: data.readDoubleLE(offset + 40),
        si: data.readDoubleLE(offset + 48),
        n: data.readDoubleLE(offset + 56),
      };
      if (acc.n === 0) {
        throw new Error(`Accumulator with zero samples in ${active.chunkKey}`);
      }
      active.voxels.set(
        voxelKey(acc.sx / acc.n, acc.sy / acc.n, acc.sz / acc.n, this.fuseVoxelMeters),
        acc,
      );
    }
    return true;
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
    writeFileAtomically(active.accumulatorPath, serialized.accumulatorBuffer);
    writeFileAtomically(active.filePath, serialized.buffer);

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

  private enforceActiveLimit(): void {
    while (this.activeChunks.size > this.maxDirtyChunks) {
      const oldestKey = this.activeChunks.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.evictChunk(oldestKey);
    }
  }

  private evictChunk(dirtyKey: string): void {
    const active = this.activeChunks.get(dirtyKey);
    if (!active) {
      return;
    }
    if (active.pointsSinceFlush > 0 || !fs.existsSync(active.filePath)) {
      this.persistChunk(active);
    }
    this.activeChunks.delete(dirtyKey);
  }

  // Encode a voxel set to the on-disk / wire 18-byte point format (one representative
  // per voxel, the component mean) and compute its world-frame bounds in one pass.
  private serializeVoxels(voxels: Map<string, VoxelAccumulator>): SerializedVoxels {
    const buffer = Buffer.allocUnsafe(voxels.size * POINT_STRIDE_BYTES);
    const accumulatorBuffer = Buffer.allocUnsafe(voxels.size * ACCUMULATOR_STRIDE_BYTES);
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
      const accumulatorOffset = (offset / POINT_STRIDE_BYTES) * ACCUMULATOR_STRIDE_BYTES;
      accumulatorBuffer.writeDoubleLE(acc.sx, accumulatorOffset);
      accumulatorBuffer.writeDoubleLE(acc.sy, accumulatorOffset + 8);
      accumulatorBuffer.writeDoubleLE(acc.sz, accumulatorOffset + 16);
      accumulatorBuffer.writeDoubleLE(acc.sr, accumulatorOffset + 24);
      accumulatorBuffer.writeDoubleLE(acc.sg, accumulatorOffset + 32);
      accumulatorBuffer.writeDoubleLE(acc.sb, accumulatorOffset + 40);
      accumulatorBuffer.writeDoubleLE(acc.si, accumulatorOffset + 48);
      accumulatorBuffer.writeDoubleLE(acc.n, accumulatorOffset + 56);

      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;

      offset += POINT_STRIDE_BYTES;
    }

    return { buffer, accumulatorBuffer, minX, minY, minZ, maxX, maxY, maxZ };
  }
}

function encodeChunkKey(chunkX: number, chunkY: number, chunkZ: number): string {
  return `${chunkX}_${chunkY}_${chunkZ}`;
}

function voxelKey(x: number, y: number, z: number, size: number): string {
  return `${Math.floor(x / size)}_${Math.floor(y / size)}_${Math.floor(z / size)}`;
}

// Accumulate 18-byte world-frame points into voxels of the given edge length, one
// accumulator per occupied cell (each input point weighted equally). Used to coarsen
// fine representatives into an LOD level.
function binPoints(buffer: Buffer, size: number): Map<string, VoxelAccumulator> {
  const voxels = new Map<string, VoxelAccumulator>();
  for (let offset = 0; offset + POINT_STRIDE_BYTES <= buffer.byteLength; offset += POINT_STRIDE_BYTES) {
    const x = buffer.readFloatLE(offset);
    const y = buffer.readFloatLE(offset + 4);
    const z = buffer.readFloatLE(offset + 8);
    const key = voxelKey(x, y, z, size);
    let acc = voxels.get(key);
    if (!acc) {
      acc = { sx: 0, sy: 0, sz: 0, sr: 0, sg: 0, sb: 0, si: 0, n: 0 };
      voxels.set(key, acc);
    }
    acc.sx += x;
    acc.sy += y;
    acc.sz += z;
    acc.sr += buffer[offset + 12];
    acc.sg += buffer[offset + 13];
    acc.sb += buffer[offset + 14];
    acc.si += buffer.readUInt16LE(offset + 15);
    acc.n += 1;
  }
  return voxels;
}

function clampU8(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

function clampU16(value: number): number {
  return value < 0 ? 0 : value > 65535 ? 65535 : value;
}

function writeFileAtomically(filePath: string, data: Buffer): void {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx');
    fs.writeFileSync(descriptor, data);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
    syncDirectory(path.dirname(filePath));
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (!isNotFoundError(cleanupError)) {
        throw cleanupError;
      }
    }
    throw error;
  }
}

function finalizeStagedFile(stagedPath: string, finalPath: string, chunkKey: string): void {
  if (fs.existsSync(stagedPath)) {
    fs.renameSync(stagedPath, finalPath);
    syncDirectory(path.dirname(finalPath));
    return;
  }
  if (!fs.existsSync(finalPath)) {
    throw new Error(`Missing staged and final chunk file for ${chunkKey}`);
  }
}

function syncDirectory(directoryPath: string): void {
  const descriptor = fs.openSync(directoryPath, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readDirectories(directoryPath: string): string[] {
  try {
    return fs
      .readdirSync(directoryPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

function removeDirectoryIfEmpty(directoryPath: string): void {
  try {
    if (fs.readdirSync(directoryPath).length === 0) {
      fs.rmdirSync(directoryPath);
    }
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
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
