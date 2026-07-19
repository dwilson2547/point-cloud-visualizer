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
import { ChunkStore } from './chunk-store.js';
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
  sentLevels?: Map<string, number>;
  frustum?: Frustum;
}

type ChunkCell = { chunkKey: string; chunkX: number; chunkY: number; chunkZ: number };

const port = parseIntegerEnv(process.env.PORT, 8080);
const sessionStore = new SessionStore();
const chunkStore = new ChunkStore({
  rootDir: path.resolve(process.env.DATA_DIR ?? 'data'),
  chunkSizeMeters: parseFloatEnv(process.env.CHUNK_SIZE_METERS, 2),
  fuseVoxelMeters: parseFloatEnv(process.env.FUSE_VOXEL_METERS, 0.04),
  numLevels: parseIntegerEnv(process.env.LOD_LEVELS, 6),
  flushPointThreshold: parseIntegerEnv(process.env.FLUSH_POINT_THRESHOLD, 50_000),
  maxDirtyChunks: parseIntegerEnv(process.env.MAX_DIRTY_CHUNKS, 128),
});
const viewerSockets = new Map<string, Set<WebSocket>>();
// Per-viewer connection state, so the live-refresh tick can reach each LOD viewer's
// frustum + sent levels (the ws Set above only tracks membership).
const viewerStates = new Map<WebSocket, ConnectionState>();
// Chunk keys changed by ingest since the last refresh tick, per session. Coalesces a
// burst of batches into one re-send per chunk per tick.
const dirtyChunksBySession = new Map<string, Set<string>>();
const liveRefreshMs = parseIntegerEnv(process.env.LIVE_REFRESH_MS, 500);
const ingestWss = new WebSocketServer({ noServer: true });
const viewerWss = new WebSocketServer({ noServer: true });

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

  if (serveStatic(req, res, url.pathname)) {
    return;
  }

  res.writeHead(404).end('Not found');
});

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

  ws.on('message', (data, isBinary) => {
    try {
      if (isBinary) {
        handlePointBatchBinary(ws, state, data);
        return;
      }
      handleIngestText(ws, state, data.toString());
    } catch (error) {
      send(ws, makeError('protocol_error', getErrorMessage(error), true, state.sessionId));
    }
  });
}

