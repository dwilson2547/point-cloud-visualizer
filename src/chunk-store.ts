import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  type AcceptedBatch,
  type SessionSnapshot,
} from './session-store.js';
import { POINT_FORMAT, POINT_STRIDE_BYTES, type Pose } from './protocol.js';
import { toInternalPoints } from './point-formats.js';
import { BatchLogWriter, readLogRecordAt, replayLog, type LogRecord, type LogRecordHeader } from './batch-log.js';
import {
  PoseCorrectionMap,
  deletePoseCorrections,
  loadPoseCorrections,
  posesDiffer,
  savePoseCorrections,
  type PoseCorrections,
} from './pose-corrections.js';

// Accumulator sidecar (.acc): a 16-byte header then one 72-byte record per voxel
// (version 2; version 1 records were 64 bytes without the opportunity baseline).
//   u32 magic 'PCVA', u32 version, f64 applied_sequence (last batch fused into it)
// A headerless file (pre-log layout) is read as applied_sequence 0.
const ACCUMULATOR_MAGIC = 0x41564350;
const ACCUMULATOR_VERSION = 2;
const ACCUMULATOR_HEADER_BYTES = 16;
const ACCUMULATOR_STRIDE_BYTES = 72;
const ACCUMULATOR_V1_STRIDE_BYTES = 64;
// Field-of-view test samples: a 3x3x3 lattice over the chunk box, so a thin elevation
// band crossing a face between corners is still caught down to ~1 m range.
const FOV_SAMPLE_STEPS = [0, 0.5, 1];

export interface ChunkStoreOptions {
  rootDir: string;
  chunkSizeMeters?: number;
  fuseVoxelMeters?: number;
  numLevels?: number;
  flushPointThreshold?: number;
  maxDirtyChunks?: number;
  maxChunksPerBatch?: number;
  // A corrected pose that moves a batch by less than this (translation, or rotation at
  // 25 m range) does not re-fuse it. Default: half the fusion voxel.
  refuseToleranceM?: number;
  // Default sensor field of view for the observation counters (per-session override via
  // create_session metadata.sensor_fov). Defaults match a level VLP-16.
  sensorFov?: SensorFov;
  // Test seam: called after the batch is durable in the log and again after it has
  // been fused and the session row updated.
  durableBatchHook?: (phase: 'logged' | 'fused') => void;
  log?: (message: string) => void;
}

export interface SensorFov {
  elevationMinDeg: number;
  elevationMaxDeg: number;
  maxRangeM: number;
  marginDeg?: number; // widen the band so edge voxels are not penalised (default 2)
}

// Serve-time observation filter: a voxel is shown when it has at least `minHits`
// samples and hits / opportunities >= `minRatio`, where opportunities counts the
// batches whose sensor pose had the voxel's chunk in view since the voxel appeared.
export interface ObservationFilter {
  minHits: number;
  minRatio: number;
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
  appliedSequence: number;
  opportunities: number;
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
  logBytes: number;
}

// What fusing a batch produced: the chunks it touched (for viewer refresh) and the
// pose it was actually fused with (the logged pose, or its correction).
export interface FusedBatch {
  touchedKeys: string[];
  pose: Pose;
}

export interface ChunkDerivation {
  points: Buffer; // 18-byte world-frame points: the full level, or only the new ones
  version: number; // fine voxel count the derivation reflects
  total: number; // point count of the full derivation at this level
}

export interface RebuildResult {
  batches: number; // batches re-fused
  chunks: number; // chunks rebuilt
  mode: 'full' | 'partial' | 'unchanged';
}

// One row of the per-session batch index: enough to find a logged batch again and to
// decide whether a new correction moves it.
interface BatchIndexRow {
  sequence: number;
  poseSequence: number;
  logOffset: number;
  loggedPose: Pose;
  fusedPose: Pose;
}

interface FuseOutcome {
  touched: string[]; // chunks that accepted points
  spanned: string[]; // every chunk the batch's points fall in, accepted or not
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
  n: number; // hits
  o0: number; // the chunk's opportunity count when this voxel first appeared
}

// Per-chunk observation counters, shared between the cell registry and the resident
// chunk so both see the same numbers. `opportunities` counts batches whose sensor
// field of view covered the chunk; `fovSequence` is the last batch counted, which
// makes replay idempotent the way `appliedSequence` does for points.
interface ChunkStats {
  opportunities: number;
  fovSequence: number;
  dirty: boolean;
}

// Every chunk cell of a session, resident or on disk: geometry plus counters.
interface CellEntry {
  chunkKey: string;
  chunkX: number;
  chunkY: number;
  chunkZ: number;
  stats: ChunkStats;
}

// A chunk resident in memory: its full current voxel set (seeded from disk on
// activation, so it is a superset of the on-disk file). Stays resident across
// periodic flushes and is released (persisted + dropped) only on eviction or an
// explicit flush. `appliedSequence` is the highest batch sequence fused into it; it
// travels with the file so log replay can skip batches a chunk already holds.
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
  appliedSequence: number;
  stats: ChunkStats;
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

interface SessionLogState {
  writer?: BatchLogWriter;
  endOffset: number; // bytes of intact records in the log
  checkpointOffset: number; // replay start: everything before is in persisted chunks
  // An in-progress checkpoint sweep: the log end when it started and the chunks that
  // were dirty then. Once all of them have been persisted, everything logged before
  // `offset` is on disk in chunk form and the checkpoint can move there.
  sweep?: { offset: number; pending: string[] };
}

export interface SessionLogSummary {
  logBytes: number;
  checkpointOffset: number;
  dirtyChunks: number;
  sweepPending: number;
}

export class ChunkStore {
  readonly chunkSizeMeters: number;
  readonly fuseVoxelMeters: number;
  readonly numLevels: number;
  readonly flushPointThreshold: number;
  readonly maxDirtyChunks: number;
  readonly maxChunksPerBatch: number;
  readonly refuseToleranceM: number;
  readonly sensorFov: SensorFov;

  private readonly rootDir: string;
  private readonly chunksDir: string;
  private readonly logsDir: string;
  private readonly database: DatabaseSync;
  private readonly durableBatchHook?: (phase: 'logged' | 'fused') => void;
  private readonly log: (message: string) => void;
  // Chunks currently resident in memory, keyed `sessionId:chunkKey`. Insertion
  // order is the LRU order used for eviction.
  private readonly activeChunks = new Map<string, ActiveChunk>();
  private readonly sessionLogs = new Map<string, SessionLogState>();
  // Per-session pose corrections, loaded lazily from data/poses; null = none on disk.
  private readonly corrections = new Map<string, PoseCorrectionMap | null>();
  // Per-session cell registry (all chunks, resident or not), loaded lazily from the
  // chunks table and extended as chunks are created.
  private readonly sessionCells = new Map<string, Map<string, CellEntry>>();
  private readonly sessionFovs = new Map<string, SensorFov>();

