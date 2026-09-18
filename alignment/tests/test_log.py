import json
import struct
import zlib

import numpy as np

from pcv_align.log import POINT_DTYPE, matrix_to_pose, parse_log, pose_to_matrix


def record(sequence: int, points: np.ndarray, translation=(0.0, 0.0, 0.0)) -> bytes:
    header = json.dumps(
        {
            "sequence": sequence,
            "pose_sequence": sequence - 1,
            "timestamp": "2026-07-10T00:00:00Z",
            "point_count": int(points.shape[0]),
            "pose": {"translation_m": list(translation), "rotation_xyzw": [0, 0, 0, 1]},
        }
    ).encode()
    wire = np.zeros(points.shape[0], dtype=POINT_DTYPE)
    wire["x"], wire["y"], wire["z"] = points[:, 0], points[:, 1], points[:, 2]
    payload = wire.tobytes()
    body = header + payload
    return struct.pack("<IIII", 0x4C564350, len(header), len(payload), zlib.crc32(body)) + body


def test_parse_log_reads_records_and_stops_at_a_torn_tail() -> None:
    pts = np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]])
    data = record(2, pts, translation=(1, 0, 0)) + record(4, pts[:1]) + b"\x00\x01"
    warnings: list[str] = []
    batches = list(parse_log(data, on_warning=warnings.append))
    assert [b.sequence for b in batches] == [2, 4]
    assert batches[0].pose_sequence == 1
    assert np.allclose(batches[0].points, pts)
    assert np.allclose(batches[0].pose[:3, 3], [1, 0, 0])
    assert batches[1].points.shape == (1, 3)
    assert warnings and "torn" in warnings[0]


def test_pose_round_trip() -> None:
    rng = np.random.default_rng(1)
    for _ in range(20):
        q = rng.normal(size=4)
        q /= np.linalg.norm(q)
        t = rng.normal(size=3)
        m = pose_to_matrix(t, q)
        back = matrix_to_pose(m)
        assert np.allclose(pose_to_matrix(back["translation_m"], back["rotation_xyzw"]), m, atol=1e-9)