function handleIngestText(ws: WebSocket, state: ConnectionState, payload: string): void {
  const message = parseClientMessage(payload);

  switch (message.type) {
    case 'create_session': {
      const session = sessionStore.createSession(message);
      chunkStore.syncSession(session);
      state.sessionId = session.sessionId;
      state.publisherId = session.publisherId;
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
      const session = sessionStore.resumeSession(message);
      chunkStore.syncSession(session);
      state.sessionId = session.sessionId;
      state.publisherId = session.publisherId;
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
      const session = sessionStore.applyPoseUpdate(message);
      chunkStore.syncSession(session);
      state.sessionId = message.session_id;
      state.publisherId = message.publisher_id;
      return;
    }
    case 'point_batch_header': {
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
      const session = sessionStore.closeSession(message.session_id, message.publisher_id, message.sequence);
      chunkStore.syncSession(session);
      chunkStore.flushSession(message.session_id);
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
  const accepted = sessionStore.acceptPointBatch(header, payload);
  const touchedKeys = chunkStore.storeAcceptedBatch(accepted);
  markChunksDirty(accepted.session.sessionId, touchedKeys);

  send(ws, {
    type: 'point_batch_ack',
    session_id: accepted.session.sessionId,
    sequence: accepted.header.sequence,
    accepted_points: accepted.header.point_count,
    rejected_points: 0,
  });

  broadcastChunkUpdate(accepted.header, accepted.payload, accepted.pose.pose);
}

function configureViewerSocket(ws: WebSocket, sessionIdFromQuery?: string, lodMode = false): void {
  const state: ConnectionState = { role: VIEWER_ROLE, lodMode, sentLevels: new Map() };
  viewerStates.set(ws, state);

  ws.on('message', (data, isBinary) => {
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
    attachViewer(ws, state, {
      type: 'viewer_join',
      session_id: sessionIdFromQuery,
    });
  }
}

function attachViewer(ws: WebSocket, state: ConnectionState, message: ViewerJoinMessage): void {
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
  for (const worldPoints of chunkStore.readSessionWorldChunks(message.session_id)) {
    sendChunkBootstrap(ws, message.session_id, worldPoints);
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
): void {
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
  send(ws, message);
  ws.send(payload, { binary: true });
}

function sendChunkBootstrap(ws: WebSocket, sessionId: string, worldPoints: Buffer): void {
  const message: ChunkBootstrapMessage = {
    type: 'chunk_bootstrap',
    session_id: sessionId,
    point_count: worldPoints.byteLength / POINT_STRIDE_BYTES,
    point_format: POINT_FORMAT,
    stride_bytes: POINT_STRIDE_BYTES,
  };
  send(ws, message);
  ws.send(worldPoints, { binary: true });
}

// Recompute the LOD base layer for a viewer against its latest camera: for each chunk
// cell, cull or pick a level, and send only the diffs — a chunk_lod when its level
// changed (or it is newly visible) and a chunk_drop when it left the view.
function onViewerView(ws: WebSocket, state: ConnectionState, message: ViewerViewMessage): void {
  state.sessionId = message.session_id;
  const sentLevels = state.sentLevels ?? (state.sentLevels = new Map());
  const frustum = buildFrustum(toViewCamera(message));
  state.frustum = frustum; // remembered so live refresh can re-evaluate changed chunks

  const visible = new Set<string>();
  for (const cell of chunkStore.listSessionChunkKeys(message.session_id)) {
    const level = selectChunkLevel(cellAabb(cell), frustum, currentLadder());
    if (level === null) {
      continue; // culled
    }
    visible.add(cell.chunkKey);
    if (sentLevels.get(cell.chunkKey) === level) {
      continue; // already at this level — no re-send on a camera nudge
    }
    sendChunkAtLevel(ws, message.session_id, cell.chunkKey, level, sentLevels);
  }

  for (const chunkKey of [...sentLevels.keys()]) {
    if (!visible.has(chunkKey)) {
      sendChunkDrop(ws, message.session_id, chunkKey);
      sentLevels.delete(chunkKey);
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

// Re-evaluate one changed chunk against a viewer's current frustum: send it at the
// selected level (always, since its data changed) or drop it if it left the view.
function refreshChunkForViewer(
  ws: WebSocket,
  state: ConnectionState,
  sessionId: string,
  cell: ChunkCell,
): void {
  const sentLevels = state.sentLevels ?? (state.sentLevels = new Map());
  const level = selectChunkLevel(cellAabb(cell), state.frustum!, currentLadder());
  if (level === null) {
    if (sentLevels.has(cell.chunkKey)) {
      sendChunkDrop(ws, sessionId, cell.chunkKey);
      sentLevels.delete(cell.chunkKey);
    }
    return;
  }
  sendChunkAtLevel(ws, sessionId, cell.chunkKey, level, sentLevels);
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

// Derive a chunk at a level and send it, recording the sent level. No-op for an empty
// chunk (leaves any prior sent level untouched).
function sendChunkAtLevel(
  ws: WebSocket,
  sessionId: string,
  chunkKey: string,
  level: number,
  sentLevels: Map<string, number>,
): void {
  const worldPoints = chunkStore.deriveChunkLevel(sessionId, chunkKey, level);
  if (worldPoints.byteLength === 0) {
    return;
  }
  sendChunkLod(ws, sessionId, chunkKey, level, worldPoints);
  sentLevels.set(chunkKey, level);
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
  worldPoints: Buffer,
): void {
  const message: ChunkLodMessage = {
    type: 'chunk_lod',
    session_id: sessionId,
    chunk_key: chunkKey,
    level,
    point_count: worldPoints.byteLength / POINT_STRIDE_BYTES,
    point_format: POINT_FORMAT,
    stride_bytes: POINT_STRIDE_BYTES,
  };
  send(ws, message);
  ws.send(worldPoints, { binary: true });
}

function sendChunkDrop(ws: WebSocket, sessionId: string, chunkKey: string): void {
  const message: ChunkDropMessage = {
    type: 'chunk_drop',
    session_id: sessionId,
    chunk_key: chunkKey,
  };
  send(ws, message);
}

function send(ws: WebSocket, message: ServerMessage): void {
  ws.send(JSON.stringify(message));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
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
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFloatEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}, flushing dirty chunks`);
  chunkStore.flushAll();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

setInterval(refreshLiveBases, liveRefreshMs);

server.listen(port, () => {
  console.log(`point-cloud-visualizer listening on http://localhost:${port}`);
});
