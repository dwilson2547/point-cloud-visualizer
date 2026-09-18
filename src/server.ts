import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';

import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import {
  INGEST_ROLE,
  POINT_FORMAT,
  POINT_STRIDE_BYTES,
  PROTOCOL_VERSION,
  VIEWER_ROLE,
  makeError,
  parseClientMessage,
  type ChunkBootstrapMessage,
  type ChunkDeltaMessage,
  type ChunkDropMessage,
  type ChunkLodMessage,
  type ChunkUpdateMessage,
  type ConnectionRole,
  type PointBatchHeaderMessage,
  type Pose,
  type ServerMessage,
  type ViewerJoinMessage,
  type ViewerViewMessage,
} from './protocol.js';
import { ChunkStore, DurableBatchError, type ObservationFilter, type RebuildResult } from './chunk-store.js';
import { validatePoseCorrections } from './pose-corrections.js';
import { SessionStore } from './session-store.js';
import {
  buildFrustum,
  selectChunkLevel,
  type Aabb,
  type Frustum,
  type LodLadder,
  type ViewCamera,
} from './lod-select.js';

interface ConnectionState {
  role: ConnectionRole;
  sessionId?: string;
  publisherId?: string;
  pendingBatchHeader?: PointBatchHeaderMessage;
  // Viewer-only, LOD mode (connected with ?lod=1): the level currently sent for each
  // chunk_key (so a view update sends just the diffs) and the last frustum (so live
  // refresh can re-evaluate a changed chunk against this viewer's current camera).
  lodMode?: boolean;
  sent?: Map<string, SentChunk>;
  frustum?: Frustum;
  lastViewAt?: number;
  filter?: ObservationFilter;
}

// What an LOD viewer holds for one chunk: the level, the chunk version (fine voxel
// count) its content reflects, how many points it has, and the version at its last
// keyframe (a chunk that doubles since then gets a fresh keyframe so early voxel
// means, which move most, are re-sent).
interface SentChunk {
  level: number;
  version: number;
  count: number;
  keyframeVersion: number;
}

class StorageOperationError extends Error {
  constructor(message: string, options: ErrorOptions) {
    super(message, options);
    this.name = 'StorageOperationError';
  }
}

type ChunkCell = { chunkKey: string; chunkX: number; chunkY: number; chunkZ: number };

const port = parseIntegerEnv(process.env.PORT, 8080);
const maxPointsPerBatch = parseIntegerEnv(process.env.MAX_POINTS_PER_BATCH, 1_000_000);
const maxViewerBufferedBytes = parseIntegerEnv(process.env.MAX_VIEWER_BUFFERED_BYTES, 32 * 1024 * 1024);
const maxRetainedPoses = parseIntegerEnv(process.env.MAX_RETAINED_POSES, 64);
const chunkStore = new ChunkStore({
  rootDir: path.resolve(process.env.DATA_DIR ?? 'data'),
  chunkSizeMeters: parseFloatEnv(process.env.CHUNK_SIZE_METERS, 2),
  fuseVoxelMeters: parseFloatEnv(process.env.FUSE_VOXEL_METERS, 0.04),
  numLevels: parseIntegerEnv(process.env.LOD_LEVELS, 6),
  flushPointThreshold: parseIntegerEnv(process.env.FLUSH_POINT_THRESHOLD, 50_000),
  maxDirtyChunks: parseIntegerEnv(process.env.MAX_DIRTY_CHUNKS, 128),
  maxChunksPerBatch: parseIntegerEnv(process.env.MAX_CHUNKS_PER_BATCH, 128),
  refuseToleranceM: process.env.REFUSE_TOLERANCE_M ? parseFloatEnv(process.env.REFUSE_TOLERANCE_M, 0.02) : undefined,
  sensorFov: {
    elevationMinDeg: parseSignedFloatEnv(process.env.SENSOR_ELEVATION_MIN_DEG, -15),
    elevationMaxDeg: parseSignedFloatEnv(process.env.SENSOR_ELEVATION_MAX_DEG, 15),
    maxRangeM: parseFloatEnv(process.env.SENSOR_MAX_RANGE_M, 100),
  },
});
const sessionStore = new SessionStore({ maxPointsPerBatch, maxRetainedPoses });
sessionStore.restoreSessions(chunkStore.loadSessions());
const viewerSockets = new Map<string, Set<WebSocket>>();
const publisherSockets = new Map<string, WebSocket>();
// Per-viewer connection state, so the live-refresh tick can reach each LOD viewer's
// frustum + sent levels (the ws Set above only tracks membership).
const viewerStates = new Map<WebSocket, ConnectionState>();
// Chunk keys changed by ingest since the last refresh tick, per session. Coalesces a
// burst of batches into one re-send per chunk per tick.
const dirtyChunksBySession = new Map<string, Set<string>>();
const liveRefreshMs = parseIntegerEnv(process.env.LIVE_REFRESH_MS, 250);
// Incremental checkpoint: every tick, rewrite at most this many dirty chunk files so
// the replay-on-restart window stays short without ever stalling ingest for a full
// cache rewrite (see docs/batch-log.md).
const checkpointTickMs = parseIntegerEnv(process.env.CHECKPOINT_TICK_MS, 1000);
const checkpointChunksPerTick = parseIntegerEnv(process.env.CHECKPOINT_CHUNKS_PER_TICK, 8);
let shuttingDown = false;
const maxPayloadBytes = Math.max(64 * 1024, maxPointsPerBatch * POINT_STRIDE_BYTES);
const ingestWss = new WebSocketServer({ noServer: true, maxPayload: maxPayloadBytes });
const viewerWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

