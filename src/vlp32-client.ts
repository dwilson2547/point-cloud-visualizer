import dgram from 'node:dgram';
import process from 'node:process';

import WebSocket from 'ws';

import {
  POINT_FORMAT,
  POINT_STRIDE_BYTES,
  PROTOCOL_VERSION,
  type PointBatchHeaderMessage,
  type ServerMessage,
} from './protocol.js';
import { loadCalibrationFile } from './vlp32-calibration.js';
import { parseVlp32Packet } from './vlp32-packet.js';

interface CliOptions {
  serverUrl: string;
  calibrationFile: string;
  sessionId: string;
  publisherId: string;
  udpPort: number;
  batchPackets: number;
  frameId: string;
  projectId?: string;
  siteId?: string;
  roomId?: string;
}

interface PendingPacket {
  payload: Buffer;
  pointCount: number;
  boundsLocal: {
    min: [number, number, number];
    max: [number, number, number];
  };
}

const options = parseArgs(process.argv.slice(2));
const calibration = loadCalibrationFile(options.calibrationFile);
const socket = dgram.createSocket('udp4');
const ws = new WebSocket(options.serverUrl);

let sessionReady = false;
let sequence = 0;
let poseSequence = 0;
let pendingPackets: PendingPacket[] = [];
let inFlightPackets: PendingPacket[] = [];
let flushedBatches = 0;
let batchInFlight = false;
let droppedPackets = 0;
let shutdownRequested = false;
let shutdownTimer: NodeJS.Timeout | undefined;
const maxPendingPackets = options.batchPackets * 20;

ws.on('open', () => {
  ws.send(
    JSON.stringify({
      type: 'create_session',
      protocol_version: PROTOCOL_VERSION,
      session_id: options.sessionId,
      publisher_id: options.publisherId,
      started_at: new Date().toISOString(),
      frame_id: options.frameId,
      units: 'meters',
      metadata: {
        project_id: options.projectId,
        site_id: options.siteId,
        room_id: options.roomId,
      },
    }),
  );
});

ws.on('message', (raw) => {
  if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) {
    return;
  }

  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  let message: ServerMessage;
  try {
    message = JSON.parse(text) as ServerMessage;
  } catch {
    return;
  }

  if (message.type === 'session_ack') {
    sequence = message.resume_from_sequence - 1;
    sessionReady = true;
    console.log(`Session ${options.sessionId} ready, listening on UDP ${options.udpPort}`);
    return;
  }

  if (message.type === 'point_batch_ack') {
    batchInFlight = false;
    inFlightPackets = [];
    flushedBatches += 1;
    if (flushedBatches % 25 === 0) {
      console.log(
        `Published ${flushedBatches} point batches (${message.accepted_points} points in latest batch)`,
      );
    }
    if (shutdownRequested) {
      drainAndClose();
    } else {
      flushPendingPackets();
    }
    return;
  }

  if (message.type === 'error') {
    abort(`Server error [${message.code}]: ${message.message}`);
  }
});

ws.on('error', (error) => {
  console.error(`WebSocket error: ${error.message}`);
});

ws.on('close', () => {
  console.log('WebSocket closed');
  clearInterval(flushInterval);
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = undefined;
  }
  closeUdpSocket();
  if (!shutdownRequested && (batchInFlight || pendingPackets.length > 0)) {
    process.exitCode = 1;
  }
});

