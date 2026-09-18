// Shared helpers for tests that drive a real server process over HTTP/WebSocket.
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';

import { WebSocket, type RawData } from 'ws';

export interface QueuedMessage {
  data: RawData;
  isBinary: boolean;
}

export class SocketMessages {
  private readonly queued: QueuedMessage[] = [];
  private readonly waiting: Array<(message: QueuedMessage) => void> = [];

  private last = 'nothing';

  constructor(ws: WebSocket, public label = 'socket') {
    ws.on('message', (data, isBinary) => {
      this.last = isBinary ? `binary ${(data as Buffer).byteLength} B` : data.toString().slice(0, 120);
      const resolve = this.waiting.shift();
      if (resolve) {
        resolve({ data, isBinary });
      } else {
        this.queued.push({ data, isBinary });
      }
    });
  }

  // Rejects after `timeoutMs` so a server that never answers fails the test with a
  // message instead of hanging the whole run.
  next(timeoutMs = 15_000): Promise<QueuedMessage> {
    const message = this.queued.shift();
    if (message) {
      return Promise.resolve(message);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiting.indexOf(settle);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new Error(`${this.label}: timed out after ${timeoutMs} ms waiting for a message (last: ${this.last})`));
      }, timeoutMs);
      const settle = (queued: QueuedMessage): void => {
        clearTimeout(timer);
        resolve(queued);
      };
      this.waiting.push(settle);
    });
  }

  async nextJson(): Promise<Record<string, unknown>> {
    const message = await this.next();
    assert.equal(message.isBinary, false);
    return JSON.parse(message.data.toString()) as Record<string, unknown>;
  }
}

export async function reservePort(): Promise<number> {
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

export async function startServer(
  port: number,
  dataDir: string,
  extraEnv: Record<string, string> = {},
): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      NODE_NO_WARNINGS: '1',
      ...extraEnv,
    },
    stdio: 'pipe',
  });
  let output = '';
  // PCV_TEST_LOG_DIR=<dir> also tees each server's output to <dir>/server-<port>.log,
  // which is the only way to see what a server did when a test hangs on it.
  const tee = process.env.PCV_TEST_LOG_DIR
    ? fs.createWriteStream(path.join(process.env.PCV_TEST_LOG_DIR, `server-${port}.log`), { flags: 'a' })
    : undefined;
  child.stdout.on('data', (data) => {
    output += data.toString();
    tee?.write(data);
  });
  child.stderr.on('data', (data) => {
    output += data.toString();
    tee?.write(data);
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

export async function stopServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  await once(child, 'exit');
}

// The message queue is attached before 'open' resolves. A server frame that arrives in
// the same read as the handshake is emitted from the nextTick queue, which runs before
// the promise continuation after `await once(ws, 'open')`; a listener attached only
// then misses it (seen as viewer sockets that "never" received their session state).
const attached = new WeakMap<WebSocket, SocketMessages>();

export async function connect(url: string, label = 'socket'): Promise<WebSocket> {
  const ws = new WebSocket(url);
  attached.set(ws, new SocketMessages(ws, label));
  await once(ws, 'open');
  return ws;
}

// The queue `connect` attached to a socket (never construct a second one: only the
// first listener sees every frame).
export function messagesOf(ws: WebSocket, label?: string): SocketMessages {
  const messages = attached.get(ws);
  if (!messages) {
    throw new Error('messagesOf: socket was not opened with connect()');
  }
  if (label) messages.label = label;
  return messages;
}
