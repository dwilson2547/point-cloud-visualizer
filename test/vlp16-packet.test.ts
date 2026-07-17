import assert from 'node:assert/strict';
import test from 'node:test';

import { POINT_STRIDE_BYTES } from '../src/protocol.js';
import { parseVlp16Packet } from '../src/vlp16-packet.js';

test('parses a synthetic VLP-16 packet into xyz_rgb_i_v1 points', () => {
  const packet = Buffer.alloc(1206);
  for (let blockIndex = 0; blockIndex < 12; blockIndex += 1) {
    const offset = blockIndex * 100;
    packet[offset] = 0xff;
    packet[offset + 1] = 0xee;
    packet.writeUInt16LE(0, offset + 2);
  }

  packet.writeUInt16LE(500, 4); // first firing, first laser => 1.0 meter
  packet[6] = 64;
  packet.writeUInt16LE(1000, 4 + (16 * 3)); // second firing, first laser => 2.0 meters
  packet[4 + (16 * 3) + 2] = 32;

  const calibration = Array.from({ length: 16 }, (_, laserId) => ({
    laserId,
    verticalDegrees: 0,
    rotationalDegrees: 0,
    distanceOffsetMeters: 0,
  }));

  const parsed = parseVlp16Packet(packet, calibration);

  assert.equal(parsed.pointCount, 2);
  assert.equal(parsed.payload.byteLength, POINT_STRIDE_BYTES * 2);
  assert.equal(parsed.payload.readFloatLE(0), 1);
  assert.equal(parsed.payload.readFloatLE(4), 0);
  assert.equal(parsed.payload.readFloatLE(8), 0);
  assert.equal(parsed.payload[12], 64);
  assert.equal(parsed.payload.readFloatLE(POINT_STRIDE_BYTES), 2);
  assert.equal(parsed.payload[POINT_STRIDE_BYTES + 12], 32);
});