  constructor(options: ChunkStoreOptions) {
    this.rootDir = options.rootDir;
    this.chunksDir = path.join(this.rootDir, 'chunks');
    this.logsDir = path.join(this.rootDir, 'log');
    this.chunkSizeMeters = options.chunkSizeMeters ?? 2;
    this.fuseVoxelMeters = options.fuseVoxelMeters ?? 0.04;
    this.numLevels = Math.max(1, options.numLevels ?? 6);
    this.flushPointThreshold = options.flushPointThreshold ?? 50_000;
    this.maxDirtyChunks = options.maxDirtyChunks ?? 128;
    this.maxChunksPerBatch = options.maxChunksPerBatch ?? 128;
    this.refuseToleranceM = options.refuseToleranceM ?? this.fuseVoxelMeters / 2;
    this.sensorFov = options.sensorFov ?? { elevationMinDeg: -15, elevationMaxDeg: 15, maxRangeM: 100 };
    this.durableBatchHook = options.durableBatchHook;
    this.log = options.log ?? ((message) => console.log(message));

    fs.mkdirSync(this.chunksDir, { recursive: true });
    fs.mkdirSync(this.logsDir, { recursive: true });
    this.database = new DatabaseSync(path.join(this.rootDir, 'metadata.sqlite'));
    // WAL + NORMAL: a commit is a WAL append without an fsync. Batches are made
    // durable by the batch log, and everything in SQLite is rebuilt from it plus the
    // chunk files, so the metadata store does not need to pay for its own fsyncs.
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.initializeSchema();
    this.recoverLogs();
  }

