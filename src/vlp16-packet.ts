import { POINT_STRIDE_BYTES } from './protocol.js';
import type { LaserCalibration } from './vlp32-calibration.js';

const VLP16_PACKET_BYTES = 1206;
const BLOCK_COUNT = 12;
const BLOCK_BYTES = 100;
const CHANNELS_PER_FIRING = 16;
const FIRINGS_PER_BLOCK = 2;
const DISTANCE_SCALE_METERS = 0.002;

export interface ParsedBatch {
  pointCount: number;
  payload: Buffer;
  boundsLocal: {
    min: [number, number, number];
    max: [number, number, number];
  };
}

export function parseVlp16Packet(packet: Buffer, calibration: LaserCalibration[]): ParsedBatch {
  if (packet.byteLength !== VLP16_PACKET_BYTES) {
    throw new Error(`Expected ${VLP16_PACKET_BYTES}-byte VLP-16 packet, got ${packet.byteLength}`);
  }
  if (calibration.length !== CHANNELS_PER_FIRING) {
    throw new Error(`Expected ${CHANNELS_PER_FIRING} laser calibration entries`);
  }

  const payload = Buffer.allocUnsafe(
    BLOCK_COUNT * FIRINGS_PER_BLOCK * CHANNELS_PER_FIRING * POINT_STRIDE_BYTES,
  );
  let writeOffset = 0;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let pointCount = 0;

  for (let blockIndex = 0; blockIndex < BLOCK_COUNT; blockIndex += 1) {
    const blockOffset = blockIndex * BLOCK_BYTES;
    if (packet[blockOffset] !== 0xff || packet[blockOffset + 1] !== 0xee) {
      throw new Error(`Invalid data block flag at block ${blockIndex}`);
    }

    const azimuthDegrees = packet.readUInt16LE(blockOffset + 2) / 100;
    const nextAzimuthDegrees = getNextAzimuthDegrees(packet, blockIndex, azimuthDegrees);
    const deltaDegrees = wrapDegrees(nextAzimuthDegrees - azimuthDegrees);

    for (let firingIndex = 0; firingIndex < FIRINGS_PER_BLOCK; firingIndex += 1) {
      const firingAzimuthDegrees = azimuthDegrees + ((deltaDegrees * firingIndex) / FIRINGS_PER_BLOCK);
      for (let laserIndex = 0; laserIndex < CHANNELS_PER_FIRING; laserIndex += 1) {
        const channelIndex = (firingIndex * CHANNELS_PER_FIRING) + laserIndex;
        const channelOffset = blockOffset + 4 + (channelIndex * 3);
        const distanceRaw = packet.readUInt16LE(channelOffset);
        if (distanceRaw === 0) {
          continue;
        }

        const calibrationEntry = calibration[laserIndex];
        const distanceMeters =
          (distanceRaw * DISTANCE_SCALE_METERS) + (calibrationEntry.distanceOffsetMeters ?? 0);
        if (distanceMeters <= 0) {
          continue;
        }

        const azimuthRadians = degreesToRadians(
          firingAzimuthDegrees + (calibrationEntry.rotationalDegrees ?? 0),
        );
        const verticalRadians = degreesToRadians(calibrationEntry.verticalDegrees);
        const xy = distanceMeters * Math.cos(verticalRadians);
        const x = xy * Math.cos(azimuthRadians);
        const y = xy * Math.sin(azimuthRadians);
        const z = distanceMeters * Math.sin(verticalRadians);
        const intensity = packet[channelOffset + 2];

        payload.writeFloatLE(x, writeOffset);
        payload.writeFloatLE(y, writeOffset + 4);
        payload.writeFloatLE(z, writeOffset + 8);
        payload[writeOffset + 12] = intensity;
        payload[writeOffset + 13] = intensity;
        payload[writeOffset + 14] = intensity;
        payload.writeUInt16LE(intensity * 257, writeOffset + 15);
        payload[writeOffset + 17] = 0;

        writeOffset += POINT_STRIDE_BYTES;
        pointCount += 1;

        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        maxZ = Math.max(maxZ, z);
      }
    }
  }

  return {
    pointCount,
    payload: payload.subarray(0, writeOffset),
    boundsLocal:
      pointCount === 0
        ? {
            min: [0, 0, 0],
            max: [0, 0, 0],
          }
        : {
            min: [minX, minY, minZ],
            max: [maxX, maxY, maxZ],
          },
  };
}

function getNextAzimuthDegrees(packet: Buffer, blockIndex: number, fallbackDegrees: number): number {
  if (blockIndex >= BLOCK_COUNT - 1) {
    return fallbackDegrees;
  }
  const nextBlockOffset = (blockIndex + 1) * BLOCK_BYTES;
  if (packet[nextBlockOffset] !== 0xff || packet[nextBlockOffset + 1] !== 0xee) {
    return fallbackDegrees;
  }
  return packet.readUInt16LE(nextBlockOffset + 2) / 100;
}

function wrapDegrees(value: number): number {
  if (value < -180) {
    return value + 360;
  }
  if (value > 180) {
    return value - 360;
  }
  return value;
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}
