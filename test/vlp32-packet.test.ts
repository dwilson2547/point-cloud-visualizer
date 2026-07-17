import assert from 'node:assert/strict';
import test from 'node:test';

import { POINT_STRIDE_BYTES } from '../src/protocol.js';
import { parseVlp32Packet } from '../src/vlp32-packet.js';

test('parses a synthetic VLP-32 packet into xyz_rgb_i_v1 points', () => {
  const packet = Buffer.alloc(1206);
  packet[0] = 0xff;
  packet[1] = 0xee;
  packet.writeUInt16LE(0, 2);
  packet.writeUInt16LE(500, 4); // 1.0 meter
  packet[6] = 64;

  for (let blockIndex = 1; blockIndex < 12; blockIndex += 1) {
    const offset = blockIndex * 100;
    packet[offset] = 0xff;
    packet[offset + 1] = 0xee;
  }

  const calibration = Array.from({ length: 32 }, (_, laserId) => ({
    laserId,
    verticalDegrees: 0,
    rotationalDegrees: 0,
    distanceOffsetMeters: 0,
  }));

  const parsed = parseVlp32Packet(packet, calibration);

  assert.equal(parsed.pointCount, 1);
  assert.equal(parsed.payload.byteLength, POINT_STRIDE_BYTES);
  assert.equal(parsed.payload.readFloatLE(0), 1);
  assert.equal(parsed.payload.readFloatLE(4), 0);
  assert.equal(parsed.payload.readFloatLE(8), 0);
  assert.equal(parsed.payload[12], 64);
  assert.equal(parsed.payload[13], 64);
  assert.equal(parsed.payload[14], 64);
  assert.equal(parsed.payload.readUInt16LE(15), 64 * 257);
});
