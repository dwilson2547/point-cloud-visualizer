// Synthetic ingest publisher: streams a moving sensor + structured point batches
// into /ws/ingest so the full ingest -> serve -> viewer loop can be exercised
// without any hardware. The "sensor" yaws while translating on a small circle and
// emits a spherical shell of points in its LOCAL frame; once the server applies
// the pose, those paint a densifying sphere in the world.
import { WebSocket } from 'ws';

import { POINT_FORMAT, POINT_STRIDE_BYTES } from './protocol.js';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length - 1; i++) {
  if (process.argv[i].startsWith('--')) {
    args.set(process.argv[i].slice(2), process.argv[i + 1]);
  }
}

const url = args.get('url') ?? 'ws://localhost:8080/ws/ingest';
const sessionId = args.get('session-id') ?? 'synthetic-demo';
const publisherId = args.get('publisher-id') ?? 'synthetic';
const pointsPerBatch = Number.parseInt(args.get('points') ?? '1500', 10);
const batchesPerSecond = Number.parseInt(args.get('rate') ?? '15', 10);

const ws = new WebSocket(url);
let sequence = 0;
const startedAt = Date.now();

ws.on('open', () => {
  send({
    type: 'create_session',
    protocol_version: 1,
    session_id: sessionId,
    publisher_id: publisherId,
    started_at: new Date().toISOString(),
    frame_id: 'map',
    units: 'meters',
  });
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'session_ack' && msg.accepted) {
    console.log(`session ${sessionId} accepted — streaming ${pointsPerBatch} pts x ${batchesPerSecond}/s`);
    console.log(`viewer: http://localhost:8080/?session_id=${encodeURIComponent(sessionId)}`);
    setInterval(emitFrame, Math.max(1, Math.round(1000 / batchesPerSecond)));
  } else if (msg.type === 'error') {
    console.error('server error:', msg.message);
  }
});

ws.on('error', (err) => console.error('ws error:', err.message));
ws.on('close', () => process.exit(0));

function emitFrame(): void {
  const t = (Date.now() - startedAt) / 1000;
  const yaw = t * 0.8;
  const pose = {
    translation_m: [2 * Math.cos(t * 0.3), 2 * Math.sin(t * 0.3), 0] as [number, number, number],
    rotation_xyzw: [0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2)] as [number, number, number, number],
  };

  const poseSequence = ++sequence;
  send({
    type: 'pose_update',
    session_id: sessionId,
    publisher_id: publisherId,
    sequence: poseSequence,
    timestamp: new Date().toISOString(),
    pose,
  });

  const payload = buildShell(pointsPerBatch);
  const batchSequence = ++sequence;
  send({
    type: 'point_batch_header',
    session_id: sessionId,
    publisher_id: publisherId,
    sequence: batchSequence,
    timestamp: new Date().toISOString(),
    pose_sequence: poseSequence,
    point_count: pointsPerBatch,
    point_format: POINT_FORMAT,
    encoding: 'binary_le',
    compression: 'none',
    stride_bytes: POINT_STRIDE_BYTES,
  });
  ws.send(payload);
}

// A spherical shell (radius ~4 m) sampled in the sensor's local frame, colored by
// elevation so the accumulating world cloud is legible.
function buildShell(count: number): Buffer {
  const buf = Buffer.alloc(count * POINT_STRIDE_BYTES);
  for (let i = 0; i < count; i++) {
    const el = (Math.random() - 0.5) * 2.4; // elevation rad
    const az = (Math.random() - 0.5) * 0.3; // narrow forward azimuth wedge
    const r = 4 + (Math.random() - 0.5) * 0.1;
    const cx = r * Math.cos(el);
    const x = cx * Math.cos(az);
    const y = cx * Math.sin(az);
    const z = r * Math.sin(el);

    const o = i * POINT_STRIDE_BYTES;
    buf.writeFloatLE(x, o);
    buf.writeFloatLE(y, o + 4);
    buf.writeFloatLE(z, o + 8);
    const [red, green, blue] = heatColor((el + 1.2) / 2.4);
    buf[o + 12] = red;
    buf[o + 13] = green;
    buf[o + 14] = blue;
    buf.writeUInt16LE(Math.floor(Math.random() * 65535), o + 15);
    buf[o + 17] = 0;
  }
  return buf;
}

function heatColor(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  const r = Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * x - 3))));
  const g = Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * x - 2))));
  const b = Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * x - 1))));
  return [r, g, b];
}

function send(message: unknown): void {
  ws.send(JSON.stringify(message));
}