// Static viewer assets live in <project>/public; resolve relative to this module
// so it works from both src/ (tsx) and dist/ (built).
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.writeHead(400).end('Missing URL');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
        pointFormat: POINT_FORMAT,
        pointStrideBytes: POINT_STRIDE_BYTES,
        sessions: sessionStore.getSessionCount(),
        storage: chunkStore.getStorageSummary(),
      }),
    );
    return;
  }

  if (url.pathname === '/storage') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(chunkStore.getStorageSummary()));
    return;
  }

  if (url.pathname === '/sessions') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        sessionStore.listSessions().map((session) => ({
          sessionId: session.sessionId,
          publisherId: session.publisherId,
          startedAt: session.startedAt,
          lastSeenAt: session.lastSeenAt,
          closed: session.closed,
          totalPoints: session.totalPoints,
          pointBatches: session.pointBatches,
          lastSequence: session.lastSequence,
          lastPoseSequence: session.lastPoseSequence,
          log: chunkStore.getSessionLogSummary(session.sessionId),
        })),
      ),
    );
    return;
  }

  const chunkPathMatch = url.pathname.match(/^\/sessions\/([^/]+)\/chunks$/);
  if (chunkPathMatch) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(chunkStore.listSessionChunks(decodeURIComponent(chunkPathMatch[1]))));
    return;
  }

  const sessionResourceMatch = url.pathname.match(/^\/sessions\/([^/]+)\/(log|pose-corrections|rebuild)$/);
  if (sessionResourceMatch) {
    void handleSessionResource(
      req,
      res,
      decodeURIComponent(sessionResourceMatch[1]),
      sessionResourceMatch[2] as 'log' | 'pose-corrections' | 'rebuild',
    );
    return;
  }

  if (serveStatic(req, res, url.pathname)) {
    return;
  }

  res.writeHead(404).end('Not found');
});

