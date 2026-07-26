import struct

import numpy as np
import pytest

from pcv_kiss_icp.publisher import encode_points, matrix_to_pose
from pcv_kiss_icp.vlp16 import (
    LaserCalibration,
    SpinAssembler,
    parse_packet,
)


def calibration() -> list[LaserCalibration]:
    return [
        LaserCalibration(laser_id=index, vertical_degrees=0.0)
        for index in range(16)
    ]


def packet(azimuth: float, timestamp_us: int, distance_raw: int = 500) -> bytes:
    data = bytearray(1206)
    for block_index in range(12):
        offset = block_index * 100
        struct.pack_into("<H", data, offset, 0xEEFF)
        block_azimuth = int(((azimuth + block_index) % 360.0) * 100)
        struct.pack_into("<H", data, offset + 2, block_azimuth)
        for channel_index in range(32):
            channel_offset = offset + 4 + channel_index * 3
            struct.pack_into("<H", data, channel_offset, distance_raw)
            data[channel_offset + 2] = 64
    struct.pack_into("<I", data, 1200, timestamp_us)
    return bytes(data)


def test_parse_packet_produces_points_and_monotonic_timestamps() -> None:
    firings = parse_packet(packet(10.0, 1_000_000), calibration())
    assert len(firings) == 24
    points = np.concatenate([firing.points for firing in firings])
    timestamps = np.concatenate([firing.timestamps_us for firing in firings])
    assert points.shape == (384, 3)
    assert np.all(np.diff(timestamps) >= 0)
    assert np.isclose(points[0, 0], np.cos(np.deg2rad(10.0)))


def test_spin_assembler_discards_partial_spin_then_emits_full_spin() -> None:
    assembler = SpinAssembler(calibration(), minimum_points=100)
    completed = []
    for index, azimuth in enumerate([300.0, 340.0, 5.0, 80.0, 160.0, 240.0, 320.0, 5.0]):
        completed.extend(assembler.add_packet(packet(azimuth, 1_000_000 + index * 1_500)))
    assert len(completed) == 1
    spin = completed[0]
    assert spin.points.shape[0] >= 100
    assert float(spin.timestamps.min()) >= 0.0
    assert float(spin.timestamps.max()) <= 1.0


def test_malformed_packet_does_not_change_timestamp_rollover_state() -> None:
    assembler = SpinAssembler(calibration(), minimum_points=100)
    assembler.add_packet(packet(10.0, 1_000_000))

    malformed = bytearray(packet(20.0, 3_500_000_000))
    struct.pack_into("<H", malformed, 0, 0)
    with pytest.raises(ValueError, match="Invalid data block flag"):
        assembler.add_packet(bytes(malformed))

    assembler.add_packet(packet(30.0, 1_010_000))
    assert assembler._timestamp_epoch_us == 0


def test_wire_encoding_and_pose_conversion() -> None:
    points = np.asarray([[1.0, 2.0, 3.0], [-1.0, 0.0, 0.5]])
    payload, bounds = encode_points(points)
    assert len(payload) == 2 * 18
    assert bounds == {"min": [-1.0, 0.0, 0.5], "max": [1.0, 2.0, 3.0]}

    pose = np.eye(4)
    pose[:3, 3] = [4.0, 5.0, 6.0]
    translation, quaternion = matrix_to_pose(pose)
    assert translation == [4.0, 5.0, 6.0]
    assert np.allclose(quaternion, [0.0, 0.0, 0.0, 1.0])
