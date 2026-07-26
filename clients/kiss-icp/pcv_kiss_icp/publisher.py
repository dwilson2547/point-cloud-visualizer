from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import queue
import signal
import socket
import threading
from typing import Any

from kiss_icp.config import load_config
from kiss_icp.kiss_icp import KissICP
import numpy as np
from websockets.sync.client import ClientConnection, connect

from .vlp16 import Spin, SpinAssembler, load_calibration

POINT_FORMAT = "xyz_rgb_i_v1"
POINT_STRIDE_BYTES = 18
PROTOCOL_VERSION = 1

WIRE_DTYPE = np.dtype(
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


class PacketReceiver:
    def __init__(self, port: int, sensor_ip: str | None, capacity: int = 4096) -> None:
        self.port = port
        self.sensor_ip = sensor_ip
        self.queue: queue.Queue[bytes] = queue.Queue(maxsize=capacity)
        self.dropped_packets = 0
        self.filtered_packets = 0
        self._stop = threading.Event()
        self._socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._socket.settimeout(0.25)
        self._thread = threading.Thread(target=self._run, name="vlp16-udp", daemon=True)

    def start(self) -> None:
        self._socket.bind(("0.0.0.0", self.port))
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=1.0)
        self._socket.close()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                packet, sender = self._socket.recvfrom(2048)
            except TimeoutError:
                continue
            if self.sensor_ip is not None and sender[0] != self.sensor_ip:
                self.filtered_packets += 1
                continue
            try:
                self.queue.put_nowait(packet)
            except queue.Full:
                self.dropped_packets += 1


class IngestClient:
    def __init__(
        self,
        connection: ClientConnection,
        session_id: str,
        publisher_id: str,
        frame_id: str,
    ) -> None:
        self.connection = connection
        self.session_id = session_id
        self.publisher_id = publisher_id
        self.frame_id = frame_id
        self.sequence = 0

    def create_session(self) -> None:
        self._send_json(
            {
                "type": "create_session",
                "protocol_version": PROTOCOL_VERSION,
                "session_id": self.session_id,
                "publisher_id": self.publisher_id,
                "started_at": _now(),
                "frame_id": self.frame_id,
                "units": "meters",
                "metadata": {"odometry": "kiss-icp", "sensor": "vlp16"},
            }
        )
        response = self._receive_json()
        if response.get("type") == "error":
            raise RuntimeError(f"Server rejected session: {response.get('message')}")
        if response.get("type") != "session_ack" or not response.get("accepted"):
            raise RuntimeError(f"Unexpected session response: {response}")
        self.sequence = int(response["resume_from_sequence"]) - 1

    def publish_spin(self, points: np.ndarray, pose: np.ndarray) -> None:
        if points.size == 0:
            return
        timestamp = _now()
        pose_sequence = self._next_sequence()
        translation, quaternion = matrix_to_pose(pose)
        self._send_json(
            {
                "type": "pose_update",
                "session_id": self.session_id,
                "publisher_id": self.publisher_id,
                "sequence": pose_sequence,
                "timestamp": timestamp,
                "pose": {
                    "translation_m": translation,
                    "rotation_xyzw": quaternion,
                },
            }
        )

        payload, bounds = encode_points(points)
        batch_sequence = self._next_sequence()
        self._send_json(
            {
                "type": "point_batch_header",
                "session_id": self.session_id,
                "publisher_id": self.publisher_id,
                "sequence": batch_sequence,
                "timestamp": timestamp,
                "pose_sequence": pose_sequence,
                "point_count": int(points.shape[0]),
                "point_format": POINT_FORMAT,
                "encoding": "binary_le",
                "compression": "none",
                "stride_bytes": POINT_STRIDE_BYTES,
                "bounds_local": bounds,
            }
        )
        self.connection.send(payload)
        response = self._receive_json()
        if response.get("type") == "error":
            raise RuntimeError(f"Server rejected batch: {response.get('message')}")
        if response.get("type") != "point_batch_ack":
            raise RuntimeError(f"Unexpected batch response: {response}")
        if int(response.get("sequence", -1)) != batch_sequence:
            raise RuntimeError("Point batch acknowledgement sequence mismatch")

    def close_session(self) -> None:
        self._send_json(
            {
                "type": "close_session",
                "session_id": self.session_id,
                "publisher_id": self.publisher_id,
                "sequence": self._next_sequence(),
            }
        )

    def _next_sequence(self) -> int:
        self.sequence += 1
        return self.sequence

    def _send_json(self, message: dict[str, Any]) -> None:
        self.connection.send(json.dumps(message, separators=(",", ":")))

    def _receive_json(self) -> dict[str, Any]:
        message = self.connection.recv()
        if not isinstance(message, str):
            raise RuntimeError("Expected a JSON control message from the server")
        return json.loads(message)