socket.on('message', (packet) => {
  if (!sessionReady || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  try {
    const parsed = parseVlp32Packet(packet, calibration);
    if (parsed.pointCount === 0) {
      return;
    }
    if (pendingPackets.length >= maxPendingPackets) {
      droppedPackets += 1;
      if (droppedPackets === 1 || droppedPackets % 100 === 0) {
        console.error(`Dropped ${droppedPackets} lidar packets while waiting for server acknowledgements`);
      }
      return;
    }
    pendingPackets.push(parsed);
    if (pendingPackets.length >= options.batchPackets && !batchInFlight) {
      flushPendingPackets();
    }
  } catch (error) {
    console.error(`Failed to parse VLP-32 packet: ${getErrorMessage(error)}`);
  }
});

socket.on('listening', () => {
  const address = socket.address();
  if (typeof address === 'string') {
    console.log(`UDP socket listening on ${address}`);
    return;
  }
  console.log(`UDP socket listening on ${address.address}:${address.port}`);
});

socket.bind(options.udpPort);

const flushInterval = setInterval(() => {
  if (pendingPackets.length > 0 && sessionReady && ws.readyState === WebSocket.OPEN) {
    flushPendingPackets();
  }
}, 100);

process.on('SIGINT', beginShutdown);
process.on('SIGTERM', beginShutdown);

function flushPendingPackets(): void {
  if (
    pendingPackets.length === 0 ||
    batchInFlight ||
    ws.readyState !== WebSocket.OPEN ||
    ws.bufferedAmount > 4 * 1024 * 1024
  ) {
    return;
  }

  const packets = pendingPackets.splice(0, options.batchPackets);
  inFlightPackets = packets;
  let pointCount = 0;
  let totalBytes = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const batch of packets) {
    pointCount += batch.pointCount;
    totalBytes += batch.payload.byteLength;
    minX = Math.min(minX, batch.boundsLocal.min[0]);
    minY = Math.min(minY, batch.boundsLocal.min[1]);
    minZ = Math.min(minZ, batch.boundsLocal.min[2]);
    maxX = Math.max(maxX, batch.boundsLocal.max[0]);
    maxY = Math.max(maxY, batch.boundsLocal.max[1]);
    maxZ = Math.max(maxZ, batch.boundsLocal.max[2]);
  }

  const payload = Buffer.concat(
    packets.map((batch) => batch.payload),
    totalBytes,
  );
  poseSequence = nextSequence();
  const timestamp = new Date().toISOString();
  ws.send(
    JSON.stringify({
      type: 'pose_update',
      session_id: options.sessionId,
      publisher_id: options.publisherId,
      sequence: poseSequence,
      timestamp,
      pose: {
        translation_m: [0, 0, 0],
        rotation_xyzw: [0, 0, 0, 1],
      },
    }),
  );
  const header: PointBatchHeaderMessage = {
    type: 'point_batch_header',
    session_id: options.sessionId,
    publisher_id: options.publisherId,
    sequence: nextSequence(),
    timestamp,
    pose_sequence: poseSequence,
    point_count: pointCount,
    point_format: POINT_FORMAT,
    encoding: 'binary_le',
    compression: 'none',
    stride_bytes: POINT_STRIDE_BYTES,
    bounds_local: {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
    },
  };

  ws.send(JSON.stringify(header));
  ws.send(payload, { binary: true });
  batchInFlight = true;
}

function nextSequence(): number {
  sequence += 1;
  return sequence;
}

function parseArgs(args: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(usage());
    }
    values.set(key.slice(2), value);
  }

  const serverUrl = values.get('server-url') ?? 'ws://localhost:8080/ws/ingest';
  const calibrationFile = values.get('calibration-file');
  const sessionId = values.get('session-id');
  const publisherId = values.get('publisher-id') ?? 'vlp32-publisher';
  const udpPort = parseInteger(values.get('udp-port') ?? '2368', 'udp-port');
  const batchPackets = parseInteger(values.get('batch-packets') ?? '10', 'batch-packets');
  const frameId = values.get('frame-id') ?? 'map';

  if (!calibrationFile || !sessionId) {
    throw new Error(usage());
  }

  return {
    serverUrl,
    calibrationFile,
    sessionId,
    publisherId,
    udpPort,
    batchPackets,
    frameId,
    projectId: values.get('project-id'),
    siteId: values.get('site-id'),
    roomId: values.get('room-id'),
  };
}

function parseInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function usage(): string {
  return [
    'Usage:',
    '  npm run client:vlp32 -- \\',
    '    --calibration-file ./vlp32-calibration.json \\',
    '    --session-id scan-room-a-001 \\',
    '    [--server-url ws://localhost:8080/ws/ingest] \\',
    '    [--publisher-id vlp32-main] \\',
    '    [--udp-port 2368] \\',
    '    [--batch-packets 10] \\',
    '    [--frame-id map] \\',
    '    [--project-id demo] [--site-id office-1] [--room-id lab]',
  ].join('\n');
}

function beginShutdown(): void {
  if (shutdownRequested) {
    return;
  }
  shutdownRequested = true;
  clearInterval(flushInterval);
  closeUdpSocket();
  shutdownTimer = setTimeout(() => {
    abort('Timed out waiting for queued lidar data to be acknowledged during shutdown');
  }, 10_000);
  drainAndClose();
}

function drainAndClose(): void {
  if (batchInFlight) {
    return;
  }
  if (pendingPackets.length > 0 && sessionReady && ws.readyState === WebSocket.OPEN) {
    flushPendingPackets();
    return;
  }
  if (sessionReady && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: 'close_session',
        session_id: options.sessionId,
        publisher_id: options.publisherId,
        sequence: nextSequence(),
      }),
    );
    sessionReady = false;
  }
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = undefined;
  }
  ws.close();
}

function abort(message: string): void {
  console.error(message);
  console.error(`Aborting with ${inFlightPackets.length} unacknowledged and ${pendingPackets.length} queued packets`);
  clearInterval(flushInterval);
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = undefined;
  }
  process.exitCode = 1;
  closeUdpSocket();
  ws.close();
}

function closeUdpSocket(): void {
  try {
    socket.close();
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      (error as { code?: unknown }).code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING'
    ) {
      throw error;
    }
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
