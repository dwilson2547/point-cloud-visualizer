import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { encodeRecord, type LogRecordHeader } from '../src/batch-log.js';
import { IggyHttpClient } from '../src/iggy-http.js';
import { parseMessage } from '../src/iggy-consumer.js';
import { INGEST_FORMAT_Q4, encodeQ4 } from '../src/point-formats.js';
import { POINT_FORMAT, POINT_STRIDE_BYTES } from '../src/protocol.js';
import { SessionStore } from '../src/session-store.js';
import { reservePort, startServer, stopServer } from './helpers.js';

function header(sequence: number, pointCount: number, format = POINT_FORMAT): LogRecordHeader {
  return {
    sequence,
    pose_sequence: sequence - 1,
    timestamp: '2026-07-10T00:00:01Z',
    point_count: pointCount,
    pose: { translation_m: [0, 0, 0], rotation_xyzw: [0, 0, 0, 1] },
    point_format: format,
  };
}

function v1Points(xs: number[]): Buffer {
  const payload = Buffer.alloc(xs.length * POINT_STRIDE_BYTES);
  xs.forEach((x, i) => {
    payload.writeFloatLE(x, i * POINT_STRIDE_BYTES);
    payload.writeFloatLE(0.5, i * POINT_STRIDE_BYTES + 4);
    payload.writeFloatLE(0.5, i * POINT_STRIDE_BYTES + 8);
  });
  return payload;
}

test('pub/sub messages are classified as batch records, control messages, or invalid', () => {
  const record = encodeRecord(header(2, 1), v1Points([0.5]));
  const parsed = parseMessage(record);
  assert.equal(parsed.kind, 'batch');
  if (parsed.kind === 'batch') {
    assert.equal(parsed.record.header.sequence, 2);
    assert.equal(parsed.record.payload.byteLength, POINT_STRIDE_BYTES);
  }
  const control = parseMessage(Buffer.from(JSON.stringify({ type: 'close_session', session_id: 'x' })));
  assert.equal(control.kind, 'control');
  assert.equal(parseMessage(Buffer.from('not json')).kind, 'invalid');
  const corrupt = Buffer.from(record);
  corrupt[corrupt.byteLength - 1] ^= 0xff;
  assert.equal(parseMessage(corrupt).kind, 'invalid');
  assert.equal(parseMessage(record.subarray(0, record.byteLength - 3)).kind, 'invalid', 'truncated record');
});

test('external batches need no pose_update, drop redeliveries, and may skip sequences', () => {
  const store = new SessionStore();
  store.createSession({
    type: 'create_session',
    protocol_version: 1,
    session_id: 'ext',
    publisher_id: 'ext-pub',
    started_at: '2026-07-10T00:00:00Z',
    frame_id: 'map',
    units: 'meters',
  });
  const first = store.prepareExternalBatch('ext', header(2, 1), v1Points([0.5]));
  assert.ok(first);
  assert.equal(first.pose.pose.translation_m[0], 0);
  store.commitExternalBatch(first);
  assert.equal(store.prepareExternalBatch('ext', header(2, 1), v1Points([0.5])), null, 'redelivery');
  assert.equal(store.prepareExternalBatch('ext', header(1, 1), v1Points([0.5])), null, 'older sequence');
  const later = store.prepareExternalBatch('ext', header(10, 2, INGEST_FORMAT_Q4), encodeQ4(v1Points([0.5, 1.5])));
  assert.ok(later, 'a gap is fine: the broker preserved order and nothing was lost here');
  store.commitExternalBatch(later);
  const state = store.getSessionState('ext');
  assert.equal(state.last_sequence, 10);
  assert.equal(state.point_batches, 2);
  assert.equal(state.total_points, 3);
  assert.throws(() => store.prepareExternalBatch('ext', header(11, 5), v1Points([1])), /point_count/);
});

const iggyUrl = process.env.IGGY_HTTP_URL;
test(
  'the server consumes a session published to Iggy, once, across a restart',
  { skip: iggyUrl ? false : 'set IGGY_HTTP_URL to an Iggy HTTP endpoint to run' },
  async (t) => {
    const stream = `pcv-test-${Date.now()}`;
    const sessionId = `iggy-${Date.now()}`;
    const client = new IggyHttpClient({ url: iggyUrl!, username: 'iggy', password: 'iggy' });
    await client.ensureStream(stream);
    await client.ensureTopic(stream, sessionId);
    const control = (message: Record<string, unknown>) => Buffer.from(JSON.stringify(message));
    await client.send(stream, sessionId, [
      control({
        type: 'create_session',
        protocol_version: 1,
        session_id: sessionId,
        publisher_id: 'iggy-pub',
        started_at: '2026-07-10T00:00:00Z',
        frame_id: 'map',
        units: 'meters',
      }),
      encodeRecord(header(2, 1), v1Points([0.5])),
      encodeRecord(header(4, 2, INGEST_FORMAT_Q4), encodeQ4(v1Points([2.5, 4.5]))),
    ]);

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcv-iggy-'));
    const port = await reservePort();
    const env = { IGGY_HTTP_URL: iggyUrl!, IGGY_STREAM: stream, IGGY_CONSUMER: `test-${Date.now()}`, IGGY_POLL_MS: '50', CHUNK_SIZE_METERS: '1' };
    let server = await startServer(port, dataDir, env);
    t.after(async () => {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    });
    const sessions = async (): Promise<Array<Record<string, unknown>>> =>
      (await (await fetch(`http://127.0.0.1:${port}/sessions`)).json()) as Array<Record<string, unknown>>;
    const waitFor = async (predicate: (s: Record<string, unknown> | undefined) => boolean, what: string): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const found = (await sessions()).find((s) => s.sessionId === sessionId);
        if (predicate(found)) return found!;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(found)}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    const consumed = await waitFor((s) => s?.pointBatches === 2, 'two batches');
    assert.equal(consumed.totalPoints, 3);
    assert.equal(consumed.lastSequence, 4);
    assert.equal(consumed.closed, false);

    // Restart: the stored consumer offset means nothing is consumed twice.
    await stopServer(server);
    server = await startServer(port, dataDir, env);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const after = await waitFor((s) => s !== undefined, 'session after restart');
    assert.equal(after.pointBatches, 2, 'no double count after restart');

    // A redelivered record and a late close are handled.
    await client.send(stream, sessionId, [
      encodeRecord(header(4, 2, INGEST_FORMAT_Q4), encodeQ4(v1Points([2.5, 4.5]))),
      encodeRecord(header(6, 1), v1Points([6.5])),
      control({ type: 'close_session', session_id: sessionId }),
    ]);
    const closed = await waitFor((s) => s?.closed === true, 'close');
    assert.equal(closed.pointBatches, 3, 'the duplicate was dropped, the new batch kept');
    assert.equal(closed.totalPoints, 4);
    const chunks = (await (await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/chunks`)).json()) as Array<{ chunkX: number }>;
    assert.deepEqual(chunks.map((c) => c.chunkX).sort((a, b) => a - b), [0, 2, 4, 6], 'fused into the world like socket batches');
  },
);