def encode_points(points: np.ndarray) -> tuple[bytes, dict[str, list[float]]]:
    finite = np.asarray(points, dtype=np.float64)
    finite = finite[np.isfinite(finite).all(axis=1)]
    if finite.size == 0:
        raise ValueError("KISS-ICP frame contains no finite points")

    wire = np.zeros(finite.shape[0], dtype=WIRE_DTYPE)
    wire["x"] = finite[:, 0]
    wire["y"] = finite[:, 1]
    wire["z"] = finite[:, 2]
    ranges = np.linalg.norm(finite, axis=1)
    colors = np.clip(255.0 * (1.0 - ranges / max(float(ranges.max()), 1.0)), 48, 220)
    wire["r"] = colors.astype(np.uint8)
    wire["g"] = np.clip(colors + 20, 0, 255).astype(np.uint8)
    wire["b"] = np.clip(255 - colors // 2, 0, 255).astype(np.uint8)
    wire["intensity"] = (wire["g"].astype(np.uint16) * 257).astype(np.uint16)
    minimum = finite.min(axis=0).tolist()
    maximum = finite.max(axis=0).tolist()
    return wire.tobytes(), {"min": minimum, "max": maximum}


def matrix_to_pose(matrix: np.ndarray) -> tuple[list[float], list[float]]:
    rotation = np.asarray(matrix[:3, :3], dtype=np.float64)
    translation = np.asarray(matrix[:3, 3], dtype=np.float64)
    trace = float(np.trace(rotation))
    if trace > 0.0:
        scale = 2.0 * np.sqrt(trace + 1.0)
        qw = 0.25 * scale
        qx = (rotation[2, 1] - rotation[1, 2]) / scale
        qy = (rotation[0, 2] - rotation[2, 0]) / scale
        qz = (rotation[1, 0] - rotation[0, 1]) / scale
    else:
        index = int(np.argmax(np.diag(rotation)))
        if index == 0:
            scale = 2.0 * np.sqrt(1.0 + rotation[0, 0] - rotation[1, 1] - rotation[2, 2])
            qw = (rotation[2, 1] - rotation[1, 2]) / scale
            qx = 0.25 * scale
            qy = (rotation[0, 1] + rotation[1, 0]) / scale
            qz = (rotation[0, 2] + rotation[2, 0]) / scale
        elif index == 1:
            scale = 2.0 * np.sqrt(1.0 + rotation[1, 1] - rotation[0, 0] - rotation[2, 2])
            qw = (rotation[0, 2] - rotation[2, 0]) / scale
            qx = (rotation[0, 1] + rotation[1, 0]) / scale
            qy = 0.25 * scale
            qz = (rotation[1, 2] + rotation[2, 1]) / scale
        else:
            scale = 2.0 * np.sqrt(1.0 + rotation[2, 2] - rotation[0, 0] - rotation[1, 1])
            qw = (rotation[1, 0] - rotation[0, 1]) / scale
            qx = (rotation[0, 2] + rotation[2, 0]) / scale
            qy = (rotation[1, 2] + rotation[2, 1]) / scale
            qz = 0.25 * scale
    quaternion = np.asarray([qx, qy, qz, qw], dtype=np.float64)
    quaternion /= np.linalg.norm(quaternion)
    return translation.tolist(), quaternion.tolist()


def run(options: argparse.Namespace) -> None:
    calibration = load_calibration(options.calibration_file)
    assembler = SpinAssembler(calibration, minimum_points=options.minimum_points)
    config = load_config(options.kiss_config)
    config.data.min_range = options.min_range
    config.data.max_range = options.max_range
    config.mapping.voxel_size = options.voxel_size or options.max_range / 100.0
    odometry = KissICP(config)
    receiver = PacketReceiver(options.udp_port, options.sensor_ip)
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())

    with connect(options.server_url, max_size=None) as connection:
        ingest = IngestClient(
            connection,
            session_id=options.session_id,
            publisher_id=options.publisher_id,
            frame_id=options.frame_id,
        )
        ingest.create_session()
        receiver.start()
        print(
            f"Listening for VLP-16 UDP on {options.udp_port}; "
            f"viewer: http://localhost:8080/?session_id={options.session_id}"
        )
        spins = 0
        malformed_packets = 0
        try:
            while not stop.is_set():
                try:
                    packet = receiver.queue.get(timeout=0.25)
                except queue.Empty:
                    continue
                try:
                    completed_spins = assembler.add_packet(packet)
                except ValueError:
                    malformed_packets += 1
                    continue
                for spin in completed_spins:
                    deskewed, _ = odometry.register_frame(spin.points, spin.timestamps)
                    ingest.publish_spin(deskewed, odometry.last_pose)
                    spins += 1
                    if spins == 1 or spins % 10 == 0:
                        xyz = odometry.last_pose[:3, 3]
                        print(
                            f"spin={spins} points={deskewed.shape[0]} "
                            f"pose=({xyz[0]:.2f}, {xyz[1]:.2f}, {xyz[2]:.2f}) "
                            f"udp_drops={receiver.dropped_packets} "
                            f"malformed={malformed_packets} filtered={receiver.filtered_packets}"
                        )
        finally:
            receiver.close()
            ingest.close_session()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Estimate VLP-16 odometry with KISS-ICP and publish it to point-cloud-visualizer"
    )
    parser.add_argument("--calibration-file", required=True)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--publisher-id", default="vlp16-kiss-icp")
    parser.add_argument("--server-url", default="ws://localhost:8080/ws/ingest")
    parser.add_argument("--udp-port", type=int, default=2368)
    parser.add_argument("--sensor-ip")
    parser.add_argument("--frame-id", default="kiss_odom")
    parser.add_argument("--minimum-points", type=int, default=1_000)
    parser.add_argument("--min-range", type=float, default=1.0)
    parser.add_argument("--max-range", type=float, default=100.0)
    parser.add_argument("--voxel-size", type=float)
    parser.add_argument("--kiss-config", type=str)
    return parser.parse_args()


def main() -> None:
    run(parse_args())


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


if __name__ == "__main__":
    main()
