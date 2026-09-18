// Shared helpers for tests that drive a real server process over HTTP/WebSocket.
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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

export async function stopServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  await once(child, 'exit');
}

export async function connect(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await once(ws, 'open');
  return ws;
}
