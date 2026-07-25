import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket, type RawData } from 'ws';

import { POINT_FORMAT, POINT_STRIDE_BYTES } from '../src/protocol.js';

interface QueuedMessage {
  data: RawData;
  isBinary: boolean;
}

class SocketMessages {
  private readonly queued: QueuedMessage[] = [];
  private readonly waiting: Array<(message: QueuedMessage) => void> = [];

  constructor(ws: WebSocket) {
    ws.on('message', (data, isBinary) => {
      const resolve = this.waiting.shift();
      if (resolve) {
        resolve({ data, isBinary });
      } else {
        this.queued.push({ data, isBinary });
      }
    });
  }

  next(): Promise<QueuedMessage> {
    const message = this.queued.shift();
    if (message) {
      return Promise.resolve(message);
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  async nextJson(): Promise<Record<string, unknown>> {
    const message = await this.next();
    assert.equal(message.isBinary, false);
    return JSON.parse(message.data.toString()) as Record<string, unknown>;
  }
}

test('restores sessions and chunks across restart, then resumes at the persisted sequence', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcv-restart-'));
  const port = await reservePort();
  let server = await startServer(port, dataDir);
  t.after(async () => {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const ingest = await connect(`ws://127.0.0.1:${port}/ws/ingest`);
  const ingestMessages = new SocketMessages(ingest);
  ingest.send(
    JSON.stringify({
      type: 'create_session',
      protocol_version: 1,
      session_id: 'restart-session',
      publisher_id: 'restart-publisher',
      started_at: '2026-07-10T00:00:00Z',
      frame_id: 'map',
      units: 'meters',
    }),
  );
  assert.equal((await ingestMessages.nextJson()).type, 'session_ack');
  sendPoseAndBatch(ingest, 1, 2, 0.25);
  const firstAck = await ingestMessages.nextJson();
  assert.equal(firstAck.type, 'point_batch_ack');
  assert.equal(firstAck.sequence, 2);
  ingest.close();
  await once(ingest, 'close');

  await stopServer(server);
  server = await startServer(port, dataDir);

  const sessionsResponse = await fetch(`http://127.0.0.1:${port}/sessions`);
  assert.equal(sessionsResponse.ok, true);
  const sessions = (await sessionsResponse.json()) as Array<Record<string, unknown>>;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, 'restart-session');
  assert.equal(sessions[0].lastSequence, 2);
  assert.equal(sessions[0].totalPoints, 1);

  const viewer = await connect(
    `ws://127.0.0.1:${port}/ws/view?session_id=restart-session`,
  );
  const viewerMessages = new SocketMessages(viewer);
  const state = await viewerMessages.nextJson();
  assert.equal(state.type, 'viewer_session_state');
  assert.equal(state.last_sequence, 2);
  const bootstrap = await viewerMessages.nextJson();
  assert.equal(bootstrap.type, 'chunk_bootstrap');
  assert.equal(bootstrap.point_count, 1);
  const bootstrapPayload = await viewerMessages.next();
  assert.equal(bootstrapPayload.isBinary, true);
  assert.equal(Buffer.from(bootstrapPayload.data as ArrayBuffer).byteLength, POINT_STRIDE_BYTES);
  viewer.close();
  await once(viewer, 'close');

  const resumed = await connect(`ws://127.0.0.1:${port}/ws/ingest`);
  const resumedMessages = new SocketMessages(resumed);
  resumed.send(
    JSON.stringify({
      type: 'resume_session',
      protocol_version: 1,
      session_id: 'restart-session',
      publisher_id: 'restart-publisher',
      last_client_sequence: 2,
    }),
  );
  const resumeAck = await resumedMessages.nextJson();
  assert.equal(resumeAck.type, 'session_ack');
  assert.equal(resumeAck.resume_from_sequence, 3);

  sendPoseAndBatch(resumed, 3, 4, 0.5);
  const secondAck = await resumedMessages.nextJson();
  assert.equal(secondAck.type, 'point_batch_ack');
  assert.equal(secondAck.sequence, 4);
  const resumedClosed = once(resumed, 'close');
  await stopServer(server);
  await resumedClosed;
});

function sendPoseAndBatch(ws: WebSocket, poseSequence: number, batchSequence: number, x: number): void {
  const timestamp = new Date().toISOString();
  ws.send(
    JSON.stringify({
      type: 'pose_update',
      session_id: 'restart-session',
      publisher_id: 'restart-publisher',
      sequence: poseSequence,
      timestamp,
      pose: {
        translation_m: [0, 0, 0],
        rotation_xyzw: [0, 0, 0, 1],
      },
    }),
  );
  const payload = Buffer.alloc(POINT_STRIDE_BYTES);
  payload.writeFloatLE(x, 0);
  payload.writeFloatLE(0.25, 4);
  payload.writeFloatLE(0.25, 8);
  ws.send(
    JSON.stringify({
      type: 'point_batch_header',
      session_id: 'restart-session',
      publisher_id: 'restart-publisher',
      sequence: batchSequence,
      timestamp,
      pose_sequence: poseSequence,
      point_count: 1,
      point_format: POINT_FORMAT,
      encoding: 'binary_le',
      compression: 'none',
      stride_bytes: POINT_STRIDE_BYTES,
    }),
  );
  ws.send(payload, { binary: true });
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  const port = (address as net.AddressInfo).port;
  server.close();
  await once(server, 'close');
  return port;
}

async function startServer(port: number, dataDir: string): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      NODE_NO_WARNINGS: '1',
    },
    stdio: 'pipe',
  });
  let output = '';
  child.stdout.on('data', (data) => {
    output += data.toString();
  });
  child.stderr.on('data', (data) => {
    output += data.toString();
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited during startup:\n${output}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) {
        return child;
      }
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error(`Server did not start:\n${output}`);
}

async function stopServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  await once(child, 'exit');
}

async function connect(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await once(ws, 'open');
  return ws;
}
