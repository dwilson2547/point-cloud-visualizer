"""Reader for the server's per-session batch log (src/batch-log.ts, docs/batch-log.md).

Each record is a 16-byte frame (magic, header length, payload length, crc32) followed by
a JSON header and the raw local-frame point payload. Reading stops at the first torn or
corrupt record, mirroring the server's own replay.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import struct
from typing import Iterator, Sequence
import zlib

import numpy as np

LOG_MAGIC = 0x4C564350
FRAME = struct.Struct("<IIII")
POINT_DTYPE = np.dtype(
    [
        ("x", "<f4"),
        ("y", "<f4"),
        ("z", "<f4"),
        ("r", "u1"),
        ("g", "u1"),
        ("b", "u1"),
        ("intensity", "<u2"),
        ("padding", "u1"),
    ],
    align=False,
)
# xyzi_q4_v2: int16 xyz at 4 mm + 8-bit intensity (src/point-formats.ts).
Q4_DTYPE = np.dtype([("x", "<i2"), ("y", "<i2"), ("z", "<i2"), ("intensity", "u1")], align=False)
Q4_METERS = 0.004
POINT_FORMAT_V1 = "xyz_rgb_i_v1"
POINT_FORMAT_Q4 = "xyzi_q4_v2"


def decode_points(payload: bytes, point_format: str) -> np.ndarray:
    """(N, 3) float64 sensor-frame points from a wire payload in either ingest format."""
    if point_format == POINT_FORMAT_Q4:
        raw = np.frombuffer(payload, dtype=Q4_DTYPE)
        return np.column_stack([raw["x"], raw["y"], raw["z"]]).astype(np.float64) * Q4_METERS
    raw = np.frombuffer(payload, dtype=POINT_DTYPE)
    return np.column_stack([raw["x"], raw["y"], raw["z"]]).astype(np.float64)


def encode_points(points: np.ndarray, point_format: str, intensity: np.ndarray | None = None) -> bytes:
    """Wire payload for sensor-frame points in either ingest format (publishers)."""
    pts = np.asarray(points, dtype=np.float64)
    if intensity is None:
        intensity = np.full(pts.shape[0], 128, dtype=np.uint8)
    if point_format == POINT_FORMAT_Q4:
        wire = np.zeros(pts.shape[0], dtype=Q4_DTYPE)
        q = np.clip(np.round(pts / Q4_METERS), -32768, 32767).astype(np.int16)
        wire["x"], wire["y"], wire["z"] = q[:, 0], q[:, 1], q[:, 2]
        wire["intensity"] = np.asarray(intensity, dtype=np.uint8)
        return wire.tobytes()
    wire = np.zeros(pts.shape[0], dtype=POINT_DTYPE)
    wire["x"], wire["y"], wire["z"] = pts[:, 0], pts[:, 1], pts[:, 2]
    wire["r"] = wire["g"] = wire["b"] = np.asarray(intensity, dtype=np.uint8)
    wire["intensity"] = np.asarray(intensity, dtype=np.uint16) << 8
    return wire.tobytes()


@dataclass
class Batch:
    sequence: int
    pose_sequence: int
    timestamp: str
    pose: np.ndarray  # 4x4 world_T_sensor as the publisher sent it
    points: np.ndarray  # (N, 3) float64, sensor frame


def pose_to_matrix(translation: Sequence[float], rotation_xyzw: Sequence[float]) -> np.ndarray:
    x, y, z, w = (float(v) for v in rotation_xyzw)
    norm = np.sqrt(x * x + y * y + z * z + w * w)
    x, y, z, w = x / norm, y / norm, z / norm, w / norm
    matrix = np.eye(4)
    matrix[:3, :3] = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]
    matrix[:3, 3] = [float(v) for v in translation]
    return matrix


def matrix_to_pose(matrix: np.ndarray) -> dict:
    rotation = np.asarray(matrix[:3, :3], dtype=np.float64)
    trace = float(np.trace(rotation))
    if trace > 0.0:
        s = 2.0 * np.sqrt(trace + 1.0)
        w = 0.25 * s
        x = (rotation[2, 1] - rotation[1, 2]) / s
        y = (rotation[0, 2] - rotation[2, 0]) / s
        z = (rotation[1, 0] - rotation[0, 1]) / s
    else:
        i = int(np.argmax(np.diag(rotation)))
        if i == 0:
            s = 2.0 * np.sqrt(1.0 + rotation[0, 0] - rotation[1, 1] - rotation[2, 2])
            w = (rotation[2, 1] - rotation[1, 2]) / s
            x = 0.25 * s
            y = (rotation[0, 1] + rotation[1, 0]) / s
            z = (rotation[0, 2] + rotation[2, 0]) / s
        elif i == 1:
            s = 2.0 * np.sqrt(1.0 + rotation[1, 1] - rotation[0, 0] - rotation[2, 2])
            w = (rotation[0, 2] - rotation[2, 0]) / s
            x = (rotation[0, 1] + rotation[1, 0]) / s
            y = 0.25 * s
            z = (rotation[1, 2] + rotation[2, 1]) / s
        else:
            s = 2.0 * np.sqrt(1.0 + rotation[2, 2] - rotation[0, 0] - rotation[1, 1])
            w = (rotation[1, 0] - rotation[0, 1]) / s
            x = (rotation[0, 2] + rotation[2, 0]) / s
            y = (rotation[1, 2] + rotation[2, 1]) / s
            z = 0.25 * s
    q = np.asarray([x, y, z, w], dtype=np.float64)
    q /= np.linalg.norm(q)
    return {
        "translation_m": [float(v) for v in matrix[:3, 3]],
        "rotation_xyzw": [float(v) for v in q],
    }


def read_log(path: str, *, on_warning=None) -> Iterator[Batch]:
    with open(path, "rb") as handle:
        data = handle.read()
    yield from parse_log(data, on_warning=on_warning)


def parse_log(data: bytes, *, on_warning=None) -> Iterator[Batch]:
    batches, consumed = parse_records(data)
    if consumed < len(data):
        _warn(on_warning, f"torn or corrupt record at {consumed}; ignoring {len(data) - consumed} bytes")
    yield from batches


def parse_records(data: bytes) -> tuple[list[Batch], int]:
    """Parse every complete record at the front of `data`. Returns the batches and the
    number of bytes consumed; a caller tailing a growing log keeps the remainder and
    prepends it to the next read."""
    batches: list[Batch] = []
    offset = 0
    size = len(data)
    while size - offset >= FRAME.size:
        magic, header_len, payload_len, crc = FRAME.unpack_from(data, offset)
        body_start = offset + FRAME.size
        body_end = body_start + header_len + payload_len
        if magic != LOG_MAGIC or header_len == 0:
            break  # corrupt: nothing after it is trusted
        if body_end > size:
            break  # incomplete: wait for the rest
        body = data[body_start:body_end]
        if zlib.crc32(body) & 0xFFFFFFFF != crc:
            break
        header = json.loads(body[:header_len])
        points = decode_points(body[header_len:], str(header.get("point_format", POINT_FORMAT_V1)))
        batches.append(
            Batch(
                sequence=int(header["sequence"]),
                pose_sequence=int(header["pose_sequence"]),
                timestamp=str(header.get("timestamp", "")),
                pose=pose_to_matrix(header["pose"]["translation_m"], header["pose"]["rotation_xyzw"]),
                points=points,
            )
        )
        offset = body_end
    return batches, offset


def _warn(on_warning, message: str) -> None:
    if on_warning is not None:
        on_warning(message)