  syncSession(session: SessionSnapshot): void {
    this.sessionFovs.delete(session.sessionId);
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

  // Fuse a batch into the resident chunk cache without logging it. For tests and
  // tooling; the server always goes through storeAcceptedBatchDurably.
  storeAcceptedBatch(accepted: AcceptedBatch): FusedBatch {
    const internal = toInternalPoints(accepted.payload, accepted.header.point_format ?? POINT_FORMAT);
    this.chunkKeysForPayload(internal, accepted.pose.pose, this.maxChunksPerBatch);
    const sessionId = accepted.session.sessionId;
    const pose = this.effectivePose(sessionId, accepted.header.pose_sequence, accepted.pose.pose);
    const { touched } = this.fuseBatch(sessionId, accepted.header.sequence, pose, internal, true);
    return { touchedKeys: touched, pose };
  }

  // The durable ingest path: append the raw batch to the session log (one write,
  // one fsync), then fuse it into the chunk cache and record the session counters.
  // Once this returns the batch survives a crash — anything not yet reflected in
  // persisted chunk files is replayed from the log at the next startup. Returns the
  // chunk keys the batch touched so callers can refresh them for viewers.
  storeAcceptedBatchDurably(accepted: AcceptedBatch, nextSession: SessionSnapshot): FusedBatch {
    const sessionId = accepted.session.sessionId;
    const format = accepted.header.point_format ?? POINT_FORMAT;
    const internal = toInternalPoints(accepted.payload, format);
    const batchChunkKeys = this.chunkKeysForPayload(internal, accepted.pose.pose, this.maxChunksPerBatch);
    if (batchChunkKeys.size > this.maxDirtyChunks) {
      throw new Error(
        `Batch touches ${batchChunkKeys.size} chunks but the resident chunk budget is ${this.maxDirtyChunks}`,
      );
    }
    try {
      const state = this.sessionLog(sessionId);
      const writer = state.writer ?? (state.writer = new BatchLogWriter(this.sessionLogPath(sessionId)));
      const record: LogRecordHeader = {
        sequence: accepted.header.sequence,
        pose_sequence: accepted.header.pose_sequence,
        timestamp: accepted.header.timestamp,
        point_count: accepted.header.point_count,
        pose: accepted.pose.pose,
        point_format: format,
      };
      const logOffset = state.endOffset;
      state.endOffset = writer.append(record, accepted.payload); // as sent, not decoded
      this.durableBatchHook?.('logged');

      this.prepareActiveCapacity(sessionId, batchChunkKeys);
      const pose = this.effectivePose(sessionId, accepted.header.pose_sequence, accepted.pose.pose);
      const { touched, spanned } = this.fuseBatch(sessionId, accepted.header.sequence, pose, internal, true);
      this.recordFusedBatch(sessionId, record, logOffset, pose, spanned);
      this.syncSession(nextSession);
      this.durableBatchHook?.('fused');
      return { touchedKeys: touched, pose };
    } catch (error) {
      throw new DurableBatchError(
        `Failed to durably commit batch ${accepted.header.sequence} for ${sessionId}`,
        { cause: error },
      );
    }
  }

  // Transform a batch's local-frame points into the world frame and fuse them into
  // per-chunk voxel grids. Density is bounded by occupied voxels, not by measurement
  // count, so re-observing a surface adds no points once its voxels are filled. A
  // chunk that already holds this sequence (a replayed batch after a partial flush)
  // is left untouched, which is what makes log replay idempotent.
  // `restrictTo`, when given, limits fusion to those chunks (a partial rebuild re-fuses
  // a batch only into the chunks being rebuilt; its other chunks already hold it).
  private fuseBatch(
    sessionId: string,
    sequence: number,
    pose: Pose,
    payload: Buffer,
    allowPersistence: boolean,
    restrictTo?: Set<string>,
  ): FuseOutcome {
    const [tx, ty, tz] = pose.translation_m;
    const [qx, qy, qz, qw] = pose.rotation_xyzw;
    const chunkSize = this.chunkSizeMeters;
    const voxelSize = this.fuseVoxelMeters;

    const touched = new Set<ActiveChunk>();
    const spanned = new Set<string>();
    let lastChunkKey = '';
    let lastActive: ActiveChunk | null = null;

    // Every existing chunk the sensor could see gets an opportunity for this batch,
    // whether or not a point lands in it. Chunks that do receive points are counted
    // below regardless of the geometry test.
    this.applyFieldOfView(sessionId, sequence, pose, restrictTo);

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
      const chunkKey = encodeChunkKey(chunkX, chunkY, chunkZ);
      if (chunkKey !== lastChunkKey) {
        lastChunkKey = chunkKey;
        spanned.add(chunkKey);
        lastActive =
          restrictTo && !restrictTo.has(chunkKey)
            ? null
            : this.activateChunk(sessionId, chunkKey, chunkX, chunkY, chunkZ);
        if (lastActive && lastActive.stats.fovSequence < sequence) {
          lastActive.stats.opportunities += 1;
          lastActive.stats.fovSequence = sequence;
          lastActive.stats.dirty = true;
        }
      }
      const active = lastActive;
      if (!active || active.appliedSequence >= sequence) {
        continue; // outside the rebuild set, or already fused before a crash
      }

      const key = voxelKey(worldX, worldY, worldZ, voxelSize);
      let acc = active.voxels.get(key);
      if (!acc) {
        acc = { sx: 0, sy: 0, sz: 0, sr: 0, sg: 0, sb: 0, si: 0, n: 0, o0: active.stats.opportunities };
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
      active.appliedSequence = sequence;
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
    return { touched: touchedKeys, spanned: [...spanned] };
  }

  // Keep the batch index current: where the batch sits in the log, the pose it was
  // fused with, and the chunks its points span. This is what lets a later correction
  // re-fuse only what moved.
  private recordFusedBatch(
    sessionId: string,
    header: LogRecordHeader,
    logOffset: number,
    fusedPose: Pose,
    spanned: string[],
  ): void {
    this.database
      .prepare(
        `INSERT INTO batches (session_id, sequence, pose_sequence, log_offset, point_count, logged_pose, fused_pose)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, sequence) DO UPDATE SET
           pose_sequence = excluded.pose_sequence,
           log_offset = excluded.log_offset,
           point_count = excluded.point_count,
           logged_pose = excluded.logged_pose,
           fused_pose = excluded.fused_pose`,
      )
      .run(
        sessionId,
        header.sequence,
        header.pose_sequence,
        logOffset,
        header.point_count,
        JSON.stringify(header.pose),
        JSON.stringify(fusedPose),
      );
    this.database
      .prepare('DELETE FROM batch_chunks WHERE session_id = ? AND sequence = ?')
      .run(sessionId, header.sequence);
    const insert = this.database.prepare(
      'INSERT OR IGNORE INTO batch_chunks (session_id, sequence, chunk_key) VALUES (?, ?, ?)',
    );
    for (const chunkKey of spanned) {
      insert.run(sessionId, header.sequence, chunkKey);
    }
  }

  private listBatchIndex(sessionId: string): BatchIndexRow[] {
    return this.database
      .prepare(
        `SELECT sequence, pose_sequence, log_offset, logged_pose, fused_pose
         FROM batches WHERE session_id = ? ORDER BY sequence`,
      )
      .all(sessionId)
      .map((row) => ({
        sequence: Number(row.sequence),
        poseSequence: Number(row.pose_sequence),
        logOffset: Number(row.log_offset),
        loggedPose: JSON.parse(String(row.logged_pose)) as Pose,
        fusedPose: JSON.parse(String(row.fused_pose)) as Pose,
      }));
  }

  // Count this batch as an opportunity for every existing chunk of the session whose
  // box lies in the sensor's field of view from `pose`. Chunk-level, not voxel-level:
  // a chunk partly in view counts for all its voxels, which slightly under-rates
  // voxels near the band edge. Idempotent per chunk via fovSequence.
  private applyFieldOfView(sessionId: string, sequence: number, pose: Pose, restrictTo?: Set<string>): void {
    const fov = this.sessionFov(sessionId);
    for (const cell of this.cells(sessionId).values()) {
      if (cell.stats.fovSequence >= sequence || (restrictTo && !restrictTo.has(cell.chunkKey))) {
        continue;
      }
      if (this.cellInFieldOfView(cell, pose, fov)) {
        cell.stats.opportunities += 1;
        cell.stats.fovSequence = sequence;
        cell.stats.dirty = true;
      }
    }
  }

  private cellInFieldOfView(cell: CellEntry, pose: Pose, fov: SensorFov): boolean {
    const size = this.chunkSizeMeters;
    const [tx, ty, tz] = pose.translation_m;
    const [qx, qy, qz, qw] = pose.rotation_xyzw;
    const minX = cell.chunkX * size;
    const minY = cell.chunkY * size;
    const minZ = cell.chunkZ * size;
    if (tx >= minX && tx <= minX + size && ty >= minY && ty <= minY + size && tz >= minZ && tz <= minZ + size) {
      return true; // sensor inside the chunk
    }
    const margin = fov.marginDeg ?? 2;
    const lo = ((fov.elevationMinDeg - margin) * Math.PI) / 180;
    const hi = ((fov.elevationMaxDeg + margin) * Math.PI) / 180;
    const maxRange2 = fov.maxRangeM * fov.maxRangeM;
    for (const fx of FOV_SAMPLE_STEPS) {
      for (const fy of FOV_SAMPLE_STEPS) {
        for (const fz of FOV_SAMPLE_STEPS) {
          const dx = minX + fx * size - tx;
          const dy = minY + fy * size - ty;
          const dz = minZ + fz * size - tz;
          const r2 = dx * dx + dy * dy + dz * dz;
          if (r2 > maxRange2) {
            continue;
          }
          // Local z of the sample = third row of R^T applied to the world offset.
          const [, , lz] = rotateAndTranslate(dx, dy, dz, -qx, -qy, -qz, qw, 0, 0, 0);
          const elevation = Math.asin(Math.max(-1, Math.min(1, lz / Math.sqrt(r2))));
          if (elevation >= lo && elevation <= hi) {
            return true;
          }
        }
      }
    }
    return false;
  }

  // Chunk keys a pose can see; used by partial rebuilds to adjust counters of chunks
  // that are not being rebuilt when a batch's pose moves.
  private fieldOfViewKeys(sessionId: string, pose: Pose): Set<string> {
    const fov = this.sessionFov(sessionId);
    const keys = new Set<string>();
    for (const cell of this.cells(sessionId).values()) {
      if (this.cellInFieldOfView(cell, pose, fov)) {
        keys.add(cell.chunkKey);
      }
    }
    return keys;
  }

  private sessionFov(sessionId: string): SensorFov {
    let fov = this.sessionFovs.get(sessionId);
    if (!fov) {
      fov = this.sensorFov;
      const row = this.database
        .prepare('SELECT metadata_json FROM sessions WHERE session_id = ?')
        .get(sessionId) as { metadata_json?: string | null } | undefined;
      if (row?.metadata_json) {
        const meta = JSON.parse(String(row.metadata_json)) as {
          sensor_fov?: { elevation_min_deg?: number; elevation_max_deg?: number; max_range_m?: number };
        };
        const override = meta.sensor_fov;
        if (override) {
          fov = {
            elevationMinDeg: finiteOr(override.elevation_min_deg, fov.elevationMinDeg),
            elevationMaxDeg: finiteOr(override.elevation_max_deg, fov.elevationMaxDeg),
            maxRangeM: finiteOr(override.max_range_m, fov.maxRangeM),
            marginDeg: fov.marginDeg,
          };
        }
      }
      this.sessionFovs.set(sessionId, fov);
    }
    return fov;
  }

  private cells(sessionId: string): Map<string, CellEntry> {
    let cells = this.sessionCells.get(sessionId);
    if (!cells) {
      cells = new Map();
      const rows = this.database
        .prepare('SELECT chunk_key, chunk_x, chunk_y, chunk_z, opportunities, fov_sequence FROM chunks WHERE session_id = ?')
        .all(sessionId);
      for (const row of rows) {
        cells.set(String(row.chunk_key), {
          chunkKey: String(row.chunk_key),
          chunkX: Number(row.chunk_x),
          chunkY: Number(row.chunk_y),
          chunkZ: Number(row.chunk_z),
          stats: { opportunities: Number(row.opportunities), fovSequence: Number(row.fov_sequence), dirty: false },
        });
      }
      this.sessionCells.set(sessionId, cells);
    }
    return cells;
  }

  private registerCell(sessionId: string, chunkKey: string, chunkX: number, chunkY: number, chunkZ: number): CellEntry {
    const cells = this.cells(sessionId);
    let cell = cells.get(chunkKey);
    if (!cell) {
      cell = { chunkKey, chunkX, chunkY, chunkZ, stats: { opportunities: 0, fovSequence: 0, dirty: true } };
      cells.set(chunkKey, cell);
    }
    return cell;
  }

  // Write counters for cells whose on-disk voxels are current (not resident, or
  // resident and clean), so the DB row and the .acc snapshot always describe the same
  // moment. Dirty resident chunks carry their counters when they are persisted.
  private flushCellStats(sessionId: string): void {
    const update = this.database.prepare(
      'UPDATE chunks SET opportunities = ?, fov_sequence = ? WHERE session_id = ? AND chunk_key = ?',
    );
    for (const cell of this.cells(sessionId).values()) {
      if (!cell.stats.dirty) {
        continue;
      }
      const active = this.activeChunks.get(`${sessionId}:${cell.chunkKey}`);
      if (active && active.pointsSinceFlush > 0) {
        continue;
      }
      const result = update.run(cell.stats.opportunities, cell.stats.fovSequence, sessionId, cell.chunkKey);
      if (Number(result.changes) > 0) {
        cell.stats.dirty = false;
      }
    }
  }

  // The pose a batch is fused with: its logged pose unless the session has corrections.
  effectivePose(sessionId: string, poseSequence: number, logged: Pose): Pose {
    const map = this.correctionMap(sessionId);
    return map ? map.apply(poseSequence, logged) : logged;
  }

  getPoseCorrections(sessionId: string): PoseCorrections | null {
    return this.correctionMap(sessionId)?.corrections ?? null;
  }

  // Install (or with null, remove) a session's pose corrections and rebuild its fused
  // chunks from the log under the new poses. The log itself is never modified.
  setPoseCorrections(sessionId: string, corrections: PoseCorrections | null): RebuildResult {
    if (corrections) {
      savePoseCorrections(this.rootDir, corrections);
      this.corrections.set(sessionId, new PoseCorrectionMap(corrections));
    } else {
      deletePoseCorrections(this.rootDir, sessionId);
      this.corrections.set(sessionId, null);
    }
    return this.rebuildChanged(sessionId);
  }

  // Re-fuse only what the current corrections moved. Compares each indexed batch's
  // fused pose with its new effective pose; falls back to a full rebuild when the
  // index is empty (data from before the index existed) or when most batches moved,
  // which is the case right after a loop closure and is cheaper done wholesale.
  rebuildChanged(sessionId: string): RebuildResult {
    const index = this.listBatchIndex(sessionId);
    if (index.length === 0) {
      return this.rebuildSession(sessionId);
    }
    const changed = index.filter((row) =>
      posesDiffer(
        row.fusedPose,
        this.effectivePose(sessionId, row.poseSequence, row.loggedPose),
        this.refuseToleranceM,
      ),
    );
    if (changed.length === 0) {
      return { batches: 0, chunks: 0, mode: 'unchanged' };
    }
    if (changed.length * 2 > index.length) {
      return this.rebuildSession(sessionId);
    }
    return this.rebuildBatches(sessionId, index, changed);
  }

  // Partial rebuild: the chunks a moved batch used to span plus the chunks it now
  // spans are dropped and rebuilt from every batch that spans them, restricted to
  // that chunk set so untouched chunks are never rewritten. The checkpoint is reset
  // first so a crash mid-way replays the whole log (chunk applied sequences make
  // that idempotent for the chunks that survived).
  private rebuildBatches(sessionId: string, index: BatchIndexRow[], changed: BatchIndexRow[]): RebuildResult {
    const logPath = this.sessionLogPath(sessionId);
    const state = this.sessionLog(sessionId);
    state.sweep = undefined;
    state.checkpointOffset = 0;
    this.database.prepare('UPDATE sessions SET checkpoint_offset = 0 WHERE session_id = ?').run(sessionId);

    const affected = new Set<string>();
    const records = new Map<number, LogRecord>();
    const changedSequences = new Set<number>();
    const oldChunks = this.database.prepare(
      'SELECT chunk_key FROM batch_chunks WHERE session_id = ? AND sequence = ?',
    );
    for (const row of changed) {
      changedSequences.add(row.sequence);
      for (const chunk of oldChunks.all(sessionId, row.sequence)) {
        affected.add(String(chunk.chunk_key));
      }
      const record = readLogRecordAt(logPath, row.logOffset);
      if (record.header.sequence !== row.sequence) {
        throw new Error(
          `Batch index for ${sessionId} points sequence ${row.sequence} at a record with sequence ${record.header.sequence}`,
        );
      }
      records.set(row.sequence, record);
      const pose = this.effectivePose(sessionId, record.header.pose_sequence, record.header.pose);
      for (const key of this.chunkKeysForPayload(internalPoints(record), pose)) {
        affected.add(key);
      }
    }

    this.database.exec('CREATE TEMP TABLE IF NOT EXISTS affected_chunks (chunk_key TEXT PRIMARY KEY)');
    this.database.exec('DELETE FROM affected_chunks');
    const insertAffected = this.database.prepare('INSERT OR IGNORE INTO affected_chunks (chunk_key) VALUES (?)');
    for (const key of affected) {
      insertAffected.run(key);
    }
    const replay = this.database
      .prepare(
        `SELECT DISTINCT b.sequence AS sequence, b.log_offset AS log_offset
         FROM batch_chunks bc
         JOIN affected_chunks a ON a.chunk_key = bc.chunk_key
         JOIN batches b ON b.session_id = bc.session_id AND b.sequence = bc.sequence
         WHERE bc.session_id = ?
         ORDER BY b.sequence`,
      )
      .all(sessionId)
      .map((row) => ({ sequence: Number(row.sequence), logOffset: Number(row.log_offset) }));
    for (const row of changed) {
      if (!replay.some((entry) => entry.sequence === row.sequence)) {
        replay.push({ sequence: row.sequence, logOffset: row.logOffset });
      }
    }
    replay.sort((a, b) => a.sequence - b.sequence);

    // Observation counters. Chunks not being rebuilt keep theirs, adjusted for the
    // moved batches (a pose that stops seeing a chunk takes an opportunity away, one
    // that starts seeing it adds one). Rebuilt chunks start from zero and are
    // recounted below from every batch's pose in order, so voxel baselines come out
    // as they would have live.
    const cells = this.cells(sessionId);
    for (const row of changed) {
      const before = this.fieldOfViewKeys(sessionId, row.fusedPose);
      const after = this.fieldOfViewKeys(sessionId, records.get(row.sequence)
        ? this.effectivePose(sessionId, row.poseSequence, row.loggedPose)
        : row.fusedPose);
      for (const key of before) {
        if (!after.has(key) && !affected.has(key)) {
          const stats = cells.get(key)!.stats;
          stats.opportunities = Math.max(0, stats.opportunities - 1);
          stats.dirty = true;
        }
      }
      for (const key of after) {
        if (!before.has(key) && !affected.has(key)) {
          const stats = cells.get(key)!.stats;
          stats.opportunities += 1;
          stats.dirty = true;
        }
      }
    }

    for (const key of affected) {
      this.activeChunks.delete(`${sessionId}:${key}`);
      removeIfPresent(path.join(this.chunksDir, sessionId, `${key}.bin`));
      removeIfPresent(path.join(this.chunksDir, sessionId, `${key}.acc`));
      const cell = cells.get(key);
      if (cell) {
        cell.stats.opportunities = 0;
        cell.stats.fovSequence = 0;
        cell.stats.dirty = true;
      }
    }
    this.database
      .prepare('DELETE FROM chunks WHERE session_id = ? AND chunk_key IN (SELECT chunk_key FROM affected_chunks)')
      .run(sessionId);

    // Walk every indexed batch in order: its pose counts opportunities for the rebuilt
    // chunks; the ones spanning them are re-fused (restricted to the rebuilt set).
    let next = 0;
    for (const row of index) {
      const pose = this.effectivePose(sessionId, row.poseSequence, row.loggedPose);
      if (next < replay.length && replay[next].sequence === row.sequence) {
        const entry = replay[next++];
        const record = records.get(entry.sequence) ?? readLogRecordAt(logPath, entry.logOffset);
        const { spanned } = this.fuseBatch(sessionId, record.header.sequence, pose, internalPoints(record), true, affected);
        if (changedSequences.has(record.header.sequence)) {
          this.recordFusedBatch(sessionId, record.header, record.offset, pose, spanned);
        }
      } else {
        this.applyFieldOfView(sessionId, row.sequence, pose, affected);
      }
    }
    // A rebuilt cell that received no points no longer exists.
    for (const key of affected) {
      if (!this.activeChunks.has(`${sessionId}:${key}`)) {
        cells.delete(key);
      }
    }
    this.database.exec('DELETE FROM affected_chunks');
    this.checkpointSession(sessionId);
    this.log(`Rebuilt ${sessionId}: ${replay.length} batches re-fused into ${affected.size} chunks (partial)`);
    return { batches: replay.length, chunks: affected.size, mode: 'partial' };
  }

  // Throw away a session's fused chunks (resident and on disk) and re-fuse every
  // logged batch under the current effective poses. Synchronous: ingest for the
  // session waits, which is the point — nothing interleaves with the rebuild.
  rebuildSession(sessionId: string): RebuildResult {
    const prefix = `${sessionId}:`;
    for (const key of [...this.activeChunks.keys()]) {
      if (key.startsWith(prefix)) {
        this.activeChunks.delete(key); // dropped, not persisted
      }
    }
    for (const chunk of this.listSessionChunks(sessionId)) {
      removeIfPresent(path.join(this.rootDir, chunk.filePath));
      removeIfPresent(path.join(this.chunksDir, sessionId, `${chunk.chunkKey}.acc`));
    }
    this.database.prepare('DELETE FROM chunks WHERE session_id = ?').run(sessionId);
    this.database.prepare('DELETE FROM batch_chunks WHERE session_id = ?').run(sessionId);
    this.database.prepare('DELETE FROM batches WHERE session_id = ?').run(sessionId);
    this.sessionCells.delete(sessionId);

    const state = this.sessionLog(sessionId);
    state.sweep = undefined;
    state.checkpointOffset = 0;
    this.database.prepare('UPDATE sessions SET checkpoint_offset = 0 WHERE session_id = ?').run(sessionId);

    const result = replayLog(this.sessionLogPath(sessionId), 0, (record) => {
      const { header } = record;
      const pose = this.effectivePose(sessionId, header.pose_sequence, header.pose);
      const { spanned } = this.fuseBatch(sessionId, header.sequence, pose, internalPoints(record), true);
      this.recordFusedBatch(sessionId, header, record.offset, pose, spanned);
    });
    state.endOffset = result.endOffset;
    this.checkpointSession(sessionId);
    this.log(`Rebuilt ${sessionId}: ${result.records} batches re-fused (full)`);
    return { batches: result.records, chunks: this.listSessionChunkKeys(sessionId).length, mode: 'full' };
  }

  sessionLogPath(sessionId: string): string {
    return path.join(this.logsDir, `${sessionId}.log`);
  }

  private correctionMap(sessionId: string): PoseCorrectionMap | null {
    let map = this.corrections.get(sessionId);
    if (map === undefined) {
      const loaded = loadPoseCorrections(this.rootDir, sessionId);
      map = loaded ? new PoseCorrectionMap(loaded) : null;
      this.corrections.set(sessionId, map);
    }
    return map;
  }

  // Advance a session's replay start. A sweep snapshots the log end and the set of
  // dirty resident chunks, persists those chunks (keeping them resident) and, once
  // none of the snapshot remains dirty, moves the checkpoint to the snapshot offset.
  // Chunks dirtied again after the snapshot are covered by later log records, and a
  // chunk persisted with data past the snapshot skips those records on replay via
  // its applied sequence. `maxChunks` bounds how many chunks one call rewrites so a
  // periodic tick never stalls ingest for a full cache rewrite; Infinity finishes the
  // sweep in one go. Returns true when the checkpoint is fully up to date.
  checkpointSession(sessionId: string, maxChunks: number = Number.POSITIVE_INFINITY): boolean {
    const state = this.sessionLog(sessionId);
    this.flushCellStats(sessionId);
    if (!state.sweep) {
      if (state.endOffset === state.checkpointOffset && this.dirtyChunkKeys(sessionId).length === 0) {
        return true;
      }
      state.sweep = { offset: state.endOffset, pending: this.dirtyChunkKeys(sessionId) };
    }
    const { sweep } = state;
    let persisted = 0;
    while (sweep.pending.length > 0 && persisted < maxChunks) {
      const chunkKey = sweep.pending.pop()!;
      const active = this.activeChunks.get(`${sessionId}:${chunkKey}`);
      // Evicted since the snapshot (persisted on the way out) or flushed by the
      // threshold path: either way its snapshot-era data is already on disk.
      if (active && active.pointsSinceFlush > 0) {
        this.persistChunk(active);
        persisted += 1;
      }
    }
    if (sweep.pending.length > 0) {
      return false;
    }
    state.sweep = undefined;
    if (sweep.offset !== state.checkpointOffset) {
      state.checkpointOffset = sweep.offset;
      this.database
        .prepare('UPDATE sessions SET checkpoint_offset = ? WHERE session_id = ?')
        .run(state.checkpointOffset, sessionId);
    }
    return state.endOffset === state.checkpointOffset;
  }

  // One periodic step of checkpointing across every session, rewriting at most
  // `maxChunks` chunk files in total.
  checkpointTick(maxChunks: number): void {
    let budget = maxChunks;
    for (const sessionId of this.sessionLogs.keys()) {
      if (budget <= 0) {
        return;
      }
      const before = this.dirtyChunkKeys(sessionId).length;
      this.checkpointSession(sessionId, budget);
      budget -= Math.max(0, before - this.dirtyChunkKeys(sessionId).length);
    }
  }

  checkpointAll(): void {
    for (const sessionId of this.sessionLogs.keys()) {
      this.checkpointSession(sessionId);
    }
  }

  getSessionLogSummary(sessionId: string): SessionLogSummary {
    const state = this.sessionLogs.get(sessionId);
    return {
      logBytes: state?.endOffset ?? 0,
      checkpointOffset: state?.checkpointOffset ?? 0,
      dirtyChunks: this.dirtyChunkKeys(sessionId).length,
      sweepPending: state?.sweep?.pending.length ?? 0,
    };
  }

  private dirtyChunkKeys(sessionId: string): string[] {
    const prefix = `${sessionId}:`;
    const keys: string[] = [];
    for (const [key, active] of this.activeChunks) {
      if (key.startsWith(prefix) && active.pointsSinceFlush > 0) {
        keys.push(active.chunkKey);
      }
    }
    return keys;
  }

  // Checkpoint a session and release its resident chunks and log handle (session
  // closed or server shutting down). Re-touching it later re-seeds from disk.
  flushSession(sessionId: string): void {
    this.checkpointSession(sessionId);
    const prefix = `${sessionId}:`;
    for (const key of [...this.activeChunks.keys()]) {
      if (key.startsWith(prefix)) {
        this.evictChunk(key);
      }
    }
    const state = this.sessionLogs.get(sessionId);
    if (state?.writer) {
      state.writer.close();
      state.writer = undefined;
    }
  }

  flushAll(): void {
    this.checkpointAll();
    for (const key of [...this.activeChunks.keys()]) {
      this.evictChunk(key);
    }
    for (const state of this.sessionLogs.values()) {
      state.writer?.close();
      state.writer = undefined;
    }
  }

  close(): void {
    for (const state of this.sessionLogs.values()) {
      state.writer?.close();
      state.writer = undefined;
    }
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

    let logBytes = 0;
    for (const state of this.sessionLogs.values()) {
      logBytes += state.endOffset;
    }

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
      logBytes,
    };
  }

  listSessionChunks(sessionId: string): ChunkMetadata[] {
    return this.database
      .prepare(
        `SELECT
          session_id, chunk_key, chunk_x, chunk_y, chunk_z, file_path,
          point_count, batch_count, bytes, applied_sequence, opportunities,
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
        appliedSequence: Number(row.applied_sequence),
        opportunities: Number(row.opportunities),
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
      yield serializeRepresentatives(active.voxels);
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
    return [...this.cells(sessionId).values()].map((cell) => ({
      chunkKey: cell.chunkKey,
      chunkX: cell.chunkX,
      chunkY: cell.chunkY,
      chunkZ: cell.chunkZ,
    }));
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
  // chunk has no data.
  deriveChunkLevel(sessionId: string, chunkKey: string, level: number, filter?: ObservationFilter): Buffer {
    return this.deriveChunk(sessionId, chunkKey, level, filter).points;
  }

  // Derive a chunk at a level, either in full (a keyframe) or as the points added
  // since `sinceVersion` (a delta). A chunk's version is its fine voxel count: voxels
  // are append-only and kept in insertion order in memory and on disk, so the fine
  // voxels at index >= version are exactly the new ones. At a coarser level a cell is
  // new when its first fine voxel is new; a new fine voxel joining an existing cell
  // only nudges that cell's mean and is not re-sent. `total` is the point count of the
  // full derivation at this level, so a caller holding `count` points that receives a
  // delta of `d` can detect divergence (e.g. voxels newly passing the filter) when
  // count + d != total and ask for a keyframe instead.
  deriveChunk(
    sessionId: string,
    chunkKey: string,
    level: number,
    filter?: ObservationFilter,
    sinceVersion?: number,
  ): ChunkDerivation {
    const fine = this.readOrderedFine(sessionId, chunkKey, filter);
    if (!fine || fine.count === 0) {
      return { points: Buffer.alloc(0), version: 0, total: 0 };
    }
    const since = sinceVersion ?? 0;
    const { buffer, pass, count } = fine;

    if (level >= this.numLevels - 1) {
      let total = 0;
      let newCount = 0;
      for (let i = 0; i < count; i++) {
        if (pass && !pass[i]) continue;
        total += 1;
        if (i >= since) newCount += 1;
      }
      const points = Buffer.allocUnsafe(newCount * POINT_STRIDE_BYTES);
      let w = 0;
      for (let i = Math.max(since, 0); i < count; i++) {
        if (pass && !pass[i]) continue;
        buffer.copy(points, w, i * POINT_STRIDE_BYTES, (i + 1) * POINT_STRIDE_BYTES);
        w += POINT_STRIDE_BYTES;
      }
      return { points, version: count, total };
    }

    const size = this.levelVoxelMeters(level);
    const cells = new Map<string, { acc: VoxelAccumulator; first: number }>();
    for (let i = 0; i < count; i++) {
      if (pass && !pass[i]) continue;
      const o = i * POINT_STRIDE_BYTES;
      const x = buffer.readFloatLE(o);
      const y = buffer.readFloatLE(o + 4);
      const z = buffer.readFloatLE(o + 8);
      const key = voxelKey(x, y, z, size);
      let cell = cells.get(key);
      if (!cell) {
        cell = { acc: { sx: 0, sy: 0, sz: 0, sr: 0, sg: 0, sb: 0, si: 0, n: 0, o0: 0 }, first: i };
        cells.set(key, cell);
      }
      cell.acc.sx += x;
      cell.acc.sy += y;
      cell.acc.sz += z;
      cell.acc.sr += buffer[o + 12];
      cell.acc.sg += buffer[o + 13];
      cell.acc.sb += buffer[o + 14];
      cell.acc.si += buffer.readUInt16LE(o + 15);
      cell.acc.n += 1;
    }
    const fresh = new Map<string, VoxelAccumulator>();
    for (const [key, cell] of cells) {
      if (cell.first >= since) fresh.set(key, cell.acc);
    }
    return { points: serializeRepresentatives(fresh), version: count, total: cells.size };
  }

  // The chunk's fine representatives in insertion order (one 18-byte point per voxel)
  // plus, when a filter is active, a pass flag per voxel. Resident chunks serialise
  // their voxel map; on-disk chunks read the .bin (same order) or, when the filter
  // needs hit counts, the .acc sidecar.
  private readOrderedFine(
    sessionId: string,
    chunkKey: string,
    filter?: ObservationFilter,
  ): { buffer: Buffer; pass: Uint8Array | null; count: number } | null {
    const active = this.activeChunks.get(`${sessionId}:${chunkKey}`);
    const filtering = isFilterActive(filter);
    let voxels: Map<string, VoxelAccumulator> | undefined;
    let stats: ChunkStats | undefined;
    if (active) {
      voxels = active.voxels;
      stats = active.stats;
    } else if (!filtering) {
      try {
        const buffer = fs.readFileSync(path.join(this.chunksDir, sessionId, `${chunkKey}.bin`));
        return { buffer, pass: null, count: buffer.byteLength / POINT_STRIDE_BYTES };
      } catch (error) {
        if (isNotFoundError(error)) return null;
        throw error;
      }
    } else {
      const cell = this.cells(sessionId).get(chunkKey);
      if (!cell) return null;
      voxels = this.loadAccumulators(path.join(this.chunksDir, sessionId, `${chunkKey}.acc`), cell.stats, chunkKey)?.voxels;
      stats = cell.stats;
    }
    if (!voxels || voxels.size === 0) return null;
    const buffer = serializeRepresentatives(voxels);
    if (!filtering || !filter || !stats) {
      return { buffer, pass: null, count: voxels.size };
    }
    const pass = new Uint8Array(voxels.size);
    const opportunities = stats.opportunities;
    let i = 0;
    for (const acc of voxels.values()) {
      const seen = Math.max(1, opportunities - acc.o0 + 1);
      pass[i++] = acc.n >= filter.minHits && acc.n / seen >= filter.minRatio ? 1 : 0;
    }
    return { buffer, pass, count: voxels.size };
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
        last_pose_sequence INTEGER,
        checkpoint_offset INTEGER NOT NULL DEFAULT 0
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
        applied_sequence INTEGER NOT NULL DEFAULT 0,
        opportunities INTEGER NOT NULL DEFAULT 0,
        fov_sequence INTEGER NOT NULL DEFAULT 0,
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
    // Columns added after the first schema shipped; a data dir from the transaction
    // era lacks them.
    this.addColumnIfMissing('sessions', 'checkpoint_offset', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('chunks', 'applied_sequence', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('chunks', 'opportunities', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('chunks', 'fov_sequence', 'INTEGER NOT NULL DEFAULT 0');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS batches (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        pose_sequence INTEGER NOT NULL,
        log_offset INTEGER NOT NULL,
        point_count INTEGER NOT NULL,
        logged_pose TEXT NOT NULL,
        fused_pose TEXT NOT NULL,
        PRIMARY KEY (session_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS batch_chunks (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        chunk_key TEXT NOT NULL,
        PRIMARY KEY (session_id, sequence, chunk_key)
      );
      CREATE INDEX IF NOT EXISTS batch_chunks_by_chunk ON batch_chunks (session_id, chunk_key);
    `);
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) {
      this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  // Startup: replay each session's log from its checkpoint offset into the chunk
  // cache, bring the session counters up to the log, then checkpoint so the next
  // start has nothing to redo. Chunks that already hold a replayed sequence skip it.
  private recoverLogs(): void {
    const rows = this.database
      .prepare('SELECT session_id, last_sequence, total_points, point_batches, checkpoint_offset FROM sessions')
      .all() as Array<{
      session_id: string;
      last_sequence: number;
      total_points: number;
      point_batches: number;
      checkpoint_offset: number;
    }>;
    const known = new Set<string>();

    for (const row of rows) {
      const sessionId = String(row.session_id);
      known.add(sessionId);
      const logPath = this.sessionLogPath(sessionId);
      const state = this.sessionLog(sessionId);
      state.checkpointOffset = Number(row.checkpoint_offset);
      let lastSequence = Number(row.last_sequence);
      let totalPoints = Number(row.total_points);
      let pointBatches = Number(row.point_batches);
      let lastSeenAt: string | undefined;

      const result = replayLog(logPath, state.checkpointOffset, (record) => {
        const { header } = record;
        const pose = this.effectivePose(sessionId, header.pose_sequence, header.pose);
        const { spanned } = this.fuseBatch(sessionId, header.sequence, pose, internalPoints(record), true);
        this.recordFusedBatch(sessionId, header, record.offset, pose, spanned);
        if (header.sequence > lastSequence) {
          // Counters in SQLite lag the log (they are only written after the fuse), so
          // records past the persisted sequence were never counted.
          lastSequence = header.sequence;
          totalPoints += header.point_count;
          pointBatches += 1;
          lastSeenAt = header.timestamp;
        }
      });
      state.endOffset = result.endOffset;
      if (state.checkpointOffset > state.endOffset) {
        state.checkpointOffset = state.endOffset;
      }
      if (result.records > 0 || result.truncatedBytes > 0) {
        this.log(
          `Replayed ${result.records} logged batches for ${sessionId}` +
            (result.truncatedBytes > 0 ? ` (dropped ${result.truncatedBytes} torn tail bytes)` : ''),
        );
      }
      if (lastSequence !== Number(row.last_sequence)) {
        this.database
          .prepare(
            `UPDATE sessions
             SET last_sequence = ?, total_points = ?, point_batches = ?,
                 last_seen_at = COALESCE(?, last_seen_at)
             WHERE session_id = ?`,
          )
          .run(lastSequence, totalPoints, pointBatches, lastSeenAt ?? null, sessionId);
      }
      this.checkpointSession(sessionId);
    }

    for (const entry of listLogFiles(this.logsDir)) {
      if (!known.has(entry)) {
        this.log(`Batch log for unknown session ${entry} left untouched`);
      }
    }
  }

  // Every chunk a payload's points land in under `pose`; throws past `limit` chunks.
  private chunkKeysForPayload(payload: Buffer, pose: Pose, limit = Number.POSITIVE_INFINITY): Set<string> {
    const [tx, ty, tz] = pose.translation_m;
    const [qx, qy, qz, qw] = pose.rotation_xyzw;
    const chunks = new Set<string>();
    for (let offset = 0; offset < payload.byteLength; offset += POINT_STRIDE_BYTES) {
      const [worldX, worldY, worldZ] = rotateAndTranslate(
        payload.readFloatLE(offset),
        payload.readFloatLE(offset + 4),
        payload.readFloatLE(offset + 8),
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
      if (chunks.size > limit) {
        throw new Error(
          `Batch touches more than the configured ${limit} chunk limit`,
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

  private sessionLog(sessionId: string): SessionLogState {
    let state = this.sessionLogs.get(sessionId);
    if (!state) {
      state = { endOffset: 0, checkpointOffset: 0 };
      this.sessionLogs.set(sessionId, state);
    }
    return state;
  }

  // Return the resident chunk for a cell, creating it (and seeding it from any
  // existing file so fusion continues from prior state) on first touch.
  private activateChunk(
    sessionId: string,
    chunkKey: string,
    chunkX: number,
    chunkY: number,
    chunkZ: number,
  ): ActiveChunk {
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
      appliedSequence: 0,
      stats: this.registerCell(sessionId, chunkKey, chunkX, chunkY, chunkZ).stats,
    };
    this.seedFromDisk(active);
    this.activeChunks.set(dirtyKey, active);
    return active;
  }

  // Load a previously-flushed chunk back into voxel accumulators: exact sums from the
  // .acc sidecar when present, else representatives from the .bin at n=1 each.
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
        o0: active.stats.opportunities,
      });
    }
  }

  private seedAccumulatorsFromDisk(active: ActiveChunk): boolean {
    const loaded = this.loadAccumulators(active.accumulatorPath, active.stats, active.chunkKey);
    if (!loaded) {
      return false;
    }
    active.appliedSequence = loaded.appliedSequence;
    active.voxels = loaded.voxels;
    return true;
  }

  // Read an .acc sidecar into accumulators. Version 1 records lack the opportunity
  // baseline; they are given one that makes their ratio 1 (fully observed).
  private loadAccumulators(
    accumulatorPath: string,
    stats: ChunkStats,
    chunkKey: string,
  ): { voxels: Map<string, VoxelAccumulator>; appliedSequence: number } | null {
    let data: Buffer;
    try {
      data = fs.readFileSync(accumulatorPath);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
    let offset = 0;
    let appliedSequence = 0;
    let version = 1;
    if (data.byteLength >= ACCUMULATOR_HEADER_BYTES && data.readUInt32LE(0) === ACCUMULATOR_MAGIC) {
      version = data.readUInt32LE(4);
      appliedSequence = data.readDoubleLE(8);
      offset = ACCUMULATOR_HEADER_BYTES;
    }
    const stride = version >= 2 ? ACCUMULATOR_STRIDE_BYTES : ACCUMULATOR_V1_STRIDE_BYTES;
    if ((data.byteLength - offset) % stride !== 0) {
      throw new Error(`Invalid accumulator file length for ${chunkKey}`);
    }
    const voxels = new Map<string, VoxelAccumulator>();
    for (; offset < data.byteLength; offset += stride) {
      const n = data.readDoubleLE(offset + 56);
      if (n === 0) {
        throw new Error(`Accumulator with zero samples in ${chunkKey}`);
      }
      const acc: VoxelAccumulator = {
        sx: data.readDoubleLE(offset),
        sy: data.readDoubleLE(offset + 8),
        sz: data.readDoubleLE(offset + 16),
        sr: data.readDoubleLE(offset + 24),
        sg: data.readDoubleLE(offset + 32),
        sb: data.readDoubleLE(offset + 40),
        si: data.readDoubleLE(offset + 48),
        n,
        o0: version >= 2 ? data.readDoubleLE(offset + 64) : Math.max(0, stats.opportunities - n + 1),
      };
      voxels.set(voxelKey(acc.sx / acc.n, acc.sy / acc.n, acc.sz / acc.n, this.fuseVoxelMeters), acc);
    }
    return { voxels, appliedSequence };
  }

  // Overwrite a chunk's files with its current voxel state (atomic replace of both
  // the .bin representatives and the .acc sums) and upsert its metadata. The chunk
  // stays resident so fusion continues in place.
  private persistChunk(active: ActiveChunk): void {
    active.pointsSinceFlush = 0;
    if (active.voxels.size === 0) {
      return;
    }

    const serialized = serializeVoxels(active.voxels, active.appliedSequence);
    active.stats.dirty = false;
    fs.mkdirSync(path.dirname(active.filePath), { recursive: true });
    writeFileAtomically(active.accumulatorPath, serialized.accumulatorBuffer);
    writeFileAtomically(active.filePath, serialized.buffer);

    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO chunks (
          session_id, chunk_key, chunk_x, chunk_y, chunk_z, file_path,
          point_count, batch_count, bytes, applied_sequence, opportunities, fov_sequence,
          min_x, min_y, min_z, max_x, max_y, max_z, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, chunk_key) DO UPDATE SET
          file_path = excluded.file_path,
          point_count = excluded.point_count,
          batch_count = chunks.batch_count + 1,
          bytes = excluded.bytes,
          applied_sequence = excluded.applied_sequence,
          opportunities = excluded.opportunities,
          fov_sequence = excluded.fov_sequence,
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
        active.appliedSequence,
        active.stats.opportunities,
        active.stats.fovSequence,
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
}

function encodeChunkKey(chunkX: number, chunkY: number, chunkZ: number): string {
  return `${chunkX}_${chunkY}_${chunkZ}`;
}

function voxelKey(x: number, y: number, z: number, size: number): string {
  return `${Math.floor(x / size)}_${Math.floor(y / size)}_${Math.floor(z / size)}`;
}

// Encode a voxel set to the wire 18-byte point format only (one representative per
// voxel, the component mean). This is the serving path; it skips the sidecar.
function serializeRepresentatives(voxels: Map<string, VoxelAccumulator>): Buffer {
  const buffer = Buffer.allocUnsafe(voxels.size * POINT_STRIDE_BYTES);
  let offset = 0;
  for (const acc of voxels.values()) {
    writeRepresentative(buffer, offset, acc);
    offset += POINT_STRIDE_BYTES;
  }
  return buffer;
}

// Encode a voxel set to both on-disk forms — the 18-byte representatives and the
// exact accumulator sidecar — and compute its world-frame bounds in one pass.
function serializeVoxels(voxels: Map<string, VoxelAccumulator>, appliedSequence: number): SerializedVoxels {
  const buffer = Buffer.allocUnsafe(voxels.size * POINT_STRIDE_BYTES);
  const accumulatorBuffer = Buffer.allocUnsafe(
    ACCUMULATOR_HEADER_BYTES + voxels.size * ACCUMULATOR_STRIDE_BYTES,
  );
  accumulatorBuffer.writeUInt32LE(ACCUMULATOR_MAGIC, 0);
  accumulatorBuffer.writeUInt32LE(ACCUMULATOR_VERSION, 4);
  accumulatorBuffer.writeDoubleLE(appliedSequence, 8);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  let offset = 0;
  let accumulatorOffset = ACCUMULATOR_HEADER_BYTES;
  for (const acc of voxels.values()) {
    const [x, y, z] = writeRepresentative(buffer, offset, acc);
    accumulatorBuffer.writeDoubleLE(acc.sx, accumulatorOffset);
    accumulatorBuffer.writeDoubleLE(acc.sy, accumulatorOffset + 8);
    accumulatorBuffer.writeDoubleLE(acc.sz, accumulatorOffset + 16);
    accumulatorBuffer.writeDoubleLE(acc.sr, accumulatorOffset + 24);
    accumulatorBuffer.writeDoubleLE(acc.sg, accumulatorOffset + 32);
    accumulatorBuffer.writeDoubleLE(acc.sb, accumulatorOffset + 40);
    accumulatorBuffer.writeDoubleLE(acc.si, accumulatorOffset + 48);
    accumulatorBuffer.writeDoubleLE(acc.n, accumulatorOffset + 56);
    accumulatorBuffer.writeDoubleLE(acc.o0, accumulatorOffset + 64);

    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;

    offset += POINT_STRIDE_BYTES;
    accumulatorOffset += ACCUMULATOR_STRIDE_BYTES;
  }

  return { buffer, accumulatorBuffer, minX, minY, minZ, maxX, maxY, maxZ };
}

function writeRepresentative(
  buffer: Buffer,
  offset: number,
  acc: VoxelAccumulator,
): [number, number, number] {
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
  return [x, y, z];
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
      acc = { sx: 0, sy: 0, sz: 0, sr: 0, sg: 0, sb: 0, si: 0, n: 0, o0: 0 };
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

function syncDirectory(directoryPath: string): void {
  const descriptor = fs.openSync(directoryPath, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

// A log record's points in the internal layout, whatever format the publisher used.
function internalPoints(record: LogRecord): Buffer {
  return toInternalPoints(record.payload, record.header.point_format ?? POINT_FORMAT);
}

function isFilterActive(filter?: ObservationFilter): boolean {
  return !!filter && (filter.minHits > 1 || filter.minRatio > 0);
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function removeIfPresent(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

function listLogFiles(directoryPath: string): string[] {
  try {
    return fs
      .readdirSync(directoryPath)
      .filter((name) => name.endsWith('.log'))
      .map((name) => name.slice(0, -'.log'.length));
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
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
