import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BatchLogWriter, encodeRecord, replayLog, type LogRecordHeader } from '../src/batch-log.js';

function header(sequence: number, pointCount: number): LogRecordHeader {
  return {
    sequence,
    pose_sequence: sequence - 1,
    timestamp: '2026-07-10T00:00:00Z',
    point_count: pointCount,
    pose: { translation_m: [1, 2, 3], rotation_xyzw: [0, 0, 0, 1] },
  };
}

test('appends records and replays them from any offset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcv-batchlog-'));
  const file = path.join(dir, 's.log');
  const writer = new BatchLogWriter(file);
  const afterFirst = writer.append(header(2, 2), Buffer.from([1, 2, 3, 4]));
  writer.append(header(4, 1), Buffer.from([9]));
  writer.close();

  const all: number[] = [];
  const full = replayLog(file, 0, (record) => all.push(record.header.sequence));
  assert.deepEqual(all, [2, 4]);
  assert.equal(full.records, 2);
  assert.equal(full.truncatedBytes, 0);
  assert.equal(full.endOffset, fs.statSync(file).size);

  const tail: Buffer[] = [];
  replayLog(file, afterFirst, (record) => tail.push(record.payload));
  assert.equal(tail.length, 1);
  assert.deepEqual([...tail[0]], [9]);

  // Reopening resumes appends at the end.
  const reopened = new BatchLogWriter(file);
  assert.equal(reopened.offset, full.endOffset);
  reopened.close();
});

test('truncates a torn tail and a corrupt record, keeping every intact record before it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcv-batchlog-torn-'));
  const file = path.join(dir, 's.log');
  const good = encodeRecord(header(2, 1), Buffer.from([7]));
  const partial = encodeRecord(header(4, 3), Buffer.from([1, 2, 3])).subarray(0, 20);
  fs.writeFileSync(file, Buffer.concat([good, partial]));

  const seen: number[] = [];
  const result = replayLog(file, 0, (record) => seen.push(record.header.sequence));
  assert.deepEqual(seen, [2]);
  assert.equal(result.truncatedBytes, partial.byteLength);
  assert.equal(fs.statSync(file).size, good.byteLength);

  // A bit flip inside a complete record fails the CRC and is cut the same way.
  const corrupt = encodeRecord(header(4, 1), Buffer.from([5]));
  corrupt[corrupt.byteLength - 1] ^= 0xff;
  fs.appendFileSync(file, Buffer.concat([corrupt, encodeRecord(header(6, 1), Buffer.from([6]))]));
  const seenAgain: number[] = [];
  const again = replayLog(file, 0, (record) => seenAgain.push(record.header.sequence));
  assert.deepEqual(seenAgain, [2], 'nothing after the corrupt record is trusted');
  assert.equal(fs.statSync(file).size, good.byteLength);
  assert.ok(again.truncatedBytes > 0);
});