// Alignment-facing HTTP surface (see docs/alignment.md):
//   GET    /sessions/:id/log               the raw batch log, for the sidecar
//   GET    /sessions/:id/pose-corrections  the installed corrections, if any
//   PUT    /sessions/:id/pose-corrections  install corrections and rebuild the session
//   DELETE /sessions/:id/pose-corrections  remove corrections and rebuild from raw poses
//   POST   /sessions/:id/rebuild           re-fuse from the log under current poses
async function handleSessionResource(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: string,
  resource: 'log' | 'pose-corrections' | 'rebuild',
): Promise<void> {
  if (!sessionStore.hasSession(sessionId)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `Unknown session ${sessionId}` }));
    return;
  }
  try {
    if (resource === 'log' && req.method === 'GET') {
      const logPath = chunkStore.sessionLogPath(sessionId);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(logPath);
      } catch {
        res.writeHead(404).end('No batch log for this session');
        return;
      }
      // `Range: bytes=N-` lets the alignment sidecar fetch only what was appended
      // since its last pass. The end is pinned at the size seen here, so a record
      // appended mid-stream is not half-read.
      const range = req.headers.range?.match(/^bytes=(\d+)-$/);
      const start = range ? Number(range[1]) : 0;
      if (start > stat.size || (range && start === stat.size)) {
        res.writeHead(416, { 'content-range': `bytes */${stat.size}` }).end();
        return;
      }
      res.writeHead(range ? 206 : 200, {
        'content-type': 'application/octet-stream',
        'content-length': stat.size - start,
        'accept-ranges': 'bytes',
        ...(range ? { 'content-range': `bytes ${start}-${stat.size - 1}/${stat.size}` } : {}),
      });
      if (stat.size === start) {
        res.end();
        return;
      }
      fs.createReadStream(logPath, { start, end: stat.size - 1 }).pipe(res);
      return;
    }
    if (resource === 'pose-corrections' && req.method === 'GET') {
      const corrections = chunkStore.getPoseCorrections(sessionId);
      res.writeHead(corrections ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(corrections ?? { error: 'No pose corrections installed' }));
      return;
    }
    let rebuilt: RebuildResult;
    if (resource === 'pose-corrections' && req.method === 'PUT') {
      const body = await readJsonBody(req, 64 * 1024 * 1024);
      const corrections = validatePoseCorrections(body, sessionId);
      rebuilt = chunkStore.setPoseCorrections(sessionId, corrections);
    } else if (resource === 'pose-corrections' && req.method === 'DELETE') {
      rebuilt = chunkStore.setPoseCorrections(sessionId, null);
    } else if (resource === 'rebuild' && req.method === 'POST') {
      rebuilt = chunkStore.rebuildSession(sessionId);
    } else {
      res.writeHead(405).end('Method not allowed');
      return;
    }
    notifySessionRebuilt(sessionId, rebuilt);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ session_id: sessionId, ...rebuilt }));
  } catch (error) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: getErrorMessage(error) }));
  }
}

function readJsonBody(req: http.IncomingMessage, limitBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.byteLength;
      if (received > limitBytes) {
        reject(new Error(`Request body exceeds ${limitBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

// After a rebuild every viewer of the session holds stale data: tell them to clear,
// forget what was sent to LOD viewers, and mark every chunk dirty so the refresh tick
// re-sends the visible base layer against each viewer's current camera.
function notifySessionRebuilt(sessionId: string, rebuilt: RebuildResult): void {
  const viewers = viewerSockets.get(sessionId);
  if (viewers) {
    for (const ws of viewers) {
      viewerStates.get(ws)?.sent?.clear();
      send(ws, { type: 'session_rebuilt', session_id: sessionId, ...rebuilt });
    }
  }
  markChunksDirty(
    sessionId,
    chunkStore.listSessionChunkKeys(sessionId).map((cell) => cell.chunkKey),
  );
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return false;
  }
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.replace(/^\/+/, ''));
  const filePath = path.resolve(publicDir, relative);
  // Path-traversal guard: the resolved path must stay inside publicDir.
  if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
    return false;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) {
    return false;
  }
  const contentType = STATIC_CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': contentType, 'content-length': stat.size });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(filePath).pipe(res);
  return true;
}

server.on('upgrade', (req, socket, head) => {
  if (!req.url) {
    socket.destroy();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname === '/ws/ingest') {
    ingestWss.handleUpgrade(req, socket, head, (ws) => {
      configureIngestSocket(ws);
    });
    return;
  }

  if (url.pathname === '/ws/view') {
    const lodMode = url.searchParams.get('lod') === '1';
    viewerWss.handleUpgrade(req, socket, head, (ws) => {
      configureViewerSocket(ws, url.searchParams.get('session_id') ?? undefined, lodMode);
    });
    return;
  }

  socket.destroy();
});

function configureIngestSocket(ws: WebSocket): void {
  const state: ConnectionState = { role: INGEST_ROLE };
  ws.on('error', (error) => {
    console.error(`Ingest WebSocket error: ${error.message}`);
  });

  ws.on('message', (data, isBinary) => {
    if (shuttingDown) {
      return;
    }
    try {
      if (isBinary) {
        handlePointBatchBinary(ws, state, data);
        return;
      }
      handleIngestText(ws, state, data.toString());
    } catch (error) {
      if (error instanceof DurableBatchError || error instanceof StorageOperationError) {
        failFastOnStorageError(ws, error);
        return;
      }
      send(ws, makeError('protocol_error', getErrorMessage(error), true, state.sessionId));
    }
  });
  ws.on('close', () => {
    if (state.sessionId && publisherSockets.get(state.sessionId) === ws) {
      publisherSockets.delete(state.sessionId);
    }
  });
}

function handleIngestText(ws: WebSocket, state: ConnectionState, payload: string): void {
  const message = parseClientMessage(payload);

  switch (message.type) {
    case 'create_session': {
      requireUnboundPublisher(state);
      const session = sessionStore.createSession(message);
      runStorageOperation('persist created session', () => chunkStore.syncSession(session));
      state.sessionId = session.sessionId;
      state.publisherId = session.publisherId;
      publisherSockets.set(session.sessionId, ws);
      send(ws, {
        type: 'session_ack',
        session_id: session.sessionId,
        accepted: true,
        server_sequence: session.lastSequence,
        resume_from_sequence: session.lastSequence + 1,
        viewer_endpoint: `/ws/view?session_id=${encodeURIComponent(session.sessionId)}`,
      });
      return;
    }
    case 'resume_session': {
      requireUnboundPublisher(state);
      if (publisherSockets.has(message.session_id)) {
        throw new Error(`Session ${message.session_id} already has an active publisher`);
      }
      const session = sessionStore.resumeSession(message);
      runStorageOperation('persist resumed session', () => chunkStore.syncSession(session));
      state.sessionId = session.sessionId;
      state.publisherId = session.publisherId;
      publisherSockets.set(session.sessionId, ws);
      send(ws, {
        type: 'session_ack',
        session_id: session.sessionId,
        accepted: true,
        server_sequence: session.lastSequence,
        resume_from_sequence: session.lastSequence + 1,
        viewer_endpoint: `/ws/view?session_id=${encodeURIComponent(session.sessionId)}`,
      });
      return;
    }
    case 'pose_update': {
      requireBoundPublisher(state, message.session_id, message.publisher_id);
      const session = sessionStore.applyPoseUpdate(message);
      runStorageOperation('persist pose sequence', () => chunkStore.syncSession(session));
      state.sessionId = message.session_id;
      state.publisherId = message.publisher_id;
      return;
    }
    case 'point_batch_header': {
      requireBoundPublisher(state, message.session_id, message.publisher_id);
      if (state.pendingBatchHeader) {
        throw new Error('Received point_batch_header while previous batch is still pending');
      }
      if (message.point_format !== POINT_FORMAT) {
        throw new Error(`Unsupported point format ${message.point_format}`);
      }
      if (message.encoding !== 'binary_le' || message.compression !== 'none') {
        throw new Error('Unsupported batch encoding or compression');
      }
      state.sessionId = message.session_id;
      state.publisherId = message.publisher_id;
      state.pendingBatchHeader = message;
      return;
    }
    case 'close_session': {
      requireBoundPublisher(state, message.session_id, message.publisher_id);
      const session = sessionStore.closeSession(message.session_id, message.publisher_id, message.sequence);
      runStorageOperation('persist closed session', () => {
        chunkStore.flushSession(message.session_id);
        chunkStore.syncSession(session);
      });
      state.pendingBatchHeader = undefined;
      return;
    }
    case 'viewer_join':
      throw new Error('viewer_join is only valid on /ws/view');
  }
}

function handlePointBatchBinary(ws: WebSocket, state: ConnectionState, data: RawData): void {
  if (!state.pendingBatchHeader) {
    throw new Error('Received binary payload without a preceding point_batch_header');
  }

  const payload = normalizeRawData(data);
  const { header } = { header: state.pendingBatchHeader };
  state.pendingBatchHeader = undefined;
  const accepted = sessionStore.preparePointBatch(header, payload);
  const nextSession = {
    ...accepted.session,
    pointBatches: accepted.session.pointBatches + 1,
    totalPoints: accepted.session.totalPoints + accepted.header.point_count,
    lastSequence: accepted.header.sequence,
    lastSeenAt: accepted.header.timestamp,
  };
  const { touchedKeys, pose } = chunkStore.storeAcceptedBatchDurably(accepted, nextSession);
  sessionStore.commitPointBatch(accepted);
  markChunksDirty(accepted.session.sessionId, touchedKeys);

  send(ws, {
    type: 'point_batch_ack',
    session_id: accepted.session.sessionId,
    sequence: accepted.header.sequence,
    accepted_points: accepted.header.point_count,
    rejected_points: 0,
  });

  // Viewers place the live overlay with the pose the batch was actually fused with,
  // which differs from the publisher's when pose corrections are installed.
  broadcastChunkUpdate(accepted.header, accepted.payload, pose);
}

function configureViewerSocket(ws: WebSocket, sessionIdFromQuery?: string, lodMode = false): void {
  const state: ConnectionState = { role: VIEWER_ROLE, lodMode, sent: new Map() };
  viewerStates.set(ws, state);
  ws.on('error', (error) => {
    console.error(`Viewer WebSocket error: ${error.message}`);
  });

  ws.on('message', (data, isBinary) => {
    if (shuttingDown) {
      return;
    }
    try {
      if (isBinary) {
        throw new Error('Viewer endpoint does not accept binary client messages');
      }
      const message = parseClientMessage(data.toString());
      if (message.type === 'viewer_join') {
        attachViewer(ws, state, message);
        return;
      }
      if (message.type === 'viewer_view') {
        onViewerView(ws, state, message);
        return;
      }
      throw new Error('Viewer endpoint expects viewer_join or viewer_view');
    } catch (error) {
      send(ws, makeError('protocol_error', getErrorMessage(error), false, state.sessionId));
    }
  });

  ws.on('close', () => {
    viewerStates.delete(ws);
    detachViewer(ws, state.sessionId);
  });

  if (sessionIdFromQuery) {
    try {
      attachViewer(ws, state, {
        type: 'viewer_join',
        session_id: sessionIdFromQuery,
      });
    } catch (error) {
      // An unknown session must not take the server down: tell the viewer and close.
      send(ws, makeError('unknown_session', getErrorMessage(error), true, sessionIdFromQuery));
      ws.close(1008, getErrorMessage(error));
    }
  }
}

function attachViewer(ws: WebSocket, state: ConnectionState, message: ViewerJoinMessage): void {
  if (state.sessionId && state.sessionId !== message.session_id) {
    detachViewer(ws, state.sessionId);
    state.sent?.clear();
    state.frustum = undefined;
  }
  state.sessionId = message.session_id;
  let viewers = viewerSockets.get(message.session_id);
  if (!viewers) {
    viewers = new Set();
    viewerSockets.set(message.session_id, viewers);
  }
  viewers.add(ws);

  send(ws, sessionStore.getSessionState(message.session_id));
  // LOD-mode viewers get their base layer from view-driven chunk_lod messages (once
  // they send viewer_view) instead of the full cloud, so skip the bootstrap here. Plain
  // viewers still get the whole accumulated world up front.
  if (state.lodMode) {
    return;
  }
  for (const worldPoints of chunkStore.iterateSessionWorldChunks(message.session_id)) {
    if (!sendChunkBootstrap(ws, message.session_id, worldPoints)) {
      break;
    }
  }
}

function detachViewer(ws: WebSocket, sessionId?: string): void {
  if (!sessionId) {
    return;
  }
  const viewers = viewerSockets.get(sessionId);
  if (!viewers) {
    return;
  }
  viewers.delete(ws);
  if (viewers.size === 0) {
    viewerSockets.delete(sessionId);
  }
}

function broadcastChunkUpdate(header: PointBatchHeaderMessage, payload: Buffer, pose: Pose): void {
  const viewers = viewerSockets.get(header.session_id);
  if (!viewers) {
    return;
  }
  for (const viewer of viewers) {
    if (viewer.readyState === viewer.OPEN) {
      sendChunkUpdate(viewer, header, payload, pose);
    }
  }
}

function sendChunkUpdate(
  ws: WebSocket,
  header: PointBatchHeaderMessage,
  payload: Buffer,
  pose: Pose,
): boolean {
  const message: ChunkUpdateMessage = {
    type: 'chunk_update',
    session_id: header.session_id,
    sequence: header.sequence,
    pose_sequence: header.pose_sequence,
    point_count: header.point_count,
    point_format: header.point_format,
    stride_bytes: header.stride_bytes,
    timestamp: header.timestamp,
    pose,
  };
  return sendPair(ws, message, payload);
}

function sendChunkBootstrap(ws: WebSocket, sessionId: string, worldPoints: Buffer): boolean {
  const message: ChunkBootstrapMessage = {
    type: 'chunk_bootstrap',
    session_id: sessionId,
    point_count: worldPoints.byteLength / POINT_STRIDE_BYTES,
    point_format: POINT_FORMAT,
    stride_bytes: POINT_STRIDE_BYTES,
  };
  return sendPair(ws, message, worldPoints);
}

// Recompute the LOD base layer for a viewer against its latest camera: for each chunk
// cell, cull or pick a level, and send only the diffs — a chunk_lod when its level
// changed (or it is newly visible) and a chunk_drop when it left the view.
function onViewerView(ws: WebSocket, state: ConnectionState, message: ViewerViewMessage): void {
  if (!state.lodMode) {
    throw new Error('viewer_view requires an LOD-mode connection');
  }
  if (state.sessionId && state.sessionId !== message.session_id) {
    throw new Error('viewer_view session_id does not match the joined session');
  }
  const now = Date.now();
  if (state.lastViewAt !== undefined && now - state.lastViewAt < 100) {
    return;
  }
  state.lastViewAt = now;
  state.sessionId = message.session_id;
  const sent = state.sent ?? (state.sent = new Map());
  const frustum = buildFrustum(toViewCamera(message));
  state.frustum = frustum; // remembered so live refresh can re-evaluate changed chunks
  const filter = toObservationFilter(message);
  if (!sameFilter(filter, state.filter)) {
    // A different filter changes every chunk's content: forget what was sent so the
    // loop below re-sends (or drops) each visible chunk.
    state.filter = filter;
    sent.clear();
  }

  const visible = new Set<string>();
  for (const cell of chunkStore.listSessionChunkKeys(message.session_id)) {
    const level = selectChunkLevel(cellAabb(cell), frustum, currentLadder());
    if (level === null) {
      continue; // culled
    }
    visible.add(cell.chunkKey);
    if (sent.get(cell.chunkKey)?.level === level) {
      continue; // already at this level — no re-send on a camera nudge
    }
    sendChunkKeyframe(ws, message.session_id, cell.chunkKey, level, sent, state.filter);
  }

  for (const chunkKey of [...sent.keys()]) {
    if (!visible.has(chunkKey)) {
      sendChunkDrop(ws, message.session_id, chunkKey);
      sent.delete(chunkKey);
    }
  }
}

// Record chunk keys a batch changed so the next refresh tick re-sends them to viewers.
function markChunksDirty(sessionId: string, chunkKeys: string[]): void {
  if (chunkKeys.length === 0) {
    return;
  }
  let dirty = dirtyChunksBySession.get(sessionId);
  if (!dirty) {
    dirty = new Set();
    dirtyChunksBySession.set(sessionId, dirty);
  }
  for (const key of chunkKeys) {
    dirty.add(key);
  }
}

// Periodic pass: for each session with changed chunks, re-send those chunks to every
// LOD viewer at the level its current camera calls for (unlike a camera-driven update,
// a live-dirty chunk is re-sent even when its level is unchanged, because its point data
// grew). Newly-visible changed chunks are picked up here too; ones that left the view
// are dropped. This is what makes the base cloud grow without needing camera motion.
function refreshLiveBases(): void {
  for (const [sessionId, dirty] of dirtyChunksBySession) {
    if (dirty.size === 0) {
      continue;
    }
    const viewers = viewerSockets.get(sessionId);
    if (viewers && viewers.size > 0) {
      const cells = new Map<string, ChunkCell>(
        chunkStore.listSessionChunkKeys(sessionId).map((cell) => [cell.chunkKey, cell]),
      );
      for (const ws of viewers) {
        const state = viewerStates.get(ws);
        if (!state?.lodMode || !state.frustum || ws.readyState !== ws.OPEN) {
          continue;
        }
        for (const chunkKey of dirty) {
          const cell = cells.get(chunkKey);
          if (cell) {
            refreshChunkForViewer(ws, state, sessionId, cell);
          }
        }
      }
    }
    dirty.clear();
  }
}

// Re-evaluate one changed chunk against a viewer's current frustum: drop it if it left
// the view, send a keyframe if the level changed or the viewer holds nothing, else
// send just the voxels added since the viewer's version.
function refreshChunkForViewer(
  ws: WebSocket,
  state: ConnectionState,
  sessionId: string,
  cell: ChunkCell,
): void {
  const sent = state.sent ?? (state.sent = new Map());
  const level = selectChunkLevel(cellAabb(cell), state.frustum!, currentLadder());
  if (level === null) {
    if (sent.has(cell.chunkKey)) {
      sendChunkDrop(ws, sessionId, cell.chunkKey);
      sent.delete(cell.chunkKey);
    }
    return;
  }
  const held = sent.get(cell.chunkKey);
  if (!held || held.level !== level) {
    sendChunkKeyframe(ws, sessionId, cell.chunkKey, level, sent, state.filter);
    return;
  }
  const delta = chunkStore.deriveChunk(sessionId, cell.chunkKey, level, state.filter, held.version);
  const added = delta.points.byteLength / POINT_STRIDE_BYTES;
  const diverged = delta.total !== held.count + added;
  const settled = delta.version >= 2 * Math.max(held.keyframeVersion, 1);
  if (diverged || settled) {
    sendChunkKeyframe(ws, sessionId, cell.chunkKey, level, sent, state.filter);
    return;
  }
  if (added === 0) {
    held.version = delta.version;
    return;
  }
  const message: ChunkDeltaMessage = {
    type: 'chunk_delta',
    session_id: sessionId,
    chunk_key: cell.chunkKey,
    level,
    version: delta.version,
    point_count: added,
    point_format: POINT_FORMAT,
    stride_bytes: POINT_STRIDE_BYTES,
  };
  if (sendPair(ws, message, delta.points)) {
    held.version = delta.version;
    held.count = delta.total;
  }
}

function currentLadder(): LodLadder {
  return { fuseVoxelMeters: chunkStore.fuseVoxelMeters, numLevels: chunkStore.numLevels };
}

function cellAabb(cell: ChunkCell): Aabb {
  const size = chunkStore.chunkSizeMeters;
  return {
    min: [cell.chunkX * size, cell.chunkY * size, cell.chunkZ * size],
    max: [(cell.chunkX + 1) * size, (cell.chunkY + 1) * size, (cell.chunkZ + 1) * size],
  };
}

// Derive a chunk in full at a level and send it as a keyframe, recording what the
// viewer now holds. An empty derivation drops the chunk from the viewer instead.
function sendChunkKeyframe(
  ws: WebSocket,
  sessionId: string,
  chunkKey: string,
  level: number,
  sent: Map<string, SentChunk>,
  filter?: ObservationFilter,
): void {
  const full = chunkStore.deriveChunk(sessionId, chunkKey, level, filter);
  if (full.points.byteLength === 0) {
    // Nothing passes (an empty chunk, or the filter removed everything): make sure
    // the viewer is not left showing a stale version.
    if (sent.has(chunkKey)) {
      sendChunkDrop(ws, sessionId, chunkKey);
      sent.delete(chunkKey);
    }
    return;
  }
  if (sendChunkLod(ws, sessionId, chunkKey, level, full.version, full.points)) {
    sent.set(chunkKey, { level, version: full.version, count: full.total, keyframeVersion: full.version });
  }
}

function toObservationFilter(message: ViewerViewMessage): ObservationFilter | undefined {
  const raw = message.filter;
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'object') {
    throw new Error('viewer_view filter must be an object');
  }
  const minHits = raw.min_hits ?? 1;
  const minRatio = raw.min_ratio ?? 0;
  if (!Number.isInteger(minHits) || minHits < 1 || minHits > 1_000_000) {
    throw new Error('viewer_view filter.min_hits must be an integer >= 1');
  }
  if (!Number.isFinite(minRatio) || minRatio < 0 || minRatio > 1) {
    throw new Error('viewer_view filter.min_ratio must be within [0, 1]');
  }
  if (minHits === 1 && minRatio === 0) {
    return undefined;
  }
  return { minHits, minRatio };
}

function sameFilter(a?: ObservationFilter, b?: ObservationFilter): boolean {
  if (!a || !b) {
    return !a && !b;
  }
  return a.minHits === b.minHits && a.minRatio === b.minRatio;
}

function toViewCamera(message: ViewerViewMessage): ViewCamera {
  const isVec3 = (v: unknown): v is [number, number, number] =>
    Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n));
  if (!isVec3(message.position) || !isVec3(message.forward) || !isVec3(message.up)) {
    throw new Error('viewer_view requires finite [x,y,z] position, forward, and up');
  }
  if (
    !Array.isArray(message.viewport_px) ||
    message.viewport_px.length !== 2 ||
    !message.viewport_px.every((n) => Number.isFinite(n))
  ) {
    throw new Error('viewer_view requires a finite viewport_px [width, height]');
  }
  if (![message.fov_y_rad, message.near_m, message.far_m].every((n) => Number.isFinite(n))) {
    throw new Error('viewer_view requires finite fov_y_rad, near_m, and far_m');
  }
  if (Math.hypot(...message.forward) < 1e-9 || Math.hypot(...message.up) < 1e-9) {
    throw new Error('viewer_view forward and up vectors must be non-zero');
  }
  if (
    message.viewport_px[0] <= 0 ||
    message.viewport_px[1] <= 0 ||
    message.fov_y_rad <= 0 ||
    message.fov_y_rad >= Math.PI ||
    message.near_m <= 0 ||
    message.far_m <= message.near_m
  ) {
    throw new Error('viewer_view requires a positive viewport, valid FOV, and 0 < near_m < far_m');
  }
  return {
    position: message.position,
    forward: message.forward,
    up: message.up,
    fovYRad: message.fov_y_rad,
    viewportPx: message.viewport_px,
    nearM: message.near_m,
    farM: message.far_m,
  };
}

function sendChunkLod(
  ws: WebSocket,
  sessionId: string,
  chunkKey: string,
  level: number,
  version: number,
  worldPoints: Buffer,
): boolean {
  const message: ChunkLodMessage = {
    type: 'chunk_lod',
    session_id: sessionId,
    chunk_key: chunkKey,
    level,
    version,
    point_count: worldPoints.byteLength / POINT_STRIDE_BYTES,
    point_format: POINT_FORMAT,
    stride_bytes: POINT_STRIDE_BYTES,
  };
  return sendPair(ws, message, worldPoints);
}

function sendChunkDrop(ws: WebSocket, sessionId: string, chunkKey: string): void {
  const message: ChunkDropMessage = {
    type: 'chunk_drop',
    session_id: sessionId,
    chunk_key: chunkKey,
  };
  send(ws, message);
}

function send(ws: WebSocket, message: ServerMessage): boolean {
  if (!canSend(ws, 0)) {
    return false;
  }
  ws.send(JSON.stringify(message));
  return true;
}

function sendPair(ws: WebSocket, message: ServerMessage, payload: Buffer): boolean {
  const control = JSON.stringify(message);
  if (!canSend(ws, Buffer.byteLength(control) + payload.byteLength)) {
    return false;
  }
  ws.send(control);
  ws.send(payload, { binary: true });
  return true;
}

function canSend(ws: WebSocket, additionalBytes: number): boolean {
  if (ws.readyState !== ws.OPEN) {
    return false;
  }
  if (ws.bufferedAmount + additionalBytes <= maxViewerBufferedBytes) {
    return true;
  }
  ws.close(1013, 'Client is not consuming point-cloud updates quickly enough');
  return false;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

function failFastOnStorageError(
  ws: WebSocket,
  error: DurableBatchError | StorageOperationError,
): void {
  console.error(error.message, error.cause);
  if (ws.readyState === ws.OPEN) {
    ws.close(1011, 'Durable storage failure; reconnect after the server restarts');
  }
  // Continuing would retain an uncommitted batch in memory and could bias a retry.
  setImmediate(() => process.exit(1));
}

function runStorageOperation(description: string, operation: () => void): void {
  try {
    operation();
  } catch (error) {
    throw new StorageOperationError(`Failed to ${description}`, { cause: error });
  }
}

function normalizeRawData(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

function parseIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseSignedFloatEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFloatEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}, flushing dirty chunks`);
  clearInterval(liveRefreshTimer);
  clearInterval(checkpointTimer);
  const httpClosed = new Promise<void>((resolve) => server.close(() => resolve()));
  for (const ws of [...ingestWss.clients, ...viewerWss.clients]) {
    ws.close(1001, 'Server shutting down');
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  for (const ws of [...ingestWss.clients, ...viewerWss.clients]) {
    if (ws.readyState !== ws.CLOSED) {
      ws.terminate();
    }
  }
  chunkStore.flushAll();
  await httpClosed;
  await Promise.all([
    new Promise<void>((resolve) => ingestWss.close(() => resolve())),
    new Promise<void>((resolve) => viewerWss.close(() => resolve())),
  ]);
  chunkStore.close();
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

const liveRefreshTimer = setInterval(refreshLiveBases, liveRefreshMs);
const checkpointTimer = setInterval(() => {
  try {
    chunkStore.checkpointTick(checkpointChunksPerTick);
  } catch (error) {
    // A failed checkpoint leaves the log as the source of truth; the next tick retries.
    console.error('Checkpoint tick failed', error);
  }
}, checkpointTickMs);

server.listen(port, () => {
  console.log(`point-cloud-visualizer listening on http://localhost:${port}`);
});

function requireUnboundPublisher(state: ConnectionState): void {
  if (state.sessionId || state.publisherId) {
    throw new Error('This ingest connection is already bound to a session');
  }
}

function requireBoundPublisher(
  state: ConnectionState,
  sessionId: string,
  publisherId: string,
): void {
  if (!state.sessionId || !state.publisherId) {
    throw new Error('Create or resume a session before publishing data');
  }
  if (state.sessionId !== sessionId || state.publisherId !== publisherId) {
    throw new Error('Message session or publisher does not match this ingest connection');
  }
}
